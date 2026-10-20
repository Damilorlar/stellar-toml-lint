/**
 * Anchor uptime and SLA calculation model (issue #379).
 *
 * A single snapshot tells a wallet whether an anchor is reachable right now; it
 * says nothing about the reliability a listing review actually rates — 99.9 %
 * uptime over a month. This module records every probe the monitor daemon makes
 * (timestamp, latency, HTTP status, error) into a local JSON database, then
 * computes the availability percentage, MTBF (mean time between failures), and
 * MTTR (mean time to repair) for rolling 7-, 30-, and 90-day windows:
 *
 *     Uptime = (successful probes / total probes) × 100
 *
 * The 30-day window is the one listing directories quote, so a window below
 * {@link DEFAULT_SLA_THRESHOLD_PERCENT} emits `monitor/sla-below-threshold`
 * (error). Storage is plain JSON so a daemon needs no database dependency and
 * the history stays inspectable with `jq`; writes are atomic (temp file +
 * rename) so a crash mid-write cannot corrupt the history.
 *
 * `node:fs` is loaded lazily: the rule object is registered in the shared rule
 * registry the browser bundle walks, and a static import would drag a Node
 * built-in into every browser build.
 */
import type { Diagnostic, Rule, RuleOverrides, Severity } from '../types.js';

/** The rule emitted when the 30-day availability falls below the floor. */
export const SLA_BELOW_THRESHOLD_RULE = 'monitor/sla-below-threshold';

/** Listing directories quote 99.5 % as the minimum anchor reliability. */
export const DEFAULT_SLA_THRESHOLD_PERCENT = 99.5;

/** The rolling windows the calculator reports. */
export const SLA_WINDOWS_DAYS: readonly number[] = [7, 30, 90];

/** The window the `monitor/sla-below-threshold` rule judges. */
export const SLA_THRESHOLD_WINDOW_DAYS = 30;

/** Probes kept in memory and on disk; the oldest are pruned first. */
export const DEFAULT_MAX_RECORDS = 50_000;

const MS_PER_DAY = 86_400_000;

/** One recorded probe observation. */
export interface ProbeRecord {
  /** ISO-8601 timestamp of the probe. */
  timestamp: string;
  /** Round-trip time in milliseconds. */
  latencyMs: number;
  /** HTTP status code, or `null` when no response arrived. */
  statusCode: number | null;
  /** `true` when the probe met the availability definition. */
  success: boolean;
  /** Transport error detail, when the probe failed before a response. */
  error?: string;
}

/** Input accepted by {@link SlaCalculator.record}; the success flag is derived. */
export interface ProbeInput {
  latencyMs: number;
  statusCode: number | null;
  /** ISO-8601 timestamp; defaults to the calculator's clock. */
  timestamp?: string;
  error?: string;
  /** Overrides the status-code classification when set. */
  success?: boolean;
}

/** Availability, MTBF, and MTTR for one rolling window. */
export interface SlaSummary {
  windowDays: number;
  totalProbes: number;
  successfulProbes: number;
  failedProbes: number;
  /** `successful / total × 100`; `null` when the window holds no probes. */
  availabilityPercent: number | null;
  /** Mean milliseconds between failures; `null` when no failure occurred. */
  mtbfMs: number | null;
  /** Mean milliseconds to recover; `null` when no failure occurred. */
  mttrMs: number | null;
  /** Earliest probe inside the window, or `null` when empty. */
  firstProbeAt: string | null;
  /** Latest probe inside the window, or `null` when empty. */
  lastProbeAt: string | null;
}

export interface SlaCalculatorOptions {
  /** JSON database path. Without one the calculator stays in memory. */
  path?: string;
  /** Availability floor for the 30-day window, in percent. */
  thresholdPercent?: number;
  /** Clock override, primarily for tests. */
  now?: () => Date;
  /** Classifies a status code as available; default accepts 200–399. */
  isSuccess?: (statusCode: number) => boolean;
  /** Maximum probes retained. Default {@link DEFAULT_MAX_RECORDS}. */
  maxRecords?: number;
}

/**
 * The default status classifier: redirects and successes count as available.
 * A 4xx is the anchor answering but not serving the, e.g. expired, file, and a
 * 5xx is a failed request — neither is a probe a wallet could have used.
 */
export function defaultIsSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

