/**
 * Turns a lint result into what the popup actually shows.
 *
 * The popup has a few hundred pixels: the organization, the assets it lists,
 * and the findings that matter. Everything here is a read of the already-parsed
 * TOML, so it never re-implements the linter's own rules — it only presents
 * them.
 */

/** A finding, in the subset the popup renders. */
export interface SummaryFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
}

/** One listed asset, as the popup's asset chips need it. */
export interface SummaryAsset {
  /** Asset code, e.g. `USDC`. */
  code: string;
  /** Issuing account or Soroban contract id, when the currency declares one. */
  issuer?: string;
  /** True for regulated (SEP-8) assets. */
  regulated: boolean;
}

/** Everything the popup renders. */
export interface PopupSummary {
  ok: boolean;
  counts: { error: number; warning: number; info: number };
  /** `DOCUMENTATION.ORG_NAME`, when the file declares one. */
  orgName?: string;
  orgUrl?: string;
  /** One-line description from `[DOCUMENTATION]`. */
  orgDescription?: string;
  assets: SummaryAsset[];
  findings: SummaryFinding[];
  /** True when the file advertised at least one SEP endpoint. */
  servesSep: boolean;
}

/** The structural shape of a lint result this module consumes. */
export interface LintResultLike {
  ok: boolean;
  counts: { error: number; warning: number; info: number };
  parsed?: unknown;
  diagnostics: readonly {
    rule: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    position?: { line: number; column: number };
  }[];
}

/** Endpoint fields that mean "this domain runs a SEP server". */
const SEP_FIELDS = [
  'WEB_AUTH_ENDPOINT',
  'KYC_SERVER',
  'TRANSFER_SERVER',
  'TRANSFER_SERVER_SEP0024',
  'DIRECT_PAYMENT_SERVER',
  'ANCHOR_QUOTE_SERVER',
] as const;

/**
 * Builds the popup model.
 *
 * Findings are sorted error-first, then by line, because the popup shows a
 * handful and the first one shown should be the one that breaks a wallet.
 */
export function summarize(result: LintResultLike): PopupSummary {
  const parsed = isRecord(result.parsed) ? result.parsed : {};
  const documentation = isRecord(parsed.DOCUMENTATION) ? parsed.DOCUMENTATION : {};

  return {
    ok: result.ok,
    counts: result.counts,
    ...stringField(documentation.ORG_NAME, 'orgName'),
    ...stringField(documentation.ORG_URL, 'orgUrl'),
    ...stringField(documentation.ORG_DESCRIPTION, 'orgDescription'),
    assets: assetsOf(parsed),
    findings: [...result.diagnostics]
      .map((diagnostic) => ({
        rule: diagnostic.rule,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.position === undefined ? {} : { line: diagnostic.position.line }),
      }))
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) || (a.line ?? 0) - (b.line ?? 0),
      ),
    servesSep: SEP_FIELDS.some((field) => typeof parsed[field] === 'string'),
  };
}

function assetsOf(parsed: Record<string, unknown>): SummaryAsset[] {
  const currencies = parsed.CURRENCIES;
  if (!Array.isArray(currencies)) return [];

  const assets: SummaryAsset[] = [];
  for (const currency of currencies) {
    if (!isRecord(currency)) continue;
    const code = currency.code;
    if (typeof code !== 'string') continue;
    const issuer = currency.issuer ?? currency.contract;
    assets.push({
      code,
      ...(typeof issuer === 'string' ? { issuer } : {}),
      regulated: currency.regulated === true,
    });
  }
  return assets;
}

function severityRank(severity: SummaryFinding['severity']): number {
  return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1;
}

/** Spreads a field in only when it is a non-empty string. */
function stringField<T extends string>(
  value: unknown,
  key: T,
): Record<T, string> | Record<string, never> {
  return typeof value === 'string' && value !== '' ? ({ [key]: value } as Record<T, string>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
