import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_METADATA_RULE,
  ARCHIVE_SLOW_RULE,
  CHECKPOINT_STALE_RULE,
  RANGE_MISMATCH_RULE,
  RANGE_UNSUPPORTED_RULE,
  checkHistoryArchive,
  checkHistoryArchives,
  historyArchiveRules,
  metadataUrlFor,
  parseArchiveMetadata,
  probeRange,
  testArchive,
} from '../src/validators/historyArchive.js';

const ROOT = 'https://history.example.com/prd/core-live/core_live_001/';
const METADATA =
  'https://history.example.com/prd/core-live/core_live_001/.well-known/stellar-history.json';

interface ServerOptions {
  metadataStatus?: number;
  metadataBody?: unknown;
  metadataThrows?: boolean;
  /** Status the range probe answers with. 206 = compliant. */
  rangeStatus?: number;
  /** Body the range probe returns (as bytes). */
  rangeBytes?: number;
  rangeContentRange?: string | null;
  rangeThrows?: boolean;
}

function server(options: ServerOptions = {}): typeof fetch {
  const rangeLen = options.rangeBytes ?? 64 * 1024;
  return (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const wantsRange = headers.has('range');

    if (wantsRange) {
      if (options.rangeThrows === true) throw new Error('connection reset');
      const status = options.rangeStatus ?? 206;
      const body = new Uint8Array(rangeLen);
      const responseHeaders = new Headers({ 'content-type': 'application/octet-stream' });
      if (options.rangeContentRange !== undefined && options.rangeContentRange !== null) {
        responseHeaders.set('content-range', options.rangeContentRange);
      } else if (status === 206) {
        responseHeaders.set('content-range', `bytes 0-${rangeLen - 1}/1234567`);
      }
      return new Response(body, { status, headers: responseHeaders });
    }

    if (options.metadataThrows === true) throw new Error('DNS failure');
    const status = options.metadataStatus ?? 200;
    const body = options.metadataBody ?? { version: 1, currentLedger: 1000 };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('metadataUrlFor', () => {
  it('resolves an archive root to its metadata URL', () => {
    expect(metadataUrlFor(ROOT)).toBe(METADATA);
  });

  it('strips a {0} template before resolving', () => {
    expect(metadataUrlFor('https://history.example.com/{0}')).toBe(
      'https://history.example.com/.well-known/stellar-history.json',
    );
  });

  it('returns undefined for an unparseable URL', () => {
    expect(metadataUrlFor('not a uri')).toBeUndefined();
  });
});

describe('parseArchiveMetadata', () => {
  it('reads the checkpoint ledger and root hash', () => {
    expect(parseArchiveMetadata({ version: 1, currentLedger: 42, root_hash: 'abc' })).toEqual({
      currentLedger: 42,
      rootHash: 'abc',
    });
  });

  it('accepts metadata with no ledger', () => {
    expect(parseArchiveMetadata({ version: 1 })).toEqual({});
  });

  it('accepts the version 2 document stellar-core 30 writes', () => {
    expect(
      parseArchiveMetadata({
        version: 2,
        server: 'stellar-core 30.0.0',
        currentLedger: 64965375,
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      }),
    ).toEqual({ currentLedger: 64965375 });
  });

  it('rejects an unknown format version or non-object document', () => {
    expect(parseArchiveMetadata({ version: 3 })).toBeUndefined();
    expect(parseArchiveMetadata({ version: '1' })).toBeUndefined();
    expect(parseArchiveMetadata({})).toBeUndefined();
    expect(parseArchiveMetadata('<html>')).toBeUndefined();
    expect(parseArchiveMetadata([1, 2])).toBeUndefined();
    expect(parseArchiveMetadata(null)).toBeUndefined();
  });
});

describe('probeRange', () => {
  it('accepts a compliant 206 slice', async () => {
    const probe = await probeRange(METADATA, 0, 1023, server({ rangeBytes: 1024 }));
    expect(probe.problem).toBeUndefined();
    expect(probe.bytes).toBe(1024);
    expect(probe.contentRange).toBe('bytes 0-1023/1234567');
    expect(probe.status).toBe(206);
  });

  it('flags a 200 answer as unsupported range', async () => {
    const probe = await probeRange(
      METADATA,
      0,
      1023,
      server({ rangeStatus: 200, rangeBytes: 1024 }),
    );
    expect(probe.problem).toBe('not-206');
  });

  it('flags a truncated slice', async () => {
    const probe = await probeRange(METADATA, 0, 1023, server({ rangeBytes: 500 }));
    expect(probe.problem).toBe('length-mismatch');
    expect(probe.bytes).toBe(500);
  });

  it('flags a mismatched Content-Range', async () => {
    const probe = await probeRange(
      METADATA,
      0,
      1023,
      server({ rangeBytes: 1024, rangeContentRange: 'bytes 100-1123/1234567' }),
    );
    expect(probe.problem).toBe('content-range-mismatch');
  });

  it('tolerates a 206 with no Content-Range header', async () => {
    const probe = await probeRange(
      METADATA,
      0,
      1023,
      server({ rangeBytes: 1024, rangeContentRange: null }),
    );
    expect(probe.problem).toBeUndefined();
  });

  it('accepts a slice the server clipped at the end of a short file', async () => {
    // A 500-byte object cannot fill a 1024-byte window; 206 + Content-Range
    // ending at the object's own length is the compliant answer.
    const probe = await probeRange(
      METADATA,
      0,
      1023,
      server({ rangeBytes: 500, rangeContentRange: 'bytes 0-499/500' }),
    );
    expect(probe.problem).toBeUndefined();
    expect(probe.bytes).toBe(500);
    expect(probe.contentRange).toBe('bytes 0-499/500');
  });

  it('reports a transport failure without throwing', async () => {
    const probe = await probeRange(METADATA, 0, 1023, server({ rangeThrows: true }));
    expect(probe.problem).toBe('not-ok');
    expect(probe.status).toBe(0);
  });
});

describe('checkHistoryArchive', () => {
  it('is silent for a compliant archive', async () => {
    expect(await checkHistoryArchive(ROOT, server())).toEqual([]);
  });

  it('is silent when the metadata file is shorter than the range probe', async () => {
    // The mock answers inside the clock's resolution, so the throughput floor
    // — a separate concern — is switched off for this case.
    const diagnostics = await checkHistoryArchive(
      ROOT,
      server({ rangeBytes: 500, rangeContentRange: 'bytes 0-499/500' }),
      { minBytesPerSecond: 0 },
    );
    expect(diagnostics).toEqual([]);
  });

  it('reports unreadable metadata', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server({ metadataStatus: 404 }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: ARCHIVE_METADATA_RULE, severity: 'error' }),
    );
  });

  it('reports metadata in an unknown format version', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server({ metadataBody: { version: 99 } }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ rule: ARCHIVE_METADATA_RULE }));
  });

  it('accepts a version 2 archive end to end', async () => {
    const diagnostics = await checkHistoryArchive(
      ROOT,
      server({ metadataBody: { version: 2, currentLedger: 64965375 } }),
    );
    expect(diagnostics).toEqual([]);
  });

  it('stops after unreadable metadata (no range probe attempted)', async () => {
    // metadata throws → single metadata finding, nothing else.
    const diagnostics = await checkHistoryArchive(ROOT, server({ metadataThrows: true }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe(ARCHIVE_METADATA_RULE);
  });

  it('reports a range request answered with 200', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server({ rangeStatus: 200 }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: RANGE_UNSUPPORTED_RULE, severity: 'error' }),
    );
  });

  it('reports a short slice as an integrity mismatch', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server({ rangeBytes: 10 }));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: RANGE_MISMATCH_RULE, severity: 'error' }),
    );
  });

  it('reports a slow mirror against a high throughput floor', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server(), {
      minBytesPerSecond: 10 ** 12,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: ARCHIVE_SLOW_RULE, severity: 'warning' }),
    );
  });

  it('warns when the checkpoint lags the network head', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server(), { latestLedger: 10_000 });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ rule: CHECKPOINT_STALE_RULE, severity: 'warning' }),
    );
  });

  it('stays silent about staleness without a known network head', async () => {
    expect(await checkHistoryArchive(ROOT, server())).toEqual([]);
  });

  it('stays silent when the checkpoint is current', async () => {
    expect(await checkHistoryArchive(ROOT, server(), { latestLedger: 1005 })).toEqual([]);
  });

  it('honours --off overrides', async () => {
    const diagnostics = await checkHistoryArchive(ROOT, server({ metadataStatus: 404 }), {
      rules: { [ARCHIVE_METADATA_RULE]: 'off' },
    });
    expect(diagnostics).toEqual([]);
  });
});

