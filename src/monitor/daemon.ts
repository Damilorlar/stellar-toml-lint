import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isSupportedWebhookUrl } from '../reporters/webhook.js';
import type { SlaCalculator } from './sla-calculator.js';

export interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
  timestamp: string;
  url: string;
}

/**
 * One poll's observation, handed to the optional {@link MonitorDaemonOptions.onPoll}
 * callback (used by the Prometheus exporter to refresh its lint snapshot) and
 * to the SLA calculator.
 */
export interface PollSample {
  /** The response body, or `undefined` when the poll failed. */
  body?: string;
  /** Round-trip time in milliseconds. */
  latencyMs: number;
  /** HTTP status code, or `null` when no response arrived. */
  statusCode: number | null;
  /** Transport error detail, when the poll failed before a response. */
  error?: string;
}

export interface MonitorDaemonOptions {
  url: string;
  interval?: number;
  webhookUrl?: string;
  /**
   * When set, every poll is recorded for SLA calculation. The daemon records
   * at most one sample per {@link slaSampleIntervalMs} so a fast change-poll
   * interval does not flood the history.
   */
  sla?: SlaCalculator;
  /** Minimum spacing between SLA samples. Default 60 seconds. */
  slaSampleIntervalMs?: number;
  /** Called after every completed or failed poll. */
  onPoll?: (sample: PollSample) => void | Promise<void>;
}

const DEFAULT_INTERVAL = 300;
const MAX_BACKOFF_MS = 30000;
const BASE_BACKOFF_MS = 1000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_WEBHOOK_RETRIES = 2;
const DEFAULT_WEBHOOK_BACKOFF_MS = 250;
const DEFAULT_SLA_SAMPLE_INTERVAL_MS = 60_000;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the monitor target is an http(s) URL rather than a local path. */
function isRemoteTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export class MonitorDaemon {
  readonly url: string;
  readonly interval: number;
  readonly webhookUrl: string | undefined;
  readonly sla: SlaCalculator | undefined;
  lastHash: string | undefined;
  private lastBody: string | undefined;
  private backoffMs: number = BASE_BACKOFF_MS;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private lastSlaSampleMs = 0;
  private readonly slaSampleIntervalMs: number;
  private readonly onPoll: ((sample: PollSample) => void | Promise<void>) | undefined;

  constructor(options: MonitorDaemonOptions) {
    this.url = options.url;
    this.interval = options.interval ?? DEFAULT_INTERVAL;
    this.webhookUrl = options.webhookUrl;
    this.sla = options.sla;
    this.slaSampleIntervalMs = options.slaSampleIntervalMs ?? DEFAULT_SLA_SAMPLE_INTERVAL_MS;
    this.onPoll = options.onPoll;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.backoffMs = BASE_BACKOFF_MS;
    await this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Fetches one response, or reads the local file the target names. */
  private async fetchBody(): Promise<{ body: string; statusCode: number }> {
    if (isRemoteTarget(this.url)) {
      const response = await fetch(this.url);
      const body = await response.text();
      return { body, statusCode: response.status };
    }
    return { body: await readFile(this.url, 'utf8'), statusCode: 200 };
  }

  async poll(): Promise<void> {
    const startedAt = Date.now();
    try {
      const { body, statusCode } = await this.fetchBody();
      const latencyMs = Date.now() - startedAt;
      const hash = this.computeHash(body);

      if (this.lastHash !== undefined && hash !== this.lastHash) {
        const diff = this.computeDiff(this.lastBody ?? '', body);
        if (this.webhookUrl !== undefined && isSupportedWebhookUrl(this.webhookUrl)) {
          await this.sendWebhook(diff);
        }
      }

      this.lastHash = hash;
      this.lastBody = body;
      this.backoffMs = BASE_BACKOFF_MS;

      await this.sample({ body, latencyMs, statusCode });
      await this.onPoll?.({ body, latencyMs, statusCode });

      if (this.running) {
        this.timer = setTimeout(() => this.poll(), this.interval);
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const detail = error instanceof Error ? error.message : String(error);

      await this.sample({ latencyMs, statusCode: null, error: detail });
      await this.onPoll?.({ latencyMs, statusCode: null, error: detail });

      if (this.running) {
        this.timer = setTimeout(() => this.poll(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** Records an SLA sample, at most once per {@link slaSampleIntervalMs}. */
  private async sample(observation: PollSample): Promise<void> {
    if (this.sla === undefined) return;
    const now = Date.now();
    if (this.lastSlaSampleMs !== 0 && now - this.lastSlaSampleMs < this.slaSampleIntervalMs) {
      return;
    }
    this.lastSlaSampleMs = now;

    try {
      await this.sla.recordAndPersist({
        latencyMs: observation.latencyMs,
        statusCode: observation.statusCode,
        ...(observation.error !== undefined ? { error: observation.error } : {}),
      });
    } catch {
      // SLA persistence is best-effort; the monitor loop must keep running.
    }
  }

  computeHash(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  computeDiff(oldData: string, newData: string): DiffResult {
    const oldLines = oldData.split('\n').filter((line) => line.trim() !== '');
    const newLines = newData.split('\n').filter((line) => line.trim() !== '');

    const parseLine = (line: string): string => line.split('=')[0]?.trim() ?? line.trim();

    const oldKeys = new Map(oldLines.map((line) => [parseLine(line), line]));
    const newKeys = new Map(newLines.map((line) => [parseLine(line), line]));

    const added: string[] = [];
    const deleted: string[] = [];
    const modified: string[] = [];

    for (const [key, line] of newKeys) {
      if (!oldKeys.has(key)) {
        added.push(key);
      } else if (oldKeys.get(key) !== line) {
        modified.push(key);
      }
    }
    for (const [key] of oldKeys) {
      if (!newKeys.has(key)) {
        deleted.push(key);
      }
    }

    return {
      added,
      modified,
      deleted,
      timestamp: new Date().toISOString(),
      url: this.url,
    };
  }

  async sendWebhook(diff: DiffResult): Promise<boolean> {
    if (this.webhookUrl === undefined || !isSupportedWebhookUrl(this.webhookUrl)) {
      return false;
    }

    const payload = {
      timestamp: diff.timestamp,
      url: diff.url,
      added_fields: diff.added,
      modified_fields: diff.modified,
      deleted_fields: diff.deleted,
    };

    const send = fetch;

    for (let attempt = 1; attempt <= DEFAULT_WEBHOOK_RETRIES + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_WEBHOOK_TIMEOUT_MS);
      try {
        const response = await send(this.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.ok) return true;
        if (!RETRYABLE_STATUS.has(response.status)) {
          return false;
        }

        if (response.status === 429) {
          const retryAfterHeader = response.headers?.get?.('retry-after');
          if (retryAfterHeader) {
            const delaySec = parseFloat(retryAfterHeader);
            if (!isNaN(delaySec) && delaySec > 0 && attempt <= DEFAULT_WEBHOOK_RETRIES) {
              clearTimeout(timer);
              await defaultSleep(delaySec * 1000);
              continue;
            }
          }
        }
      } catch {
        // Network error; retry will follow
      } finally {
        clearTimeout(timer);
      }

      if (attempt <= DEFAULT_WEBHOOK_RETRIES) {
        await defaultSleep(DEFAULT_WEBHOOK_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    return false;
  }
}
