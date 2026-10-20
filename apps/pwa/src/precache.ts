/**
 * What the offline studio must have on disk before it can open on a plane.
 *
 * The rule catalog and the JSON Schema are generated from the linter itself by
 * `scripts/generate-offline-data.mjs`, so the frozen copy an auditor reads
 * offline is the same one the published package enforces — no retyped rules.
 *
 * This module is deliberately dependency-free: `vite.config.ts` reads it to
 * configure Workbox, the service worker reads it for its runtime routes, and
 * the test suite reads it to pin the plan down. One declaration, three
 * consumers, so they cannot disagree about what "offline" means.
 */

/** Editor-side JSON Schema for `stellar.toml`, frozen into the build. */
export const SCHEMA_ASSET = 'data/stellar-toml.schema.json';

/** The rule catalog, frozen into the build so `--off` suggestions survive offline. */
export const RULES_ASSET = 'data/rules.json';

/** Small data files that must be precached for the app to work with no network. */
export const OFFLINE_DATA_ASSETS: readonly string[] = [SCHEMA_ASSET, RULES_ASSET];

/** PWA icons, referenced by the manifest and precached with it. */
export const OFFLINE_ICONS: readonly string[] = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

/** The app shell, precached so a cold, offline launch still renders. */
export const APP_SHELL: readonly string[] = ['index.html', 'manifest.webmanifest'];

/**
 * Workbox globs for Vite's build output, consumed by `vite.config.ts`.
 *
 * Broad on purpose: everything Vite hashes is immutable, so precaching all of
 * it is cheaper than deciding file by file, and a chunk added by a later change
 * is offline-working by default rather than by remembering to edit a list.
 */
export const PRECACHE_GLOBS: readonly string[] = [
  '**/*.{js,css,html,json,png,svg,ico,woff,woff2}',
  'manifest.webmanifest',
];

/** How a runtime-cached request should be handled. */
export interface RuntimeCachePattern {
  /** Name shown in DevTools → Application → Cache Storage. */
  cacheName: string;
  /** Matched against the full request URL. */
  pattern: RegExp;
  /** `cache-first` for immutable assets, `stale-while-revalidate` for documents. */
  strategy: 'CacheFirst' | 'StaleWhileRevalidate' | 'NetworkFirst';
  /** Bounded so a long-lived install cannot grow without limit. */
  maxEntries: number;
}

/**
 * Requests that are cached on first use rather than precached.
 *
 * `.wasm` is here rather than in the precache list on purpose: the linter's
 * browser build is JS today, and a service worker that precaches a file that
 * does not exist fails its own install. Matching the extension means a future
 * WASM build is cached the first time it is needed, without a manifest edit.
 */
export const RUNTIME_CACHE_PATTERNS: readonly RuntimeCachePattern[] = [
  {
    cacheName: 'stellar-toml-lint-wasm',
    pattern: /\.wasm(\?.*)?$/i,
    strategy: 'CacheFirst',
    maxEntries: 32,
  },
  {
    cacheName: 'inspected-info-files',
    pattern: /\/\.well-known\/stellar\.toml(\?.*)?$/i,
    strategy: 'NetworkFirst',
    maxEntries: 64,
  },
];

/** The cache name that would serve `url`, or `undefined` when nothing matches. */
export function runtimeCacheFor(url: string): string | undefined {
  return RUNTIME_CACHE_PATTERNS.find((entry) => entry.pattern.test(url))?.cacheName;
}

/**
 * Workbox `additionalManifestEntries`, for the files Vite does not hash.
 *
 * `revision: null` tells Workbox the URL is already content-addressed by the
 * build, so it does not append a cache-busting query string the static host
 * would ignore.
 */
export function additionalManifestEntries(): { url: string; revision: string | null }[] {
  return [...OFFLINE_DATA_ASSETS, ...OFFLINE_ICONS, ...APP_SHELL].map((url) => ({
    url,
    revision: null,
  }));
}

/**
 * True when every precached path is one the app actually ships.
 *
 * Used by the test suite and by `scripts/verify-offline-assets.mjs`: a precache
 * list that names a 404 is the classic way a PWA installs fine and then fails
 * offline, and Workbox will not tell you until a user is on a plane.
 */
export function isPrecachePath(path: string): boolean {
  return additionalManifestEntries().some((entry) => entry.url === path);
}
