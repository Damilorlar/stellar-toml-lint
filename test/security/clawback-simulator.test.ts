import { describe, expect, it } from 'vitest';
import {
  simulateClawback,
  CLAWBACK_PERMISSION_MISMATCH_RULE,
  clawbackSimulatorRules,
} from '../../src/security/clawback-simulator.js';

const HORIZON_URL = 'https://horizon.example.com';
const SOROBAN_RPC_URL = 'https://soroban.example.com/rpc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Asset clawback transaction lifecycle simulator', () => {
  it('passes when classic asset has valid issuer authority and compliance explanation', async () => {
    const doc = {
      HORIZON_URL,
      SOROBAN_RPC_URL,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
          clawback_enabled: true,
          desc: 'Regulated USD with AML/sanctions clawback authority for compliance',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/accounts/')) {
        return jsonResponse({
          account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
          signers: [
            {
              key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              weight: 2,
              type: 'ed25519_public_key',
            },
          ],
        });
      }
      if (urlStr.includes('/rpc') || urlStr.includes('soroban')) {
        return rpcResponse({ result: { auth: [] } });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    expect(diagnostics).toEqual([]);
  });

  it('passes when Soroban asset has valid contract authority and compliance explanation', async () => {
    const doc = {
      HORIZON_URL,
      SOROBAN_RPC_URL,
      CURRENCIES: [
        {
          code: 'EUR',
          contract: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          is_asset_anchored: true,
          clawback_enabled: true,
          desc: 'Regulated EUR with sanctions compliance clawback via Soroban',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/rpc') || urlStr.includes('soroban')) {
        return rpcResponse({ result: { auth: [] } });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    expect(diagnostics).toEqual([]);
  });

  it('asserts security/clawback-permission-mismatch when classic issuer lacks high threshold signer', async () => {
    const doc = {
      HORIZON_URL,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
          clawback_enabled: true,
          desc: 'Regulated USD with AML clawback authority',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/accounts/')) {
        return jsonResponse({
          account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
          signers: [
            {
              key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              weight: 1,
              type: 'ed25519_public_key',
            },
          ],
        });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    const hits = diagnostics.filter((d) => d.rule === CLAWBACK_PERMISSION_MISMATCH_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('weight');
  });

  it('asserts security/clawback-permission-mismatch when Soroban contract simulation fails', async () => {
    const doc = {
      SOROBAN_RPC_URL,
      CURRENCIES: [
        {
          code: 'EUR',
          contract: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          is_asset_anchored: true,
          clawback_enabled: true,
          desc: 'Regulated EUR with sanctions compliance clawback',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/rpc') || urlStr.includes('soroban')) {
        return rpcResponse({ error: 'Simulation failed' }, 500);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    const hits = diagnostics.filter((d) => d.rule === CLAWBACK_PERMISSION_MISMATCH_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('Soroban');
  });

  it('asserts security/clawback-permission-mismatch when clawback_enabled but no compliance explanation in desc', async () => {
    const doc = {
      HORIZON_URL,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
          clawback_enabled: true,
          desc: 'Just a regular USD token',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/accounts/')) {
        return jsonResponse({
          account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
          signers: [
            {
              key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              weight: 2,
              type: 'ed25519_public_key',
            },
          ],
        });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    const hits = diagnostics.filter((d) => d.rule === CLAWBACK_PERMISSION_MISMATCH_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('description lacks');
  });

  it('asserts security/clawback-permission-mismatch when clawback_enabled but is_asset_anchored is false', async () => {
    const doc = {
      HORIZON_URL,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: false,
          clawback_enabled: true,
          desc: 'Regulated USD with AML clawback authority',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/accounts/')) {
        return jsonResponse({
          account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
          signers: [
            {
              key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              weight: 2,
              type: 'ed25519_public_key',
            },
          ],
        });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    const hits = diagnostics.filter((d) => d.rule === CLAWBACK_PERMISSION_MISMATCH_RULE);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.severity).toBe('error');
    expect(hits[0]?.message).toContain('is_asset_anchored is not true');
  });

  it('skips assets without clawback_enabled', async () => {
    const doc = {
      HORIZON_URL,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
          clawback_enabled: false,
          desc: 'Regular USD without clawback',
        },
      ],
    };

    const fetchImpl = (async () =>
      jsonResponse({ error: 'Not found' }, 404)) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl);
    expect(diagnostics).toEqual([]);
  });

  it('honours severity overrides', async () => {
    const doc = {
      HORIZON_URL,
      CURRENCIES: [
        {
          code: 'USD',
          issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          is_asset_anchored: true,
          clawback_enabled: true,
          desc: 'Regulated USD with AML clawback authority',
        },
      ],
    };

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/accounts/')) {
        return jsonResponse({
          account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
          signers: [
            {
              key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              weight: 1,
              type: 'ed25519_public_key',
            },
          ],
        });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }) as unknown as typeof fetch;

    const diagnostics = await simulateClawback(doc, fetchImpl, {
      rules: { [CLAWBACK_PERMISSION_MISMATCH_RULE]: 'off' },
    });
    expect(diagnostics.filter((d) => d.rule === CLAWBACK_PERMISSION_MISMATCH_RULE)).toEqual([]);
  });
});

describe('clawbackSimulatorRules', () => {
  it('registers the diagnostic the suite can emit', () => {
    const byId = new Map(clawbackSimulatorRules.map((rule) => [rule.id, rule]));

    expect([...byId.keys()]).toEqual([CLAWBACK_PERMISSION_MISMATCH_RULE]);
    expect(byId.get(CLAWBACK_PERMISSION_MISMATCH_RULE)?.severity).toBe('error');
    expect(byId.get(CLAWBACK_PERMISSION_MISMATCH_RULE)?.category).toBe('security');
  });
});
