/**
 * Deciding which tabs are worth inspecting.
 *
 * A browser extension runs everywhere, and most of "everywhere" is not a
 * Stellar anchor. Fetching `/.well-known/stellar.toml` from every page a person
 * visits would be both useless and a privacy problem, so the decision is made
 * once, here, and it is deliberately conservative: HTTPS only, a real hostname,
 * and an ordinary web scheme.
 *
 * Kept free of `chrome.*` so it can be reasoned about — and tested — as plain
 * input/output.
 */

/** Schemes that can serve a `stellar.toml`. */
const INSPECTABLE_PROTOCOLS = new Set(['https:']);

/**
 * The origin to inspect for `url`, or `undefined` when there is nothing to do.
 *
 * Only `https:` qualifies. A wallet will refuse a plaintext `stellar.toml` (and
 * so does SEP-1), so inspecting an `http:` page would only produce a finding
 * about the page's own scheme — noise, not a lint result.
 */
export function inspectableOrigin(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (!INSPECTABLE_PROTOCOLS.has(parsed.protocol)) return undefined;
  if (parsed.hostname === '') return undefined;
  // `about:blank`, `data:` and friends parse with an empty or opaque host; a
  // hostname without a dot is a single-label intranet name or a bare host, and
  // neither serves a public info file.
  if (!parsed.hostname.includes('.')) return undefined;

  return parsed.origin;
}

/** True when `url` is a page the extension should try to lint. */
export function isInspectableUrl(url: string | undefined): boolean {
  return inspectableOrigin(url) !== undefined;
}

/** The display host for a URL, for the popup header. */
export function hostOf(url: string | undefined): string | undefined {
  const origin = inspectableOrigin(url);
  return origin === undefined ? undefined : new URL(origin).hostname;
}

/** The URL a tab's info file is served from. */
export function infoFileUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}/.well-known/stellar.toml`;
}
