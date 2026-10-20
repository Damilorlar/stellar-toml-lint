/**
 * Multi-asset cross-border remittance corridor routing verifier (#400).
 *
 * A remittance corridor is a (source asset → destination asset) pair an anchor
 * implicitly promises when it lists both assets in `[[CURRENCIES]]`. Whether a
 * wallet can actually move value along that corridor depends on live SDEX
 * liquidity: if Horizon reports no payment path, or only paths whose rate
 * collapses as the order grows, the declared corridor is dead or illiquid and
 * the transfer fails at execution time — long after the file looked fine.
 *
 * The verifier derives candidate corridors from the declared currencies, then
 * for each pair queries Horizon's `/paths/strict-send` at the three standard
 * remittance amounts ($10, $100, $1,000). From those answers it derives:
 *
 * - **Routability** — does any path exist at all?
 * - **Theoretical slippage** — the per-unit rate at the smallest amount is
 *   treated as the near-spot reference; slippage is how much worse the rate
 *   gets at larger amounts. A corridor whose rate degrades steeply is thin.
 * - **Market depth** — how many distinct paths Horizon offers, and over which
 *   of the standard amounts the corridor still routes.
 * - **Viability score** — a 0–1 blend of routability, depth and slippage.
 *
 * Findings are ordinary {@link Diagnostic}s: `corridors/no-route` for a dead
 * corridor, `corridors/illiquid` for a thin one, `corridors/orphaned-asset`
 * for a declared asset that participates in no viable corridor, and
 * `corridors/unreachable` when Horizon cannot answer. The check is opt-in and
 * injected: callers pass their own `fetch`, tests pass a mock, and nothing
 * here throws on a network error.
 */
import type { Diagnostic, Rule, RuleOverrides, Severity } from '../types.js';
import { horizonUrlFor } from '../network-checks.js';
import { isString } from '../predicates.js';

/* ------------------------------------------------------------------ *
 * Rule ids
 * ------------------------------------------------------------------ */

export const NO_ROUTE_RULE = 'corridors/no-route';
export const ILLIQUID_RULE = 'corridors/illiquid';
export const ORPHANED_RULE = 'corridors/orphaned-asset';
export const UNREACHABLE_RULE = 'corridors/unreachable';

/** The standard remittance amounts, in source-asset units, that must route. */
export const STANDARD_AMOUNTS: readonly number[] = [10, 100, 1000];

/** A per-unit rate at or above this slippage marks a corridor illiquid. */
const DEFAULT_ILLIQUID_SLIPPAGE = 0.05;

/** Cap on auto-derived corridor pairs, so a huge currency list stays bounded. */
const MAX_AUTO_CORRIDORS = 24;

/* ------------------------------------------------------------------ *
 * Assets and corridors
 * ------------------------------------------------------------------ */

/** A classic asset; an absent `issuer` means native XLM. */
export interface CorridorAsset {
  code: string;
  issuer?: string;
}

/** One auto-derived corridor, with the CURRENCIES indices it came from. */
export interface CorridorPair {
  source: CorridorAsset;
  dest: CorridorAsset;
  sourceIndex: number;
  destIndex: number;
}

/** True for XLM — `code="native"`, or `XLM`/`xlm` with no issuer. */
function isNative(asset: CorridorAsset): boolean {
  if (asset.issuer !== undefined) return false;
  const code = asset.code.toLowerCase();
  return code === 'native' || code === 'xlm';
}

/** Renders an asset as `CODE:ISSUER`, or `native` for XLM — the CLI/--paths form. */
export function describeAsset(asset: CorridorAsset): string {
  return isNative(asset) ? 'native' : `${asset.code}:${asset.issuer ?? ''}`;
}

/** Reads the classic assets declared by `[[CURRENCIES]]`, in declaration order. */
function declaredAssets(doc: Record<string, unknown>): { asset: CorridorAsset; index: number }[] {
  const list = doc.CURRENCIES;
  if (!Array.isArray(list)) return [];

  const assets: { asset: CorridorAsset; index: number }[] = [];
  list.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const entry = raw as Record<string, unknown>;
    // `toml` pointers and contract-only entries describe no classic asset pair.
    if (entry.toml !== undefined || entry.contract !== undefined) return;
    if (!isString(entry.code)) return;

    if (isNative({ code: entry.code })) {
      assets.push({ asset: { code: 'native' }, index });
      return;
    }
    if (isString(entry.issuer)) {
      assets.push({ asset: { code: entry.code, issuer: entry.issuer }, index });
    }
  });
  return assets;
}

