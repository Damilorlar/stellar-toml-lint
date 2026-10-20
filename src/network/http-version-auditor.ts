/**
 * HTTP/2, HTTP/3 (QUIC), and TLS ALPN negotiation auditor (issue #378).
 *
 * High-frequency fintech wallets fire many parallel requests at an anchor's
 * `/info`, `/prices`, and `/quote` endpoints. On HTTP/1.1 each connection
 * carries one request at a time, so slow responses head-of-line-block the
 * requests queued behind them; HTTP/2 multiplexes them over one connection,
 * and HTTP/3 runs that multiplexing over QUIC. A modern anchor advertises
 * both in the TLS handshake (ALPN) and via `Alt-Svc`.
 *
 * This auditor opens one TLS connection per declared HTTPS endpoint and reads
 * the negotiated ALPN protocol from the handshake:
 *
 * - a connection that completes without selecting `h2` emits
 *   `network/legacy-http1-only` (warning) — wallets serialize every request.
 * - a handshake that fails, times out, or negotiates no protocol at all emits
 *   `network/alpn-negotiation-failed` (error).
 * - `h2` passes, and the auditor then measures how long a burst of concurrent
 *   requests takes over the single HTTP/2 connection, reporting the result to
 *   the optional `onObservation` callback. An `Alt-Svc` header naming `h3`
 *   during that burst is recorded too, since QUIC cannot be seen over TCP.
 *
 * Runs only under the opt-in `--check-network`. `node:tls` and `node:http2`
 * are loaded lazily so the shared rule registry this module's rules live in
 * never drags a Node built-in into the browser bundle.
 */
import type { Diagnostic, Rule, RuleOverrides, Severity } from '../types.js';
import { HTTPS_ENDPOINT_FIELDS } from '../spec.js';

export const LEGACY_HTTP1_ONLY_RULE = 'network/legacy-http1-only';
export const ALPN_NEGOTIATION_FAILED_RULE = 'network/alpn-negotiation-failed';

/** How long one TLS handshake may take before it counts as a failure. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Concurrent requests issued per HTTP/2 multiplexing measurement. */
export const DEFAULT_MULTIPLEX_REQUESTS = 8;

/** The protocols offered over TCP TLS ALPN. HTTP/3 uses `h3` over QUIC. */
export const TCP_ALPN_PROTOCOLS: readonly string[] = ['h2', 'http/1.1'];

/** The ALPN identifier QUIC sessions use, detected via `Alt-Svc` over TCP. */
export const HTTP3_ALPN_PROTOCOL = 'h3';

/** What one TLS ALPN probe observed. */
export interface AlpnProbeResult {
  /** The protocol ALPN selected, or `null` when the server selected none. */
  negotiated: string | null;
  /** Transport or alert detail, present when the handshake did not complete. */
  error?: string;
}

/** Opens one TLS connection and reports the ALPN result. Never rejects. */
export type AlpnProbe = (host: string, port: number, timeoutMs: number) => Promise<AlpnProbeResult>;

/** The outcome of one HTTP/2 multiplexing measurement. */
export interface MultiplexingMeasurement {
  /** Requests issued concurrently on the single connection. */
  requests: number;
  /** Wall-clock milliseconds for the whole burst. */
  totalMs: number;
  /** `totalMs / requests` — the amortized per-request latency. */
  averageRequestMs: number;
  /** True when a response advertised HTTP/3 via `Alt-Svc`. */
  http3: boolean;
  /** Transport detail when the measurement could not complete. */
  error?: string;
}

/** Issues `requests` concurrent HTTP/2 GETs on one connection. Never rejects. */
export type MultiplexingProbe = (
  host: string,
  port: number,
  options: { requests: number; timeoutMs: number },
) => Promise<MultiplexingMeasurement>;

/** One endpoint's full observation, passed to `onObservation`. */
export interface HttpVersionObservation {
  host: string;
  port: number;
  /** The TOML field (or `domain`) that named the endpoint. */
  path: string;
  negotiated: string | null;
  multiplexing?: MultiplexingMeasurement;
  error?: string;
}

export interface HttpVersionAuditOptions {
  rules?: RuleOverrides;
  /** The domain the file is served from; audited alongside declared endpoints. */
  domain?: string;
  probe?: AlpnProbe;
  multiplexProbe?: MultiplexingProbe;
  /** Handshake/measurement timeout in milliseconds. */
  timeoutMs?: number;
  /** Concurrent requests per multiplexing measurement. */
  multiplexRequests?: number;
  /** Called once per endpoint with the raw observation. */
  onObservation?: (observation: HttpVersionObservation) => void;
}

