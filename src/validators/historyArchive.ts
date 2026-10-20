/**
 * SEP-20 history archive auditing: checkpoint metadata, HTTP range-request
 * compliance, byte-slice integrity, and download throughput (#402).
 *
 * A history archive is the backbone of ledger catch-up: new nodes replay from
 * it and historical verifiers trust its checkpoint hashes. Two properties make
 * or break that trust:
 *
 * 1. `.well-known/stellar-history.json` must be present and describe the
 *    archive's current checkpoint (ledger number and root hash), or the
 *    archive is stale/unreadable.
 * 2. The server must honour HTTP range requests (`Range: bytes=…`) with
 *    `206 Partial Content` and byte-accurate slices, because stellar-core and
 *    catch-up tooling fetch large bucket files in parallel ranges. An archive
 *    that answers `200 OK` to a range request forces full downloads and
 *    collapses catch-up performance.
 *
 * The module probes each archive and reports findings as ordinary
 * {@link Diagnostic}s: a metadata fetch that fails, a range request answered
 * without `206`, a slice whose length or `Content-Range` disagrees with what
 * was asked for, and a throughput floor for slow mirrors. A CLI entry point
 * (`test-archive`) benchmarks one archive URL directly.
 *
 * Everything network-bound is opt-in and injected: callers pass their own
 * `fetch`, tests pass a mock, and no probe ever throws — an unreachable
 * archive is a finding, not a crash.
 */
import type { Diagnostic, Rule, RuleOverrides, Severity } from '../types.js';
import { specUrl } from '../spec.js';
import { isUrl } from '../predicates.js';

/** SEP-20 archive metadata document every archive must serve. */
export const METADATA_PATH = '.well-known/stellar-history.json';

/** Default bytes requested by a range probe — one small, representative slice. */
const DEFAULT_PROBE_BYTES = 64 * 1024;

/** Minimum acceptable throughput (bytes/second) for a mirror to not be "slow". */
const DEFAULT_MIN_BYTES_PER_SECOND = 16 * 1024;

/* ------------------------------------------------------------------ *
 * Rule ids
 * ------------------------------------------------------------------ */

export const ARCHIVE_METADATA_RULE = 'validators/archive-metadata-unreadable';
export const RANGE_UNSUPPORTED_RULE = 'validators/archive-range-unsupported';
export const RANGE_MISMATCH_RULE = 'validators/archive-range-mismatch';
export const ARCHIVE_SLOW_RULE = 'validators/archive-slow';
export const CHECKPOINT_STALE_RULE = 'validators/archive-checkpoint-stale';

/** Severity overrides plus probe tuning, shared by every entry point. */
export interface ArchiveCheckOptions {
  rules?: RuleOverrides;
  /** Bytes to request in the range probe. Defaults to 64 KiB. */
  probeBytes?: number;
  /** Throughput floor in bytes/second before a mirror is flagged slow. */
  minBytesPerSecond?: number;
  /**
   * The network's latest ledger, when known. Supplying it enables the
   * checkpoint-staleness check; omitting it stays silent rather than guessing.
   */
  latestLedger?: number;
}

function severityFor(
  rule: string,
  fallback: Severity,
  rules?: RuleOverrides,
): Severity | undefined {
  const override = rules?.[rule];
  if (override === 'off') return undefined;
  return override ?? fallback;
}

