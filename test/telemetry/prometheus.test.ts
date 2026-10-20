import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { lint } from '../../src/lint.js';
import { calculateReadiness } from '../../src/readiness.js';
import {
  collectMetrics,
  collectTlsCertExpiries,
  collectValidatorStatuses,
  escapeLabelValue,
  metricsFromLintResult,
  PrometheusMetricsServer,
  renderPrometheusText,
  PROMETHEUS_CONTENT_TYPE,
  type MetricsSnapshot,
} from '../../src/telemetry/prometheus-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const VALID_TOML = readFileSync(join(here, '..', 'fixtures', 'valid.toml'), 'utf8');

const servers: PrometheusMetricsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('Prometheus text exposition (#376)', () => {
  it('renders all four metric families with HELP and TYPE headers', () => {
    const text = renderPrometheusText({});

    for (const name of [
      'stellar_toml_compliance_score_ratio',
      'stellar_toml_tls_cert_expiry_seconds',
      'stellar_toml_rule_violations',
      'stellar_toml_validator_online_status',
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} gauge`);
    }
  });

  it('is deterministic: equal snapshots render byte-identical text', () => {
    const snapshot: MetricsSnapshot = {
      complianceScore: 0.95,
      tlsCertificates: [
        { endpoint: 'b.example.com:443', expirySeconds: 20 },
        { endpoint: 'a.example.com:443', expirySeconds: 10 },
      ],
      violations: [
        { ruleId: 'security/x', severity: 'warning', count: 2 },
        { ruleId: 'security/x', severity: 'error', count: 1 },
      ],
      validators: [
        { validator: 'z', online: false },
        { validator: 'a', online: true },
      ],
    };

    const first = renderPrometheusText(snapshot);
    const second = renderPrometheusText({ ...snapshot });

    expect(first).toBe(second);
    expect(first.indexOf('a.example.com')).toBeLessThan(first.indexOf('b.example.com'));
    expect(first.indexOf('security/x",severity="error')).toBeLessThan(
      first.indexOf('security/x",severity="warning'),
    );
    expect(first).toContain('stellar_toml_validator_online_status{validator="z"} 0');
  });

  it('clamps the compliance score to the 0.0-1.0 gauge range', () => {
    expect(renderPrometheusText({ complianceScore: 1.5 })).toContain(
      'stellar_toml_compliance_score_ratio 1',
    );
    expect(renderPrometheusText({ complianceScore: -3 })).toContain(
      'stellar_toml_compliance_score_ratio 0',
    );
  });

  it('escapes backslashes, quotes, and newlines in label values', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const text = renderPrometheusText({
      violations: [{ ruleId: 'path"with\\chars', severity: 'info', count: 1 }],
    });
    expect(text).toContain('rule_id="path\\"with\\\\chars"');
  });
});

describe('snapshot construction', () => {
  it('derives the compliance ratio and grouped violations from a lint result', () => {
    const result = lint(VALID_TOML);
    const snapshot = metricsFromLintResult(result);

    expect(snapshot.complianceScore).toBe(calculateReadiness(result).score / 100);
    expect(snapshot.complianceScore).toBeGreaterThanOrEqual(0);
    expect(snapshot.complianceScore).toBeLessThanOrEqual(1);
    expect(snapshot.violations).toEqual([]);
  });

  it('reports a zero score and parse violations for unparseable TOML', () => {
    const result = lint('WEB_AUTH_ENDPOINT = ');
    const snapshot = metricsFromLintResult(result);

    expect(snapshot.complianceScore).toBe(0);
    expect(snapshot.violations!.length).toBeGreaterThan(0);
  });

  it('groups repeated findings by rule id and severity', () => {
    const result = lint(VALID_TOML);
    const diagnostics = [
      {
        rule: 'security/x',
        severity: 'warning' as const,
        category: 'network' as const,
        message: 'a',
      },
      {
        rule: 'security/x',
        severity: 'warning' as const,
        category: 'network' as const,
        message: 'b',
      },
      {
        rule: 'security/x',
        severity: 'error' as const,
        category: 'network' as const,
        message: 'c',
      },
    ];
    const snapshot = metricsFromLintResult({ ...result, diagnostics });

    expect(snapshot.violations).toEqual(
      expect.arrayContaining([
        { ruleId: 'security/x', severity: 'warning', count: 2 },
        { ruleId: 'security/x', severity: 'error', count: 1 },
      ]),
    );
  });

  it('collects certificate expiries through the injected probe', async () => {
    const probe = vi.fn(async () => new Date('2026-01-01T00:00:00Z'));
    const doc = {
      WEB_AUTH_ENDPOINT: 'https://auth.example.com/sep10',
      TRANSFER_SERVER: 'https://api.example.com:8443/sep6',
    };

    const metrics = await collectTlsCertExpiries(doc, {
      probe,
      now: new Date('2025-12-31T00:00:00Z'),
    });

    expect(probe).toHaveBeenCalledWith('auth.example.com', 443);
    expect(probe).toHaveBeenCalledWith('api.example.com', 8443);
    expect(metrics).toEqual(
      expect.arrayContaining([
        { endpoint: 'auth.example.com:443', expirySeconds: 86_400 },
        { endpoint: 'api.example.com:8443', expirySeconds: 86_400 },
      ]),
    );
    expect(metrics).toHaveLength(2);
  });

  it('omits endpoints the certificate probe cannot observe', async () => {
    const metrics = await collectTlsCertExpiries(
      { WEB_AUTH_ENDPOINT: 'https://auth.example.com/sep10' },
      { probe: async () => null },
    );

    expect(metrics).toEqual([]);
    expect(await collectTlsCertExpiries({ VERSION: '2.7.0' })).toEqual([]);
  });

  it('labels validator status by ALIAS and treats probe failures as offline', async () => {
    const doc = {
      VALIDATORS: [
        { ALIAS: 'core-eu', HOST: 'core.example.com:11625' },
        { HOST: 'core.example.com:11625' },
        { HOST: 'down.example.com:11625' },
      ],
    };
    const probe = vi.fn(async (host: string) => {
      if (host === 'down.example.com') throw new Error('refused');
      return true;
    });

    const metrics = await collectValidatorStatuses(doc, { probe });

    expect(metrics).toEqual([
      { validator: 'core-eu', online: true },
      { validator: 'down.example.com:11625', online: false },
    ]);
  });

  it('collectMetrics combines the lint result with both network probes', async () => {
    const result = lint(VALID_TOML);
    const snapshot = await collectMetrics(
      { WEB_AUTH_ENDPOINT: 'https://auth.example.com/sep10' },
      result,
      {
        certProbe: async () => new Date('2026-01-01T00:00:00Z'),
        validatorProbe: async () => true,
        now: new Date('2025-12-31T00:00:00Z'),
      },
    );

    expect(snapshot.complianceScore).toBe(calculateReadiness(result).score / 100);
    expect(snapshot.tlsCertificates).toEqual([
      { endpoint: 'auth.example.com:443', expirySeconds: 86_400 },
    ]);
    expect(snapshot.violations).toEqual([]);
  });
});

describe('PrometheusMetricsServer', () => {
  it('serves the exposition format on GET /metrics over an ephemeral port', async () => {
    const server = new PrometheusMetricsServer({
      port: 0,
      host: '127.0.0.1',
      collect: () => ({ complianceScore: 1 }),
    });
    servers.push(server);
    await server.start();

    const response = await fetch(server.url());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
    const body = await response.text();
    expect(body).toContain('stellar_toml_compliance_score_ratio 1');
  });

  it('calls collect on every scrape so the snapshot stays current', async () => {
    let score = 0.5;
    const collect = vi.fn(() => ({ complianceScore: score }));
    const server = new PrometheusMetricsServer({ port: 0, host: '127.0.0.1', collect });
    servers.push(server);
    await server.start();

    const first = await (await fetch(server.url())).text();
    score = 0.9;
    const second = await (await fetch(server.url())).text();

    expect(collect).toHaveBeenCalledTimes(2);
    expect(first).toContain('stellar_toml_compliance_score_ratio 0.5');
    expect(second).toContain('stellar_toml_compliance_score_ratio 0.9');
  });

  it('rejects non-/metrics paths and non-GET methods', async () => {
    const server = new PrometheusMetricsServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await server.start();

    const missing = await fetch(new URL('/healthz', server.url()));
    expect(missing.status).toBe(404);

    const method = await fetch(server.url(), { method: 'POST' });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET, HEAD');
  });

  it('serves the last snapshot when a collection fails', async () => {
    const collect = vi
      .fn<() => MetricsSnapshot>()
      .mockReturnValueOnce({ complianceScore: 1 })
      .mockRejectedValueOnce(new Error('probe exploded'));
    const server = new PrometheusMetricsServer({ port: 0, host: '127.0.0.1', collect });
    servers.push(server);
    await server.start();

    expect(await (await fetch(server.url())).text()).toContain('_ratio 1');

    const afterFailure = await fetch(server.url());
    expect(afterFailure.status).toBe(200);
    expect(await afterFailure.text()).toContain('_ratio 1');
  });

  it('serves a provided snapshot when no collector is set', async () => {
    const server = new PrometheusMetricsServer({ port: 0, host: '127.0.0.1' });
    server.setSnapshot({ validators: [{ validator: 'core', online: true }] });
    servers.push(server);
    await server.start();

    expect(await (await fetch(server.url())).text()).toContain(
      'stellar_toml_validator_online_status{validator="core"} 1',
    );
  });
});
