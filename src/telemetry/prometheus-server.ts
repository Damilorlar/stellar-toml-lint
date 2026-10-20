/**
 * Native Prometheus metrics scrape exporter (issue #376).
 *
 * Kubernetes clusters running an anchor monitoring daemon scrape an HTTP
 * `GET /metrics` endpoint on a fixed interval. This module serves the standard
 * Prometheus text exposition format (`text/plain; version=0.0.4`) from Node's
 * built-in `node:http`, with no Prometheus client dependency to audit:
 *
 * - `stellar_toml_compliance_score_ratio` — the readiness score as a 0.0–1.0
 *   gauge, so a dashboard can alert on a compliance regression.
 * - `stellar_toml_tls_cert_expiry_seconds` — seconds until each declared
 *   endpoint's TLS certificate expires (negative once it has).
 * - `stellar_toml_rule_violations` — the lint findings, labelled by `rule_id`
 *   and `severity`.
 * - `stellar_toml_validator_online_status` — 1 when a declared
 *   `[[VALIDATORS]].HOST` port accepts a TCP connection, 0 otherwise.
 *
 * The snapshot is collected lazily: the server calls its `collect` callback on
 * every scrape, so a long-running daemon always exports current data and the
 * scrape interval (controlled by Prometheus, not by us) bounds how often the
 * network probes run.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { calculateReadiness } from '../readiness.js';
import type { LintResult, Severity } from '../types.js';
import { endpointsOf, handshakeProbe, type CertExpiryProbe } from '../network/cert-expiry.js';
import { defaultTcpProbe, validatorHostsOf, type TcpPortProbe } from '../validators/net-probe.js';

/** The Prometheus text exposition content type. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** The port Kubernetes deployments commonly suggest for anchor exporters. */
export const DEFAULT_METRICS_PORT = 9464;

/** How long a metrics-time probe may take before it counts as offline. */
export const DEFAULT_METRICS_PROBE_TIMEOUT_MS = 5_000;

/** Seconds until one endpoint's TLS certificate expires. */
export interface TlsCertificateMetric {
  /** `host:port` of the declared endpoint. */
  endpoint: string;
  /** Seconds until `valid_to`, negative when already expired. */
  expirySeconds: number;
}

/** One lint rule's findings, split by severity. */
export interface RuleViolationMetric {
  ruleId: string;
  severity: Severity;
  count: number;
}

/** Whether a declared validator's overlay port accepted a connection. */
export interface ValidatorStatusMetric {
  /** `ALIAS` when the entry names one, otherwise `HOST`. */
  validator: string;
  online: boolean;
}

/** Everything one scrape exposes. Every field is optional. */
export interface MetricsSnapshot {
  /** Readiness score divided by 100, so the gauge stays within 0.0–1.0. */
  complianceScore?: number;
  tlsCertificates?: TlsCertificateMetric[];
  violations?: RuleViolationMetric[];
  validators?: ValidatorStatusMetric[];
}

export interface PrometheusMetricsServerOptions {
  /** Port to bind. `0` picks an ephemeral port; the default is 9464. */
  port?: number;
  /** Interface to bind. Defaults to all interfaces. */
  host?: string;
  /**
   * Snapshot provider, invoked on every scrape when set. Returning a promise
   * lets a daemon refresh its lint result and network probes lazily.
   */
  collect?: () => MetricsSnapshot | Promise<MetricsSnapshot>;
  /**
   * When true the listening socket keeps the process alive on its own. The
   * CLI sets it for a standalone exporter; tests leave it off so a forgotten
   * `stop()` cannot hang the runner.
   */
  keepAlive?: boolean;
}

/** Escapes a Prometheus label value per the exposition format's rules. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Renders a numeric sample, mapping non-finite values to Prometheus' `NaN`. */
function sampleValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/** Builds `name{a="b",c="d"}`, or just `name` when there are no labels. */
function series(name: string, labels: Record<string, string> = {}): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  const rendered = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `${name}{${rendered}}`;
}

/**
 * Renders a snapshot in the Prometheus text exposition format.
 *
 * Deterministic by construction: metrics, label sets, and samples are sorted,
 * so two equal snapshots always produce byte-identical output and a test never
 * depends on object key order.
 */