function emit(
  out: Diagnostic[],
  rule: string,
  fallback: Severity,
  message: string,
  options: ArchiveCheckOptions,
  extra: Partial<Diagnostic> = {},
): void {
  const severity = severityFor(rule, fallback, options.rules);
  if (severity === undefined) return;
  out.push({
    rule,
    severity,
    category: 'validators',
    message,
    helpUri: specUrl('validator-information'),
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

/** What an archive's `stellar-history.json` tells us about its checkpoint. */
export interface ArchiveMetadata {
  /** Checkpoint ledger the archive currently serves, when declared. */
  currentLedger?: number;
  /** Root/ledger hash the archive declares for that checkpoint, when present. */
  rootHash?: string;
}

/**
 * History metadata schema versions this linter understands: stellar-core wrote
 * `"version": 1` up to 29.x and `"version": 2` from 30.0 on (SDF's own
 * archives serve 2), so both are usable checkpoint records.
 */
const SUPPORTED_METADATA_VERSIONS = new Set([1, 2]);

/**
 * Parses an archive metadata document.
 *
 * Returns `undefined` when the body is not an object declaring a supported
 * `"version"` — anything else (an HTML error page, a JSON array, a format
 * version this linter does not know) is not a usable checkpoint record.
 */
export function parseArchiveMetadata(body: unknown): ArchiveMetadata | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.version !== 'number' || !SUPPORTED_METADATA_VERSIONS.has(record.version)) {
    return undefined;
  }

  const metadata: ArchiveMetadata = {};
  if (typeof record.currentLedger === 'number' && Number.isFinite(record.currentLedger)) {
    metadata.currentLedger = record.currentLedger;
  }
  // `root_hash` and `currentLedger`'s hash appear under a couple of names
  // across archive implementations; accept the common ones.
  const hash = record.root_hash ?? record.rootHash ?? record.hash;
  if (typeof hash === 'string' && hash.length > 0) metadata.rootHash = hash;
  return metadata;
}

/**
 * Resolves an archive root (possibly containing a `{0}` template) to its
 * metadata URL, dropping the template so metadata is read from the server root.
 */
export function metadataUrlFor(history: string): string | undefined {
  const cleaned = history.replace(/\{[^}]*\}/g, '');
  let base: URL;
  try {
    base = new URL(cleaned);
  } catch {
    return undefined;
  }
  base.search = '';
  base.hash = '';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  try {
    return new URL(METADATA_PATH, base).toString();
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Range probing
 * ------------------------------------------------------------------ */

/** Result of one HTTP range-request probe. */
export interface RangeProbe {
  /** Bytes actually received. */
  bytes: number;
  /** Wall-clock time for the request, in milliseconds. */
  durationMs: number;
  /** Derived throughput, bytes/second (0 when instantaneous). */
  bytesPerSecond: number;
  /** `Content-Range` response header, when the server sent one. */
  contentRange?: string;
  /** Why the response does not satisfy the range request, or `undefined`. */
  problem?: 'not-ok' | 'not-206' | 'length-mismatch' | 'content-range-mismatch';
  /** HTTP status observed (0 when the request threw). */
  status: number;
}

/** The expected `bytes <start>-<end>/<total>` prefix for a satisfied probe. */
function expectedRangePrefix(start: number, end: number): string {
  return `bytes ${start}-${end}/`;
}

/** Parses a `bytes <first>-<last>/<total>` header, or `undefined`. */
function parseContentRange(
  value: string | undefined,
): { first: number; last: number; total: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (match === null) return undefined;
  return { first: Number(match[1]), last: Number(match[2]), total: Number(match[3]) };
}

/**
 * Issues `Range: bytes=start-end` against `url` and checks the answer.
 *
 * A compliant archive returns `206 Partial Content` with exactly the requested
 * slice and a matching `Content-Range`. A `200 OK` means the server ignored the
 * range (forces full-file downloads); a truncated or mislabelled slice means
 * the bytes cannot be trusted for parallel fetch.
 *
 * Never throws: a transport failure surfaces as `status: 0` with
 * `problem: 'not-ok'`.
 */
export async function probeRange(
  url: string,
  start: number,
  end: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RangeProbe> {
  const expectedLength = end - start + 1;
  const began = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { range: `bytes=${start}-${end}` } });
  } catch {
    return {
      bytes: 0,
      durationMs: Date.now() - began,
      bytesPerSecond: 0,
      status: 0,
      problem: 'not-ok',
    };
  }

  const durationMs = Math.max(Date.now() - began, 0);
  const status = response.status;

  if (!ok(status)) {
    // Drain nothing; the body is irrelevant to a failed probe.
    return { bytes: 0, durationMs, bytesPerSecond: 0, status, problem: 'not-ok' };
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    return { bytes: 0, durationMs, bytesPerSecond: 0, status, problem: 'not-ok' };
  }
  const bytes = buffer.byteLength;
  const bytesPerSecond = durationMs > 0 ? Math.round((bytes / durationMs) * 1000) : bytes;
  const contentRange = response.headers.get('content-range') ?? undefined;

  // 200 OK answers the whole body, not the slice — range is unsupported.
  if (status !== 206) {
    return {
      bytes,
      durationMs,
      bytesPerSecond,
      status,
      problem: 'not-206',
      ...(contentRange !== undefined ? { contentRange } : {}),
    };
  }

  if (bytes !== expectedLength && !clippedAtEof(start, end, bytes, contentRange)) {
    return {
      bytes,
      durationMs,
      bytesPerSecond,
      status,
      problem: 'length-mismatch',
      ...(contentRange !== undefined ? { contentRange } : {}),
    };
  }

  // `Content-Range` must echo the requested window when the server sends it —
  // or the end of the file it stopped at.
  if (
    contentRange !== undefined &&
    !contentRange.startsWith(expectedRangePrefix(start, end)) &&
    !clippedAtEof(start, end, bytes, contentRange)
  ) {
    return {
      bytes,
      durationMs,
      bytesPerSecond,
      status,
      problem: 'content-range-mismatch',
      contentRange,
    };
  }

  return {
    bytes,
    durationMs,
    bytesPerSecond,
    status,
    ...(contentRange !== undefined ? { contentRange } : {}),
  };
}

