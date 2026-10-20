import { randomUUID } from 'node:crypto';

import type { Diagnostic, RuleCategory, RuleOverrides, Severity } from '../types.js';

export const DELETE_CUSTOMER_UNSUPPORTED_RULE = 'sep12/delete-customer-unsupported';
export const CUSTOMER_RECORD_RETENTION_FAILURE_RULE = 'sep12/customer-record-retention-failure';

const DEFAULT_TIMEOUT_MS = 15_000;
const SEP12_HELP = 'https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md';

export interface Sep12DeletionOptions {
  rules?: RuleOverrides;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface CustomerResponse {
  id?: string;
  status?: string;
  fields?: Record<string, KycField>;
  message?: string;
}

interface KycField {
  type?: string;
  description?: string;
  optional?: boolean;
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
    helpUri: SEP12_HELP,
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

function normalizeKycServer(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function syntheticCustomer(): Record<string, string> {
  const id = randomUUID();
  return {
    first_name: 'Lint',
    last_name: 'Suite',
    email_address: `kyc-${id}@example.com`,
    id_number: id,
    mobile_number: '+10000000000',
    address: '1 Test Street, Nowhere, XX 00000',
    birth_date: '1990-01-01',
  };
}

function generateTestJwt(): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const payload = btoa(
    JSON.stringify({
      iss: 'https://example.com/auth',
      sub: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBRTC4TQBXXK2ZBDUFLYWWDZDT',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = 'mock_signature_for_lint_testing';
  return `${header}.${payload}.${signature}`;
}

export async function verifySep12Deletion(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch,
  options: Sep12DeletionOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const kycServer = normalizeKycServer(doc.KYC_SERVER);
  if (!kycServer) return diagnostics;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const overrides = options.rules;

  const synthetic = syntheticCustomer();
  const registerResult = await fetchJson(
    fetchImpl,
    `${kycServer}/customer`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(synthetic),
    },
    timeoutMs,
  );

  if (!registerResult || registerResult.status < 200 || registerResult.status >= 300) {
    return diagnostics;
  }

  const registered = registerResult.body as CustomerResponse | null;
  const customerId = registered?.id;
  if (!customerId) {
    return diagnostics;
  }

  const testJwt = generateTestJwt();
  const deleteResult = await fetchJson(
    fetchImpl,
    `${kycServer}/customer/${encodeURIComponent(customerId)}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${testJwt}`,
        accept: 'application/json',
      },
    },
    timeoutMs,
  );

  if (!deleteResult) {
    const diag = makeDiagnostic(
      DELETE_CUSTOMER_UNSUPPORTED_RULE,
      'sep12',
      'warning',
      overrides,
      `SEP-12 DELETE /customer/${customerId} request failed (network error or timeout)`,
      { suggestion: 'Ensure DELETE /customer endpoint is implemented and reachable' },
    );
    if (diag) diagnostics.push(diag);
    return diagnostics;
  }

  if (deleteResult.status === 405 || deleteResult.status === 501) {
    const diag = makeDiagnostic(
      DELETE_CUSTOMER_UNSUPPORTED_RULE,
      'sep12',
      'warning',
      overrides,
      `SEP-12 DELETE /customer/${customerId} returned HTTP ${deleteResult.status} (Method Not Allowed / Not Implemented)`,
      { suggestion: 'Implement DELETE /customer as required by SEP-12 for GDPR/CCPA compliance' },
    );
    if (diag) diagnostics.push(diag);
    return diagnostics;
  }

  if (deleteResult.status >= 400) {
    const diag = makeDiagnostic(
      DELETE_CUSTOMER_UNSUPPORTED_RULE,
      'sep12',
      'warning',
      overrides,
      `SEP-12 DELETE /customer/${customerId} returned HTTP ${deleteResult.status}`,
      { suggestion: 'DELETE /customer should return 200 or 204 on success' },
    );
    if (diag) diagnostics.push(diag);
    return diagnostics;
  }

  const getResult = await fetchJson(
    fetchImpl,
    `${kycServer}/customer/${encodeURIComponent(customerId)}`,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
    },
    timeoutMs,
  );

  if (!getResult) {
    return diagnostics;
  }

  if (getResult.status === 200) {
    const body = getResult.body as CustomerResponse | null;
    if (body && typeof body === 'object') {
      const status = body.status;
      if (
        status !== undefined &&
        status !== 'DELETED' &&
        status !== 'INACTIVE' &&
        status !== 'PURGED'
      ) {
        const diag = makeDiagnostic(
          CUSTOMER_RECORD_RETENTION_FAILURE_RULE,
          'sep12',
          'error',
          overrides,
          `SEP-12 GET /customer/${customerId} after DELETE returned status "${status}" instead of DELETED/INACTIVE/PURGED`,
          {
            suggestion:
              'After DELETE /customer, the record should be purged or marked DELETED/INACTIVE',
          },
        );
        if (diag) diagnostics.push(diag);
      }
    }
  }

  return diagnostics;
}

export const sep12DeletionRules = [
  {
    id: DELETE_CUSTOMER_UNSUPPORTED_RULE,
    category: 'sep12' as RuleCategory,
    severity: 'warning' as Severity,
    description: 'SEP-12 DELETE /customer endpoint must be implemented for GDPR/CCPA compliance',
  },
  {
    id: CUSTOMER_RECORD_RETENTION_FAILURE_RULE,
    category: 'sep12' as RuleCategory,
    severity: 'error' as Severity,
    description:
      'After DELETE /customer, the customer record must be purged or marked DELETED/INACTIVE',
  },
] as const;
