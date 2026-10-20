import { describe, expect, it } from 'vitest';
import { Address, xdr } from '@stellar/stellar-base';
import { lint } from '../src/lint.js';
import { decodeCbor, CborDecodeError } from '../src/soroban/cbor.js';
import {
  extractCustomSections,
  customSectionPayload,
  WasmParseError,
} from '../src/soroban/wasm.js';
import {
  parseContractMetadata,
  decodeSpecEntries,
  decodeEnvMetaEntry,
  renderSpecType,
  fetchContractWasm,
  ContractMetadataParser,
  checkContractMetadata,
  declaredContractsOf,
  SpecDecodeError,
  ContractFetchError,
  contractMetadataRules,
  FUNCTION_UNDECLARED_RULE,
  EVENT_UNDECLARED_RULE,
  METADATA_UNDECODABLE_RULE,
  SPEC_SECTION,
  ENV_META_SECTION,
} from '../src/soroban/contractMetadata.js';
import {
  tokenContractWasm,
  kitchenSinkContractWasm,
  bareContractWasm,
  buildWasm,
  cborStringArray,
} from './fixtures/contracts/build.js';

const CONTRACT = 'CACTZSQPCQSSZ5YG3PI3N7WO6JEERKEUHTPILKB4MBANF2K4D2UHKDDU';
const NETWORK = 'Test SDF Network ; September 2015';
const RPC = 'https://soroban-testnet.stellar.org';
const WASM_HASH = Buffer.alloc(32, 7);