/**
 * True when a short 206 is the server clipping the window at the file's end.
 *
 * A file smaller than the requested range cannot supply the whole window, and
 * RFC 7233 lets the server answer with what exists: the slice still starts
 * where we asked, covers exactly the bytes it declares, and stops at the
 * object's total length — intact, not truncated.
 */
function clippedAtEof(
  start: number,
  end: number,
  bytes: number,
  contentRange: string | undefined,
): boolean {
  const window = parseContentRange(contentRange);
  if (window === undefined) return false;
  if (window.first !== start || window.last - window.first + 1 !== bytes) return false;
  return window.last + 1 === window.total && window.total <= end;
}

/** `fetch`'s `Response.ok` covers 200–299; kept local to avoid coupling tests. */
function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/* ------------------------------------------------------------------ *
 * Per-archive audit
 * ------------------------------------------------------------------ */

/**
 * Audits one history archive: reads its checkpoint metadata, then probes a
 * range request against the metadata URL itself (a guaranteed-existing object)
 * to verify `206` behaviour, byte integrity, and throughput.
 *
 * Returns diagnostics; never throws. `path` describes the HISTORY entry when
 * one was given, else the archive URL.
 */
export async function checkHistoryArchive(
  history: string,
  fetchImpl: typeof fetch = fetch,
  options: ArchiveCheckOptions = {},
  path = 'HISTORY',
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  const metadataUrl = metadataUrlFor(history);
  if (metadataUrl === undefined) {
    emit(
      diagnostics,
      ARCHIVE_METADATA_RULE,
      'error',
      `${path} is not a usable archive URL: ${history}`,
      options,
      {
        path,
        suggestion:
          'Point at the archive root, e.g. "https://history.example.com/prd/core-live/core_live_001/".',
      },
    );
    return diagnostics;
  }

  // 1. Checkpoint metadata.
  let metadata: ArchiveMetadata | undefined;
  try {
    const response = await fetchImpl(metadataUrl);
    if (!response.ok) {
      emit(
        diagnostics,
        ARCHIVE_METADATA_RULE,
        'error',
        `${path} does not serve ${METADATA_PATH}: it returned HTTP ${response.status}`,
        options,
        {
          path,
          suggestion:
            'Publish the archive metadata at the archive root so catch-up can verify checkpoints.',
        },
      );
      return diagnostics;
    }
    metadata = parseArchiveMetadata(await response.json());
  } catch {
    emit(
      diagnostics,
      ARCHIVE_METADATA_RULE,
      'error',
      `${path} does not serve a readable ${METADATA_PATH}`,
      options,
      {
        path,
        suggestion:
          'Publish the archive metadata at the archive root so catch-up can verify checkpoints.',
      },
    );
    return diagnostics;
  }

  if (metadata === undefined) {
    emit(
      diagnostics,
      ARCHIVE_METADATA_RULE,
      'error',
      `${path} returned a ${METADATA_PATH} that declares a format version this linter does not understand`,
      options,
      { path, suggestion: 'Regenerate the archive metadata with a SEP-20 compliant writer.' },
    );
    return diagnostics;
  }

  // 2. Checkpoint staleness, only when the caller told us the network head.
  if (options.latestLedger !== undefined && metadata.currentLedger !== undefined) {
    const behind = options.latestLedger - metadata.currentLedger;
    // Checkpoints are spaced by the network's ledger speed; being more than
    // one checkpoint interval behind means the mirror is not being updated.
    if (behind > CHECKPOINT_INTERVAL_LEDGERS) {
      emit(
        diagnostics,
        CHECKPOINT_STALE_RULE,
        'warning',
        `${path} serves checkpoint ${metadata.currentLedger}, ${behind} ledgers behind the network's latest ${options.latestLedger}`,
        options,
        { path, suggestion: 'Ensure the archive is being written by a live stellar-core catchup.' },
      );
    }
  }

  // 3. Range-request compliance + integrity + throughput, probed on metadata.
  const probeBytes = options.probeBytes ?? DEFAULT_PROBE_BYTES;
  const probe = await probeRange(metadataUrl, 0, probeBytes - 1, fetchImpl);

  if (probe.problem === 'not-ok') {
    emit(
      diagnostics,
      RANGE_UNSUPPORTED_RULE,
      'error',
      `${path} failed a range request: ${probe.status === 0 ? 'the request could not be completed' : `HTTP ${probe.status}`}`,
      options,
      { path, suggestion: 'Confirm the archive serves Range requests and is reachable.' },
    );
    return diagnostics;
  }

  if (probe.problem === 'not-206') {
    emit(
      diagnostics,
      RANGE_UNSUPPORTED_RULE,
      'error',
      `${path} answered HTTP ${probe.status} to a range request instead of 206 Partial Content, forcing full-file downloads during catch-up`,
      options,
      { path, suggestion: 'Enable HTTP range support (206) on the archive server.' },
    );
    return diagnostics;
  }

  if (probe.problem === 'length-mismatch') {
    emit(
      diagnostics,
      RANGE_MISMATCH_RULE,
      'error',
      `${path} returned ${probe.bytes} byte(s) for a ${probeBytes}-byte range, so byte-slice integrity cannot be trusted`,
      options,
      {
        path,
        suggestion: 'The server returned a truncated/overlong slice; check its range handling.',
      },
    );
    return diagnostics;
  }

  if (probe.problem === 'content-range-mismatch') {
    emit(
      diagnostics,
      RANGE_MISMATCH_RULE,
      'error',
      `${path} returned Content-Range "${probe.contentRange ?? ''}" that does not match the requested bytes 0-${probeBytes - 1}`,
      options,
      { path, suggestion: 'The server mislabels its range window; fix its Content-Range header.' },
    );
    return diagnostics;
  }

  // 4. Throughput floor.
  const floor = options.minBytesPerSecond ?? DEFAULT_MIN_BYTES_PER_SECOND;
  if (probe.bytesPerSecond < floor) {
    emit(
      diagnostics,
      ARCHIVE_SLOW_RULE,
      'warning',
      `${path} served the range probe at ${probe.bytesPerSecond} B/s, below the ${floor} B/s floor (a slow mirror slows catch-up for everyone)`,
      options,
      { path, suggestion: 'Move the archive closer to its users or upgrade its link.' },
    );
  }

  return diagnostics;
}

