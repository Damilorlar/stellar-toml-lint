/**
 * Builders for realistic Soroban contract fixtures: real WASM binaries with
 * real `contractspecv0`/`contractenvmetav0` custom sections, encoded with the
 * same XDR types `@stellar/stellar-base` decodes at runtime.
 *
 * The builders are deterministic — the same inputs always yield the same bytes
 * — so tests mint WASM in memory rather than committing opaque `.wasm` blobs.
 * That still hands the parser real, spec-carrying binaries with varying
 * interface definitions (the issue's ask) while letting corruption cases be
 * minted inline.
 *
 * The layout mirrors what `soroban contract build` emits: a `\\0asm` header,
 * then custom sections whose payloads are CBOR arrays of base64-encoded XDR
 * spec entries.
 */
import { xdr } from '@stellar/stellar-base';

/* ---------------- CBOR encoding (arrays of text strings only) ---------------- */

function leb128(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

/**
 * CBOR length argument: values below 24 are inlined, larger ones use the
 * 1/2/4-byte encodings of RFC 8949 §3.1.
 */
function cborArg(major: number, value: number): number[] {
  if (value < 24) return [major + value];
  if (value < 0x100) return [major + 24, value];
  if (value < 0x10000) return [major + 25, value >> 8, value & 0xff];
  return [
    major + 26,
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

/** Encodes a CBOR array of text strings — the only shape Soroban sections use. */
export function cborStringArray(strings: string[]): Uint8Array {
  const bytes: number[] = [...cborArg(0x80, strings.length)];
  for (const str of strings) {
    const encoded = new TextEncoder().encode(str);
    bytes.push(...cborArg(0x60, encoded.length), ...encoded);
  }
  return new Uint8Array(bytes);
}

/* ---------------- WASM binary assembly ---------------- */

function leb128Bytes(value: number): Uint8Array {
  return new Uint8Array(leb128(value));
}

/** Wraps payloads in a valid WASM binary as named custom sections (id 0). */
export function buildWasm(sections: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  for (const [name, payload] of Object.entries(sections)) {
    const nameBytes = new TextEncoder().encode(name);
    const body = new Uint8Array([...leb128Bytes(nameBytes.length), ...nameBytes, ...payload]);
    parts.push(new Uint8Array([0x00, ...leb128Bytes(body.length), ...body]));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const wasm = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    wasm.set(part, at);
    at += part.length;
  }
  return wasm;
}

/* ---------------- Spec entry helpers ---------------- */

const text = (s: string): Buffer => Buffer.from(s, 'utf8');

const T = xdr.ScSpecTypeDef;

export function functionEntry(
  name: string,
  doc: string,
  inputs: [string, xdr.ScSpecTypeDef][],
  outputs: xdr.ScSpecTypeDef[],
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: text(doc),
      name: text(name),
      inputs: inputs.map(
        ([inputName, inputType]) =>
          new xdr.ScSpecFunctionInputV0({ doc: text(''), name: text(inputName), type: inputType }),
      ),
      outputs,
    }),
  );
}

export function errorEnumEntry(name: string, cases: [string, number][]): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: text(''),
      lib: text(''),
      name: text(name),
      cases: cases.map(
        ([caseName, value]) =>
          new xdr.ScSpecUdtErrorEnumCaseV0({ doc: text(''), name: text(caseName), value }),
      ),
    }),
  );
}

export function eventEntry(
  name: string,
  doc: string,
  params: [string, xdr.ScSpecTypeDef, 'topic' | 'data'][],
  format: xdr.ScSpecEventDataFormat = xdr.ScSpecEventDataFormat.scSpecEventDataFormatSingleValue(),
  prefixTopics: string[] = [],
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryEventV0(
    new xdr.ScSpecEventV0({
      doc: text(doc),
      lib: text(''),
      name: text(name),
      prefixTopics: prefixTopics.map(text),
      params: params.map(
        ([paramName, paramType, location]) =>
          new xdr.ScSpecEventParamV0({
            doc: text(''),
            name: text(paramName),
            type: paramType,
            location:
              location === 'data'
                ? xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationData()
                : xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList(),
          }),
      ),
      dataFormat: format,
    }),
  );
}

export function structEntry(
  name: string,
  doc: string,
  fields: [string, xdr.ScSpecTypeDef][],
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: text(doc),
      lib: text(''),
      name: text(name),
      fields: fields.map(
        ([fieldName, fieldType]) =>
          new xdr.ScSpecUdtStructFieldV0({ doc: text(''), name: text(fieldName), type: fieldType }),
      ),
    }),
  );
}

export function unionEntry(
  name: string,
  cases: { name: string; types?: xdr.ScSpecTypeDef[] }[],
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
    new xdr.ScSpecUdtUnionV0({
      doc: text(''),
      lib: text(''),
      name: text(name),
      cases: cases.map((unionCase) =>
        unionCase.types === undefined
          ? xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(
              new xdr.ScSpecUdtUnionCaseVoidV0({ doc: text(''), name: text(unionCase.name) }),
            )
          : xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseTupleV0(
              new xdr.ScSpecUdtUnionCaseTupleV0({
                doc: text(''),
                name: text(unionCase.name),
                type: unionCase.types,
              }),
            ),
      ),
    }),
  );
}