describe('checkHistoryArchives', () => {
  it('audits every validator HISTORY entry', async () => {
    const doc = {
      VALIDATORS: [
        { ALIAS: 'a', HISTORY: 'https://a.example.com/{0}' },
        { ALIAS: 'b', HISTORY: 'https://b.example.com/{0}' },
      ],
    };
    const diagnostics = await checkHistoryArchives(doc, server({ metadataStatus: 404 }));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.path).toBe('VALIDATORS[0].HISTORY');
    expect(diagnostics[1]?.path).toBe('VALIDATORS[1].HISTORY');
  });

  it('is silent with no validators', async () => {
    expect(await checkHistoryArchives({}, server())).toEqual([]);
  });
});

describe('testArchive (CLI entry point)', () => {
  it('benchmarks a valid URL', async () => {
    expect(await testArchive(ROOT, server())).toEqual([]);
  });

  it('rejects a non-URL argument', async () => {
    const diagnostics = await testArchive('not-a-url', server());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/absolute http\(s\) URL/);
  });
});

describe('historyArchiveRules', () => {
  it('registers every emitted rule id', () => {
    expect(historyArchiveRules.map((r) => ({ id: r.id, severity: r.severity }))).toEqual([
      { id: ARCHIVE_METADATA_RULE, severity: 'error' },
      { id: RANGE_UNSUPPORTED_RULE, severity: 'error' },
      { id: RANGE_MISMATCH_RULE, severity: 'error' },
      { id: ARCHIVE_SLOW_RULE, severity: 'warning' },
      { id: CHECKPOINT_STALE_RULE, severity: 'warning' },
    ]);
  });
});