/** Rule object behind the audit, registered for `--list-rules` and overrides. */
export const slaCalculatorRules: Rule[] = [
  {
    id: SLA_BELOW_THRESHOLD_RULE,
    category: 'monitor',
    severity: 'error',
    description: 'A monitored anchor must keep its 30-day probe availability at or above 99.5%',
    run() {},
  },
];

export const slaCalculatorRuleIds: readonly string[] = slaCalculatorRules.map((rule) => rule.id);

/** Severity for the rule, or `undefined` when switched off. */
function severityFor(rules: RuleOverrides | undefined): Severity | undefined {
  const override = rules?.[SLA_BELOW_THRESHOLD_RULE];
  if (override === 'off') return undefined;
  return override === 'error' || override === 'warning' || override === 'info' ? override : 'error';
}

/** Rounds to two decimals so persisted summaries stay readable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Records probe snapshots and computes availability, MTBF, and MTTR.
 *
 * The calculator is deterministic given its records and clock: `summary()`
 * never touches the network, and the JSON file is only a persistence detail.
 */
export class SlaCalculator {
  readonly path: string | undefined;
  readonly thresholdPercent: number;
  readonly maxRecords: number;
  private readonly now: () => Date;
  private readonly isSuccess: (statusCode: number) => boolean;
  private records: ProbeRecord[] = [];
  private loaded = false;
  private loading: Promise<ProbeRecord[]> | undefined;

  constructor(options: SlaCalculatorOptions = {}) {
    this.path = options.path;
    this.thresholdPercent = options.thresholdPercent ?? DEFAULT_SLA_THRESHOLD_PERCENT;
    this.now = options.now ?? (() => new Date());
    this.isSuccess = options.isSuccess ?? defaultIsSuccess;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  /** Every record currently held, oldest first. */
  get snapshots(): readonly ProbeRecord[] {
    return this.records;
  }

  /** Records one probe observation, deriving `success` when not supplied. */
  record(input: ProbeInput): ProbeRecord {
    const record: ProbeRecord = {
      timestamp: input.timestamp ?? this.now().toISOString(),
      latencyMs: input.latencyMs,
      statusCode: input.statusCode,
      success:
        input.success ??
        (input.error === undefined &&
          input.statusCode !== null &&
          this.isSuccess(input.statusCode)),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(this.records.length - this.maxRecords);
    }
    return record;
  }

  /**
   * Persists one probe observation to the JSON database.
   *
   * Writes are serialized through a temp file + rename so an interrupted
   * write leaves the previous history intact, and the write is skipped when
   * no path was configured.
   */
  async recordAndPersist(input: ProbeInput): Promise<ProbeRecord> {
    const record = this.record(input);
    await this.persist();
    return record;
  }

  /** Loads the JSON database into memory. Safe to call more than once. */
  async load(): Promise<readonly ProbeRecord[]> {
    if (this.loaded) return this.records;
    if (this.loading !== undefined) return this.loading;

    this.loading = this.readDatabase().then((records) => {
      this.records = records;
      this.loaded = true;
      this.loading = undefined;
      return this.records;
    });
    return this.loading;
  }

  private async readDatabase(): Promise<ProbeRecord[]> {
    if (this.path === undefined) return [];
    const fs = await import('node:fs/promises').catch(() => null);
    if (fs === null) return [];

    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      // No database yet: the first record creates it.
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' &&
            parsed !== null &&
            Array.isArray((parsed as { probes?: unknown }).probes)
          ? (parsed as { probes: unknown[] }).probes
          : [];
      return list.filter(isProbeRecord);
    } catch {
      // A corrupt history is not worth crashing a daemon over; start over.
      return [];
    }
  }

  /** Writes the in-memory history to the configured JSON database. */
  async persist(): Promise<void> {
    if (this.path === undefined) return;
    const fs = await import('node:fs/promises').catch(() => null);
    if (fs === null) return;

    const payload = JSON.stringify({ version: 1, probes: this.records }, null, 2) + '\n';
    const temporary = `${this.path}.tmp`;
    try {
      await fs.writeFile(temporary, payload, 'utf8');
      await fs.rename(temporary, this.path);
    } catch {
      // Persistence is best-effort: an unwritable path must not break the daemon.
    }
  }

  /** Clears the in-memory history (the database is left untouched). */
  clear(): void {
    this.records = [];
  }

