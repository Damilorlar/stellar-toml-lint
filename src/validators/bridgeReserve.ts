/**
 * Cross-ledger bridge reserve invariant auditing (#403).
 *
 * A cross-chain bridge locks an origin-chain asset in a custody contract and
 * mints a 1:1 wrapped asset on Stellar. The solvency invariant is simple to
 * state and catastrophic to break: the reserve locked on the origin chain must
 * be at least the wrapped supply minted on Stellar. If the locked balance ever
 * trails the minted supply, the bridge is undercollateralised and redemptions
 * cannot be honoured — a direct loss for holders.
 *
 * This module reads bridge declarations from `[[CURRENCIES]]` entries that
 * carry origin-chain metadata, then reconciles two live balances:
 *
 * 1. **Minted supply** — the total wrapped amount on Stellar, read from
 *    Horizon's `/assets` endpoint (the sum across all trustlines).
 * 2. **Locked reserve** — the origin-chain balance held by the bridge custody
 *    account/contract, read over a configurable EVM JSON-RPC endpoint.
 *
 * Both are exact integers: Stellar amounts are 7-decimal stroops, origin
 * amounts are wei-scale (typically 18 decimals). Every comparison uses BigInt
 * scaled to a common precision, so there is no floating-point drift — a bridge
 * holding one wei less than it minted is reported, not rounded away.
 *
 * The audit is opt-in and injected: callers pass their own `fetch`, tests pass
 * a mock, and a balance that cannot be read is a finding, never a crash.
 */
import type { Diagnostic, Rule, RuleOverrides, Severity } from '../types.js';
import { specUrl } from '../spec.js';
import { horizonUrlFor } from '../network-checks.js';
import { isHex, isString } from '../predicates.js';

/* ------------------------------------------------------------------ *
 * Rule ids
 * ------------------------------------------------------------------ */

export const BRIDGE_UNREACHABLE_RULE = 'bridge/balance-unreachable';
export const BRIDGE_UNDERCOLLATERALIZED_RULE = 'bridge/undercollateralized';
export const BRIDGE_OVER_RESERVED_RULE = 'bridge/over-reserved';
export const BRIDGE_CONFIG_INCOMPLETE_RULE = 'bridge/config-incomplete';

/** Decimal precision of every Stellar asset amount (stroops). */
const STELLAR_DECIMALS = 7;

/** Default origin-chain decimals for an EVM-native asset (wei scale). */
const DEFAULT_ORIGIN_DECIMALS = 18;

/** Options for the bridge-reserve audit. */
export interface BridgeCheckOptions {
  rules?: RuleOverrides;
  /** EVM JSON-RPC endpoint used to read locked origin balances. */
  evmRpcUrl?: string;
  /** Override the Horizon endpoint (defaults to the one for the passphrase). */
  horizonUrl?: string;
  /**
   * Allowed shortfall (in stroops) before a reserve counts as insolvent.
   * Defaults to 0 — even a 1-stroop shortfall is reported.
   */
  toleranceStroops?: bigint;
  /** Origin-chain decimals; defaults to 18. Overridden per bridge. */
  originDecimals?: number;
}

/* ------------------------------------------------------------------ *
 * Bridge configuration
 * ------------------------------------------------------------------ */

/** A `[[CURRENCIES]]` entry that declares a cross-chain bridge wrapper. */
export interface BridgeConfig {
  /** Wrapped asset code. */
  code: string;
  /** Wrapped asset issuer on Stellar. */
  issuer: string;
  /** Origin network the asset is bridged from, e.g. `ethereum`. */
  originNetwork: string;
  /** EVM address holding the locked reserves (custody contract/account). */
  reserveCustodian: string;
  /** Dotted path to the offending entry, e.g. `CURRENCIES[0]`. */
  path: string;
  /** Origin-chain decimals; defaults to 18. */
  originDecimals: number;
}

/** A `[[CURRENCIES]]` entry is a bridge when it names an origin network. */
function isBridgeEntry(entry: Record<string, unknown>): boolean {
  return isString(entry.origin_network) && entry.origin_network.length > 0;
}

/**
 * Reads every bridge declaration from `[[CURRENCIES]]`.
 *
 * An entry qualifies as a bridge when it carries an `origin_network`. The
 * custody address is read from `bridge_contract` or `reserve_custodian`; the
 * wrapped asset needs a `code` and `issuer` to locate its Stellar supply.
 */
