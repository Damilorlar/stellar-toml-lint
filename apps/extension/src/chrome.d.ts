/**
 * The slice of the `chrome.*` API this extension actually calls.
 *
 * Declared here rather than pulled from `@types/chrome` so the extension needs
 * no type dependency it does not ship, and so the API surface in use is visible
 * in one place. It mirrors the Manifest V3 promise-based signatures, which is
 * why nothing in the source passes a callback to `tabs.query` or `action.*`.
 */
declare namespace chrome {
  interface Tab {
    id?: number;
    url?: string;
  }

  interface MessageSender {
    tab?: Tab;
  }

  namespace tabs {
    const onUpdated: {
      addListener(
        callback: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
    };
    const onActivated: {
      addListener(callback: (info: { tabId: number }) => void): void;
    };
    function query(info: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
  }

  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
    function setTitle(details: { tabId?: number; title: string }): Promise<void>;
  }

  namespace runtime {
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;
  }

  namespace storage {
    const session: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  }
}