/** Checkpoints are written at this ledger cadence (8 ledgers ≈ 40s). */
const CHECKPOINT_INTERVAL_LEDGERS = 8;

/* ------------------------------------------------------------------ *
 * Whole-file audit (`--check-network`)
 * ------------------------------------------------------------------ */

/** Reads `[[VALIDATORS]]` as tables, ignoring malformed entries. */
function validatorsOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  const list = doc.VALIDATORS;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

/**
 * Audits every `[[VALIDATORS]].HISTORY` archive declared by the file.
 *
 * Silent when the file declares no validators. Each archive is probed
 * independently so one unreachable mirror never takes down the rest.
 */
export async function checkHistoryArchives(
  doc: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options: ArchiveCheckOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const [index, entry] of validatorsOf(doc).entries()) {
    const history = entry.HISTORY;
    if (typeof history !== 'string') continue;
    diagnostics.push(
      ...(await checkHistoryArchive(history, fetchImpl, options, `VALIDATORS[${index}].HISTORY`)),
    );
  }
  return diagnostics;
}

/** Rule objects behind the archive probes, registered for `--list-rules`/`--off`. */
export const historyArchiveRules: Rule[] = [
  {
    id: ARCHIVE_METADATA_RULE,
    category: 'validators',
    severity: 'error',
    description:
      'A validator history archive does not serve a readable .well-known/stellar-history.json',
    run() {},
  },
  {
    id: RANGE_UNSUPPORTED_RULE,
    category: 'validators',
    severity: 'error',
    description: 'A history archive does not honour HTTP range requests with 206 Partial Content',
    run() {},
  },
  {
    id: RANGE_MISMATCH_RULE,
    category: 'validators',
    severity: 'error',
    description: 'A history archive returns a range slice whose length or Content-Range is wrong',
    run() {},
  },
  {
    id: ARCHIVE_SLOW_RULE,
    category: 'validators',
    severity: 'warning',
    description:
      'A history archive serves range probes slower than the configured throughput floor',
    run() {},
  },
  {
    id: CHECKPOINT_STALE_RULE,
    category: 'validators',
    severity: 'warning',
    description: 'A history archive serves a checkpoint far behind the network’s latest ledger',
    run() {},
  },
];

/**
 * CLI entry point: benchmarks a single archive URL (`test-archive --url …`).
 *
 * Prints a human-readable report and returns diagnostics so the CLI can map
 * them onto an exit code. Returns a single diagnostic when the URL is not a
 * usable archive at all.
 */
export async function testArchive(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: ArchiveCheckOptions = {},
): Promise<Diagnostic[]> {
  if (!isUrl(url)) {
    return [
      {
        rule: ARCHIVE_METADATA_RULE,
        severity: 'error',
        category: 'validators',
        message: `--url must be an absolute http(s) URL, got "${url}"`,
        suggestion:
          'Pass the archive root, e.g. https://history.stellar.org/prd/core-live/core_live_000/',
      },
    ];
  }
  return checkHistoryArchive(url, fetchImpl, options, url);
}