export function renderPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push(
    '# HELP stellar_toml_compliance_score_ratio SEP-1 wallet listing readiness score as a 0.0-1.0 ratio.',
  );
  lines.push('# TYPE stellar_toml_compliance_score_ratio gauge');
  if (snapshot.complianceScore !== undefined) {
    const score = Math.min(1, Math.max(0, snapshot.complianceScore));
    lines.push(`stellar_toml_compliance_score_ratio ${sampleValue(score)}`);
  }

  lines.push(
    '# HELP stellar_toml_tls_cert_expiry_seconds Seconds until the declared endpoint TLS certificate expires, negative once expired.',
  );
  lines.push('# TYPE stellar_toml_tls_cert_expiry_seconds gauge');
  for (const certificate of [...(snapshot.tlsCertificates ?? [])].sort((a, b) =>
    a.endpoint.localeCompare(b.endpoint),
  )) {
    lines.push(
      `${series('stellar_toml_tls_cert_expiry_seconds', { endpoint: certificate.endpoint })} ${sampleValue(certificate.expirySeconds)}`,
    );
  }

  lines.push(
    '# HELP stellar_toml_rule_violations Lint findings currently reported, labelled by rule id and severity.',
  );
  lines.push('# TYPE stellar_toml_rule_violations gauge');
  for (const violation of [...(snapshot.violations ?? [])].sort(
    (a, b) => a.ruleId.localeCompare(b.ruleId) || a.severity.localeCompare(b.severity),
  )) {
    lines.push(
      `${series('stellar_toml_rule_violations', {
        rule_id: violation.ruleId,
        severity: violation.severity,
      })} ${sampleValue(violation.count)}`,
    );
  }

  lines.push(
    '# HELP stellar_toml_validator_online_status Whether the validator overlay port accepted a TCP connection (1) or not (0).',
  );
  lines.push('# TYPE stellar_toml_validator_online_status gauge');
  for (const validator of [...(snapshot.validators ?? [])].sort((a, b) =>
    a.validator.localeCompare(b.validator),
  )) {
    lines.push(
      `${series('stellar_toml_validator_online_status', { validator: validator.validator })} ${validator.online ? 1 : 0}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/** Turns a lint result into the offline part of a snapshot. */
export function metricsFromLintResult(
  result: LintResult,
  extras: Pick<MetricsSnapshot, 'tlsCertificates' | 'validators'> = {},
): MetricsSnapshot {
  const complianceScore = result.parsed === undefined ? 0 : calculateReadiness(result).score / 100;

  const violations = new Map<string, RuleViolationMetric>();
  for (const diagnostic of result.diagnostics) {
    const key = `${diagnostic.rule}\u0000${diagnostic.severity}`;
    const existing = violations.get(key);
    if (existing === undefined) {
      violations.set(key, {
        ruleId: diagnostic.rule,
        severity: diagnostic.severity,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }

  return {
    complianceScore,
    violations: [...violations.values()],
    ...(extras.tlsCertificates !== undefined ? { tlsCertificates: extras.tlsCertificates } : {}),
    ...(extras.validators !== undefined ? { validators: extras.validators } : {}),
  };
}

/**
 * Seconds until each declared HTTPS endpoint's certificate expires.
 *
 * Reuses the certificate-expiry audit's endpoint extraction and probe, so the
 * metric always agrees with `security/tls-cert-expiring-soon`. Endpoints the
 * probe cannot observe are omitted rather than exported as zero.
 */
export async function collectTlsCertExpiries(
  doc: Record<string, unknown>,
  options: { probe?: CertExpiryProbe; now?: Date } = {},
): Promise<TlsCertificateMetric[]> {
  const endpoints = endpointsOf(doc);
  if (endpoints.length === 0) return [];

  const probe = options.probe ?? handshakeProbe;
  const now = options.now ?? new Date();
  const metrics: TlsCertificateMetric[] = [];

  for (const endpoint of endpoints) {
    const expiry = await probe(endpoint.host, endpoint.port);
    if (expiry === null) continue;
    metrics.push({
      endpoint: `${endpoint.host}:${endpoint.port}`,
      expirySeconds: Math.round((expiry.getTime() - now.getTime()) / 1000),
    });
  }

  return metrics;
}

/**
 * Online status of each declared validator overlay port.
 *
 * The label is the entry's `ALIAS` when present, falling back to `HOST`, so a
 * dashboard reads names rather than addresses. A probe that throws degrades to
 * offline (`0`) rather than failing the scrape.
 */
export async function collectValidatorStatuses(
  doc: Record<string, unknown>,
  options: { probe?: TcpPortProbe; timeoutMs?: number } = {},
): Promise<ValidatorStatusMetric[]> {
  const entries = Array.isArray(doc.VALIDATORS) ? doc.VALIDATORS : [];
  const names = new Map<string, string>();
  entries.forEach((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    if (typeof record.HOST !== 'string') return;
    // A later entry for the same address must not clobber an earlier ALIAS.
    if (!names.has(record.HOST) || typeof record.ALIAS === 'string') {
      names.set(record.HOST, typeof record.ALIAS === 'string' ? record.ALIAS : record.HOST);
    }
  });

  const hosts = validatorHostsOf(doc);
  if (hosts.length === 0) return [];

  const probe = options.probe ?? defaultTcpProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_METRICS_PROBE_TIMEOUT_MS;
  const metrics: ValidatorStatusMetric[] = [];

  for (const { host, port } of hosts) {
    const online = await probe(host, port, timeoutMs).catch(() => false);
    metrics.push({
      validator: names.get(`${host}:${port}`) ?? `${host}:${port}`,
      online,
    });
  }

  return metrics;
}

/**
 * A `node:http` server exposing one `/metrics` endpoint.
 *
 * `collect` is called on every scrape, with the previous snapshot served to any
 * concurrent request while a new one is being gathered, so a slow probe never
 * blocks Prometheus or doubles the load.
 */
export class PrometheusMetricsServer {
  readonly port: number;
  readonly host: string;
  private readonly collect: (() => MetricsSnapshot | Promise<MetricsSnapshot>) | undefined;
  private readonly keepAlive: boolean;
  private server: Server | undefined;
  private latest: MetricsSnapshot = {};
  private inFlight: Promise<MetricsSnapshot> | undefined;

  constructor(options: PrometheusMetricsServerOptions = {}) {
    this.port = options.port ?? DEFAULT_METRICS_PORT;
    this.host = options.host ?? '0.0.0.0';
    this.collect = options.collect;
    this.keepAlive = options.keepAlive ?? false;
  }

  /** Replaces the snapshot served until the next collection. */
  setSnapshot(snapshot: MetricsSnapshot): void {
    this.latest = snapshot;
  }

  /** The port the server is actually bound to (useful when `port` was 0). */
  get boundPort(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null
      ? (address as AddressInfo).port
      : this.port;
  }

  /** The scrape URL, with the bound port when the server is listening. */
  url(): string {
    const host = this.host === '0.0.0.0' || this.host === '::' ? 'localhost' : this.host;
    return `http://${host}:${this.boundPort}/metrics`;
  }

  private async snapshot(): Promise<MetricsSnapshot> {
    if (this.collect === undefined) return this.latest;
    if (this.inFlight !== undefined) return this.inFlight;

    const pending = Promise.resolve(this.collect()).then(
      (snapshot) => {
        this.latest = snapshot;
        this.inFlight = undefined;
        return snapshot;
      },
      () => {
        this.inFlight = undefined;
        return this.latest;
      },
    );
    this.inFlight = pending;
    return pending;
  }

  private handle = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? '/').split('?')[0];
    if (path !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found. The scrape endpoint is GET /metrics.\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
        allow: 'GET, HEAD',
      });
      response.end('Method not allowed.\n');
      return;
    }

    void this.snapshot().then((snapshot) => {
      const body = renderPrometheusText(snapshot);
      response.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE });
      response.end(request.method === 'HEAD' ? undefined : body);
    });
  };

  /** Starts listening. Resolves with the bound address once ready. */
  async start(): Promise<{ host: string; port: number }> {
    if (this.server !== undefined) return { host: this.host, port: this.boundPort };

    const server = createServer(this.handle);
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    // A live scrape endpoint should not keep a test runner alive by itself;
    // the standalone CLI exporter opts into keeping the process up.
    if (!this.keepAlive) server.unref();

    return { host: this.host, port: this.boundPort };
  }

  /** Stops the server and waits for open connections to close. */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }
}

/** Builds a snapshot from a lint result plus the two network-derived metrics. */
export async function collectMetrics(
  doc: Record<string, unknown>,
  result: LintResult,
  options: {
    certProbe?: CertExpiryProbe;
    validatorProbe?: TcpPortProbe;
    probeTimeoutMs?: number;
    now?: Date;
  } = {},
): Promise<MetricsSnapshot> {
  const [tlsCertificates, validators] = await Promise.all([
    collectTlsCertExpiries(doc, {
      ...(options.certProbe !== undefined ? { probe: options.certProbe } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
    collectValidatorStatuses(doc, {
      ...(options.validatorProbe !== undefined ? { probe: options.validatorProbe } : {}),
      ...(options.probeTimeoutMs !== undefined ? { timeoutMs: options.probeTimeoutMs } : {}),
    }),
  ]);

  return metricsFromLintResult(result, { tlsCertificates, validators });
}