export function bridgesOf(doc: Record<string, unknown>): BridgeConfig[] {
  const list = doc.CURRENCIES;
  if (!Array.isArray(list)) return [];

  const bridges: BridgeConfig[] = [];
  list.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const entry = raw as Record<string, unknown>;
    if (!isBridgeEntry(entry)) return;

    const custodian = entry.bridge_contract ?? entry.reserve_custodian;
    const originDecimals =
      typeof entry.origin_decimals === 'number' && Number.isInteger(entry.origin_decimals)
        ? entry.origin_decimals
        : DEFAULT_ORIGIN_DECIMALS;

    bridges.push({
      code: isString(entry.code) ? entry.code : '',
      issuer: isString(entry.issuer) ? entry.issuer : '',
      originNetwork: entry.origin_network as string,
      reserveCustodian: isString(custodian) ? custodian : '',
      path: `CURRENCIES[${index}]`,
      originDecimals,
    });
  });
  return bridges;
}

/* ------------------------------------------------------------------ *
 * Precision math
 * ------------------------------------------------------------------ */

/**
 * Rescales an integer amount between decimal precisions using exact BigInt
 * arithmetic. Scaling up multiplies; scaling down truncates toward zero (the
 * only lossy direction, used solely for display-side normalisation).
 */
export function scaleAmount(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (toDecimals > fromDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

/**
 * Parses a Horizon decimal amount string (e.g. `"123.4500000"`) into stroops.
 *
 * Returns `undefined` when the string is not a well-formed decimal — a
 * malformed amount is unreadable, not zero.
 */
export function stroopsFromDecimal(amount: string): bigint | undefined {
  if (!/^-?\d*(\.\d*)?$/.test(amount) || amount === '' || amount === '.') return undefined;
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  // Pad/truncate the fraction to exactly 7 decimals (stroops).
  const frac = (fraction + '0000000').slice(0, STELLAR_DECIMALS);
  const combined = BigInt(whole) * 10n ** BigInt(STELLAR_DECIMALS) + BigInt(frac);
  return negative ? -combined : combined;
}

/* ------------------------------------------------------------------ *
 * Balance fetching
 * ------------------------------------------------------------------ */

/** Why a balance could not be read. */
export class BridgeBalanceError extends Error {}

/**
 * Reads the total minted supply of a wrapped asset from Horizon `/assets`.
 *
 * The endpoint filters on `asset_code`/`asset_issuer` (what its own link
 * template advertises); an `asset=CODE:ISSUER` filter is ignored and would
 * silently return an unrelated asset's record.
 */
export async function fetchMintedSupply(
  horizonUrl: string,
  code: string,
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<bigint> {
  const base = horizonUrl.replace(/\/+$/, '');
  const url = `${base}/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${encodeURIComponent(issuer)}&limit=1`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new BridgeBalanceError(
      `could not reach Horizon at ${horizonUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new BridgeBalanceError(`Horizon returned HTTP ${response.status} for ${code}:${issuer}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BridgeBalanceError(`Horizon did not return valid JSON for ${code}:${issuer}`);
  }

  const embedded = (body as { _embedded?: { records?: unknown[] } })._embedded;
  const records = embedded?.records;
  // No records means the asset has never been issued — zero minted supply.
  if (!Array.isArray(records) || records.length === 0) return 0n;

  const amount = supplyOf(records[0] as Record<string, unknown>);
  if (!isString(amount)) {
    throw new BridgeBalanceError(`Horizon returned no amount for ${code}:${issuer}`);
  }
  const stroops = stroopsFromDecimal(amount);
  if (stroops === undefined) {
    throw new BridgeBalanceError(
      `Horizon returned a malformed amount "${amount}" for ${code}:${issuer}`,
    );
  }
  return stroops;
}

/**
 * Total trustline-held units of an asset, as a decimal string.
 *
 * Horizon used to send the total as a flat `amount`; current instances report
 * the same total split across the `balances` buckets (authorized, pending
 * liabilities, unauthorized), so both shapes read as one supply.
 */
function supplyOf(record: Record<string, unknown>): string | undefined {
  if (isString(record.amount)) return record.amount;

  const balances = record.balances;
  if (typeof balances !== 'object' || balances === null || Array.isArray(balances)) {
    return undefined;
  }
  const buckets = Object.values(balances as Record<string, unknown>);
  if (buckets.length === 0) return undefined;

  let total = 0n;
  for (const bucket of buckets) {
    if (!isString(bucket)) return undefined;
    const stroops = stroopsFromDecimal(bucket);
    if (stroops === undefined) return undefined;
    total += stroops;
  }
  return formatStroops(total);
}

/** Renders integer stroops the way Horizon spells amounts: 7 decimal places. */
function formatStroops(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${fraction}`;
}

/** Reads an EVM address balance (in wei) over JSON-RPC `eth_getBalance`. */
export async function fetchLockedReserve(
  evmRpcUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<bigint> {
  if (!isHex(address.replace(/^0x/, ''), 40)) {
    throw new BridgeBalanceError(`reserve custodian "${address}" is not a 20-byte EVM address`);
  }
  let response: Response;
  try {
    response = await fetchImpl(evmRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address.startsWith('0x') ? address : `0x${address}`, 'latest'],
      }),
    });
  } catch (error) {
    throw new BridgeBalanceError(
      `could not reach the EVM RPC at ${evmRpcUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new BridgeBalanceError(`the EVM RPC at ${evmRpcUrl} returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BridgeBalanceError(`the EVM RPC at ${evmRpcUrl} did not return valid JSON`);
  }

  const { result, error } = body as { result?: unknown; error?: { message?: unknown } };
  if (error !== undefined && error !== null) {
    const detail = isString(error.message) ? `: ${error.message}` : '';
    throw new BridgeBalanceError(`the EVM RPC answered with an error${detail}`);
  }
  if (!isString(result) || !/^0x[0-9a-fA-F]+$/.test(result)) {
    throw new BridgeBalanceError(`the EVM RPC did not return a hex balance for ${address}`);
  }
  return BigInt(result);
}

/* ------------------------------------------------------------------ *
 * The audit
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
  options: BridgeCheckOptions,
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
    helpUri: specUrl('currency-information'),
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}

/**
 * Reads both the minted supply and the locked reserve for one bridge.
 *
 * Emits a {@link BRIDGE_UNREACHABLE_RULE} diagnostic (and returns `undefined`)
 * when either side cannot be read, so the caller skips the invariant rather
 * than comparing a real number against a guess.
 */
async function readBothBalances(
  bridge: BridgeConfig,
  horizonUrl: string,
  fetchImpl: typeof fetch,
  options: BridgeCheckOptions,
  diagnostics: Diagnostic[],
): Promise<[bigint, bigint] | undefined> {
  let mintedStroops: bigint;
  try {
    mintedStroops = await fetchMintedSupply(horizonUrl, bridge.code, bridge.issuer, fetchImpl);
  } catch (error) {
    emit(
      diagnostics,
      BRIDGE_UNREACHABLE_RULE,
      'warning',
      `${bridge.path} could not read the minted supply of ${bridge.code}: ${error instanceof Error ? error.message : String(error)}`,
      bridge.path,
      options,
      'Confirm Horizon is reachable and the wrapped asset code/issuer are correct.',
    );
    return undefined;
  }

  if (options.evmRpcUrl === undefined) {
    emit(
      diagnostics,
      BRIDGE_UNREACHABLE_RULE,
      'warning',
      `${bridge.path} could not read the locked reserve: no EVM RPC endpoint was given (pass --evm-rpc)`,
      bridge.path,
      options,
      'Point --evm-rpc at the origin chain to verify locked reserves.',
    );
    return undefined;
  }

  let lockedWei: bigint;
  try {
    lockedWei = await fetchLockedReserve(options.evmRpcUrl, bridge.reserveCustodian, fetchImpl);
  } catch (error) {
    emit(
      diagnostics,
      BRIDGE_UNREACHABLE_RULE,
      'warning',
      `${bridge.path} could not read the locked reserve for ${bridge.reserveCustodian}: ${error instanceof Error ? error.message : String(error)}`,
      bridge.path,
      options,
      'Confirm the EVM RPC endpoint and the custody address are correct.',
    );
    return undefined;
  }

  return [mintedStroops, lockedWei];
}

/**
 * Reconciles one bridge's locked reserve against its minted supply.
 *
 * Both sides are brought to the origin-chain decimal scale (exact BigInt), so
 * the delta is exact. A shortfall beyond the tolerance is insolvent; a surplus
 * is over-reserved. Returns the diagnostics for this bridge.
 */
export async function checkBridgeReserve(
  bridge: BridgeConfig,
  fetchImpl: typeof fetch,
  options: BridgeCheckOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  // Without a custodian address there is nothing to verify against — flag the
  // configuration as unverifiable rather than silently passing.
  if (bridge.reserveCustodian === '') {
    emit(
      diagnostics,
      BRIDGE_CONFIG_INCOMPLETE_RULE,
      'warning',
      `${bridge.path} declares origin network "${bridge.originNetwork}" but no bridge_contract/reserve_custodian to verify locked reserves against`,
      bridge.path,
      options,
      'Add bridge_contract (the EVM custody address) so the reserve invariant can be checked.',
    );
    return diagnostics;
  }

  const horizonUrl = options.horizonUrl ?? horizonUrlFor(undefined);

  const balances = await readBothBalances(bridge, horizonUrl, fetchImpl, options, diagnostics);
  // If either side is missing, the invariant cannot be evaluated this run.
  if (balances === undefined) return diagnostics;
  const [mintedStroops, lockedWei] = balances;

  // Bring both to the origin decimal scale. Minted stroops are scaled UP (exact
  // multiply); locked wei is already at origin scale.
  const scale = bridge.originDecimals;
  const mintedAtOrigin = scaleAmount(mintedStroops, STELLAR_DECIMALS, scale);
  const lockedAtOrigin = lockedWei;
  const delta = lockedAtOrigin - mintedAtOrigin;
  const tolerance = scaleAmount(options.toleranceStroops ?? 0n, STELLAR_DECIMALS, scale);

  if (delta < -tolerance) {
    const shortfall = -delta;
    emit(
      diagnostics,
      BRIDGE_UNDERCOLLATERALIZED_RULE,
      'error',
      `${bridge.path} (${bridge.code}) is undercollateralized: ${bridge.originNetwork} locks ${lockedAtOrigin} (${scale}dp) but ${mintedAtOrigin} is minted on Stellar — a shortfall of ${shortfall}`,
      bridge.path,
      options,
      'Pause minting and top up the custody reserve, or burn the excess wrapped supply.',
    );
  } else if (delta > tolerance) {
    emit(
      diagnostics,
      BRIDGE_OVER_RESERVED_RULE,
      'info',
      `${bridge.path} (${bridge.code}) is over-reserved: ${bridge.originNetwork} locks ${lockedAtOrigin} (${scale}dp) against ${mintedAtOrigin} minted on Stellar — ${delta} excess`,
      bridge.path,
      options,
      'Excess reserve is safe but may indicate unminted deposits; reconcile if unintended.',
    );
  }

  return diagnostics;
}

/**
 * Audits every bridge the file declares.
 *
 * Silent when the file declares no bridges. Each bridge is reconciled
 * independently so one unreachable chain never takes down the rest.
 */
export async function checkBridgeReserves(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: BridgeCheckOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const bridge of bridgesOf(doc)) {
    diagnostics.push(...(await checkBridgeReserve(bridge, fetchImpl, options)));
  }
  return diagnostics;
}

/** Rule objects behind the bridge probes, registered for `--list-rules`/`--off`. */
export const bridgeReserveRules: Rule[] = [
  {
    id: BRIDGE_UNDERCOLLATERALIZED_RULE,
    category: 'network',
    severity: 'error',
    description: 'A bridge locks less on the origin chain than it has minted on Stellar',
    run() {},
  },
  {
    id: BRIDGE_OVER_RESERVED_RULE,
    category: 'network',
    severity: 'info',
    description: 'A bridge locks more on the origin chain than it has minted on Stellar',
    run() {},
  },
  {
    id: BRIDGE_UNREACHABLE_RULE,
    category: 'network',
    severity: 'warning',
    description: 'A bridge reserve balance could not be read from Horizon or the origin chain',
    run() {},
  },
  {
    id: BRIDGE_CONFIG_INCOMPLETE_RULE,
    category: 'network',
    severity: 'warning',
    description: 'A bridge declaration lacks the custody address needed to verify its reserves',
    run() {},
  },
];
