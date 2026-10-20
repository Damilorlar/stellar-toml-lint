/**
 * Soroban contract metadata: parse, decode, and cross-check the interface a
 * deployed contract actually exposes (#401).
 *
 * A compiled Soroban contract carries its interface with it. The `contract*`
 * custom sections of the WASM binary hold CBOR-encoded, base64-wrapped XDR of
 * {@link https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md | Soroban spec entries}
 * (`contractspecv0`: functions, structs, enums, error enums, events) and
 * environment metadata (`contractenvmetav0`: the host interface version the
 * contract was compiled against). When anchors reference Soroban contract IDs
 * in `stellar.toml`, client applications rely on that embedded metadata to
 * understand the contract's interface, events, and type definitions — so a
 * file that documents functions a contract does not expose is a broken
 * promise that only surfaces at invocation time.
 *
 * This module reads that metadata end to end:
 *
 * 1. {@link extractCustomSections} pulls the named sections out of the WASM
 *    binary (pure TypeScript, zero native dependencies).
 * 2. {@link decodeCbor} decodes each section's CBOR envelope.
 * 3. {@link decodeSpecEntries} / {@link decodeEnvMetaEntry} decode the XDR
 *    payload into human-readable contract specification objects.
 * 4. {@link ContractMetadataParser} fetches deployed bytecode through the
 *    Soroban RPC's `getLedgerEntries` and drives 1–3.
 * 5. {@link checkContractMetadata} cross-checks the decoded spec against what
 *    a `stellar.toml` documents (`[[CURRENCIES]]` contract entries), reporting
 *    drift as ordinary {@link Diagnostic}s.
 *
 * Error reporting is deliberate at every layer: a corrupted WASM binary, a
 * truncated CBOR payload, an undecodable XDR entry, and an unreachable RPC
 * each produce a distinct, positioned message rather than a generic failure.
 */
import { xdr } from '@stellar/stellar-base';
import type { Diagnostic, Rule, RuleOverrides, Severity } from '../types.js';
import { isString } from '../predicates.js';
import { rpcUrlFor } from '../rules/display-decimals-audit.js';
import { contractIdsOf } from '../rules/currencies.js';
import { webAuthContractIdOf } from '../rules/general.js';
import { contractCodeKey, contractDataInstanceKey, wasmHashOf } from '../soroban.js';
import { decodeCbor, CborDecodeError } from './cbor.js';
import type { CborValue } from './cbor.js';
import { extractCustomSections, customSectionPayload } from './wasm.js';

/** The WASM custom sections Soroban metadata lives in. */
export const SPEC_SECTION = 'contractspecv0';
export const ENV_META_SECTION = 'contractenvmetav0';

/** Diagnostics this module can emit; registered so `--list-rules` knows them. */
export const METADATA_UNDECODABLE_RULE = 'soroban/contract-metadata-undecodable';
export const FUNCTION_UNDECLARED_RULE = 'soroban/contract-function-undeclared';
export const FUNCTION_UNDOCUMENTED_RULE = 'soroban/contract-function-undocumented';
export const EVENT_UNDECLARED_RULE = 'soroban/contract-event-undeclared';
export const INTERFACE_VERSION_DRIFT_RULE = 'soroban/contract-interface-version-drift';

const SEP41_URL = 'https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md';

/* ------------------------------------------------------------------ *
 * Human-readable specification objects
 * ------------------------------------------------------------------ */

/** One function parameter or event parameter, with its rendered type. */
export interface SpecParameter {
  name: string;
  doc: string;
  type: string;
}

/** A function the contract exposes. */
export interface SpecFunction {
  name: string;
  doc: string;
  inputs: SpecParameter[];
  /** Rendered return types; empty for unit-returning functions. */
  outputs: string[];
}

/** One case of a custom error enum (`scspecv0` error enums). */
export interface SpecErrorCase {
  name: string;
  doc: string;
  /** Numeric discriminant the contract returns on this error. */
  code: number;
}

