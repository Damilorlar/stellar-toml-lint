/* eslint-disable no-undef, no-console -- Node build script; same escape hatch as scripts/build-browser.js. */
/**
 * Builds the extension for Chrome, Edge, and Firefox.
 *
 * Two outputs rather than one, because the two browsers ship MV3 differently:
 * Chrome runs the background as a module service worker, Firefox's MV3
 * background is a script list (its service-worker support is not there yet), so
 * the same source is emitted as ESM for one and as a classic IIFE for the other.
 * Only the manifest and the module format differ.
 *
 * The linter is aliased to the repository's prebuilt browser bundle instead of
 * its TypeScript source: that bundle is already shimmed for the Node built-ins
 * the linter imports lazily (`node:tls`), and reimplementing that shim here
 * would let the two builds drift. Run `npm run build` at the repository root
 * first.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This script sits at the app root, not in scripts/, so `here` is the app dir.
const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(appDir, '..', '..');
const browserBundle = join(repoRoot, 'dist', 'browser', 'index.js');

if (!existsSync(browserBundle)) {
  console.error(
    `Could not find ${browserBundle}. Run "npm run build" at the repository root before building the extension.`,
  );
  process.exit(1);
}

/** Where each browser's build lands, and how its background must be emitted. */
const TARGETS = [
  { browser: 'chrome', outDir: 'dist-chrome', manifest: 'manifest.chrome.json', format: 'esm' },
  { browser: 'firefox', outDir: 'dist-firefox', manifest: 'manifest.firefox.json', format: 'iife' },
];

const shared = {
  bundle: true,
  platform: 'browser',
  target: ['chrome102', 'firefox115'],
  sourcemap: true,
  logLevel: 'warning',
  // The linter's bundle branches on `process.env.NODE_ENV`; define it away so a
  // browser global it does not have is never referenced.
  define: { 'process.env.NODE_ENV': '"production"' },
};

const alias = { 'stellar-toml-lint/browser': browserBundle };

for (const target of TARGETS) {
  const outDir = join(appDir, target.outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await build({
    ...shared,
    entryPoints: [join(appDir, 'src', 'background.ts')],
    outfile: join(outDir, 'background.js'),
    format: target.format,
    alias,
  });

  await build({
    ...shared,
    entryPoints: [join(appDir, 'src', 'popup.ts')],
    outfile: join(outDir, 'popup.js'),
    format: 'esm',
    alias,
  });

  cpSync(join(appDir, 'src', 'popup.html'), join(outDir, 'popup.html'));
  cpSync(join(appDir, 'src', 'popup.css'), join(outDir, 'popup.css'));
  cpSync(join(appDir, 'icons'), join(outDir, 'icons'), { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), readFileSync(join(appDir, target.manifest)));

  console.log(`built ${target.browser} extension into apps/extension/${target.outDir}/`);
}