/** Rule objects behind the audit, registered for `--list-rules` and overrides. */
export const httpVersionAuditorRules: Rule[] = [
  {
    id: LEGACY_HTTP1_ONLY_RULE,
    category: 'network',
    severity: 'warning',
    description:
      'A declared endpoint should negotiate HTTP/2 so wallets can multiplex parallel requests',
    run() {},
  },
  {
    id: ALPN_NEGOTIATION_FAILED_RULE,
    category: 'network',
    severity: 'error',
    description: 'A declared endpoint must complete TLS ALPN negotiation with a supported protocol',
    run() {},
  },
];

export const httpVersionAuditorRuleIds: readonly string[] = httpVersionAuditorRules.map(
  (rule) => rule.id,
);

function severityFor(
  rule: string,
  fallback: Severity,
  rules: RuleOverrides | undefined,
): Severity | undefined {
  const override = rules?.[rule];
  if (override === 'off') return undefined;
  return override === 'error' || override === 'warning' || override === 'info'
    ? override
    : fallback;
}

/** One endpoint to probe, with the TOML field that named it. */
export interface HttpVersionTarget {
  host: string;
  port: number;
  path: string;
}

/** True for a bare IPv4 address or a bracketed/unbracketed IPv6 literal. */
function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

/**
 * Every host the file points clients at, deduplicated by host and port.
 *
 * IP literals are kept: a test or an internal deployment may name one
 * directly, and ALPN applies to any TLS listener. The `--domain` the file was
 * fetched from is audited first, because wallets reach the file itself over
 * the same connection handling as the API endpoints.
 */
export function httpVersionTargetsOf(
  doc: Record<string, unknown>,
  domain?: string,
): HttpVersionTarget[] {
  const targets: HttpVersionTarget[] = [];
  const seen = new Set<string>();

  const add = (host: string | undefined, port: number, path: string): void => {
    if (host === undefined || host === '') return;
    const normalized = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
    const key = `${normalized}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ host: normalized, port, path });
  };

  if (typeof domain === 'string' && domain !== '') {
    const host = domain
      .replace(/^[a-z]+:\/\//i, '')
      .split('/')[0]
      ?.split(':')[0]
      ?.toLowerCase();
    add(host, 443, 'domain');
  }

  const fields: readonly string[] = [...HTTPS_ENDPOINT_FIELDS, 'HORIZON_URL'];
  for (const field of fields) {
    const value = doc[field];
    if (typeof value !== 'string') continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // Not a URL at all — the offline rules report that with a position.
      continue;
    }
    if (url.protocol !== 'https:') continue;
    const port = url.port === '' ? 443 : Number(url.port);
    add(url.hostname, port, field);
  }

  return targets;
}

/**
 * The default ALPN probe: one short TLS handshake offering `h2` and
 * `http/1.1`. Certificate verification is deliberately disabled — this audit
 * judges the protocol, not the chain, which `security/tls-*` already covers —
 * and the socket is destroyed on every path.
 */
export const defaultAlpnProbe: AlpnProbe = async (host, port, timeoutMs) => {
  const tls = await import('node:tls').catch(() => null);
  if (tls === null) {
    return { negotiated: null, error: 'node:tls is unavailable in this runtime' };
  }

  return new Promise<AlpnProbeResult>((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host,
      port,
      ...(isIpLiteral(host) ? {} : { servername: host }),
      ALPNProtocols: [...TCP_ALPN_PROTOCOLS],
      rejectUnauthorized: false,
    });

    const settle = (result: AlpnProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const selected = socket.alpnProtocol;
      settle({ negotiated: selected === false || selected === undefined ? null : selected });
    });
    socket.once('timeout', () => settle({ negotiated: null, error: 'TLS handshake timed out' }));
    socket.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      settle({ negotiated: null, error: code ?? error.message });
    });
  });
};

/**
 * The default multiplexing probe: a burst of concurrent GETs over one HTTP/2
 * session, timed wall-clock. `Alt-Svc` headers are inspected for an `h3`
 * advertisement, since QUIC is UDP and invisible to this TCP session.
 */
export const defaultMultiplexProbe: MultiplexingProbe = async (host, port, options) => {
  const http2 = await import('node:http2').catch(() => null);
  if (http2 === null) {
    return {
      requests: 0,
      totalMs: 0,
      averageRequestMs: 0,
      http3: false,
      error: 'node:http2 is unavailable in this runtime',
    };
  }

  return new Promise<MultiplexingMeasurement>((resolve) => {
    const started = Date.now();
    let settled = false;
    let http3 = false;
    let remaining = options.requests;

    const session = http2.connect(`https://${host}:${port}`, {
      ...(isIpLiteral(host) ? {} : { servername: host }),
      ALPNProtocols: ['h2'],
      rejectUnauthorized: false,
    });

    const settle = (error?: string): void => {
      if (settled) return;
      settled = true;
      session.destroy();
      const totalMs = Date.now() - started;
      resolve({
        requests: options.requests,
        totalMs,
        averageRequestMs: options.requests === 0 ? 0 : Math.round(totalMs / options.requests),
        http3,
        ...(error !== undefined ? { error } : {}),
      });
    };

    session.setTimeout(options.timeoutMs, () =>
      settle('HTTP/2 multiplexing measurement timed out'),
    );

    session.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      settle(code ?? error.message);
    });

    session.once('connect', () => {
      for (let i = 0; i < options.requests; i++) {
        let done = false;
        const request = session.request({ ':method': 'GET', ':path': '/' });
        request.on('response', (headers) => {
          const altSvc = headers['alt-svc'];
          if (altSvc !== undefined && /\bh3\b/.test(String(altSvc))) http3 = true;
        });
        request.once('error', () => {
          if (!done) {
            done = true;
            remaining -= 1;
            if (remaining === 0) settle();
          }
        });
        request.once('close', () => {
          if (!done) {
            done = true;
            remaining -= 1;
            if (remaining === 0) settle();
          }
        });
        request.resume();
        request.end();
      }
    });
  });
};

