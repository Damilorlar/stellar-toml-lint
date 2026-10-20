import { describe, expect, it } from 'vitest';
import {
  BRIDGE_CONFIG_INCOMPLETE_RULE,
  BRIDGE_OVER_RESERVED_RULE,
  BRIDGE_UNDERCOLLATERALIZED_RULE,
  BRIDGE_UNREACHABLE_RULE,
  bridgeReserveRules,
  bridgesOf,
  checkBridgeReserve,
  checkBridgeReserves,
  fetchMintedSupply,
  scaleAmount,
  stroopsFromDecimal,
} from '../src/validators/bridgeReserve.js';

const HORIZON = 'https://horizon.stellar.org';
const EVM_RPC = 'https://rpc.example.com';
const CUSTODIAN = '0x1111111111111111111111111111111111111111';

interface ChainState {
  /** Minted supply as a Horizon decimal string, e.g. "100.0000000". */
  minted?: string;
  /** Locked reserve in wei, e.g. "100000000000000000000". */
  locked?: string;
  /** Force Horizon to fail. */
  horizonDown?: boolean;
  /** Force the EVM RPC to fail. */
  evmDown?: boolean;
}

function chain(state: ChainState): typeof fetch {
  return (async (input: string | URL | globalThis.Request) => {
    const url = String(input);

    if (url.includes('/assets')) {
      if (state.horizonDown === true) throw new Error('horizon offline');
      const records =
        state.minted === undefined ? [] : [{ amount: state.minted, asset_code: 'WETH' }];
      return new Response(JSON.stringify({ _embedded: { records } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // EVM JSON-RPC.
    if (state.evmDown === true) throw new Error('evm offline');
    const result = state.locked === undefined ? '0x0' : `0x${BigInt(state.locked).toString(16)}`;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const bridgeDoc = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  CURRENCIES: [
    {
      code: 'WETH',
      issuer: 'GISSZQVY4SYSX4W5YJXUWGYHJYX4YKX4YKX4YKX4YKX4YKX4YKX4YKX',
      origin_network: 'ethereum',
      bridge_contract: CUSTODIAN,
      ...extra,
    },
  ],
});

const OPTIONS = { evmRpcUrl: EVM_RPC, horizonUrl: HORIZON };

describe('stroopsFromDecimal', () => {
  it('parses a whole decimal into stroops', () => {
    expect(stroopsFromDecimal('100')).toBe(100_0000000n);
  });

  it('parses a fractional decimal', () => {
    expect(stroopsFromDecimal('1.5')).toBe(15_000000n);
  });

  it('truncates beyond 7 decimals', () => {
    expect(stroopsFromDecimal('0.123456789')).toBe(1_234567n);
  });

  it('rejects malformed amounts', () => {
    expect(stroopsFromDecimal('abc')).toBeUndefined();
    expect(stroopsFromDecimal('')).toBeUndefined();
    expect(stroopsFromDecimal('.')).toBeUndefined();
  });
});

describe('scaleAmount', () => {
  it('scales up by multiplying', () => {
    expect(scaleAmount(1n, 7, 18)).toBe(10n ** 11n);
  });

  it('scales down by truncating division', () => {
    expect(scaleAmount(10n ** 11n, 18, 7)).toBe(1n);
  });

  it('is a no-op at equal decimals', () => {
    expect(scaleAmount(42n, 7, 7)).toBe(42n);
  });
});

describe('bridgesOf', () => {
  it('extracts entries that declare an origin network', () => {
    const bridges = bridgesOf(bridgeDoc());
    expect(bridges).toHaveLength(1);
    expect(bridges[0]).toMatchObject({
      code: 'WETH',
      originNetwork: 'ethereum',
      reserveCustodian: CUSTODIAN,
      path: 'CURRENCIES[0]',
      originDecimals: 18,
    });
  });

  it('defaults decimals to 18 and honours an override', () => {
    expect(bridgesOf(bridgeDoc())[0]?.originDecimals).toBe(18);
    expect(bridgesOf(bridgeDoc({ origin_decimals: 6 }))[0]?.originDecimals).toBe(6);
  });

  it('ignores non-bridge currency entries', () => {
    expect(bridgesOf({ CURRENCIES: [{ code: 'USD' }] })).toEqual([]);
    expect(bridgesOf({})).toEqual([]);
  });
});

describe('fetchMintedSupply', () => {
  const ISSUER = 'GISSZQVY4SYSX4W5YJXUWGYHJYX4YKX4YKX4YKX4YKX4YKX4YKX4YKX';

  const horizonWith = (records: unknown[]): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ _embedded: { records } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('filters the asset with asset_code and asset_issuer', async () => {
    let requested = '';
    const fetchImpl = (async (input: string | URL | globalThis.Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ _embedded: { records: [{ amount: '100.0000000' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    expect(await fetchMintedSupply(HORIZON, 'WETH', ISSUER, fetchImpl)).toBe(100_0000000n);
    expect(requested).toContain('/assets?asset_code=WETH');
    expect(requested).toContain(`asset_issuer=${ISSUER}`);
    // An unfiltered asset= filter would return an unrelated asset's record.
    expect(requested).not.toContain('?asset=');
  });

  it('reads a supply split across the balances buckets', async () => {
    const fetchImpl = horizonWith([
      {
        asset_code: 'WETH',
        asset_issuer: ISSUER,
        balances: {
          authorized: '60.0000000',
          authorized_to_maintain_liabilities: '0.0000000',
          unauthorized: '40.0000000',
        },
      },
    ]);
    expect(await fetchMintedSupply(HORIZON, 'WETH', ISSUER, fetchImpl)).toBe(100_0000000n);
  });

  it('returns zero for an asset that has never been issued', async () => {
    expect(await fetchMintedSupply(HORIZON, 'WETH', ISSUER, horizonWith([]))).toBe(0n);
  });

  it('fails when the record carries no readable supply', async () => {
    await expect(fetchMintedSupply(HORIZON, 'WETH', ISSUER, horizonWith([{}]))).rejects.toThrow(
      /no amount/,
    );
  });
});

describe('checkBridgeReserve', () => {
  it('is silent when locked equals minted (balanced)', async () => {
    // 100 WETH minted; 100e18 wei locked.
    const doc = bridgeDoc();
    const fetchImpl = chain({ minted: '100.0000000', locked: '100000000000000000000' });
    const [bridge] = bridgesOf(doc);
    expect(await checkBridgeReserve(bridge!, fetchImpl, OPTIONS)).toEqual([]);
  });

  it('errors when locked is less than minted (insolvent)', async () => {
    const doc = bridgeDoc();
    const fetchImpl = chain({ minted: '100.0000000', locked: '99000000000000000000' });
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(bridge!, fetchImpl, OPTIONS);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_UNDERCOLLATERALIZED_RULE, severity: 'error' }),
    );
  });

  it('detects a one-wei shortfall (no float drift)', async () => {
    const doc = bridgeDoc();
    // 1 WETH minted = 1e18 wei; locked 1 wei less.
    const fetchImpl = chain({ minted: '1.0000000', locked: '999999999999999999' });
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(bridge!, fetchImpl, OPTIONS);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_UNDERCOLLATERALIZED_RULE }),
    );
  });

  it('reports over-reserve as info', async () => {
    const doc = bridgeDoc();
    const fetchImpl = chain({ minted: '100.0000000', locked: '101000000000000000000' });
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(bridge!, fetchImpl, OPTIONS);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_OVER_RESERVED_RULE, severity: 'info' }),
    );
  });

  it('honours a shortfall tolerance', async () => {
    const doc = bridgeDoc();
    const [bridge] = bridgesOf(doc);
    // Exact 1-stroop shortfall at 18dp: minted 100 → 100e18; locked 100e18 - 1e11.
    const short = chain({
      minted: '100.0000000',
      locked: (100n * 10n ** 18n - 10n ** 11n).toString(),
    });

    // Without tolerance the shortfall is reported.
    const withoutTolerance = await checkBridgeReserve(bridge!, short, OPTIONS);
    expect(withoutTolerance).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_UNDERCOLLATERALIZED_RULE }),
    );

    // A 1-stroop tolerance absorbs exactly that shortfall.
    const withTolerance = await checkBridgeReserve(bridge!, short, {
      ...OPTIONS,
      toleranceStroops: 1n,
    });
    expect(withTolerance.filter((d) => d.rule === BRIDGE_UNDERCOLLATERALIZED_RULE)).toEqual([]);
  });

  it('flags a bridge with no custodian address', async () => {
    const doc: Record<string, unknown> = {
      CURRENCIES: [{ code: 'WETH', issuer: 'GISS', origin_network: 'ethereum' }],
    };
    const diagnostics = await checkBridgeReserves(doc, chain({}), OPTIONS);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_CONFIG_INCOMPLETE_RULE, severity: 'warning' }),
    );
  });

  it('warns when Horizon is unreachable', async () => {
    const doc = bridgeDoc();
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(bridge!, chain({ horizonDown: true }), OPTIONS);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_UNREACHABLE_RULE, severity: 'warning' }),
    );
  });

  it('warns when the EVM RPC is unreachable', async () => {
    const doc = bridgeDoc();
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(
      bridge!,
      chain({ minted: '100.0000000', evmDown: true }),
      OPTIONS,
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: BRIDGE_UNREACHABLE_RULE }));
  });

  it('warns when no EVM RPC endpoint is configured', async () => {
    const doc = bridgeDoc();
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(bridge!, chain({ minted: '100.0000000' }), {
      horizonUrl: HORIZON,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: BRIDGE_UNREACHABLE_RULE }));
  });

  it('treats an unissued asset as zero minted supply', async () => {
    const doc = bridgeDoc();
    const [bridge] = bridgesOf(doc);
    // No records → 0 minted; locked 1 ETH → over-reserved.
    const diagnostics = await checkBridgeReserve(
      bridge!,
      chain({ locked: '1000000000000000000' }),
      OPTIONS,
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_OVER_RESERVED_RULE }),
    );
  });

  it('honours --off overrides', async () => {
    const doc = bridgeDoc();
    const [bridge] = bridgesOf(doc);
    const diagnostics = await checkBridgeReserve(
      bridge!,
      chain({ minted: '100.0000000', locked: '1' }),
      { ...OPTIONS, rules: { [BRIDGE_UNDERCOLLATERALIZED_RULE]: 'off' } },
    );
    expect(diagnostics.filter((d) => d.rule === BRIDGE_UNDERCOLLATERALIZED_RULE)).toEqual([]);
  });
});