  /** Computes availability, MTBF, and MTTR for one rolling window. */
  summary(windowDays: number): SlaSummary {
    const nowMs = this.now().getTime();
    const fromMs = nowMs - windowDays * MS_PER_DAY;
    const inWindow = this.records
      .filter((record) => {
        const at = Date.parse(record.timestamp);
        return !Number.isNaN(at) && at >= fromMs && at <= nowMs;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    const successfulProbes = inWindow.filter((record) => record.success).length;
    const failedProbes = inWindow.length - successfulProbes;
    const availabilityPercent =
      inWindow.length === 0 ? null : round2((successfulProbes / inWindow.length) * 100);

    const { mtbfMs, mttrMs } = this.failureMetrics(inWindow, nowMs);

    return {
      windowDays,
      totalProbes: inWindow.length,
      successfulProbes,
      failedProbes,
      availabilityPercent,
      mtbfMs,
      mttrMs,
      firstProbeAt: inWindow[0]?.timestamp ?? null,
      lastProbeAt: inWindow[inWindow.length - 1]?.timestamp ?? null,
    };
  }

  /** The 7-, 30-, and 90-day summaries, in window order. */
  summaries(): SlaSummary[] {
    return SLA_WINDOWS_DAYS.map((days) => this.summary(days));
  }

  /**
   * MTBF and MTTR from a time-ordered window.
   *
   * A failure episode runs from the first failing probe until the next
   * successful one; an episode still ongoing at `nowMs` counts its downtime
   * up to the clock. MTBF divides the observed healthy time by the number of
   * episodes, and MTTR divides the total downtime by the same count. With no
   * failures both are `null` rather than `Infinity`, so the value survives a
   * JSON round trip.
   */
  private failureMetrics(
    ordered: ProbeRecord[],
    nowMs: number,
  ): { mtbfMs: number | null; mttrMs: number | null } {
    if (ordered.length === 0) return { mtbfMs: null, mttrMs: null };

    const spanMs = nowMs - Date.parse(ordered[0]!.timestamp);
    let episodes = 0;
    let downtimeMs = 0;
    let failingSince: number | null = null;

    for (const record of ordered) {
      const at = Date.parse(record.timestamp);
      if (!record.success && failingSince === null) {
        failingSince = at;
        episodes += 1;
        continue;
      }
      if (record.success && failingSince !== null) {
        downtimeMs += Math.max(0, at - failingSince);
        failingSince = null;
      }
    }
    if (failingSince !== null) {
      downtimeMs += Math.max(0, nowMs - failingSince);
    }

    if (episodes === 0) return { mtbfMs: null, mttrMs: null };

    const healthyMs = Math.max(0, spanMs - downtimeMs);
    return {
      mtbfMs: Math.round(healthyMs / episodes),
      mttrMs: Math.round(downtimeMs / episodes),
    };
  }

  /**
   * The `monitor/sla-below-threshold` diagnostic for the 30-day window, or
   * `undefined` when availability is at or above the floor (or the rule is
   * switched off, or no probes have been recorded yet).
   */
  diagnostic(options: { rules?: RuleOverrides; windowDays?: number } = {}): Diagnostic | undefined {
    const severity = severityFor(options.rules);
    if (severity === undefined) return undefined;

    const windowDays = options.windowDays ?? SLA_THRESHOLD_WINDOW_DAYS;
    const summary = this.summary(windowDays);
    const availability = summary.availabilityPercent;
    if (availability === null || availability >= this.thresholdPercent) return undefined;

    return {
      rule: SLA_BELOW_THRESHOLD_RULE,
      severity,
      category: 'monitor',
      message: `${windowDays}-day availability is ${availability}%, below the ${this.thresholdPercent}% SLA floor (${summary.failedProbes} of ${summary.totalProbes} probes failed)`,
      path: this.path,
      suggestion:
        'Investigate the failing probes in the SLA database, then fix or fail over the endpoint before the next listing review.',
    };
  }
}

/** Narrows a parsed JSON value to a {@link ProbeRecord}. */
function isProbeRecord(value: unknown): value is ProbeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === 'string' &&
    typeof record.latencyMs === 'number' &&
    (record.statusCode === null || typeof record.statusCode === 'number') &&
    typeof record.success === 'boolean'
  );
}
