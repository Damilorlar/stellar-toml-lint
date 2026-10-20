import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createSecureServer, type Http2SecureServer, type ServerHttp2Stream } from 'node:http2';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  ALPN_NEGOTIATION_FAILED_RULE,
  auditHttpVersions,
  httpVersionTargetsOf,
  LEGACY_HTTP1_ONLY_RULE,
  type AlpnProbeResult,
  type MultiplexingMeasurement,
} from '../../src/network/http-version-auditor.js';

const here = dirname(fileURLToPath(import.meta.url));
const KEY = readFileSync(join(here, '..', 'fixtures', 'tls', 'test-key.pem'));
const CERT = readFileSync(join(here, '..', 'fixtures', 'tls', 'test-cert.pem'));

/** A file that points one endpoint at a local test server. */
function docFor(port: number): Record<string, unknown> {
  return { WEB_AUTH_ENDPOINT: `https://127.0.0.1:${port}/sep10` };
}

type Stoppable = { port: number; close: () => Promise<void> };

const openServers: Stoppable[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

/** An HTTP/2 server over TLS that also accepts HTTP/1.1 fallbacks. */
async function startHttp2Server(): Promise<Stoppable> {
  const server: Http2SecureServer = createSecureServer({
    key: KEY,
    cert: CERT,
    ALPNProtocols: ['h2', 'http/1.1'],
  });
  server.on('stream', (stream: ServerHttp2Stream) => {
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stoppable: Stoppable = {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  openServers.push(stoppable);
  return stoppable;
}

/** A legacy TLS server whose ALPN list stops at HTTP/1.1. */
async function startHttp1OnlyServer(): Promise<Stoppable> {
  const server: HttpsServer = createHttpsServer(
    { key: KEY, cert: CERT, ALPNProtocols: ['http/1.1'] },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stoppable: Stoppable = {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  openServers.push(stoppable);
  return stoppable;
}

/** A TCP listener that is not TLS at all: the handshake cannot complete. */
async function startBrokenServer(): Promise<Stoppable> {
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.end('this is not a TLS server\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stoppable: Stoppable = {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  openServers.push(stoppable);
  return stoppable;
}

describe('HTTP/2 and ALPN protocol auditor (#378)', () => {
  it('passes a server that negotiates h2 and measures multiplexing', async () => {
    const server = await startHttp2Server();
    const observations: { negotiated: string | null; multiplexing?: MultiplexingMeasurement }[] =
      [];

    const diagnostics = await auditHttpVersions(docFor(server.port), {
      onObservation: (observation) => observations.push(observation),
    });

    expect(diagnostics).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.negotiated).toBe('h2');
    expect(observations[0]?.multiplexing?.requests).toBeGreaterThan(0);
    expect(observations[0]?.multiplexing?.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('asserts network/legacy-http1-only when the server restricts ALPN to HTTP/1.1', async () => {
    const server = await startHttp1OnlyServer();

    const diagnostics = await auditHttpVersions(docFor(server.port), { timeoutMs: 2000 });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        rule: LEGACY_HTTP1_ONLY_RULE,
        severity: 'warning',
        category: 'network',
        path: 'WEB_AUTH_ENDPOINT',
      }),
    );
    expect(diagnostics[0]?.message).toContain('http/1.1');
  });

  it('asserts network/alpn-negotiation-failed (error) when the handshake fails', async () => {
    const server = await startBrokenServer();

    const diagnostics = await auditHttpVersions(docFor(server.port), { timeoutMs: 2000 });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        rule: ALPN_NEGOTIATION_FAILED_RULE,
        severity: 'error',
        category: 'network',
        path: 'WEB_AUTH_ENDPOINT',
      }),
    );
  });

  it('uses an injected probe and multiplexing measurement without opening sockets', async () => {
    const probe = vi.fn(async (): Promise<AlpnProbeResult> => ({ negotiated: 'h2' }));
    const multiplexProbe = vi.fn(async (): Promise<MultiplexingMeasurement> => ({
      requests: 4,
      totalMs: 40,
      averageRequestMs: 10,
      http3: true,
    }));

    const diagnostics = await auditHttpVersions(docFor(443), { probe, multiplexProbe });

    expect(diagnostics).toEqual([]);
    expect(probe).toHaveBeenCalledWith('127.0.0.1', 443, expect.any(Number));
    expect(multiplexProbe).toHaveBeenCalledTimes(1);
  });

  it('skips the multiplexing measurement when the protocol is not h2', async () => {
    const probe = vi.fn(async (): Promise<AlpnProbeResult> => ({ negotiated: 'http/1.1' }));
    const multiplexProbe = vi.fn();

    const diagnostics = await auditHttpVersions(docFor(443), { probe, multiplexProbe });

    expect(diagnostics.map((d) => d.rule)).toEqual([LEGACY_HTTP1_ONLY_RULE]);
    expect(multiplexProbe).not.toHaveBeenCalled();
  });

  it('treats an ALPN selection of none as a failed negotiation', async () => {
    const probe = vi.fn(async (): Promise<AlpnProbeResult> => ({ negotiated: null }));

    const diagnostics = await auditHttpVersions(docFor(443), { probe });

    expect(diagnostics.map((d) => d.rule)).toEqual([ALPN_NEGOTIATION_FAILED_RULE]);
  });

  it('opens no sockets when both rules are off', async () => {
    const probe = vi.fn(async (): Promise<AlpnProbeResult> => ({ negotiated: null }));
    const diagnostics = await auditHttpVersions(docFor(443), {
      probe,
      rules: { [LEGACY_HTTP1_ONLY_RULE]: 'off', [ALPN_NEGOTIATION_FAILED_RULE]: 'off' },
    });

    expect(diagnostics).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('honours severity overrides', async () => {
    const probe = vi.fn(async (): Promise<AlpnProbeResult> => ({ negotiated: 'http/1.1' }));
    const diagnostics = await auditHttpVersions(docFor(443), {
      probe,
      rules: { [LEGACY_HTTP1_ONLY_RULE]: 'error' },
    });

    expect(diagnostics[0]?.severity).toBe('error');
  });

  it('deduplicates shared hosts and includes the anchor domain', () => {
    const targets = httpVersionTargetsOf(
      {
        TRANSFER_SERVER: 'https://api.example.com/sep6',
        KYC_SERVER: 'https://api.example.com/kyc',
        HORIZON_URL: 'https://horizon.example.com',
      },
      'example.com',
    );

    expect(targets.map((target) => `${target.host}:${target.port}:${target.path}`)).toEqual([
      'example.com:443:domain',
      'api.example.com:443:TRANSFER_SERVER',
      'horizon.example.com:443:HORIZON_URL',
    ]);
  });

  it('returns no diagnostics when the file declares no endpoints', async () => {
    expect(await auditHttpVersions({ VERSION: '2.7.0' })).toEqual([]);
  });
});
