import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultIsSuccess,
  DEFAULT_SLA_THRESHOLD_PERCENT,
  SLA_BELOW_THRESHOLD_RULE,
  SlaCalculator,
} from '../../src/monitor/sla-calculator.js';

const NOW = new Date('2026-01-15T00:00:00Z');
const DAY_MS = 86_400_000;

/** An ISO timestamp `days` before the fixed clock. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStore(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sla-calculator-'));
  directories.push(directory);
  return join(directory, 'sla.json');
}

/** A calculator pinned to the fixed clock. */
function calculator(overrides: ConstructorParameters<typeof SlaCalculator>[0] = {}) {
  return new SlaCalculator({ now: () => new Date(NOW), ...overrides });
}

describe('SLA calculation (#379)', () => {
  it('classifies 2xx and 3xx responses as available by default', () => {
    expect(defaultIsSuccess(200)).toBe(true);
    expect(defaultIsSuccess(399)).toBe(true);
    expect(defaultIsSuccess(400)).toBe(false);
    expect(defaultIsSuccess(503)).toBe(false);
  });

  it('computes availability for each rolling window', () => {
    const sla = calculator();
    for (let index = 0; index < 19; index += 1) {
      sla.record({ latencyMs: 50, statusCode: 200, timestamp: daysAgo(0.5) });
    }
    sla.record({ latencyMs: 0, statusCode: null, timestamp: daysAgo(1), error: 'timeout' });
    for (let index = 0; index < 10; index += 1) {
      sla.record({ latencyMs: 50, statusCode: 200, timestamp: daysAgo(20) });
    }

    const [week, month, quarter] = sla.summaries();

    expect(week!.totalProbes).toBe(20);
    expect(week!.availabilityPercent).toBe(95);
    expect(month!.totalProbes).toBe(30);
    expect(month!.availabilityPercent).toBe(96.67);
    expect(quarter!.totalProbes).toBe(30);
  });

  it('returns null availability and failure metrics for an empty window', () => {
    const summary = calculator().summary(7);

    expect(summary).toEqual({
      windowDays: 7,
      totalProbes: 0,
      successfulProbes: 0,
      failedProbes: 0,
      availabilityPercent: null,
      mtbfMs: null,
      mttrMs: null,
      firstProbeAt: null,
      lastProbeAt: null,
    });
  });

  it('calculates MTBF and MTTR from failure episodes', () => {
    const sla = calculator();
    const start = NOW.getTime() - 10 * DAY_MS;
    const failureAt = start + 4 * DAY_MS;
    const recoveredAt = failureAt + 2 * DAY_MS;

    sla.record({ latencyMs: 10, statusCode: 200, timestamp: new Date(start).toISOString() });
    sla.record({ latencyMs: 0, statusCode: null, timestamp: new Date(failureAt).toISOString() });
    sla.record({
      latencyMs: 10,
      statusCode: 200,
      timestamp: new Date(recoveredAt).toISOString(),
    });

    const summary = sla.summary(30);

    expect(summary.failedProbes).toBe(1);
    expect(summary.mttrMs).toBe(2 * DAY_MS);
    // Span 10 days from first probe to now, minus 2 days down = 8 days healthy.
    expect(summary.mtbfMs).toBe(8 * DAY_MS);
  });

  it('counts an ongoing outage up to the clock', () => {
    const sla = calculator();
    sla.record({ latencyMs: 10, statusCode: 200, timestamp: daysAgo(3) });
    sla.record({ latencyMs: 0, statusCode: null, timestamp: daysAgo(1), error: 'timeout' });

    const summary = sla.summary(7);

    expect(summary.failedProbes).toBe(1);
    expect(summary.mttrMs).toBe(DAY_MS);
    expect(summary.mtbfMs).toBe(2 * DAY_MS);
  });

  it('flags a 30-day availability below the threshold', () => {
    const sla = calculator();
    for (let index = 0; index < 9; index += 1) {
      sla.record({ latencyMs: 50, statusCode: 200, timestamp: daysAgo(1) });
    }
    sla.record({ latencyMs: 0, statusCode: 500, timestamp: daysAgo(1) });

    const diagnostic = sla.diagnostic();

    expect(diagnostic).toEqual(
      expect.objectContaining({
        rule: SLA_BELOW_THRESHOLD_RULE,
        severity: 'error',
        category: 'monitor',
      }),
    );
    expect(diagnostic!.message).toContain('90%');
    expect(diagnostic!.message).toContain(`${DEFAULT_SLA_THRESHOLD_PERCENT}%`);
  });

  it('stays silent at or above the threshold and with no probes', () => {
    const passing = calculator();
    passing.record({ latencyMs: 50, statusCode: 200, timestamp: daysAgo(1) });

    expect(passing.diagnostic()).toBeUndefined();
    expect(calculator().diagnostic()).toBeUndefined();
  });

  it('honours threshold, window, and rule overrides', () => {
    const sla = calculator({ thresholdPercent: 100 });
    sla.record({ latencyMs: 50, statusCode: 200, timestamp: daysAgo(40) });
    sla.record({ latencyMs: 50, statusCode: 200, timestamp: daysAgo(1) });
    sla.record({ latencyMs: 0, statusCode: 500, timestamp: daysAgo(1) });

    expect(sla.diagnostic({ rules: { [SLA_BELOW_THRESHOLD_RULE]: 'off' } })).toBeUndefined();
    expect(sla.diagnostic({ rules: { [SLA_BELOW_THRESHOLD_RULE]: 'warning' } })?.severity).toBe(
      'warning',
    );
    // The 7-day window sees both recent probes: 50%, below 100.
    expect(sla.diagnostic({ windowDays: 7 })?.message).toContain('7-day');
  });

  it('derives success from the classifier and explicit overrides', () => {
    const sla = calculator();
    const derived = sla.record({ latencyMs: 10, statusCode: 404 });
    const overridden = sla.record({ latencyMs: 10, statusCode: 404, success: true });

    expect(derived.success).toBe(false);
    expect(overridden.success).toBe(true);
  });

  it('persists probes and reloads them from the JSON database', async () => {
    const path = await temporaryStore();
    const first = calculator({ path });
    await first.recordAndPersist({ latencyMs: 12, statusCode: 200, timestamp: daysAgo(1) });
    await first.recordAndPersist({
      latencyMs: 0,
      statusCode: null,
      timestamp: daysAgo(0.5),
      error: 'refused',
    });

    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      probes: unknown[];
    };
    expect(stored.version).toBe(1);
    expect(stored.probes).toHaveLength(2);

    const second = calculator({ path });
    const loaded = await second.load();

    expect(loaded).toHaveLength(2);
    expect(second.summary(7).availabilityPercent).toBe(50);
  });

  it('starts fresh when the database is missing or corrupt', async () => {
    const path = await temporaryStore();
    const missing = calculator({ path });
    expect(await missing.load()).toEqual([]);

    await writeFile(path, '{ not json', 'utf8');
    const corrupt = calculator({ path });
    expect(await corrupt.load()).toEqual([]);
  });

  it('prunes the oldest probes past maxRecords', async () => {
    const path = await temporaryStore();
    const sla = calculator({ path, maxRecords: 3 });

    for (let index = 0; index < 5; index += 1) {
      await sla.recordAndPersist({
        latencyMs: index,
        statusCode: 200,
        timestamp: daysAgo(5 - index),
      });
    }

    const stored = JSON.parse(await readFile(path, 'utf8')) as { probes: { latencyMs: number }[] };
    expect(stored.probes.map((probe) => probe.latencyMs)).toEqual([2, 3, 4]);
  });

  it('stays in memory when no path is configured', async () => {
    const sla = calculator();
    await sla.recordAndPersist({ latencyMs: 10, statusCode: 200 });

    expect(sla.path).toBeUndefined();
    expect(sla.snapshots).toHaveLength(1);
  });
});