/**
 * Derives candidate corridor pairs from the declared currencies.
 *
 * Every ordered pair of distinct declared assets is a corridor the file
 * implicitly advertises (a remittance can run either direction). The result is
 * capped at {@link MAX_AUTO_CORRIDORS} so a large currency list cannot trigger
 * a request storm; callers wanting a specific pair use the explicit form.
 */
export function corridorsOf(doc: Record<string, unknown>): CorridorPair[] {
  const assets = declaredAssets(doc);
  const corridors: CorridorPair[] = [];

  for (const source of assets) {
    for (const dest of assets) {
      if (source.index === dest.index) continue;
      if (corridors.length >= MAX_AUTO_CORRIDORS) return corridors;
      corridors.push({
        source: source.asset,
        dest: dest.asset,
        sourceIndex: source.index,
        destIndex: dest.index,
      });
    }
  }
  return corridors;
}

/* ------------------------------------------------------------------ *
 * Horizon /paths
 * ------------------------------------------------------------------ */

/** Adds Horizon asset query params for `asset` under `prefix`. */
function assetParams(prefix: string, asset: CorridorAsset): string {
  if (isNative(asset)) return `${prefix}_asset_type=native`;
  // Alphanum4 covers codes up to 4 chars; longer codes are alphanum5.
  const type = asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum5';
  return `${prefix}_asset_type=${type}&${prefix}_asset_code=${encodeURIComponent(asset.code)}&${prefix}_asset_issuer=${encodeURIComponent(asset.issuer ?? '')}`;
}

/**
 * Builds the `/paths/strict-send` URL for one corridor at one amount.
 *
 * Horizon takes the destination of a strict-send as a `destination_assets`
 * list of asset labels (`native` or `CODE:ISSUER`) — the per-field
 * `destination_asset_*` params belong to `/paths/strict-receive` and make a
 * strict-send answer 400, so the destination is rendered with `describeAsset`.
 */
export function strictSendUrl(
  horizonUrl: string,
  source: CorridorAsset,
  dest: CorridorAsset,
  amount: number,
): string {
  const base = horizonUrl.replace(/\/+$/, '');
  const query = [
    assetParams('source', source),
    `source_amount=${amount}`,
    `destination_assets=${encodeURIComponent(describeAsset(dest))}`,
  ].join('&');
  return `${base}/paths/strict-send?${query}`;
}

/** One amount's routing answer: the best destination amount and path count. */
interface AmountRouting {
  destinationAmount: number;
  pathCount: number;
}

/**
 * Queries `/paths/strict-send` for one corridor at one amount.
 *
 * Returns `undefined` when Horizon cannot be reached or answered non-200 — the
 * caller distinguishes "no route" from "could not verify". A 200 with zero
 * records is a valid answer meaning "no path", and yields `{ destinationAmount:
 * 0, pathCount: 0 }`.
 */
