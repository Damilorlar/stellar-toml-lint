import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BADGE_COLORS } from '../src/badge.js';

/**
 * Drives the real service worker against stubbed browser APIs.
 *
 * The worker is where the badge, the cache, and the fetch meet, and it is the
 * one file the unit tests cannot reach — so instead of trusting it, this test
 * installs a minimal `chrome` global and a stub `fetch`, imports the worker,
 * and then dispatches a tab update. That exercises the whole path a real anchor
 * visit takes, badge painting included, without a browser.
 */

interface BadgeRecord {
  text?: string;
  color?: string;
  title?: string;
}

interface Stub {
  onUpdated: ((tabId: number, change: unknown, tab: unknown) => void)[];
  onActivated: ((info: { tabId: number }) => void)[];
  onMessage: ((message: unknown, sender: unknown, respond: (r: unknown) => void) => unknown)[];
  badges: Map<number, BadgeRecord>;
  tabs: Map<number, { id?: number; url?: string }>;
  fetched: string[];
}

// The browser APIs this test stubs are untyped by design: the point is to drive
// the worker with the smallest object that behaves like `chrome`, not to model it.
type Any = any;

function badgeRecord(state: Stub, tabId: number | undefined): BadgeRecord {
  const key = tabId ?? -1;
  let record = state.badges.get(key);
  if (record === undefined) {
    record = {};
    state.badges.set(key, record);
  }
  return record;
}

/** Installs the smallest `chrome` surface the worker touches. */
function installChrome(state: Stub): void {
  (globalThis as Any).chrome = {
    tabs: {
      onUpdated: {
        addListener: (cb: (t: number, c: unknown, tab: unknown) => void) =>
          state.onUpdated.push(cb),
      },
      onActivated: {
        addListener: (cb: (info: { tabId: number }) => void) => state.onActivated.push(cb),
      },
      query: async () => [...state.tabs.values()],
      get: async (tabId: number) => {
        const tab = state.tabs.get(tabId);
        if (tab === undefined) throw new Error(`No tab ${tabId}`);
        return tab;
      },
    },
    action: {
      setBadgeText: async ({ tabId, text }: { tabId?: number; text: string }) => {
        badgeRecord(state, tabId).text = text;
      },
      setBadgeBackgroundColor: async ({ tabId, color }: { tabId?: number; color: string }) => {
        badgeRecord(state, tabId).color = color;
      },
      setTitle: async ({ tabId, title }: { tabId?: number; title: string }) => {
        badgeRecord(state, tabId).title = title;
      },
    },
    runtime: {
      onMessage: { addListener: (cb: Stub['onMessage'][number]) => state.onMessage.push(cb) },
      onInstalled: { addListener: () => {} },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: async () => undefined,
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };
}

function newState(): Stub {
  return {
    onUpdated: [],
    onActivated: [],
    onMessage: [],
    badges: new Map(),
    tabs: new Map(),
    fetched: [],
  };
}

/** A stub transport that serves one info file with browser-friendly headers. */
function stubFetch(state: Stub, toml: string | 'fail'): void {
  (globalThis as Any).fetch = async (url: string) => {
    state.fetched.push(String(url));
    if (toml === 'fail') throw new Error('getaddrinfo ENOTFOUND');
    return new Response(toml, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
  };
}

/** The worker registers its listeners at import time, so it is re-imported per test. */
async function loadWorker(): Promise<void> {
  vi.resetModules();
  await import('../src/background.js');
}

async function waitForBadge(state: Stub, tabId: number): Promise<BadgeRecord> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const record = state.badges.get(tabId);
    if (record?.text !== undefined && record.title !== undefined) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the badge was never painted');
}

const BROKEN_TOML = `VERSION = "1.0.0"
NETWORK_PASSPHRASE = "not a real network"
`;

let state: Stub;

beforeEach(() => {
  state = newState();
  installChrome(state);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Any).chrome;
});

describe('background service worker', () => {
  it('badges a visited anchor with its error count', async () => {
    stubFetch(state, BROKEN_TOML);
    await loadWorker();

    state.tabs.set(1, { id: 1, url: 'https://anchor.example.com/' });
    state.onUpdated[0]?.(1, { status: 'complete' }, { id: 1, url: 'https://anchor.example.com/' });

    const badge = await waitForBadge(state, 1);
    expect(badge.color).toBe(BADGE_COLORS.error);
    expect(Number(badge.text)).toBeGreaterThan(0);
    expect(state.fetched[0]).toBe('https://anchor.example.com/.well-known/stellar.toml');
  });

  it('clears the badge for a page it will not inspect', async () => {
    stubFetch(state, BROKEN_TOML);
    await loadWorker();

    state.tabs.set(2, { id: 2, url: 'http://anchor.example.com/' });
    state.onUpdated[0]?.(2, { status: 'complete' }, { id: 2, url: 'http://anchor.example.com/' });

    const badge = await waitForBadge(state, 2);
    expect(badge.text).toBe('');
    expect(badge.color).toBe(BADGE_COLORS.neutral);
    expect(state.fetched).toEqual([]);
  });

  it('reports an unreadable file without inventing a verdict', async () => {
    stubFetch(state, 'fail');
    await loadWorker();

    state.tabs.set(3, { id: 3, url: 'https://offline.example.com/' });
    state.onUpdated[0]?.(3, { status: 'complete' }, { id: 3, url: 'https://offline.example.com/' });

    const badge = await waitForBadge(state, 3);
    expect(badge.text).toBe('?');
    expect(badge.color).toBe(BADGE_COLORS.neutral);
  });

  it('answers the popup with the organization it found', async () => {
    stubFetch(
      state,
      `VERSION = "1.0.0"
NETWORK_PASSPHRASE = "not a real network"

[DOCUMENTATION]
ORG_NAME = "Example Anchor"
ORG_URL = "https://anchor.example.com"
`,
    );
    await loadWorker();

    state.tabs.set(4, { id: 4, url: 'https://anchor.example.com/kyc' });
    const response = await new Promise<Any>((resolve) => {
      state.onMessage[0]?.({ type: 'stellar-toml-lint:inspect', tabId: 4 }, {}, resolve);
    });

    expect(response.origin).toBe('https://anchor.example.com');
    expect(response.summary.orgName).toBe('Example Anchor');
    expect(response.summary.findings.length).toBeGreaterThan(0);
  });

  it('reuses the cached verdict instead of re-fetching on every navigation', async () => {
    stubFetch(state, BROKEN_TOML);
    await loadWorker();

    state.tabs.set(5, { id: 5, url: 'https://anchor.example.com/a' });
    state.onUpdated[0]?.(5, { status: 'complete' }, { id: 5, url: 'https://anchor.example.com/a' });
    await waitForBadge(state, 5);

    state.tabs.set(5, { id: 5, url: 'https://anchor.example.com/b' });
    state.onUpdated[0]?.(5, { status: 'complete' }, { id: 5, url: 'https://anchor.example.com/b' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.fetched).toHaveLength(1);
  });

  it('ignores messages that are not ours', async () => {
    stubFetch(state, BROKEN_TOML);
    await loadWorker();

    const handled = state.onMessage[0]?.({ type: 'unrelated' }, {}, () => {});
    expect(handled).toBe(false);
  });
});
