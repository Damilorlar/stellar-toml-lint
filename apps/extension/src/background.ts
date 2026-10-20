/**
 * The MV3 background service worker.
 *
 * It watches tab navigation, and — only for an https origin — fetches and
 * lints `/.well-known/stellar.toml`, then paints the answer onto the toolbar
 * badge. Everything expensive is in `stellar-toml-lint/browser`, so what is
 * left here is the part that is genuinely about being a browser extension:
 * which events matter, and where the answer is kept.
 *
 * State lives in `chrome.storage.session` as well as in the in-memory map,
 * because an MV3 worker is terminated after ~30 s idle: a popup opened a minute
 * later would otherwise find an empty cache and no summary to show.
 */
import { lintBrowserDomain } from 'stellar-toml-lint/browser';
import {
  NEUTRAL_BADGE,
  badgeFor,
  badgeForSkipped,
  badgeForUnreachable,
  type BadgeState,
} from './badge.js';
import { inspectableOrigin } from './origin.js';
import { summarize, type PopupSummary } from './summary.js';
import { MESSAGE_REFRESH, isInspectRequest, type InspectResponse } from './messages.js';

/** Beyond this the cached summaries are evicted, oldest first. */
const MAX_CACHED_TABS = 50;

const STORAGE_KEY = 'summaries';

interface StoredSummary {
  origin: string;
  summary?: PopupSummary;
  error?: string;
  checkedAt: number;
}

const cache = new Map<number, StoredSummary>();

/**
 * Rehydrates the cache after the worker has been restarted.
 *
 * Session storage is cleared when the browser closes, which is exactly the
 * lifetime we want: a stale verdict must not outlive the browser session.
 */
async function loadCache(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const entries = stored[STORAGE_KEY];
    if (typeof entries !== 'object' || entries === null) return;
    for (const [key, value] of Object.entries(entries as Record<string, StoredSummary>)) {
      const tabId = Number(key);
      if (Number.isInteger(tabId)) cache.set(tabId, value);
    }
  } catch {
    // A missing or unreadable session store is not fatal: the cache is an
    // optimisation, and every path that misses it re-inspects.
  }
}

async function saveCache(): Promise<void> {
  try {
    const trimmed = [...cache.entries()]
      .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
      .slice(0, MAX_CACHED_TABS);
    await chrome.storage.session.set({ [STORAGE_KEY]: Object.fromEntries(trimmed) });
  } catch {
    // Non-fatal, as above.
  }
}

async function paint(tabId: number, state: BadgeState): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: state.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: state.color });
    await chrome.action.setTitle({
      tabId,
      title: state.title === '' ? NEUTRAL_BADGE.title : state.title,
    });
  } catch {
    // The tab may have closed between the event and the paint.
  }
}

/** Inspects one tab, caching and painting the outcome either way. */
async function inspect(
  tabId: number,
  url: string | undefined,
  force: boolean,
): Promise<InspectResponse> {
  const origin = inspectableOrigin(url);

  if (origin === undefined) {
    cache.delete(tabId);
    await paint(tabId, badgeForSkipped());
    await saveCache();
    return {};
  }

  const cached = cache.get(tabId);
  if (!force && cached?.origin === origin) {
    return { origin, ...(cached.summary === undefined ? {} : { summary: cached.summary }) };
  }

  try {
    const result = await lintBrowserDomain(origin);
    const summary = summarize(result);
    cache.set(tabId, { origin, summary, checkedAt: Date.now() });
    // "We could not read the file" and "the file has three errors" are
    // different answers, and a red digit cannot tell them apart — so a
    // transport failure gets the question mark, not the count.
    await paint(tabId, isUnreachable(result) ? badgeForUnreachable(origin) : badgeFor(result));
    await saveCache();
    return { origin, summary };
  } catch (error) {
    // A host that is unreachable, offline, or serving garbage is reported as
    // "could not read", never as a fabricated finding.
    const message = error instanceof Error ? error.message : String(error);
    cache.set(tabId, { origin, error: message, checkedAt: Date.now() });
    await paint(tabId, badgeForUnreachable(origin));
    await saveCache();
    return { origin, error: message };
  }
}

/** True when the linter's own verdict was "the file never arrived". */
function isUnreachable(result: { diagnostics: readonly { rule: string }[] }): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.rule === 'network/unreachable');
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && changeInfo.url === undefined) return;
  void inspect(tabId, tab.url ?? changeInfo.url, false);
});

chrome.tabs.onActivated.addListener((info) => {
  void (async () => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      await inspect(info.tabId, tab.url, false);
    } catch {
      // The tab went away before it could be read.
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isInspectRequest(message)) return false;

  void (async () => {
    await loadCache();
    const tabId =
      message.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId === undefined) {
      sendResponse({ error: 'No active tab.' } satisfies InspectResponse);
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    const response = await inspect(tabId, tab.url, message.type === MESSAGE_REFRESH);
    sendResponse(response satisfies InspectResponse);
  })();

  // Keeps the message channel open for the async response above.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await inspect(tab.id, tab.url, true);
  })();
});