/** A custom error enum the contract defines. */
export interface SpecErrorEnum {
  name: string;
  doc: string;
  cases: SpecErrorCase[];
}

/** One parameter of an emitted event. */
export interface SpecEventParameter {
  name: string;
  doc: string;
  type: string;
  location: 'topic' | 'data';
}

/** An event the contract can emit. */
export interface SpecEvent {
  name: string;
  doc: string;
  format: 'single' | 'vec' | 'map';
  /** Topic parameters, in order; the rest live in the data payload. */
  prefixTopics: string[];
  params: SpecEventParameter[];
}

/** A struct the contract defines. */
export interface SpecStruct {
  name: string;
  doc: string;
  fields: SpecParameter[];
}

/** One case of a union type. */
export interface SpecUnionCase {
  name: string;
  doc: string;
  /** Tuple payload types; empty for void cases. */
  types: string[];
}

/** A discriminated union the contract defines. */
export interface SpecUnion {
  name: string;
  doc: string;
  cases: SpecUnionCase[];
}

/** One case of a plain enum. */
export interface SpecEnumCase {
  name: string;
  doc: string;
  value: number;
}

/** A plain enum the contract defines. */
export interface SpecEnum {
  name: string;
  doc: string;
  cases: SpecEnumCase[];
}

/** Everything `contractspecv0` declares, decoded. */
export interface ContractSpec {
  functions: SpecFunction[];
  errors: SpecErrorEnum[];
  events: SpecEvent[];
  structs: SpecStruct[];
  unions: SpecUnion[];
  enums: SpecEnum[];
}

/** What `contractenvmetav0` declares about the host environment. */
export interface ContractEnvMeta {
  /** Soroban host interface version the contract targets, when declared. */
  interfaceVersion: number | undefined;
}

/** Decoded metadata for one contract. */
export interface ContractMetadata {
  contractId?: string;
  wasmHash?: string;
  spec: ContractSpec;
  envMeta: ContractEnvMeta;
  /** Custom section names found, so callers can see what else the binary carries. */
  sections: string[];
}

/* ------------------------------------------------------------------ *
 * XDR → human-readable rendering
 * ------------------------------------------------------------------ */

/** Renders a {@link xdr.ScSpecTypeDef} as a Soroban-spec type string. */
export function renderSpecType(type: xdr.ScSpecTypeDef): string {
  switch (type.switch().name) {
    case 'scSpecTypeUdt':
      return type.udt().name().toString();
    case 'scSpecTypeOption':
      return `option<${renderSpecType(type.option().valueType())}>`;
    case 'scSpecTypeResult':
      return `result<${renderSpecType(type.result().okType())}, ${renderSpecType(type.result().errorType())}>`;
    case 'scSpecTypeVec':
      return `vec<${renderSpecType(type.vec().elementType())}>`;
    case 'scSpecTypeMap':
      return `map<${renderSpecType(type.map().keyType())}, ${renderSpecType(type.map().valueType())}>`;
    case 'scSpecTypeTuple': {
      const parts = type.tuple().valueTypes().map(renderSpecType);
      return `tuple<${parts.join(', ')}>`;
    }
    case 'scSpecTypeBytesN':
      return `bytesN<${type.bytesN().n()}>`;
    default:
      // Primitive arms (val, bool, u32, address, …) are named by the enum arm.
      return primitiveName(type.switch().name);
  }
}

/** Maps a `ScSpecType` primitive arm to the name used in the spec docs. */
function primitiveName(arm: string): string {
  const withoutPrefix = arm.replace(/^scSpecType/, '');
  return withoutPrefix.charAt(0).toLowerCase() + withoutPrefix.slice(1);
}

const specText = (bytes: { toString(): string }): string => bytes.toString();

function renderInput(input: xdr.ScSpecFunctionInputV0): SpecParameter {
  return {
    name: specText(input.name()),
    doc: specText(input.doc()),
    type: renderSpecType(input.type()),
  };
}