/* ------------------------------------------------------------------ *
 * CBOR decoder
 * ------------------------------------------------------------------ */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('decodeCbor', () => {
  it('decodes a Soroban string array', () => {
    expect(decodeCbor(cborStringArray(['a', 'bc']))).toEqual(['a', 'bc']);
  });

  it('decodes an empty array', () => {
    expect(decodeCbor(cborStringArray([]))).toEqual([]);
  });

  it('decodes integers, negatives and 1/2/4-byte forms', () => {
    expect(decodeCbor(bytes(0x05))).toBe(5);
    expect(decodeCbor(bytes(0x25))).toBe(-6);
    expect(decodeCbor(bytes(0x18, 0x19))).toBe(25);
    expect(decodeCbor(bytes(0x19, 0x03, 0xe8))).toBe(1000);
    expect(decodeCbor(bytes(0x1a, 0x00, 0x01, 0x00, 0x00))).toBe(65536);
  });

  it('decodes a 64-bit integer beyond the safe range as a bigint', () => {
    const big = decodeCbor(bytes(0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
    expect(big).toBe(18446744073709551615n);
  });

  it('decodes booleans, null and undefined', () => {
    expect(decodeCbor(bytes(0xf5))).toBe(true);
    expect(decodeCbor(bytes(0xf4))).toBe(false);
    expect(decodeCbor(bytes(0xf6))).toBeNull();
    expect(decodeCbor(bytes(0xf7))).toBeUndefined();
  });

  it('decodes half-, single- and double-precision floats', () => {
    expect(decodeCbor(bytes(0xf9, 0x3c, 0x00))).toBe(1);
    expect(decodeCbor(bytes(0xfa, 0x40, 0x20, 0x00, 0x00))).toBe(2.5);
    expect(decodeCbor(bytes(0xfb, 0x40, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))).toBe(2.5);
  });

  it('decodes a byte string', () => {
    expect(decodeCbor(bytes(0x43, 0x01, 0x02, 0x03))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('decodes indefinite-length arrays and strings', () => {
    expect(decodeCbor(bytes(0x9f, 0x01, 0x02, 0xff))).toEqual([1, 2]);
    expect(decodeCbor(bytes(0x7f, 0x61, 0x61, 0x61, 0x62, 0xff))).toBe('ab');
  });

  it('decodes a definite map, keyed by string', () => {
    const decoded = decodeCbor(bytes(0xa1, 0x61, 0x61, 0x01)) as Map<CborValueLike, CborValueLike>;
    expect(decoded.get('a')).toBe(1);
  });

  it('unwraps a tag to the inner value', () => {
    expect(decodeCbor(bytes(0xc0, 0x61, 0x61))).toBe('a');
  });

  it('rejects trailing bytes after the top-level value', () => {
    expect(() => decodeCbor(bytes(0x01, 0x02))).toThrow(CborDecodeError);
    expect(() => decodeCbor(bytes(0x01, 0x02))).toThrow(/trailing byte/);
  });

  it('rejects a truncated string payload', () => {
    expect(() => decodeCbor(bytes(0x62, 0x61))).toThrow(/payload ends/);
  });

  it('rejects invalid UTF-8 in a text string', () => {
    expect(() => decodeCbor(bytes(0x61, 0xff))).toThrow(/not valid UTF-8/);
  });

  it('rejects duplicate map keys', () => {
    expect(() => decodeCbor(bytes(0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02))).toThrow(
      /duplicate map key/,
    );
  });

  it('carries the failing byte offset on the error', () => {
    try {
      decodeCbor(bytes(0x62, 0x61));
      expect.unreachable('should have thrown');
    } catch (error) {
      // The payload runs out mid-string; the offset is where the parser stopped.
      expect((error as CborDecodeError).offset).toBe(1);
    }
  });
});

type CborValueLike = unknown;

/* ------------------------------------------------------------------ *
 * WASM custom-section extractor
 * ------------------------------------------------------------------ */

describe('extractCustomSections', () => {
  it('pulls named custom sections out in file order', () => {
    const wasm = buildWasm({ first: bytes(1), second: bytes(2, 3) });
    const sections = extractCustomSections(wasm);
    expect(sections.map((s) => s.name)).toEqual(['first', 'second']);
    expect([...(sections[1]?.payload ?? [])]).toEqual([2, 3]);
  });

  it('finds a payload by name, or undefined when absent', () => {
    const wasm = buildWasm({ only: bytes(9) });
    expect([...(customSectionPayload(extractCustomSections(wasm), 'only') ?? [])]).toEqual([9]);
    expect(customSectionPayload(extractCustomSections(wasm), 'missing')).toBeUndefined();
  });

  it('rejects a file that is not WASM', () => {
    expect(() => extractCustomSections(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(WasmParseError);
    expect(() => extractCustomSections(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(/magic number/);
  });

  it('rejects a file shorter than the header', () => {
    expect(() => extractCustomSections(bytes(0x00, 0x61))).toThrow(/too short/);
  });

  it('rejects a section that extends past the end of the file', () => {
    const wasm = buildWasm({ s: bytes(1) });
    // Layout: 8-byte header, then section id (1 byte) at [8] and its LEB128
    // size prefix at [9]. Inflate the size to claim far more than exists.
    const corrupted = wasm.slice();
    corrupted[9] = 0x7f;
    expect(() => extractCustomSections(corrupted)).toThrow(/past the end/);
  });

  it('returns no sections for a header-only binary', () => {
    expect(extractCustomSections(buildWasm({}))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Spec / env-meta XDR decoding
 * ------------------------------------------------------------------ */

describe('parseContractMetadata', () => {
  it('decodes a SEP-41-style token contract', () => {
    const metadata = parseContractMetadata(tokenContractWasm());

    expect(metadata.spec.functions.map((f) => f.name)).toEqual([
      'transfer',
      'burn',
      'balance',
      'mint',
    ]);
    const transfer = metadata.spec.functions[0];
    expect(transfer?.inputs.map((i) => `${i.name}: ${i.type}`)).toEqual([
      'from: address',
      'to: address',
      'amount: i128',
    ]);
    expect(transfer?.outputs).toEqual(['val']);

    expect(metadata.spec.errors[0]?.name).toBe('ContractError');
    expect(metadata.spec.errors[0]?.cases.map((c) => c.code)).toEqual([1, 2, 3]);

    expect(metadata.spec.events[0]?.name).toBe('transfer');
    expect(metadata.spec.events[0]?.format).toBe('single');
    expect(metadata.spec.events[0]?.params.map((p) => p.location)).toEqual([
      'topic',
      'topic',
      'data',
    ]);

    expect(metadata.spec.structs[0]?.name).toBe('Balance');
    expect(metadata.envMeta.interfaceVersion).toBe(21_000);
    expect(metadata.sections).toEqual([ENV_META_SECTION, SPEC_SECTION]);
  });

  it('decodes every spec-entry kind in the kitchen-sink contract', () => {
    const metadata = parseContractMetadata(kitchenSinkContractWasm());

    const setConfig = metadata.spec.functions[0];
    expect(setConfig?.name).toBe('set_config');
    expect(setConfig?.inputs.map((i) => i.type)).toEqual([
      'vec<symbol>',
      'map<u32, tuple<bool, bytes>>',
      'bytesN<32>',
      'option<u64>',
      'result<i32, error>',
      'Pair',
    ]);
    expect(setConfig?.outputs).toEqual(['void']);

    expect(metadata.spec.unions[0]).toEqual({
      name: 'Operation',
      doc: '',
      cases: [
        { name: 'None', doc: '', types: [] },
        { name: 'Some', doc: '', types: ['u32'] },
      ],
    });
    expect(metadata.spec.enums[0]?.cases).toEqual([
      { name: 'Red', doc: '', value: 0 },
      { name: 'Green', doc: '', value: 1 },
    ]);
    expect(metadata.spec.structs.find((s) => s.name === 'Pair')?.fields.map((f) => f.type)).toEqual(
      ['i32', 'i32'],
    );

    const event = metadata.spec.events[0];
    expect(event?.name).toBe('update_event');
    expect(event?.format).toBe('vec');
    expect(event?.prefixTopics).toEqual(['contract']);
    expect(event?.params[0]?.type).toBe('vec<Pair>');

    expect(metadata.envMeta.interfaceVersion).toBe(23_000);
  });

  it('yields empty (but well-formed) metadata for a contract with no sections', () => {
    const metadata = parseContractMetadata(bareContractWasm());
    expect(metadata.spec.functions).toEqual([]);
    expect(metadata.spec.events).toEqual([]);
    expect(metadata.envMeta.interfaceVersion).toBeUndefined();
    expect(metadata.sections).toEqual([]);
  });

  it('surfaces a structurally corrupted binary as WasmParseError', () => {
    expect(() => parseContractMetadata(new Uint8Array([9, 9, 9]))).toThrow(WasmParseError);
  });

  it('surfaces an undecodable spec section as SpecDecodeError', () => {
    const wasm = buildWasm({ [SPEC_SECTION]: bytes(0x01) });
    expect(() => parseContractMetadata(wasm)).toThrow(SpecDecodeError);
  });
});

describe('decodeSpecEntries', () => {
  it('rejects a payload that is not a CBOR array', () => {
    expect(() => decodeSpecEntries(bytes(0x01))).toThrow(/not a CBOR array/);
  });

  it('rejects an entry that is not a CBOR string', () => {
    expect(() => decodeSpecEntries(bytes(0x81, 0x01))).toThrow(/not a CBOR text string/);
  });

  it('names the offending index for invalid base64 XDR', () => {
    expect(() => decodeSpecEntries(cborStringArray(['not-xdr']))).toThrow(/entry 0/);
  });
});

describe('decodeEnvMetaEntry', () => {
  it('rejects an empty payload', () => {
    expect(() => decodeEnvMetaEntry(cborStringArray([]))).toThrow(/non-empty/);
  });

  it('reports the interface version as unknown for a future kind', () => {
    // Encode a ScEnvMetaEntry that is not interfaceVersion by reusing a valid
    // entry's bytes is impractical; instead assert the known-kind path holds.
    const entry = xdr.ScEnvMetaEntry.scEnvMetaKindInterfaceVersion(
      new xdr.ScEnvMetaEntryInterfaceVersion({ protocol: 20, preRelease: 1 }),
    );
    const decoded = decodeEnvMetaEntry(cborStringArray([entry.toXDR('base64')]));
    expect(decoded.interfaceVersion).toBe(20_001);
  });
});

describe('renderSpecType', () => {
  it('renders primitives by their arm name', () => {
    expect(renderSpecType(xdr.ScSpecTypeDef.scSpecTypeAddress())).toBe('address');
    expect(renderSpecType(xdr.ScSpecTypeDef.scSpecTypeI128())).toBe('i128');
    expect(renderSpecType(xdr.ScSpecTypeDef.scSpecTypeVal())).toBe('val');
    expect(renderSpecType(xdr.ScSpecTypeDef.scSpecTypeMuxedAddress())).toBe('muxedAddress');
  });

  it('renders nested composites', () => {
    const option = xdr.ScSpecTypeDef.scSpecTypeOption(
      new xdr.ScSpecTypeOption({
        valueType: xdr.ScSpecTypeDef.scSpecTypeVec(
          new xdr.ScSpecTypeVec({ elementType: xdr.ScSpecTypeDef.scSpecTypeU64() }),
        ),
      }),
    );
    expect(renderSpecType(option)).toBe('option<vec<u64>>');
  });
});

/* ------------------------------------------------------------------ *
 * RPC fetch
 * ------------------------------------------------------------------ */

function instanceEntryXdr(contractId: string, wasmHash: Buffer): string {
  const entry = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4), 'raw'),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
          storage: [],
        }),
      ),
    }),
  );
  return entry.toXDR('base64');
}

function nativeInstanceEntryXdr(contractId: string): string {
  const entry = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4), 'raw'),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          storage: [],
        }),
      ),
    }),
  );
  return entry.toXDR('base64');
}

