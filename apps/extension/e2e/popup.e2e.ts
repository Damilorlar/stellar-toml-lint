/**
 * Playwright checks that the extension loads and the popup renders.
 *
 * Named `.e2e.ts` rather than `.spec.ts` so the repository's own vitest run
 * does not try to collect it: these tests need a real browser with extension
 * support (so, a display — `xvfb-run` in CI), which the unit suite must never
 * depend on.
 *
 * What this covers is deliberately narrow: that Chrome loads the built MV3
 * extension, that its service worker is running, and that the popup draws the
 * "nothing to inspect" state for a page that is not an https site. The badge
 * decisions themselves are covered exhaustively by
 * `test/background.test.ts`, which drives the real worker against stubbed
 * browser APIs and needs no browser at all.
 */
import { expect, test, chromium, type BrowserContext } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-chrome');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  test.skip(
    !existsSync(join(extensionDir, 'manifest.json')),
    'Build the extension first: npm run build:extension',
  );

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test('loads as an unpacked MV3 extension with a running service worker', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('declares the manifest Chrome actually read', async () => {
  const worker = context.serviceWorkers()[0];
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.action?.default_popup).toBe('popup.html');
  expect(manifest.browser_specific_settings).toBeUndefined();
});

test('renders the inspector popup', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // The popup itself is a chrome-extension:// page, so there is nothing for the
  // worker to inspect and the popup must say so instead of showing a verdict.
  await expect(popup.locator('h1')).toHaveText('No site to inspect');
  await expect(popup.locator('#popup-root')).not.toContainText('Inspecting this site');
});
