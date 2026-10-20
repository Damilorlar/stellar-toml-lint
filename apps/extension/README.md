# stellar.toml lint inspector (browser extension)

A Manifest V3 WebExtension for Chrome, Edge, and Firefox that watches the sites you visit and tells
you — in the toolbar — whether each one serves a valid `/.well-known/stellar.toml`.

Ecosystem developers, security researchers, and wallet engineers navigating anchor sites should not
have to `curl` a file and read it by hand to know whether the domain in front of them is safe to
integrate with.

## What it does

- **Auto-detects** the `https` origin of every tab, and fetches
  `https://<origin>/.well-known/stellar.toml` in the background. `http` pages, browser-internal
  pages, and single-label hosts are skipped, so nothing is fetched from a page that could not serve
  a real info file anyway.
- **Badges the result** on the toolbar action:
  | Badge     | Meaning                                             |
  | --------- | --------------------------------------------------- |
  | green `✓` | no findings                                         |
  | amber `n` | `n` warnings, no errors                             |
  | red `n`   | `n` errors                                          |
  | grey `?`  | the file could not be read (offline, 5xx, DNS, TLS) |
  | (empty)   | not an https site; nothing to inspect               |
- **Opens an inspector** popup with the organization name, the assets it lists (regulated ones
  marked), and the findings, error-first. A **Re-check** button forces a fresh fetch.
- **Caches per tab** for the browser session, so navigating around a site does not re-fetch on every
  page view.

The linter itself runs in the service worker, which means a page cannot see or influence the result.

## Build

The extension consumes the repository's prebuilt browser bundle, so build the package first:

```bash
npm run build              # at the repository root
npm run build:extension    # → apps/extension/dist-chrome/ and dist-firefox/
```

Then load it:

- **Chrome / Edge** — `chrome://extensions` → enable _Developer mode_ → _Load unpacked_ →
  `apps/extension/dist-chrome`.
- **Firefox** — `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ → pick
  `apps/extension/dist-firefox/manifest.json`.

The two outputs differ only where the browsers genuinely differ: Chrome runs the background as a
module service worker, Firefox's MV3 background is a script list, and only the Firefox build carries
a `browser_specific_settings.gecko.id` so it can be published to addons.mozilla.org.

## Test

```bash
npm test          # unit + integration tests, no browser required
npm run test:e2e  # Playwright: loads the built extension in Chromium (needs a display)
```

`test/background.test.ts` is the interesting one: it installs a minimal `chrome` global and a stub
`fetch`, imports the real service worker, and dispatches a tab update, asserting exactly which badge
gets painted. That covers the badge logic end to end without a browser — which is why `test:e2e` can
stay small and focus on "does Chrome load it and does the popup render".

`test/e2e/popup.e2e.ts` is named `.e2e.ts` rather than `.spec.ts` so the repository's vitest run
never tries to collect it; run it with `xvfb-run -a npm run test:e2e` on a headless machine.

## Layout

| File                         | Role                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `manifest.chrome.json`       | MV3 manifest for Chrome and Edge.                            |
| `manifest.firefox.json`      | MV3 manifest for Firefox (script-list background, gecko id). |
| `src/background.ts`          | The service worker: navigation events, fetch, badge, cache.  |
| `src/origin.ts`              | Which URLs are worth inspecting.                             |
| `src/badge.ts`               | Lint result → badge text, colour, tooltip.                   |
| `src/summary.ts`             | Lint result → what the popup renders.                        |
| `src/popup.ts`               | Popup rendering.                                             |
| `build.mjs`                  | Bundles both targets with esbuild.                           |
| `scripts/generate-icons.mjs` | Writes the 16/32/48/128 PNG action icons.                    |