describe('checkBridgeReserves', () => {
  it('audits every bridge and is silent with none', async () => {
    expect(await checkBridgeReserves({}, chain({}), OPTIONS)).toEqual([]);
  });

  it('scales a non-18-decimal bridge correctly', async () => {
    // USDC-style 6-decimal origin. 100 minted on Stellar (7dp) = 100e6 at 6dp.
    const doc: Record<string, unknown> = {
      CURRENCIES: [
        {
          code: 'USDC',
          issuer: 'GISS',
          origin_network: 'polygon',
          bridge_contract: CUSTODIAN,
          origin_decimals: 6,
        },
      ],
    };
    // 100 USDC locked at 6dp = 100_000000.
    const balanced = chain({ minted: '100.0000000', locked: '100000000' });
    expect(await checkBridgeReserves(doc, balanced, OPTIONS)).toEqual([]);

    // 99 locked → insolvent.
    const short = chain({ minted: '100.0000000', locked: '99000000' });
    const diagnostics = await checkBridgeReserves(doc, short, OPTIONS);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: BRIDGE_UNDERCOLLATERALIZED_RULE }),
    );
  });
});

describe('bridgeReserveRules', () => {
  it('registers every emitted rule id', () => {
    expect(bridgeReserveRules.map((r) => ({ id: r.id, severity: r.severity }))).toEqual([
      { id: BRIDGE_UNDERCOLLATERALIZED_RULE, severity: 'error' },
      { id: BRIDGE_OVER_RESERVED_RULE, severity: 'info' },
      { id: BRIDGE_UNREACHABLE_RULE, severity: 'warning' },
      { id: BRIDGE_CONFIG_INCOMPLETE_RULE, severity: 'warning' },
    ]);
  });
});