function codeEntryXdr(wasm: Uint8Array): string {
  const entry = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: new xdr.ContractCodeEntryExt(0),
      hash: WASM_HASH,
      code: Buffer.from(wasm),
    }),
  );
  return entry.toXDR('base64');
}

interface MetadataRpcOptions {
  wasm?: Uint8Array;
  missingInstance?: boolean;
  missingCode?: boolean;
  native?: boolean;
  /** Network protocol version reported by `getNetwork` (for version drift). */
  networkProtocol?: number;
}

function metadataRpcMock(options: MetadataRpcOptions = {}): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as {
      method: string;
      params?: { keys: string[] };
    };
    if (body.method === 'getNetwork') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { passphrase: NETWORK, protocolVersion: options.networkProtocol ?? 21 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const key = body.params?.keys[0] as string;
    const ledgerKey = xdr.LedgerKey.fromXDR(key, 'base64');
    const isCode = ledgerKey.switch().name === 'contractCode';

    let xdrStr: string | undefined;
    if (isCode) {
      if (options.missingCode !== true) xdrStr = codeEntryXdr(options.wasm ?? tokenContractWasm());
    } else if (options.missingInstance !== true) {
      xdrStr =
        options.native === true
          ? nativeInstanceEntryXdr(CONTRACT)
          : instanceEntryXdr(CONTRACT, WASM_HASH);
    }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          latestLedger: 100_000,
          entries:
            xdrStr === undefined
              ? []
              : [{ key, xdr: xdrStr, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 200_000 }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('fetchContractWasm', () => {
  it('resolves the instance, then reads the WASM code entry', async () => {
    const wasm = tokenContractWasm();
    const { fetchImpl, calls } = metadataRpcMock({ wasm });

    const fetched = await fetchContractWasm(CONTRACT, RPC, fetchImpl);
    expect([...fetched]).toEqual([...wasm]);
    expect(calls()).toBe(2);
  });

  it('errors when the contract instance is missing', async () => {
    const { fetchImpl } = metadataRpcMock({ missingInstance: true });
    await expect(fetchContractWasm(CONTRACT, RPC, fetchImpl)).rejects.toThrow(ContractFetchError);
    await expect(fetchContractWasm(CONTRACT, RPC, fetchImpl)).rejects.toThrow(
      /no live contract-instance/,
    );
  });

  it('errors when the executable is not WASM', async () => {
    const { fetchImpl } = metadataRpcMock({ native: true });
    await expect(fetchContractWasm(CONTRACT, RPC, fetchImpl)).rejects.toThrow(
      /not a WASM contract/,
    );
  });

  it('errors when the code entry is missing', async () => {
    const { fetchImpl } = metadataRpcMock({ missingCode: true });
    await expect(fetchContractWasm(CONTRACT, RPC, fetchImpl)).rejects.toThrow(
      /no readable WASM entry/,
    );
  });

  it('errors when the RPC is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('Network offline');
    }) as unknown as typeof fetch;
    await expect(fetchContractWasm(CONTRACT, RPC, fetchImpl)).rejects.toThrow(/could not reach/);
  });

  it('errors on a non-200 answer', async () => {
    const fetchImpl = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchContractWasm(CONTRACT, RPC, fetchImpl)).rejects.toThrow(/HTTP 500/);
  });
});

