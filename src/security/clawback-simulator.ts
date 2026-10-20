import type { Diagnostic, RuleCategory, RuleOverrides, Severity } from '../types.js';

export const CLAWBACK_PERMISSION_MISMATCH_RULE = 'security/clawback-permission-mismatch';

const CAP35_HELP = 'https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0035.md';
const SOROBAN_HELP = 'https://soroban.stellar.org/docs/learn/auth';

export interface ClawbackSimulatorOptions {
  rules?: RuleOverrides;
  fetchImpl?: typeof fetch;
  rpcUrl?: string;
  timeoutMs?: number;
}

interface AssetInfo {
  code: string;
  issuer?: string;
  contract?: string;
  is_asset_anchored?: boolean;
  clawback_enabled?: boolean;
  desc?: string;
}

interface HorizonAccountResponse {
  account_id: string;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  signers: Array<{
    key: string;
    weight: number;
    type: string;
  }>;
}

interface SorobanRpcResponse {
  result?: {
    auth?: Array<{
      address: string;
      nonce: number;
    }>;
  };
  error?: string;
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
    helpUri: CAP35_HELP,
    ...extras,
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function hasClawbackExplanation(desc: string | undefined): boolean {
  if (!desc) return false;
  const keywords = ['clawback', 'aml', 'sanctions', 'compliance', 'regulatory', 'freeze', 'revoke'];
  const lower = desc.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

async function checkClassicClawbackAuthority(
  fetchImpl: typeof fetch,
  horizonUrl: string,
  asset: AssetInfo,
  timeoutMs: number,
): Promise<{ hasAuthority: boolean; message: string }> {
  if (!asset.issuer) {
    return { hasAuthority: false, message: 'No issuer specified for classic asset' };
  }

  const result = await fetchJson(
    fetchImpl,
    `${horizonUrl}/accounts/${asset.issuer}`,
    { method: 'GET', headers: { accept: 'application/json' } },
    timeoutMs,
  );

  if (!result || result.status !== 200) {
    return {
      hasAuthority: false,
      message: `Could not fetch issuer account ${asset.issuer} from Horizon`,
    };
  }

  const account = result.body as HorizonAccountResponse | null;
  if (!account) {
    return { hasAuthority: false, message: 'Invalid Horizon account response' };
  }

  const highThreshold = account.thresholds.high_threshold;
  const hasClawbackSigner = account.signers.some(
    (signer) => signer.weight >= highThreshold && signer.type === 'ed25519_public_key',
  );

  if (!hasClawbackSigner) {
    return {
      hasAuthority: false,
      message: `Issuer ${asset.issuer} lacks a signer with weight >= high_threshold (${highThreshold}) required for ClawbackOp`,
    };
  }

  return {
    hasAuthority: true,
    message: `Issuer ${asset.issuer} has sufficient signer weight for clawback`,
  };
}

async function checkSorobanClawbackAuthority(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  asset: AssetInfo,
  timeoutMs: number,
): Promise<{ hasAuthority: boolean; message: string }> {
  if (!asset.contract) {
    return { hasAuthority: false, message: 'No contract ID specified for Soroban asset' };
  }

  const result = await rpcCall(
    fetchImpl,
    rpcUrl,
    'simulateTransaction',
    [
      {
        contract_id: asset.contract,
        function_name: 'clawback',
        args: [],
      },
    ],
    timeoutMs,
  );

  if (!result || result.status !== 200) {
    return {
      hasAuthority: false,
      message: `Soroban RPC simulation failed for contract ${asset.contract}`,
    };
  }

  const body = result.body as SorobanRpcResponse | null;
  if (!body || body.error) {
    return {
      hasAuthority: false,
      message: `Soroban clawback simulation error: ${body?.error ?? 'unknown'}`,
    };
  }

  return {
    hasAuthority: true,
    message: `Soroban contract ${asset.contract} allows clawback simulation`,
  };
}

export async function simulateClawback(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch,
  options: ClawbackSimulatorOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const overrides = options.rules;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const horizonUrl = (doc.HORIZON_URL as string) ?? 'https://horizon.stellar.org';
  const rpcUrl =
    options.rpcUrl ?? (doc.SOROBAN_RPC_URL as string) ?? 'https://soroban.stellar.org/rpc';

  const currencies = (doc.CURRENCIES as AssetInfo[]) ?? [];

  for (const [index, asset] of currencies.entries()) {
    const path = `CURRENCIES[${index}]`;

    if (asset.clawback_enabled !== true) continue;

    if (!asset.is_asset_anchored) {
      const diag = makeDiagnostic(
        CLAWBACK_PERMISSION_MISMATCH_RULE,
        'network',
        'error',
        overrides,
        `${path} declares clawback_enabled=true but is_asset_anchored is not true`,
        { path: `${path}.clawback_enabled` },
      );
      if (diag) diagnostics.push(diag);
      continue;
    }

    const hasExplanation = hasClawbackExplanation(asset.desc);
    if (!hasExplanation) {
      const diag = makeDiagnostic(
        CLAWBACK_PERMISSION_MISMATCH_RULE,
        'network',
        'error',
        overrides,
        `${path} declares clawback_enabled=true but description lacks AML/sanctions/compliance explanation`,
        {
          path: `${path}.desc`,
          suggestion:
            'Add explanation of regulatory authority for clawback (AML, sanctions, compliance requirements)',
        },
      );
      if (diag) diagnostics.push(diag);
    }

    if (asset.issuer) {
      const { hasAuthority, message } = await checkClassicClawbackAuthority(
        fetchImpl,
        horizonUrl,
        asset,
        timeoutMs,
      );
      if (!hasAuthority) {
        const diag = makeDiagnostic(
          CLAWBACK_PERMISSION_MISMATCH_RULE,
          'network',
          'error',
          overrides,
          `${path}: ${message}`,
          { path: `${path}.issuer`, helpUri: CAP35_HELP },
        );
        if (diag) diagnostics.push(diag);
      }
    } else if (asset.contract) {
      const { hasAuthority, message } = await checkSorobanClawbackAuthority(
        fetchImpl,
        rpcUrl,
        asset,
        timeoutMs,
      );
      if (!hasAuthority) {
        const diag = makeDiagnostic(
          CLAWBACK_PERMISSION_MISMATCH_RULE,
          'network',
          'error',
          overrides,
          `${path}: ${message}`,
          { path: `${path}.contract`, helpUri: SOROBAN_HELP },
        );
        if (diag) diagnostics.push(diag);
      }
    } else {
      const diag = makeDiagnostic(
        CLAWBACK_PERMISSION_MISMATCH_RULE,
        'network',
        'error',
        overrides,
        `${path} declares clawback_enabled=true but has neither issuer nor contract`,
        { path: `${path}.clawback_enabled` },
      );
      if (diag) diagnostics.push(diag);
    }
  }

  return diagnostics;
}

export const clawbackSimulatorRules = [
  {
    id: CLAWBACK_PERMISSION_MISMATCH_RULE,
    category: 'security' as RuleCategory,
    severity: 'error' as Severity,
    description:
      'Asset with clawback_enabled must have valid signer authority and compliance explanation',
  },
] as const;
