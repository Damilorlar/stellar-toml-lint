# stellar.toml offline studio (PWA)

An installable, offline-first studio for [`stellar-toml-lint`](../../README.md). Auditors and anchor
engineers work on planes, in field offices, and behind corporate proxies that block everything — so
the app caches the linter, the rule catalog, and the JSON Schema, and keeps your projects in the
browser rather than on a server.

## What it does

- **Installable** — a Web App Manifest with 192/512 icons plus a maskable variant, `display:
standalone`, and a real service worker, so Chrome, Edge, and iOS Safari offer "Install app".
- **Offline by construction** — Workbox precaches the app shell, the icons, the frozen rule catalog
  (`data/rules.json`), and the JSON Schema (`data/stellar-toml.schema.json`). Runtime routes cache
  `.wasm` assets on first use and re-read `/.well-known/stellar.toml` documents network-first.
- **Named projects in IndexedDB** — several `stellar.toml` files, each kept exactly as you left it.
  If IndexedDB is unavailable (a private window exposes it and then throws), storage falls back to
  memory rather than breaking the page.
- **Linting off the main thread** — the bundled `stellar-toml-lint/worker` runs the linter, so
  re-linting a large paste does not lock the tab.

## Run it

```bash
cd apps/pwa
npm install

# The generators need the package built once from the repo root:
cd ../.. && npm run build && cd apps/pwa

npm run dev        # http://localhost:5173, service worker enabled in dev
npm run build      # generates icons + offline data, then builds to dist/
npm run preview    # serve the production build
npm test           # installability, precache plan, and storage tests
npm run audit      # Lighthouse CI against dist/ (needs Chrome)
```

## How it is put together

| File                                | Role                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `public/manifest.webmanifest`       | The Web App Manifest a browser inspects to decide installability.    |
| `src/precache.ts`                   | The offline plan: which files are precached, and the runtime routes. |
| `src/projects.ts`                   | Project storage: repository logic plus IndexedDB / memory backends.  |
| `src/main.ts`                       | The UI: project sidebar, editor, findings, install prompt.           |
| `scripts/generate-icons.mjs`        | Writes real PNG icons (a tiny hand-rolled encoder, no image dep).    |
| `scripts/generate-offline-data.mjs` | Freezes the rule catalog and JSON Schema from the built package.     |
| `scripts/verify-offline-assets.mjs` | Fails the build when a precached file is missing or a PNG is wrong.  |

`vite.config.ts` reads `src/precache.ts` so the Workbox configuration and the tests share one
declaration of what "offline" means.

### Why the offline data is generated

`rules.json` and `stellar-toml.schema.json` are produced from the published package, not written by
hand. A frozen copy that drifts from the checker is worse than no copy: an offline audit would
report a file as valid against rules that no longer exist. Both files are timestamped-free and
sorted, so regenerating them is a no-op in the diff.
