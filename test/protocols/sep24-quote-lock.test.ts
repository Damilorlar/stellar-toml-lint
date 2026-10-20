import { describe, expect, it } from 'vitest';
import {
  verifySep24QuoteLock,
  QUOTE_FEE_INSTABILITY_RULE,
  sep24QuoteLockRules,
} from '../../src/protocols/sep24-quote-lock.js';

const TRANSFER_SERVER = 'https://transfer.example.com/sep24';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Routes {
  interactiveDeposit?: () => Response;
  getTransaction?: (id: string) => Response;
}

function fetchServer(routes: Routes): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'POST' && url.pathname.endsWith('/transactions/deposit/interactive')) {
      return (
        routes.interactiveDeposit ??
        (() =>
          jsonResponse({
            id: 'txn-1',
            url: 'https://example.com/interactive',
          }))
      )();
    }

    if (method === 'GET' && url.pathname.includes('/transactions/')) {
      const id = url.pathname.split('/transactions/')[1] ?? '';
      return (
        routes.getTransaction ??
        (() =>
          jsonResponse({
            id: 'txn-1',
            status: 'pending',
            amount_fee: { fixed: 1.5, percent: 0.5 },
          }))
      )(id);
    }

    throw new Error(`unexpected request ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe('SEP-24 transaction fee quote lock verifier', () => {
  it('passes when fee quote remains stable across polls', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
        },
      ],
    };

    let pollCount = 0;
    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () =>
          jsonResponse({ id: 'txn-1', url: 'https://example.com/interactive' }),
        getTransaction: () => {
          pollCount++;
          return jsonResponse({
            id: 'txn-1',
            status: pollCount >= 3 ? 'completed' : 'pending',
            amount_fee: { fixed: 1.5, percent: 0.5, minimum: 0.5 },
          });
        },
      }),
      { pollIntervalMs: 10, pollDurationMs: 100 },
    );

    expect(diagnostics).toEqual([]);
  });

  it('passes when transaction completes quickly with stable fee', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'EUR',
          issuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF',
          is_asset_anchored: true,
        },
      ],
    };

    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () =>
          jsonResponse({ id: 'txn-1', url: 'https://example.com/interactive' }),
        getTransaction: () =>
          jsonResponse({
            id: 'txn-1',
            status: 'completed',
            amount_fee: { fixed: 2.0, percent: 0.3 },
          }),
      }),
      { pollIntervalMs: 10, pollDurationMs: 100 },
    );

    expect(diagnostics).toEqual([]);
  });

  it('asserts sep24/quote-fee-instability when fee changes mid-session', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
        },
      ],
    };

    let pollCount = 0;
    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () =>
          jsonResponse({ id: 'txn-1', url: 'https://example.com/interactive' }),
        getTransaction: () => {
          pollCount++;
          if (pollCount === 1) {
            return jsonResponse({
              id: 'txn-1',
              status: 'pending',
              amount_fee: { fixed: 1.5, percent: 0.5 },
            });
          }
          return jsonResponse({
            id: 'txn-1',
            status: 'pending',
            amount_fee: { fixed: 2.5, percent: 0.5 },
          });
        },
      }),
      { pollIntervalMs: 10, pollDurationMs: 100 },
    );

    const hits = diagnostics.filter((d) => d.rule === QUOTE_FEE_INSTABILITY_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('fee quote changed');
    expect(hits[0]?.message).toContain('1.5');
    expect(hits[0]?.message).toContain('2.5');
  });

  it('asserts sep24/quote-fee-instability when percent fee changes', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
        },
      ],
    };

    let pollCount = 0;
    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () =>
          jsonResponse({ id: 'txn-1', url: 'https://example.com/interactive' }),
        getTransaction: () => {
          pollCount++;
          if (pollCount === 1) {
            return jsonResponse({
              id: 'txn-1',
              status: 'pending',
              amount_fee: { percent: 0.5 },
            });
          }
          return jsonResponse({
            id: 'txn-1',
            status: 'pending',
            amount_fee: { percent: 1.0 },
          });
        },
      }),
      { pollIntervalMs: 10, pollDurationMs: 100 },
    );

    const hits = diagnostics.filter((d) => d.rule === QUOTE_FEE_INSTABILITY_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('percent');
  });

  it('asserts sep24/quote-fee-instability when minimum fee changes', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
        },
      ],
    };

    let pollCount = 0;
    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () =>
          jsonResponse({ id: 'txn-1', url: 'https://example.com/interactive' }),
        getTransaction: () => {
          pollCount++;
          if (pollCount === 1) {
            return jsonResponse({
              id: 'txn-1',
              status: 'pending',
              amount_fee: { fixed: 1.0, minimum: 0.5 },
            });
          }
          return jsonResponse({
            id: 'txn-1',
            status: 'pending',
            amount_fee: { fixed: 1.0, minimum: 1.0 },
          });
        },
      }),
      { pollIntervalMs: 10, pollDurationMs: 100 },
    );

    const hits = diagnostics.filter((d) => d.rule === QUOTE_FEE_INSTABILITY_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('minimum');
  });

  it('stays silent when TRANSFER_SERVER_SEP0024 is absent', async () => {
    const doc = { CURRENCIES: [] };
    const diagnostics = await verifySep24QuoteLock(doc, fetchServer({}));
    expect(diagnostics).toEqual([]);
  });

  it('stays silent when no anchored currencies', async () => {
    const doc = { TRANSFER_SERVER_SEP0024: TRANSFER_SERVER, CURRENCIES: [] };
    const diagnostics = await verifySep24QuoteLock(doc, fetchServer({}));
    expect(diagnostics).toEqual([]);
  });

  it('stays silent when interactive deposit fails', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
        },
      ],
    };

    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () => jsonResponse({ error: 'Unauthorized' }, 401),
      }),
    );
    expect(diagnostics).toEqual([]);
  });

  it('honours severity overrides', async () => {
    const doc = {
      TRANSFER_SERVER_SEP0024: TRANSFER_SERVER,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
        },
      ],
    };

    let pollCount = 0;
    const diagnostics = await verifySep24QuoteLock(
      doc,
      fetchServer({
        interactiveDeposit: () =>
          jsonResponse({ id: 'txn-1', url: 'https://example.com/interactive' }),
        getTransaction: () => {
          pollCount++;
          if (pollCount === 1) {
            return jsonResponse({ id: 'txn-1', status: 'pending', amount_fee: { fixed: 1.5 } });
          }
          return jsonResponse({ id: 'txn-1', status: 'pending', amount_fee: { fixed: 2.5 } });
        },
      }),
      {
        rules: { [QUOTE_FEE_INSTABILITY_RULE]: 'off' },
        pollIntervalMs: 10,
        pollDurationMs: 100,
      },
    );
    expect(diagnostics.filter((d) => d.rule === QUOTE_FEE_INSTABILITY_RULE)).toEqual([]);
  });
});

describe('sep24QuoteLockRules', () => {
  it('registers the diagnostic the suite can emit', () => {
    const byId = new Map(sep24QuoteLockRules.map((rule) => [rule.id, rule]));

    expect([...byId.keys()]).toEqual([QUOTE_FEE_INSTABILITY_RULE]);
    expect(byId.get(QUOTE_FEE_INSTABILITY_RULE)?.severity).toBe('error');
    expect(byId.get(QUOTE_FEE_INSTABILITY_RULE)?.category).toBe('network');
  });
});