function decodeSpecEntry(entry: xdr.ScSpecEntry, into: ContractSpec): void {
  switch (entry.switch().name) {
    case 'scSpecEntryFunctionV0': {
      const fn = entry.functionV0();
      into.functions.push({
        name: specText(fn.name()),
        doc: specText(fn.doc()),
        inputs: fn.inputs().map(renderInput),
        outputs: fn.outputs().map(renderSpecType),
      });
      return;
    }
    case 'scSpecEntryUdtErrorEnumV0': {
      const errorEnum = entry.udtErrorEnumV0();
      into.errors.push({
        name: specText(errorEnum.name()),
        doc: specText(errorEnum.doc()),
        cases: errorEnum.cases().map((errorCase) => ({
          name: specText(errorCase.name()),
          doc: specText(errorCase.doc()),
          code: Number(errorCase.value()),
        })),
      });
      return;
    }
    case 'scSpecEntryEventV0': {
      const event = entry.eventV0();
      const formatArm = event.dataFormat().name;
      into.events.push({
        name: specText(event.name()),
        doc: specText(event.doc()),
        format:
          formatArm === 'scSpecEventDataFormatVec'
            ? 'vec'
            : formatArm === 'scSpecEventDataFormatMap'
              ? 'map'
              : 'single',
        prefixTopics: event.prefixTopics().map(specText),
        params: event.params().map((param) => ({
          name: specText(param.name()),
          doc: specText(param.doc()),
          type: renderSpecType(param.type()),
          location: param.location().name === 'scSpecEventParamLocationData' ? 'data' : 'topic',
        })),
      });
      return;
    }
    case 'scSpecEntryUdtStructV0': {
      const struct = entry.udtStructV0();
      into.structs.push({
        name: specText(struct.name()),
        doc: specText(struct.doc()),
        fields: struct.fields().map(renderInput),
      });
      return;
    }
    case 'scSpecEntryUdtUnionV0': {
      const union = entry.udtUnionV0();
      into.unions.push({
        name: specText(union.name()),
        doc: specText(union.doc()),
        cases: union.cases().map((unionCase) => {
          // Both arms carry name/doc; only a tuple arm carries payload types.
          const arm = unionCase.value();
          return {
            name: specText(arm.name()),
            doc: specText(arm.doc()),
            types:
              unionCase.switch().name === 'scSpecUdtUnionCaseTupleV0'
                ? unionCase.tupleCase().type().map(renderSpecType)
                : [],
          };
        }),
      });
      return;
    }
    case 'scSpecEntryUdtEnumV0': {
      const enumEntry = entry.udtEnumV0();
      into.enums.push({
        name: specText(enumEntry.name()),
        doc: specText(enumEntry.doc()),
        cases: enumEntry.cases().map((enumCase) => ({
          name: specText(enumCase.name()),
          doc: specText(enumCase.doc()),
          value: Number(enumCase.value()),
        })),
      });
      return;
    }
    /* c8 ignore next 2 -- guarded by decodeSpecEntries' try/catch for future kinds */
    default:
      throw new Error(`unsupported spec entry kind ${entry.switch().name}`);
  }
}

/** Raised when a section's CBOR or XDR payload cannot be decoded. */
export class SpecDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecDecodeError';
  }
}

/**
 * Decodes the `contractspecv0` payload: a CBOR array of base64 strings, each
 * an XDR-encoded {@link xdr.ScSpecEntry}.
 *
 * The array may legitimately be empty (a contract with no exported surface).
 * A payload that is not an array of strings, or an entry that is not valid
 * XDR, raises {@link SpecDecodeError} naming the offending index.
 */
