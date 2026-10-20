import { describe, expect, it } from 'vitest';
import {
  verifySep12Deletion,
  DELETE_CUSTOMER_UNSUPPORTED_RULE,
  CUSTOMER_RECORD_RETENTION_FAILURE_RULE,
  sep12DeletionRules,
} from '../../src/protocols/sep12-deletion.js';

const KYC_SERVER = 'https://kyc.example.com/sep12';
const DOC = { KYC_SERVER };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Routes {
  putCustomer?: (payload: Record<string, unknown>) => Response;
  deleteCustomer?: () => Response;
  getCustomer?: (id: string) => Response;
}

function fetchServer(routes: Routes): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'PUT' && url.pathname.endsWith('/customer')) {
      const payload =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      return (routes.putCustomer ?? (() => jsonResponse({ id: 'cust-1', status: 'PROCESSING' })))(
        payload,
      );
    }

    if (method === 'DELETE' && url.pathname.includes('/customer/')) {
      return (routes.deleteCustomer ?? (() => jsonResponse({})))();
    }

    if (method === 'GET' && url.pathname.includes('/customer/')) {
      return (routes.getCustomer ?? (() => jsonResponse({ id: 'cust-1', status: 'DELETED' })))('');
    }

    throw new Error(`unexpected request ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe('SEP-12 customer deletion verifier', () => {
  it('passes when DELETE /customer is implemented and record is purged', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({ success: true }, 200),
        getCustomer: () => jsonResponse({ id: 'cust-1', status: 'DELETED' }),
      }),
    );
    expect(diagnostics).toEqual([]);
  });

  it('asserts sep12/delete-customer-unsupported when DELETE returns 405', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({ error: 'Method Not Allowed' }, 405),
      }),
    );

    const hits = diagnostics.filter((d) => d.rule === DELETE_CUSTOMER_UNSUPPORTED_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('warning');
    expect(hits[0]?.message).toContain('405');
  });

  it('asserts sep12/delete-customer-unsupported when DELETE returns 501', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({ error: 'Not Implemented' }, 501),
      }),
    );

    const hits = diagnostics.filter((d) => d.rule === DELETE_CUSTOMER_UNSUPPORTED_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('warning');
    expect(hits[0]?.message).toContain('501');
  });

  it('asserts sep12/delete-customer-unsupported when DELETE returns 404', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({ error: 'Not Found' }, 404),
      }),
    );

    const hits = diagnostics.filter((d) => d.rule === DELETE_CUSTOMER_UNSUPPORTED_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('warning');
  });

  it('asserts sep12/customer-record-retention-failure when GET after DELETE returns active status', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({}, 200),
        getCustomer: () => jsonResponse({ id: 'cust-1', status: 'ACCEPTED' }),
      }),
    );

    const hits = diagnostics.filter((d) => d.rule === CUSTOMER_RECORD_RETENTION_FAILURE_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('ACCEPTED');
  });

  it('asserts sep12/customer-record-retention-failure when GET after DELETE returns PROCESSING', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({}, 200),
        getCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
      }),
    );

    const hits = diagnostics.filter((d) => d.rule === CUSTOMER_RECORD_RETENTION_FAILURE_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('PROCESSING');
  });

  it('stays silent when KYC_SERVER is absent', async () => {
    expect(await verifySep12Deletion({}, fetchServer({}))).toEqual([]);
  });

  it('stays silent when KYC_SERVER is not a valid URL', async () => {
    expect(await verifySep12Deletion({ KYC_SERVER: 'not a url' }, fetchServer({}))).toEqual([]);
  });

  it('honours severity overrides', async () => {
    const diagnostics = await verifySep12Deletion(
      DOC,
      fetchServer({
        putCustomer: () => jsonResponse({ id: 'cust-1', status: 'PROCESSING' }),
        deleteCustomer: () => jsonResponse({ error: 'Method Not Allowed' }, 405),
      }),
      {
        rules: { [DELETE_CUSTOMER_UNSUPPORTED_RULE]: 'off' },
      },
    );
    expect(diagnostics.filter((d) => d.rule === DELETE_CUSTOMER_UNSUPPORTED_RULE)).toEqual([]);
  });
});

describe('sep12DeletionRules', () => {
  it('registers every diagnostic the suite can emit', () => {
    const byId = new Map(sep12DeletionRules.map((rule) => [rule.id, rule]));

    expect([...byId.keys()].sort()).toEqual(
      [DELETE_CUSTOMER_UNSUPPORTED_RULE, CUSTOMER_RECORD_RETENTION_FAILURE_RULE].sort(),
    );
    expect(byId.get(DELETE_CUSTOMER_UNSUPPORTED_RULE)?.severity).toBe('warning');
    expect(byId.get(CUSTOMER_RECORD_RETENTION_FAILURE_RULE)?.severity).toBe('error');
    for (const rule of sep12DeletionRules) expect(rule.category).toBe('sep12');
  });
});