export function enumEntry(name: string, cases: [string, number][]): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
    new xdr.ScSpecUdtEnumV0({
      doc: text(''),
      lib: text(''),
      name: text(name),
      cases: cases.map(
        ([caseName, value]) =>
          new xdr.ScSpecUdtEnumCaseV0({ doc: text(''), name: text(caseName), value }),
      ),
    }),
  );
}

/* ---------------- Ready-made contract fixtures ---------------- */

export const specSection = (entries: xdr.ScSpecEntry[]): Uint8Array =>
  cborStringArray(entries.map((entry) => entry.toXDR('base64')));

export const envMetaSection = (protocol: number): Uint8Array =>
  cborStringArray([
    xdr.ScEnvMetaEntry.scEnvMetaKindInterfaceVersion(
      new xdr.ScEnvMetaEntryInterfaceVersion({ protocol, preRelease: 0 }),
    ).toXDR('base64'),
  ]);

/**
 * A SEP-41-style token: transfer/burn/balance/mint, a custom error enum, a
 * transfer event, a balance struct — and an env meta pinned to host
 * protocol 21.
 */
export function tokenContractWasm(): Uint8Array {
  return buildWasm({
    contractenvmetav0: envMetaSection(21),
    contractspecv0: specSection([
      functionEntry(
        'transfer',
        'Transfers an amount of the token to the destination account.',
        [
          ['from', T.scSpecTypeAddress()],
          ['to', T.scSpecTypeAddress()],
          ['amount', T.scSpecTypeI128()],
        ],
        [T.scSpecTypeVal()],
      ),
      functionEntry(
        'burn',
        'Destroys an amount of the token held by the caller.',
        [['amount', T.scSpecTypeI128()]],
        [T.scSpecTypeVal()],
      ),
      functionEntry(
        'balance',
        'Returns the token balance of the given account.',
        [['id', T.scSpecTypeAddress()]],
        [T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: T.scSpecTypeI128() }))],
      ),
      functionEntry('mint', 'Mints a new amount of the token.', [], [T.scSpecTypeVal()]),
      errorEnumEntry('ContractError', [
        ['NotInitialized', 1],
        ['AlreadyInitialized', 2],
        ['InsufficientBalance', 3],
      ]),
      eventEntry('transfer', 'Emitted whenever tokens move.', [
        ['from', T.scSpecTypeAddress(), 'topic'],
        ['to', T.scSpecTypeAddress(), 'topic'],
        ['amount', T.scSpecTypeI128(), 'data'],
      ]),
      structEntry('Balance', 'An account balance pair.', [
        ['account', T.scSpecTypeAddress()],
        ['amount', T.scSpecTypeI128()],
      ]),
    ]),
  });
}

/**
 * A richer contract exercising every spec-entry kind: unions, enums, vec/map/
 * tuple/bytesN/result/udt types, and a vec-format event with a prefix topic —
 * so the renderer is covered beyond the token path.
 */
export function kitchenSinkContractWasm(): Uint8Array {
  return buildWasm({
    contractenvmetav0: envMetaSection(23),
    contractspecv0: specSection([
      functionEntry(
        'set_config',
        'Stores a configuration tuple under a symbol key.',
        [
          ['key', T.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: T.scSpecTypeSymbol() }))],
          [
            'value',
            T.scSpecTypeMap(
              new xdr.ScSpecTypeMap({
                keyType: T.scSpecTypeU32(),
                valueType: T.scSpecTypeTuple(
                  new xdr.ScSpecTypeTuple({
                    valueTypes: [T.scSpecTypeBool(), T.scSpecTypeBytes()],
                  }),
                ),
              }),
            ),
          ],
          ['digest', T.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }))],
          ['maybe', T.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: T.scSpecTypeU64() }))],
          [
            'outcome',
            T.scSpecTypeResult(
              new xdr.ScSpecTypeResult({
                okType: T.scSpecTypeI32(),
                errorType: T.scSpecTypeError(),
              }),
            ),
          ],
          ['custom', T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: text('Pair') }))],
        ],
        [T.scSpecTypeVoid()],
      ),
      unionEntry('Operation', [{ name: 'None' }, { name: 'Some', types: [T.scSpecTypeU32()] }]),
      enumEntry('Color', [
        ['Red', 0],
        ['Green', 1],
      ]),
      structEntry('Pair', 'A pair of values.', [
        ['a', T.scSpecTypeI32()],
        ['b', T.scSpecTypeI32()],
      ]),
      eventEntry(
        'update_event',
        'Batched update event.',
        [
          [
            'pairs',
            T.scSpecTypeVec(
              new xdr.ScSpecTypeVec({
                elementType: T.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: text('Pair') })),
              }),
            ),
            'data',
          ],
        ],
        xdr.ScSpecEventDataFormat.scSpecEventDataFormatVec(),
        ['contract'],
      ),
    ]),
  });
}

/** A contract carrying no metadata sections at all. */
export function bareContractWasm(): Uint8Array {
  return buildWasm({});
}