async function queryRouting(
  horizonUrl: string,
  source: CorridorAsset,
  dest: CorridorAsset,
  amount: number,
  fetchImpl: typeof fetch,
): Promise<AmountRouting | undefined> {
  const url = strictSendUrl(horizonUrl, source, dest, amount);
  let response: Response;
  try {
    response = await fetchImpl(url);
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

  const records = (body as { _embedded?: { records?: unknown[] } })._embedded?.records;
  if (!Array.isArray(records)) return { destinationAmount: 0, pathCount: 0 };

  let best = 0;
  for (const raw of records) {
    const destinationAmount = Number((raw as { destination_amount?: unknown }).destination_amount);
    if (Number.isFinite(destinationAmount) && destinationAmount > best) best = destinationAmount;
  }
  return { destinationAmount: best, pathCount: records.length };
}

/* ------------------------------------------------------------------ *
 * Corridor analysis
 * ------------------------------------------------------------------ */

/** Everything one corridor's probe revealed. */
export interface CorridorReport {
  pair: CorridorPair;
  /** True when at least one standard amount found a path. */
  routable: boolean;
  /** The standard amounts (source units) that still routed. */
  routableAmounts: number[];
  /** Worst observed per-unit slippage across the standard amounts (0 = flat). */
  slippage: number;
  /** Distinct paths Horizon offered at the routable amounts, summed. */
  depth: number;
  /** 0–1 viability score; 0 when unroutable. */
  score: number;
}

/**
 * Probes one corridor at the standard amounts and derives its report.
 *
 * The per-unit rate at the smallest routable amount is the near-spot
 * reference; slippage is the worst relative degradation of that rate as the
 * order grows to the larger standard amounts. Score rewards routability, path
 * redundancy and a flat (non-collapsing) rate.
 *
 * Returns `undefined` only when Horizon could not be reached at every amount —
 * an "unverifiable" corridor, distinct from a dead one.
 */
export async function analyzeCorridor(
  pair: CorridorPair,
  horizonUrl: string,
  fetchImpl: typeof fetch,
): Promise<CorridorReport | undefined> {
  const routings: { amount: number; destinationAmount: number; pathCount: number }[] = [];
  let reachedHorizon = false;

  for (const amount of STANDARD_AMOUNTS) {
    const routing = await queryRouting(horizonUrl, pair.source, pair.dest, amount, fetchImpl);
    if (routing === undefined) continue;
    reachedHorizon = true;
    routings.push({ amount, ...routing });
  }

  if (!reachedHorizon) return undefined;

  const routableAmounts = routings.filter((r) => r.destinationAmount > 0).map((r) => r.amount);
  const routable = routableAmounts.length > 0;

  if (!routable) {
    return { pair, routable: false, routableAmounts: [], slippage: 0, depth: 0, score: 0 };
  }

  // Near-spot reference: per-unit rate at the smallest routable amount.
  const smallest = routings.find((r) => r.amount === routableAmounts[0]) as {
    amount: number;
    destinationAmount: number;
  };
  const referenceRate = smallest.destinationAmount / smallest.amount;

  let slippage = 0;
  let depth = 0;
  for (const r of routings) {
    depth += r.pathCount;
    if (r.destinationAmount <= 0) continue;
    const rate = r.destinationAmount / r.amount;
    const degradation = referenceRate > 0 ? (referenceRate - rate) / referenceRate : 0;
    if (degradation > slippage) slippage = degradation;
  }

  // Score: half routability coverage, half rate stability (1 - slippage).
  const coverage = routableAmounts.length / STANDARD_AMOUNTS.length;
  const stability = Math.max(0, 1 - slippage);
  const score = Math.round((coverage * 0.5 + stability * 0.5) * 100) / 100;

  return { pair, routable: true, routableAmounts, slippage, depth, score };
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

function severityFor(
  rule: string,
  fallback: Severity,
  rules?: RuleOverrides,
): Severity | undefined {
  const override = rules?.[rule];
  if (override === 'off') return undefined;
  return override ?? fallback;
}

function emit(
  out: Diagnostic[],
  rule: string,
  fallback: Severity,
  message: string,
  path: string,
  options: CorridorCheckOptions,
  suggestion?: string,
): void {
  const severity = severityFor(rule, fallback, options.rules);
  if (severity === undefined) return;
  out.push({
    rule,
    severity,
    category: 'network',
    message,
    path,
    helpUri: 'https://developers.stellar.org/docs/getting-started/create-an-account',
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}

/** Options for the corridor-routing audit. */
export interface CorridorCheckOptions {
  rules?: RuleOverrides;
  /** Override the Horizon endpoint (defaults to the one for the passphrase). */
  horizonUrl?: string;
  /** Per-unit slippage at or above which a routable corridor is "illiquid". */
  illiquidSlippage?: number;
}

/** Turns one corridor's report into diagnostics (no-route / illiquid). */
function diagnosticsForReport(report: CorridorReport, options: CorridorCheckOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sourceLabel = describeAsset(report.pair.source);
  const destLabel = describeAsset(report.pair.dest);
  const path = `CURRENCIES[${report.pair.sourceIndex}].code`;

  if (!report.routable) {
    emit(
      diagnostics,
      NO_ROUTE_RULE,
      'error',
      `No payment path on SDEX from ${sourceLabel} to ${destLabel} at any standard remittance amount ($10/$100/$1,000) — the declared corridor is unroutable`,
      path,
      options,
      'Confirm both assets trade on SDEX, or remove the corridor implied by this currency pair.',
    );
    return diagnostics;
  }

  const floor = options.illiquidSlippage ?? DEFAULT_ILLIQUID_SLIPPAGE;
  if (report.slippage >= floor) {
    emit(
      diagnostics,
      ILLIQUID_RULE,
      'warning',
      `Corridor ${sourceLabel} → ${destLabel} is illiquid: the effective rate degrades ${(report.slippage * 100).toFixed(1)}% between the $10 and $1,000 test amounts (viability ${report.score.toFixed(2)})`,
      path,
      options,
      'Deepen SDEX liquidity for this pair, or route remittances through a more liquid bridge asset.',
    );
  } else if (report.routableAmounts.length < STANDARD_AMOUNTS.length) {
    emit(
      diagnostics,
      ILLIQUID_RULE,
      'warning',
      `Corridor ${sourceLabel} → ${destLabel} only routes at $${report.routableAmounts.join('/$')}, not the full $10/$100/$1,000 ladder — larger remittances will fail`,
      path,
      options,
      'Deepen SDEX liquidity so the corridor supports standard remittance sizes.',
    );
  }

  return diagnostics;
}

/**
 * Audits every auto-derived corridor the file implies.
 *
 * Silent when the file declares fewer than two classic assets (no corridor to
 * probe). Also reports declared assets that participate in no viable corridor
 * as orphaned. Never throws; an unreachable Horizon surfaces once.
 */
export async function checkCorridorRouting(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: CorridorCheckOptions = {},
): Promise<Diagnostic[]> {
  const corridors = corridorsOf(doc);
  if (corridors.length === 0) return [];

  const horizonUrl = options.horizonUrl ?? horizonUrlFor(undefined);
  const diagnostics: Diagnostic[] = [];

  const reports: CorridorReport[] = [];
  let anyUnreachable = false;
  for (const pair of corridors) {
    const report = await analyzeCorridor(pair, horizonUrl, fetchImpl);
    if (report === undefined) {
      anyUnreachable = true;
      continue;
    }
    reports.push(report);
    diagnostics.push(...diagnosticsForReport(report, options));
  }

  if (anyUnreachable) {
    emit(
      diagnostics,
      UNREACHABLE_RULE,
      'warning',
      `Could not query Horizon /paths at ${horizonUrl}; some corridors could not be verified`,
      'HORIZON_URL',
      options,
      'Confirm Horizon is reachable, or pass an explicit Horizon endpoint.',
    );
  }

  // Orphaned assets: declared but present in no routable corridor.
  const viable = reports.filter((r) => r.routable);
  const participating = new Set<number>();
  for (const report of viable) {
    participating.add(report.pair.sourceIndex);
    participating.add(report.pair.destIndex);
  }
  for (const { asset, index } of declaredAssets(doc)) {
    if (participating.has(index)) continue;
    emit(
      diagnostics,
      ORPHANED_RULE,
      'warning',
      `Declared asset ${describeAsset(asset)} participates in no routable SDEX corridor with any other declared asset`,
      `CURRENCIES[${index}].code`,
      options,
      'Confirm the asset is issued and trades on SDEX, or remove it if it is informational only.',
    );
  }

  return diagnostics;
}

/** CLI-facing helper: audits one explicit corridor (`corridor-check`). */
export async function checkOneCorridor(
  source: CorridorAsset,
  dest: CorridorAsset,
  fetchImpl: typeof fetch = fetch,
  options: CorridorCheckOptions = {},
): Promise<{ report: CorridorReport | undefined; diagnostics: Diagnostic[] }> {
  const horizonUrl = options.horizonUrl ?? horizonUrlFor(undefined);
  const pair: CorridorPair = { source, dest, sourceIndex: 0, destIndex: 1 };
  const report = await analyzeCorridor(pair, horizonUrl, fetchImpl);
  if (report === undefined) {
    const diagnostics: Diagnostic[] = [];
    emit(
      diagnostics,
      UNREACHABLE_RULE,
      'warning',
      `Could not query Horizon /paths at ${horizonUrl}; the corridor could not be verified`,
      'HORIZON_URL',
      options,
      'Confirm Horizon is reachable, or pass an explicit Horizon endpoint.',
    );
    return { report: undefined, diagnostics };
  }
  return { report, diagnostics: diagnosticsForReport(report, options) };
}

/** Rule objects behind the corridor probes, registered for `--list-rules`/`--off`. */
export const corridorRoutingRules: Rule[] = [
  {
    id: NO_ROUTE_RULE,
    category: 'network',
    severity: 'error',
    description: 'A declared currency pair has no SDEX payment path at standard remittance amounts',
    run() {},
  },
  {
    id: ILLIQUID_RULE,
    category: 'network',
    severity: 'warning',
    description:
      'A corridor routes but its rate degrades steeply or misses part of the amount ladder',
    run() {},
  },
  {
    id: ORPHANED_RULE,
    category: 'network',
    severity: 'warning',
    description: 'A declared asset participates in no routable SDEX corridor',
    run() {},
  },
  {
    id: UNREACHABLE_RULE,
    category: 'network',
    severity: 'warning',
    description: 'Corridor routing could not be verified because Horizon /paths was unreachable',
    run() {},
  },
];