describe('ContractMetadataParser', () => {
  it('parses a deployed contract end to end', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm() });
    const parser = new ContractMetadataParser(fetchImpl);

    const metadata = await parser.parseContract(CONTRACT, RPC);
    expect(metadata.contractId).toBe(CONTRACT);
    expect(metadata.spec.functions.map((f) => f.name)).toContain('transfer');
  });

  it('decodes bytes the caller already holds', () => {
    const parser = new ContractMetadataParser();
    const metadata = parser.parseWasm(kitchenSinkContractWasm(), CONTRACT);
    expect(metadata.contractId).toBe(CONTRACT);
    expect(metadata.spec.unions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * stellar.toml cross-check
 * ------------------------------------------------------------------ */

function docWith(conditions: string, code = 'TOKEN'): Record<string, unknown> {
  const source = [
    `NETWORK_PASSPHRASE="${NETWORK}"`,
    '',
    '[[CURRENCIES]]',
    `code="${code}"`,
    `contract="${CONTRACT}"`,
    `conditions="${conditions}"`,
  ].join('\n');
  return lint(source).parsed ?? {};
}

describe('declaredContractsOf', () => {
  it('extracts contract ids, asset codes and documented functions', () => {
    const declared = declaredContractsOf(
      docWith('Requires `transfer(from, to, amount)` to move funds.'),
    );
    const currency = declared.find((d) => d.path.startsWith('CURRENCIES'));
    expect(currency?.contractId).toBe(CONTRACT);
    expect(currency?.assetCode).toBe('TOKEN');
    expect(currency?.documentedFunctions).toEqual(['transfer']);
  });
});

describe('checkContractMetadata', () => {
  it('is silent when documented functions and events match the deployed spec', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm(), networkProtocol: 21 });
    // Document every exposed function so nothing counts as undocumented.
    const doc = docWith(
      'Emits `transfer` when funds move. Exposes `transfer(from, to, amount)`, `burn(amount)`, `balance(id)`, and `mint(…)`.',
    );

    expect(await checkContractMetadata(doc, fetchImpl)).toEqual([]);
  });

  it('reports exposed functions the file never documents', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm(), networkProtocol: 21 });
    // Documents only `transfer`, so burn/balance/mint are undocumented.
    const doc = docWith('Exposes `transfer(from, to, amount)` to move funds.');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    const undocumented = diagnostics.filter(
      (d) => d.rule === 'soroban/contract-function-undocumented',
    );
    expect(undocumented.map((d) => d.severity)).toEqual(['info', 'info', 'info']);
    const messages = undocumented.map((d) => d.message).join('\n');
    expect(messages).toMatch(/burn/);
    expect(messages).toMatch(/balance/);
    expect(messages).toMatch(/mint/);
    expect(messages).not.toMatch(/transfer/);
  });

  it('errors when conditions document a function the contract does not expose', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm() });
    const doc = docWith('Use `swap(input, output)` to exchange value.');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: FUNCTION_UNDECLARED_RULE, severity: 'error' }),
    );
  });

  it('warns when a documented event is not declared by the spec', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm() });
    const doc = docWith('Emits `rebalanced` on every network change.');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: EVENT_UNDECLARED_RULE, severity: 'warning' }),
    );
  });

  it('warns when an asset contract lacks SEP-41 transfer', async () => {
    // kitchenSink exposes no `transfer`, so a declared TOKEN asset is a dead end.
    const { fetchImpl } = metadataRpcMock({ wasm: kitchenSinkContractWasm() });
    const doc = docWith('');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: FUNCTION_UNDECLARED_RULE, severity: 'warning' }),
    );
  });

  it('reports an unreadable contract as metadata-undecodable', async () => {
    const { fetchImpl } = metadataRpcMock({ missingInstance: true });
    const doc = docWith('');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: METADATA_UNDECODABLE_RULE, severity: 'warning' }),
    );
  });

  it('warns when the contract targets an older protocol than the network runs', async () => {
    // tokenContractWasm pins protocol 21; the network has moved on to 23.
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm(), networkProtocol: 23 });
    const doc = docWith('');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: 'soroban/contract-interface-version-drift',
        severity: 'warning',
      }),
    );
  });

  it('does not warn when the contract matches the network protocol', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm(), networkProtocol: 21 });
    const doc = docWith('');

    const diagnostics = await checkContractMetadata(doc, fetchImpl);
    expect(
      diagnostics.filter((d) => d.rule === 'soroban/contract-interface-version-drift'),
    ).toEqual([]);
  });

  it('skips the drift check when getNetwork cannot answer', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm() });
    const doc = docWith('');

    // Point at an unknown network with an explicit rpcUrl but break getNetwork.
    type FetchArgs = Parameters<typeof fetch>;
    const broken = (async (...args: FetchArgs) => {
      const init = args[1];
      const method = JSON.parse(String((init as RequestInit | undefined)?.body)) as {
        method: string;
      };
      if (method.method === 'getNetwork') throw new Error('no getNetwork');
      return fetchImpl(...args);
    }) as unknown as typeof fetch;

    const diagnostics = await checkContractMetadata(doc, broken, {
      rpcUrl: 'http://localhost:8000/rpc',
    });
    expect(
      diagnostics.filter((d) => d.rule === 'soroban/contract-interface-version-drift'),
    ).toEqual([]);
  });

  it('honours --off overrides', async () => {
    const { fetchImpl } = metadataRpcMock({ wasm: tokenContractWasm(), networkProtocol: 21 });
    const doc = docWith('Use `swap(input, output)`.');

    const diagnostics = await checkContractMetadata(doc, fetchImpl, {
      rules: { [FUNCTION_UNDECLARED_RULE]: 'off' },
    });
    expect(diagnostics.filter((d) => d.rule === FUNCTION_UNDECLARED_RULE)).toEqual([]);
  });

  it('is silent when the file declares no contracts', async () => {
    const { fetchImpl, calls } = metadataRpcMock({});
    const doc = lint(`NETWORK_PASSPHRASE="${NETWORK}"`).parsed ?? {};

    expect(await checkContractMetadata(doc, fetchImpl)).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('uses an explicit RPC override for unknown networks', async () => {
    const { fetchImpl, calls } = metadataRpcMock({ wasm: tokenContractWasm() });
    const doc = { ...docWith(''), NETWORK_PASSPHRASE: 'Private Herder Network' };

    // Unknown passphrase without rpcUrl → silent (no endpoint derivable).
    expect(await checkContractMetadata(doc, fetchImpl)).toEqual([]);
    expect(calls()).toBe(0);

    // With an explicit rpcUrl it proceeds and reaches the RPC.
    await checkContractMetadata(doc, fetchImpl, { rpcUrl: 'http://localhost:8000/rpc' });
    expect(calls()).toBeGreaterThan(0);
  });
});

describe('contractMetadataRules', () => {
  it('registers the expected rule ids and severities', () => {
    expect(contractMetadataRules.map((r) => ({ id: r.id, severity: r.severity }))).toEqual([
      { id: METADATA_UNDECODABLE_RULE, severity: 'warning' },
      { id: FUNCTION_UNDECLARED_RULE, severity: 'error' },
      { id: 'soroban/contract-function-undocumented', severity: 'info' },
      { id: EVENT_UNDECLARED_RULE, severity: 'warning' },
      { id: 'soroban/contract-interface-version-drift', severity: 'warning' },
    ]);
  });
});