export function decodeSpecEntries(payload: Uint8Array): ContractSpec {
  const spec: ContractSpec = {
    functions: [],
    errors: [],
    events: [],
    structs: [],
    unions: [],
    enums: [],
  };

  let decoded: CborValue;
  try {
    decoded = decodeCbor(payload);
  } catch (error) {
    if (error instanceof CborDecodeError) throw new SpecDecodeError(error.message);
    /* c8 ignore next */ throw error;
  }

  if (!Array.isArray(decoded)) {
    throw new SpecDecodeError('contractspecv0 payload is not a CBOR array');
  }

  decoded.forEach((item, index) => {
    if (!isString(item)) {
      throw new SpecDecodeError(`contractspecv0 entry ${index} is not a CBOR text string`);
    }
    let entry: xdr.ScSpecEntry;
    try {
      entry = xdr.ScSpecEntry.fromXDR(item, 'base64');
    } catch {
      throw new SpecDecodeError(`contractspecv0 entry ${index} is not valid base64 XDR`);
    }
    try {
      decodeSpecEntry(entry, spec);
    } catch (error) {
      throw new SpecDecodeError(
        `contractspecv0 entry ${index} (${entry.switch().name}) could not be decoded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  return spec;
}

/**
 * Decodes the `contractenvmetav0` payload: a CBOR array holding one
 * base64-encoded XDR {@link xdr.ScEnvMetaEntry}.
 */
export function decodeEnvMetaEntry(payload: Uint8Array): ContractEnvMeta {
  let decoded: CborValue;
  try {
    decoded = decodeCbor(payload);
  } catch (error) {
    if (error instanceof CborDecodeError) throw new SpecDecodeError(error.message);
    /* c8 ignore next */ throw error;
  }

  if (!Array.isArray(decoded) || decoded.length === 0) {
    throw new SpecDecodeError('contractenvmetav0 payload is not a non-empty CBOR array');
  }

  const first = decoded[0];
  if (!isString(first)) {
    throw new SpecDecodeError('contractenvmetav0 entry is not a CBOR text string');
  }

  let entry: xdr.ScEnvMetaEntry;
  try {
    entry = xdr.ScEnvMetaEntry.fromXDR(first, 'base64');
  } catch {
    throw new SpecDecodeError('contractenvmetav0 entry is not valid base64 XDR');
  }

  if (entry.switch().name !== 'scEnvMetaKindInterfaceVersion') {
    // A future env-meta kind carries no interface version we can read; report
    // the version as unknown rather than failing the whole parse.
    return { interfaceVersion: undefined };
  }
  // The host interface version is `protocol * 1000 + pre-release`, matching
  // the Soroban SDK's own `get_interface_version` derivation.
  const meta = entry.interfaceVersion();
  return { interfaceVersion: meta.protocol() * 1000 + meta.preRelease() };
}

/**
 * Parses the metadata sections of a compiled contract's WASM binary.
 *
 * A binary with neither `contractspecv0` nor `contractenvmetav0` yields empty
 * (but well-formed) metadata — plenty of real contracts ship without spec
 * sections, and that absence is itself the finding callers report.
 * Structurally corrupted binaries raise {@link WasmParseError};
 * undecodable section payloads raise {@link SpecDecodeError}.
 */
export function parseContractMetadata(wasm: Uint8Array): ContractMetadata {
  const sections = extractCustomSections(wasm);
  const spec = customSectionPayload(sections, SPEC_SECTION);
  const envMeta = customSectionPayload(sections, ENV_META_SECTION);

  return {
    spec:
      spec !== undefined
        ? decodeSpecEntries(spec)
        : { functions: [], errors: [], events: [], structs: [], unions: [], enums: [] },
    envMeta: envMeta !== undefined ? decodeEnvMetaEntry(envMeta) : { interfaceVersion: undefined },
    sections: sections.map((section) => section.name),
  };
}

/* ------------------------------------------------------------------ *
 * Fetching deployed bytecode via the Soroban RPC
 * ------------------------------------------------------------------ */

/** Why a contract's WASM could not be fetched. */
export class ContractFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractFetchError';
  }
}

interface LedgerEntryResult {
  entries: { xdr?: unknown }[];
  latestLedger: number;
}

/**
 * POSTs one `getLedgerEntries` request and returns the entries it holds.
 *
 * Mirrors the transport in `../soroban.ts`: an unreachable endpoint, a non-200
 * answer, or malformed JSON all raise {@link ContractFetchError} with the
 * detail a human needs, because a silent `undefined` at this layer becomes a
 * misleading "no metadata" finding three call frames later.
 */
async function getLedgerEntries(
  rpcUrl: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<LedgerEntryResult> {
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLedgerEntries',
        params: { keys: [key] },
      }),
    });
  } catch (error) {
    throw new ContractFetchError(
      `could not reach the Soroban RPC at ${rpcUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new ContractFetchError(`the Soroban RPC at ${rpcUrl} returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ContractFetchError(`the Soroban RPC at ${rpcUrl} did not return valid JSON`);
  }

  const result = (body as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) {
    const rpcError = (body as { error?: { message?: unknown } }).error;
    const detail = isString(rpcError?.message) ? `: ${rpcError.message}` : '';
    throw new ContractFetchError(`the Soroban RPC at ${rpcUrl} answered with an error${detail}`);
  }

  const record = result as { latestLedger?: unknown; entries?: unknown };
  const latestLedger = Number(record.latestLedger);
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    entries: entries.filter((e): e is { xdr?: unknown } => typeof e === 'object' && e !== null),
    latestLedger: Number.isInteger(latestLedger) ? latestLedger : 0,
  };
}

/**
 * Reads the network's current protocol version via the RPC's `getNetwork`.
 *
 * Returns `undefined` when the endpoint cannot answer — interface-version
 * drift is a best-effort cross-check, and an unreachable `getNetwork` must not
 * become a misleading finding (transport problems are already reported by the
 * metadata fetch itself).
 */
async function getNetworkProtocolVersion(
  rpcUrl: string,
  fetchImpl: typeof fetch,
): Promise<number | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const version = Number(
    (body as { result?: { protocolVersion?: unknown } }).result?.protocolVersion,
  );
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

/** Reads the WASM bytes out of a contract-code ledger entry. */
function wasmBytesOf(entryXdr: unknown): Uint8Array | undefined {
  if (!isString(entryXdr)) return undefined;
  try {
    const data = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
    return new Uint8Array(data.contractCode().code());
  } catch {
    return undefined;
  }
}

/**
 * Fetches a deployed contract's WASM bytecode through the Soroban RPC.
 *
 * Resolves the contract's instance entry, extracts the WASM hash it points
 * at, then reads the code entry that hash names. Raises
 * {@link ContractFetchError} when the contract is unknown (archived or never
 * deployed) or the RPC cannot answer.
 */
export async function fetchContractWasm(
  contractId: string,
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const instance = await getLedgerEntries(rpcUrl, contractDataInstanceKey(contractId), fetchImpl);
  const instanceEntry = instance.entries[0];
  if (instanceEntry === undefined) {
    throw new ContractFetchError(
      `the Soroban RPC at ${rpcUrl} has no live contract-instance entry for ${contractId} (expired, archived, or never deployed)`,
    );
  }

  const wasmHash = wasmHashOf(instanceEntry.xdr);
  if (wasmHash === undefined) {
    throw new ContractFetchError(
      `${contractId} is not a WASM contract (it may be a native contract)`,
    );
  }

  const code = await getLedgerEntries(rpcUrl, contractCodeKey(wasmHash), fetchImpl);
  const wasm = wasmBytesOf(code.entries[0]?.xdr);
  if (wasm === undefined) {
    throw new ContractFetchError(
      `the Soroban RPC at ${rpcUrl} returned no readable WASM entry for ${contractId} (its code may be archived)`,
    );
  }
  return wasm;
}

/**
 * The high-level parser: fetch a contract's deployed bytecode and decode its
 * metadata sections in one step.
 *
 * @example
 * ```ts
 * const parser = new ContractMetadataParser(fetch);
 * const metadata = await parser.parseContract('C…', 'https://soroban-testnet.stellar.org');
 * console.log(metadata.spec.functions.map((f) => f.name));
 * ```
 */
export class ContractMetadataParser {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  /** Fetches and decodes one contract's metadata. */
  async parseContract(contractId: string, rpcUrl: string): Promise<ContractMetadata> {
    const wasm = await fetchContractWasm(contractId, rpcUrl, this.fetchImpl);
    const metadata = parseContractMetadata(wasm);
    return { ...metadata, contractId };
  }

  /** Decodes metadata from WASM bytes the caller already holds. */
  parseWasm(wasm: Uint8Array, contractId?: string): ContractMetadata {
    const metadata = parseContractMetadata(wasm);
    return contractId !== undefined ? { ...metadata, contractId } : metadata;
  }
}

/* ------------------------------------------------------------------ *
 * stellar.toml ↔ deployed spec validation
 * ------------------------------------------------------------------ */

/** What a `stellar.toml` documents about one contract, for cross-checking. */
export interface DeclaredContract {
  contractId: string;
  /** Dotted path to the declaration, e.g. `CURRENCIES[0].contract`. */
  path: string;
  /** Functions the file's `conditions`/docs name, when enumerated. */
  documentedFunctions?: string[];
  /** The asset code this contract is supposed to serve, when declared. */
  assetCode?: string;
}

/**
 * Reads the contracts a file declares: every `[[CURRENCIES]].contract`, plus
 * `WEB_AUTH_CONTRACT_ID`.
 *
 * `conditions` strings may enumerate an expected interface in the form
 * `` `function_name(arg, …)` `` — backticked invocations — which we treat as
 * documented functions the deployed contract must expose. This is the only
 * interface documentation SEP-1 offers a home for, so it is what the
 * synchronizer compares.
 */
export function declaredContractsOf(doc: Record<string, unknown>): DeclaredContract[] {
  const declared: DeclaredContract[] = contractIdsOf(doc).map(({ id, path }, index) => {
    const entry = (doc.CURRENCIES as Record<string, unknown>[] | undefined)?.[index];
    const conditions =
      entry !== undefined && isString(entry.conditions) ? entry.conditions : undefined;
    return {
      contractId: id,
      path,
      ...(conditions !== undefined ? { documentedFunctions: functionsNamedIn(conditions) } : {}),
      ...(entry !== undefined && isString(entry.code) ? { assetCode: entry.code } : {}),
    };
  });

  const webAuth = webAuthContractIdOf(doc);
  if (webAuth !== undefined) {
    declared.push({ contractId: webAuth.id, path: webAuth.path });
  }
  return declared;
}

/** Extracts backticked `name(…)` invocations from a prose string. */
function functionsNamedIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

function severityFor(
  rule: string,
  fallback: Severity,
  rules: RuleOverrides | undefined,
): Severity | undefined {
  const override = rules?.[rule];
  if (override === 'off') return undefined;
  return override ?? fallback;
}

function finding(
  rule: string,
  fallback: Severity,
  message: string,
  path: string,
  suggestion: string,
  rules: RuleOverrides | undefined,
): Diagnostic[] {
  const severity = severityFor(rule, fallback, rules);
  if (severity === undefined) return [];
  return [{ rule, severity, category: 'network', message, path, helpUri: SEP41_URL, suggestion }];
}

/** Options for {@link checkContractMetadata}. */
export interface ContractMetadataCheckOptions {
  /** Severity overrides, keyed by rule id. */
  rules?: RuleOverrides;
  /** RPC endpoint; defaults to the one implied by `NETWORK_PASSPHRASE`. */
  rpcUrl?: string;
}

/**
 * Cross-checks every contract a `stellar.toml` declares against its deployed
 * metadata.
 *
 * Reports, per contract:
 * - `soroban/contract-metadata-undecodable` (warning) when the binary or its
 *   spec sections cannot be read — corrupted metadata is indistinguishable
 *   from none, and both leave clients unable to introspect;
 * - `soroban/contract-function-undeclared` (error) when `conditions`
 *   documents a function the deployed contract does not expose;
 * - `soroban/contract-event-undeclared` (warning) when a documented
 *   `` `event_name` `` is not in the spec's events;
 * - `soroban/contract-function-undocumented` (info) when the deployed spec
 *   exposes functions the file never mentions, since anchors generally should
 *   document their full interface;
 * - `soroban/contract-interface-version-drift` (warning) when the contract
 *   targets a Soroban protocol older than the network currently runs.
 *
 * Silent when the file declares no contracts, or when no RPC endpoint can be
 * derived (pass `options.rpcUrl` to force one).
 */
export async function checkContractMetadata(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: ContractMetadataCheckOptions = {},
): Promise<Diagnostic[]> {
  const rpcUrl =
    options.rpcUrl ??
    rpcUrlFor(typeof doc.NETWORK_PASSPHRASE === 'string' ? doc.NETWORK_PASSPHRASE : undefined);
  const declared = declaredContractsOf(doc);
  if (rpcUrl === undefined || declared.length === 0) return [];

  const parser = new ContractMetadataParser(fetchImpl);
  const diagnostics: Diagnostic[] = [];

  // The network's protocol version is the same for every contract in the file;
  // fetch it at most once, and only when a contract actually pins a version.
  let cachedNetworkProtocol: number | undefined;
  let networkProtocolFetched = false;
  const networkProtocolVersion = async (): Promise<number | undefined> => {
    if (!networkProtocolFetched) {
      networkProtocolFetched = true;
      cachedNetworkProtocol = await getNetworkProtocolVersion(rpcUrl, fetchImpl);
    }
    return cachedNetworkProtocol;
  };

  for (const target of declared) {
    let metadata: ContractMetadata;
    try {
      metadata = await parser.parseContract(target.contractId, rpcUrl);
    } catch (error) {
      // An unreachable or empty RPC answer is a transport finding, not a
      // metadata mismatch: report it distinctly and move on.
      const detail = error instanceof Error ? error.message : String(error);
      diagnostics.push(
        ...finding(
          METADATA_UNDECODABLE_RULE,
          'warning',
          `${target.path} (${target.contractId}) metadata could not be read: ${detail}`,
          target.path,
          'Confirm the contract ID and that the Soroban RPC endpoint serves its ledger entries.',
          options.rules,
        ),
      );
      continue;
    }

    const exposed = new Set(metadata.spec.functions.map((fn) => fn.name));
    const exposedEvents = new Set(metadata.spec.events.map((event) => event.name));

    for (const fnName of target.documentedFunctions ?? []) {
      if (exposed.has(fnName)) continue;
      diagnostics.push(
        ...finding(
          FUNCTION_UNDECLARED_RULE,
          'error',
          `${target.path} documents the function \`${fnName}(…)\` but ${target.contractId} does not expose it`,
          target.path,
          `Remove \`${fnName}\` from the documentation, or redeploy the contract version that exports it.`,
          options.rules,
        ),
      );
    }

    // The spec exposes more than the file documents; anchors generally should
    // document their full interface. A file that names no functions at all
    // isn't making a partial promise, so only files that document *some*
    // function are held to the whole exposed surface.
    const documented = target.documentedFunctions ?? [];
    if (documented.length > 0) {
      for (const fnName of exposed) {
        if (documented.includes(fnName)) continue;
        diagnostics.push(
          ...finding(
            FUNCTION_UNDOCUMENTED_RULE,
            'info',
            `${target.contractId} exposes \`${fnName}(… )\` that ${target.path} never documents`,
            target.path,
            `Document \`${fnName}(… )\` in \`conditions\`, or drop it from the contract's interface.`,
            options.rules,
          ),
        );
      }
    }

    // A lone backticked word in `conditions` that matches an event name reads
    // as a documented event, not a function call.
    const conditions = (doc.CURRENCIES as Record<string, unknown>[] | undefined)?.find(
      (entry) => entry.contract === target.contractId,
    )?.conditions;
    if (isString(conditions)) {
      for (const word of conditions.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
        const name = word[1];
        if (name === undefined || exposedEvents.has(name) || exposed.has(name)) continue;
        diagnostics.push(
          ...finding(
            EVENT_UNDECLARED_RULE,
            'warning',
            `${target.path} documents the event \`${name}\` but ${target.contractId} does not declare it`,
            target.path,
            `Remove \`${name}\` from the documentation, or redeploy the contract version that emits it.`,
            options.rules,
          ),
        );
      }
    }

    // SEP-41 token contracts must expose `transfer` for wallets to move the
    // asset; a declared asset code with no transfer function is a client
    // dead end even when nothing else is wrong.
    if (target.assetCode !== undefined && !exposed.has('transfer')) {
      diagnostics.push(
        ...finding(
          FUNCTION_UNDECLARED_RULE,
          'warning',
          `${target.path} declares the asset ${target.assetCode} on ${target.contractId}, which does not expose \`transfer(…)\` (SEP-41)`,
          target.path,
          'Confirm the contract ID; a SEP-41 token contract exposes transfer, burn, and balance.',
          options.rules,
        ),
      );
    }

    // Interface-version drift: a contract pins the Soroban host interface it
    // was compiled against; warn once the network has moved past that protocol.
    const targetProtocol =
      metadata.envMeta.interfaceVersion === undefined
        ? undefined
        : Math.floor(metadata.envMeta.interfaceVersion / 1000);
    if (targetProtocol !== undefined) {
      const currentProtocol = await networkProtocolVersion();
      if (currentProtocol !== undefined && targetProtocol < currentProtocol) {
        diagnostics.push(
          ...finding(
            INTERFACE_VERSION_DRIFT_RULE,
            'warning',
            `${target.path} (${target.contractId}) targets Soroban protocol ${targetProtocol}, but the network runs ${currentProtocol}`,
            target.path,
            `Rebuild and redeploy the contract against protocol ${currentProtocol} so it matches the network's host interface.`,
            options.rules,
          ),
        );
      }
    }
  }

  return diagnostics;
}

/* ------------------------------------------------------------------ *
 * Rule registration (--list-rules / --off)
 * ------------------------------------------------------------------ */

/** Rule objects behind the metadata checks; `run` is empty because these are
 * async audits, mirroring the network-check convention. */
export const contractMetadataRules: Rule[] = [
  {
    id: METADATA_UNDECODABLE_RULE,
    category: 'network',
    severity: 'warning',
    description: 'A declared Soroban contract’s metadata sections cannot be fetched or decoded',
    run() {},
  },
  {
    id: FUNCTION_UNDECLARED_RULE,
    category: 'network',
    severity: 'error',
    description:
      'A function documented in stellar.toml is not exposed by the deployed contract spec',
    run() {},
  },
  {
    id: FUNCTION_UNDOCUMENTED_RULE,
    category: 'network',
    severity: 'info',
    description:
      'A deployed Soroban contract exposes functions the stellar.toml documentation omits',
    run() {},
  },
  {
    id: EVENT_UNDECLARED_RULE,
    category: 'network',
    severity: 'warning',
    description:
      'An event documented in stellar.toml is not declared by the deployed contract spec',
    run() {},
  },
  {
    id: INTERFACE_VERSION_DRIFT_RULE,
    category: 'network',
    severity: 'warning',
    description: 'A contract targets an older Soroban host interface version than the network runs',
    run() {},
  },
];
