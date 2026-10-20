/* eslint-disable no-undef -- Node globals; the same escape hatch scripts/build-browser.js uses. */
/**
 * Verifies that everything the service worker promises to precache exists.
 *
 * A PWA with a missing precache entry has the worst possible failure mode: it
 * installs cleanly, passes review, and then refuses to start offline — for the
 * one user who actually needs it. So the build checks the plan against the
 * files, and fails loudly rather than shipping a broken cache.
 *
 * Reads the plan from the TypeScript source (via esbuild, which ships with
 * Vite) so the check cannot drift from what `vite.config.ts` configures.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const publicDir = join(appDir, 'public');
const distDir = join(appDir, 'dist');

const bundled = await build({
  entryPoints: [join(appDir, 'src', 'precache.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});
const code = bundled.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const plan = await import(moduleUrl);

const problems = [];

/** Every path the plan promises to have cached, app shell included. */
const planned = plan.additionalManifestEntries().map((entry) => entry.url);

/**
 * Where a planned asset comes from: `public/` for static files, the app root
 * for `index.html` (which Vite turns into the built entry document).
 */
function locate(asset) {
  for (const base of [publicDir, appDir]) {
    const candidate = join(base, asset);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

for (const asset of planned) {
  const source = locate(asset);
  if (source === undefined) {
    problems.push(
      `${asset} is in the precache plan but exists in neither public/ nor the app root`,
    );
  } else if (existsSync(distDir) && !existsSync(join(distDir, asset))) {
    problems.push(`${asset} exists at ${source} but did not reach dist/ — check the build step`);
  }
}

// The manifest is the other half of "installable", and a JSON typo in it is
// invisible until a browser silently refuses to offer the install prompt.
const manifestPath = join(publicDir, 'manifest.webmanifest');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  problems.push(`public/manifest.webmanifest is not valid JSON: ${String(error)}`);
}

if (manifest !== undefined) {
  for (const field of [
    'name',
    'short_name',
    'start_url',
    'display',
    'theme_color',
    'background_color',
  ]) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      problems.push(`manifest is missing a usable "${field}"`);
    }
  }
  if (
    manifest.display !== 'standalone' &&
    manifest.display !== 'fullscreen' &&
    manifest.display !== 'minimal-ui'
  ) {
    problems.push(`manifest display "${manifest.display}" is not installable`);
  }
  const sizes = new Set((manifest.icons ?? []).map((icon) => icon.sizes));
  for (const required of ['192x192', '512x512']) {
    if (!sizes.has(required)) problems.push(`manifest has no ${required} icon`);
  }
  if (!(manifest.icons ?? []).some((icon) => String(icon.purpose ?? '').includes('maskable'))) {
    problems.push('manifest has no maskable icon');
  }
  for (const icon of manifest.icons ?? []) {
    const path = join(publicDir, icon.src.replace(/^\.\//, ''));
    if (!existsSync(path)) problems.push(`manifest icon ${icon.src} does not exist`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`Offline assets are incomplete:\n  - ${problems.join('\n  - ')}\n`);
  process.exit(1);
}

process.stdout.write(`Verified ${planned.length} precached assets and the web app manifest.\n`);
