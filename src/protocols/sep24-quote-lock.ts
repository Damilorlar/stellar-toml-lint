import type { Diagnostic, RuleCategory, RuleOverrides, Severity } from '../types.js';
import { isString, isUrl } from '../predicates.js';
import { currenciesOf } from '../rules/currencies.js';

export const QUOTE_FEE_INSTABILITY_RULE = 'sep24/quote-fee-instability';

const SEP24_SPEC = 'https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_DURATION_MS = 60_000;

export interface Sep24QuoteLockOptions {
  rules?: RuleOverrides;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  pollDurationMs?: number;
}

interface FeeBreakdown {
  fixed?: number;
  percent?: number;
  minimum?: number;
  maximum?: number;
}

interface TransactionResponse {
  id?: string;
  status?: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: FeeBreakdown;
  fee?: FeeBreakdown;
  quote?: FeeBreakdown;
}

function severityOf(rule: string, fallback: Severity, overrides?: RuleOverrides): Severity | 'off' {
  const override = overrides?.[rule];
  if (override === undefined) return fallback;
  return override;
}

function makeDiagnostic(
  rule: string,
  category: RuleCategory,
  fallback: Severity,
  overrides: RuleOverrides | undefined,
  message: string,
  extras: Partial<Diagnostic> = {},
): Diagnostic | null {
  const severity = severityOf(rule, fallback, overrides);
  if (severity === 'off') return null;
  return {
    rule,
    severity,
    category,
    message,
    helpUri: SEP24_SPEC,
    ...extras,
  };
}

function normalizeTransferServer(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function extractFeeBreakdown(body: TransactionResponse): FeeBreakdown | null {
  if (body.amount_fee && typeof body.amount_fee === 'object') return body.amount_fee;
  if (body.fee && typeof body.fee === 'object') return body.fee;
  if (body.quote && typeof body.quote === 'object') return body.quote;
  return null;
}

function feeBreakdownsEqual(a: FeeBreakdown | null, b: FeeBreakdown | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keys: (keyof FeeBreakdown)[] = ['fixed', 'percent', 'minimum', 'maximum'];
  return keys.every((key) => {
    const valA = a[key];
    const valB = b[key];
    if (valA === undefined && valB === undefined) return true;
    if (valA === undefined || valB === undefined) return false;
    return Math.abs(valA - valB) < 0.000001;
  });
}

function formatFeeBreakdown(fee: FeeBreakdown | null): string {
  if (!fee) return 'none';
  const parts: string[] = [];
  if (fee.fixed !== undefined) parts.push(`fixed=${fee.fixed}`);
  if (fee.percent !== undefined) parts.push(`percent=${fee.percent}`);
  if (fee.minimum !== undefined) parts.push(`minimum=${fee.minimum}`);
  if (fee.maximum !== undefined) parts.push(`maximum=${fee.maximum}`);
  return `{ ${parts.join(', ')} }`;
}

const TEST_JWT = 'sep24.lint.test.jwt';

export async function verifySep24QuoteLock(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch,
  options: Sep24QuoteLockOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const overrides = options.rules;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollDurationMs = options.pollDurationMs ?? DEFAULT_POLL_DURATION_MS;

  const preferred = doc.TRANSFER_SERVER_SEP0024;
  const fallback = doc.TRANSFER_SERVER;
  const server = normalizeTransferServer(
    isString(preferred) && isUrl(preferred) ? preferred : fallback,
  );
  if (!server) return diagnostics;

  const currencies = currenciesOf(doc).filter(
    (entry) => entry.is_asset_anchored === true && isString(entry.code) && entry.code.length > 0,
  );
  const assetCode = currencies[0]?.code;
  if (!isString(assetCode)) return diagnostics;

  let initResponse: Response;
  try {
    initResponse = await fetchImpl(`${server}/transactions/deposit/interactive`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_JWT}`,
      },
      body: JSON.stringify({
        asset_code: assetCode,
        type: 'bank_account',
        amount: '100',
      }),
      redirect: 'follow',
    });
  } catch {
    return diagnostics;
  }

  if (!initResponse.ok) return diagnostics;

  const initBody = await initResponse.json().catch(() => null);
  if (!initBody || typeof initBody !== 'object') return diagnostics;

  const initBodyRecord = initBody as Record<string, unknown>;
  const transactionId = initBodyRecord.id;
  if (!isString(transactionId) || transactionId.length === 0) return diagnostics;

  let firstPoll = true;
  let initialFee: FeeBreakdown | null = null;
  let feeChanged = false;
  let feeChangeDetails = '';

  const startTime = Date.now();
  while (Date.now() - startTime < pollDurationMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    let pollResponse: Response;
    try {
      pollResponse = await fetchImpl(
        `${server}/transactions/${encodeURIComponent(transactionId)}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${TEST_JWT}`,
          },
          redirect: 'follow',
        },
      );
    } catch {
      break;
    }

    if (!pollResponse.ok) {
      if (pollResponse.status === 404) break;
      continue;
    }

    const pollBody = await pollResponse.json().catch(() => null);
    if (!pollBody || typeof pollBody !== 'object') continue;

    const txn = pollBody as TransactionResponse;
    const currentFee = extractFeeBreakdown(txn);

    if (firstPoll) {
      initialFee = currentFee;
      firstPoll = false;
      continue;
    }

    if (!feeBreakdownsEqual(initialFee, currentFee)) {
      feeChanged = true;
      feeChangeDetails = `Initial: ${formatFeeBreakdown(initialFee)}, Current: ${formatFeeBreakdown(currentFee)}`;
      break;
    }

    if (txn.status === 'completed' || txn.status === 'error' || txn.status === 'refunded') {
      break;
    }
  }

  if (feeChanged) {
    const diag = makeDiagnostic(
      QUOTE_FEE_INSTABILITY_RULE,
      'network',
      'error',
      overrides,
      `SEP-24 interactive deposit fee quote changed mid-session for ${assetCode}: ${feeChangeDetails}`,
      {
        path: 'TRANSFER_SERVER_SEP0024',
        suggestion: 'Lock the quoted fee for the entire session duration as SEP-24 requires',
      },
    );
    if (diag) diagnostics.push(diag);
  }

  return diagnostics;
}

export const sep24QuoteLockRules = [
  {
    id: QUOTE_FEE_INSTABILITY_RULE,
    category: 'network' as RuleCategory,
    severity: 'error' as Severity,
    description: 'SEP-24 interactive deposit fee quote must remain locked for the session duration',
  },
] as const;
