import { describe, expect, it } from 'vitest';
import {
  ILLIQUID_RULE,
  NO_ROUTE_RULE,
  ORPHANED_RULE,
  UNREACHABLE_RULE,
  corridorRoutingRules,
  corridorsOf,
  analyzeCorridor,
  checkCorridorRouting,
  checkOneCorridor,
  describeAsset,
  strictSendUrl,
} from '../src/corridors/routingVerifier.js';

const HORIZON = 'https://horizon.stellar.org';

const USD = { code: 'USD', issuer: 'GISSUSDISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
const EUR = { code: 'EUR', issuer: 'GISSEURISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
const NATIVE = { code: 'native' };

interface PathOptions {
  /** destination_amount for each standard amount key, e.g. { 10: 9.9 }. */
  amounts?: Record<number, number>;
  /** Force Horizon to throw. */
  down?: boolean;
  /** Number of path records to return per query. */
  paths?: number;
  /** Force a non-200 status. */
  status?: number;
}

function horizon(options: PathOptions = {}): typeof fetch {
  return (async (input: string | URL | globalThis.Request) => {
    const url = String(input);
    if (options.down === true) throw new Error('horizon offline');
    if (options.status !== undefined && options.status !== 200) {
      return new Response('nope', { status: options.status });
    }

    const amountMatch = /source_amount=(\d+)/.exec(url);
    const amount = Number(amountMatch?.[1] ?? 0);
    const destinationAmount = options.amounts?.[amount];
    const pathCount = options.paths ?? 1;

    const records =
      destinationAmount === undefined
        ? []
        : Array.from({ length: pathCount }, () => ({
            destination_amount: String(destinationAmount),
            source_amount: String(amount),
            path: [],
          }));

    return new Response(JSON.stringify({ _embedded: { records } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const docWith = (currencies: Record<string, unknown>[]): Record<string, unknown> => ({
  CURRENCIES: currencies,
});

const usdEntry = { code: 'USD', issuer: USD.issuer };
const eurEntry = { code: 'EUR', issuer: EUR.issuer };

describe('describeAsset', () => {
  it('renders native and issued assets', () => {
    expect(describeAsset(NATIVE)).toBe('native');
    expect(describeAsset(USD)).toBe(`USD:${USD.issuer}`);
  });
});

describe('strictSendUrl', () => {
  it('builds a strict-send query for an issued source and dest', () => {
    const url = strictSendUrl(HORIZON, USD, EUR, 100);
    expect(url).toContain('/paths/strict-send?');
    expect(url).toContain('source_asset_type=credit_alphanum4');
    expect(url).toContain(`source_asset_code=USD`);
    expect(url).toContain(`source_asset_issuer=${USD.issuer}`);
    expect(url).toContain('source_amount=100');
    // Horizon wants the destination as a destination_assets label list.
    expect(url).toContain(`destination_assets=${encodeURIComponent(`EUR:${EUR.issuer}`)}`);
    expect(url).not.toContain('destination_asset_code=');
  });

  it('uses asset_type=native for XLM', () => {
    const url = strictSendUrl(HORIZON, NATIVE, USD, 10);
    expect(url).toContain('source_asset_type=native');
    expect(url).toContain(`destination_assets=${encodeURIComponent(`USD:${USD.issuer}`)}`);
    expect(url).not.toContain('source_asset_code');
  });
});

describe('corridorsOf', () => {
  it('derives ordered pairs across declared classic assets', () => {
    const corridors = corridorsOf(docWith([usdEntry, eurEntry]));
    expect(corridors).toHaveLength(2); // USD→EUR and EUR→USD
    expect(corridors[0]).toMatchObject({ sourceIndex: 0, destIndex: 1 });
    expect(corridors[1]).toMatchObject({ sourceIndex: 1, destIndex: 0 });
  });

  it('includes native assets', () => {
    const corridors = corridorsOf(docWith([usdEntry, { code: 'native' }]));
    expect(corridors).toHaveLength(2);
  });

  it('skips toml pointers and contract-only entries', () => {
    expect(
      corridorsOf(
        docWith([
          { code: 'X', toml: 'https://x.example.com' },
          { code: 'Y', contract: 'CABC' },
        ]),
      ),
    ).toEqual([]);
  });

  it('is empty with fewer than two classic assets', () => {
    expect(corridorsOf(docWith([usdEntry]))).toEqual([]);
    expect(corridorsOf({})).toEqual([]);
  });

  it('caps the auto-derived corridor count', () => {
    // 8 assets → 56 ordered pairs, capped at 24.
    const many = Array.from({ length: 8 }, (_, i) => ({
      code: `A${i}`,
      issuer: `GISS${i}ISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    }));
    expect(corridorsOf(docWith(many)).length).toBeLessThanOrEqual(24);
  });
});

describe('analyzeCorridor', () => {
  it('reports a flat, fully-covered corridor with high score', async () => {
    const report = await analyzeCorridor(
      { source: USD, dest: EUR, sourceIndex: 0, destIndex: 1 },
      HORIZON,
      horizon({ amounts: { 10: 9.9, 100: 99, 1000: 990 } }),
    );
    expect(report?.routable).toBe(true);
    expect(report?.routableAmounts).toEqual([10, 100, 1000]);
    expect(report?.slippage).toBeCloseTo(0, 5);
    expect(report?.score).toBeGreaterThan(0.9);
  });

  it('reports steep rate degradation as high slippage', async () => {
    const report = await analyzeCorridor(
      { source: USD, dest: EUR, sourceIndex: 0, destIndex: 1 },
      HORIZON,
      horizon({ amounts: { 10: 10, 100: 80, 1000: 500 } }),
    );
    expect(report?.routable).toBe(true);
    expect(report?.slippage).toBeCloseTo(0.5, 5); // 500/1000=0.5 vs 10/10=1.0
    expect(report?.score).toBeLessThan(0.8);
  });

  it('reports an unroutable corridor', async () => {
    const report = await analyzeCorridor(
      { source: USD, dest: EUR, sourceIndex: 0, destIndex: 1 },
      HORIZON,
      horizon({ amounts: {} }),
    );
    expect(report?.routable).toBe(false);
    expect(report?.score).toBe(0);
  });

  it('returns undefined when Horizon is unreachable at every amount', async () => {
    const report = await analyzeCorridor(
      { source: USD, dest: EUR, sourceIndex: 0, destIndex: 1 },
      HORIZON,
      horizon({ down: true }),
    );
    expect(report).toBeUndefined();
  });

  it('counts path redundancy as depth', async () => {
    const report = await analyzeCorridor(
      { source: USD, dest: EUR, sourceIndex: 0, destIndex: 1 },
      HORIZON,
      horizon({ amounts: { 10: 9.9, 100: 99, 1000: 990 }, paths: 3 }),
    );
    expect(report?.depth).toBe(9); // 3 paths × 3 amounts
  });
});

describe('checkCorridorRouting', () => {
  it('is silent for a healthy corridor', async () => {
    const doc = docWith([usdEntry, eurEntry]);
    const diagnostics = await checkCorridorRouting(
      doc,
      horizon({ amounts: { 10: 9.9, 100: 99, 1000: 990 } }),
      {
        horizonUrl: HORIZON,
      },
    );
    expect(diagnostics).toEqual([]);
  });

  it('errors on an unroutable corridor', async () => {
    const doc = docWith([usdEntry, eurEntry]);
    const diagnostics = await checkCorridorRouting(doc, horizon({ amounts: {} }), {
      horizonUrl: HORIZON,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: NO_ROUTE_RULE, severity: 'error' }),
    );
  });

  it('warns on an illiquid corridor', async () => {
    const doc = docWith([usdEntry, eurEntry]);
    const diagnostics = await checkCorridorRouting(
      doc,
      horizon({ amounts: { 10: 10, 100: 80, 1000: 500 } }),
      {
        horizonUrl: HORIZON,
      },
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: ILLIQUID_RULE, severity: 'warning' }),
    );
  });

  it('warns when only part of the amount ladder routes', async () => {
    const doc = docWith([usdEntry, eurEntry]);
    // Only $10 routes.
    const diagnostics = await checkCorridorRouting(doc, horizon({ amounts: { 10: 9.9 } }), {
      horizonUrl: HORIZON,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: ILLIQUID_RULE }));
  });

  it('warns once when Horizon is unreachable', async () => {
    const doc = docWith([usdEntry, eurEntry]);
    const diagnostics = await checkCorridorRouting(doc, horizon({ down: true }), {
      horizonUrl: HORIZON,
    });
    const unreachable = diagnostics.filter((d) => d.rule === UNREACHABLE_RULE);
    expect(unreachable).toHaveLength(1);
  });

  it('flags an orphaned asset with no viable corridor', async () => {
    // USD↔EUR route fine; XYZ pairs with nothing (mock returns no paths for it).
    const xyzEntry = { code: 'XYZ', issuer: 'GISSXYZISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    const doc = docWith([usdEntry, eurEntry, xyzEntry]);
    const fetchImpl = (async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      const isXyz = url.includes('XYZ');
      const amountMatch = /source_amount=(\d+)/.exec(url);
      const amount = Number(amountMatch?.[1] ?? 0);
      const destinationAmount = isXyz ? undefined : amount * 0.99;
      const records =
        destinationAmount === undefined ? [] : [{ destination_amount: String(destinationAmount) }];
      return new Response(JSON.stringify({ _embedded: { records } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const diagnostics = await checkCorridorRouting(doc, fetchImpl, { horizonUrl: HORIZON });
    const orphaned = diagnostics.filter((d) => d.rule === ORPHANED_RULE);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.path).toBe('CURRENCIES[2].code');
  });

  it('is silent with fewer than two classic assets', async () => {
    expect(
      await checkCorridorRouting(docWith([usdEntry]), horizon({}), { horizonUrl: HORIZON }),
    ).toEqual([]);
    expect(await checkCorridorRouting({}, horizon({}), { horizonUrl: HORIZON })).toEqual([]);
  });

  it('honours --off overrides', async () => {
    const doc = docWith([usdEntry, eurEntry]);
    const diagnostics = await checkCorridorRouting(doc, horizon({ amounts: {} }), {
      horizonUrl: HORIZON,
      rules: { [NO_ROUTE_RULE]: 'off' },
    });
    expect(diagnostics.filter((d) => d.rule === NO_ROUTE_RULE)).toEqual([]);
  });
});

describe('checkOneCorridor (CLI entry point)', () => {
  it('returns a report and diagnostics for one explicit pair', async () => {
    const { report, diagnostics } = await checkOneCorridor(
      USD,
      EUR,
      horizon({ amounts: { 10: 9.9, 100: 99, 1000: 990 } }),
      {
        horizonUrl: HORIZON,
      },
    );
    expect(report?.routable).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it('reports unreachable without throwing', async () => {
    const { report, diagnostics } = await checkOneCorridor(USD, EUR, horizon({ down: true }), {
      horizonUrl: HORIZON,
    });
    expect(report).toBeUndefined();
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: UNREACHABLE_RULE }));
  });
});

describe('corridorRoutingRules', () => {
  it('registers every emitted rule id', () => {
    expect(corridorRoutingRules.map((r) => ({ id: r.id, severity: r.severity }))).toEqual([
      { id: NO_ROUTE_RULE, severity: 'error' },
      { id: ILLIQUID_RULE, severity: 'warning' },
      { id: ORPHANED_RULE, severity: 'warning' },
      { id: UNREACHABLE_RULE, severity: 'warning' },
    ]);
  });
});
