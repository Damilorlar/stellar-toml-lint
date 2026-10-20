/**
 * The message contract between the popup and the service worker.
 *
 * MV3 service workers are stopped when idle, so the popup cannot hold a
 * reference to state in memory — it asks the worker for the current tab's
 * summary and the worker answers from `chrome.storage.session`. Naming the two
 * messages here keeps both ends in step without a shared runtime import.
 */
import type { PopupSummary } from './summary.js';

/** Popup → worker: "what do you know about this tab?" */
export const MESSAGE_INSPECT = 'stellar-toml-lint:inspect';

/** Popup → worker: "forget the cache and fetch it again." */
export const MESSAGE_REFRESH = 'stellar-toml-lint:refresh';

/** Popup → worker: request for the active tab's summary. */
export interface InspectRequest {
  type: typeof MESSAGE_INSPECT | typeof MESSAGE_REFRESH;
  /** Tab to inspect; defaults to the active tab when omitted. */
  tabId?: number;
}

/** Worker → popup answer. `summary` is absent when the attempt failed. */
export interface InspectResponse {
  /** The origin inspected, when one was found. */
  origin?: string;
  summary?: PopupSummary;
  /** Human-readable reason the inspection failed, when it did. */
  error?: string;
}

/** True when a message is one this extension handles. */
export function isInspectRequest(message: unknown): message is InspectRequest {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return type === MESSAGE_INSPECT || type === MESSAGE_REFRESH;
}