/**
 * Audits ALPN negotiation and HTTP/2 multiplexing for the anchor domain and
 * every declared HTTPS endpoint.
 *
 * Returns `[]` when both rules are off, the document declares nothing to
 * probe, or every probe has already been accounted for. Each endpoint yields
 * at most one diagnostic, and the multiplexing measurement is only taken for
 * endpoints that negotiated `h2`.
 */
export async function auditHttpVersions(
  doc: Record<string, unknown>,
  options: HttpVersionAuditOptions = {},
): Promise<Diagnostic[]> {
  const targets = httpVersionTargetsOf(doc, options.domain);
  if (targets.length === 0) return [];

  const legacySeverity = severityFor(LEGACY_HTTP1_ONLY_RULE, 'warning', options.rules);
  const failedSeverity = severityFor(ALPN_NEGOTIATION_FAILED_RULE, 'error', options.rules);
  // Nothing worth a socket when every rule here is off.
  if (legacySeverity === undefined && failedSeverity === undefined) return [];

  const probe = options.probe ?? defaultAlpnProbe;
  const multiplex = options.multiplexProbe ?? defaultMultiplexProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const multiplexRequests = options.multiplexRequests ?? DEFAULT_MULTIPLEX_REQUESTS;
  const diagnostics: Diagnostic[] = [];

  for (const target of targets) {
    const result = await probe(target.host, target.port, timeoutMs).catch((error: unknown) => ({
      negotiated: null,
      error: error instanceof Error ? error.message : String(error),
    }));

    if (result.error !== undefined || result.negotiated === null) {
      const detail = result.error ?? 'the server selected no protocol';
      options.onObservation?.({
        host: target.host,
        port: target.port,
        path: target.path,
        negotiated: null,
        error: detail,
      });

      if (failedSeverity !== undefined) {
        diagnostics.push({
          rule: ALPN_NEGOTIATION_FAILED_RULE,
          severity: failedSeverity,
          category: 'network',
          message: `${target.path} host ${target.host}:${target.port} failed TLS ALPN negotiation (${detail})`,
          path: target.path,
          suggestion:
            'Enable ALPN on the TLS terminator and offer h2 alongside http/1.1, so wallets can multiplex their requests.',
        });
      }
      continue;
    }

    if (result.negotiated !== 'h2') {
      options.onObservation?.({
        host: target.host,
        port: target.port,
        path: target.path,
        negotiated: result.negotiated,
      });

      if (legacySeverity !== undefined) {
        diagnostics.push({
          rule: LEGACY_HTTP1_ONLY_RULE,
          severity: legacySeverity,
          category: 'network',
          message: `${target.path} host ${target.host}:${target.port} negotiated ${result.negotiated} only, so parallel wallet requests head-of-line block`,
          path: target.path,
          suggestion:
            'Terminate TLS with HTTP/2 (h2 ALPN) and keep http/1.1 as the fallback for older clients.',
        });
      }
      continue;
    }

    let measurement: MultiplexingMeasurement | undefined;
    try {
      measurement = await multiplex(target.host, target.port, {
        requests: multiplexRequests,
        timeoutMs,
      });
    } catch (error) {
      measurement = {
        requests: multiplexRequests,
        totalMs: 0,
        averageRequestMs: 0,
        http3: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    options.onObservation?.({
      host: target.host,
      port: target.port,
      path: target.path,
      negotiated: result.negotiated,
      multiplexing: measurement,
    });
  }

  return diagnostics;
}
