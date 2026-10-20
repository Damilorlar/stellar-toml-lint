import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint } from '../../../src/lint.js';
import { hostOf, infoFileUrl, inspectableOrigin, isInspectableUrl } from '../src/origin.js';
import { BADGE_COLORS, badgeFor, badgeForSkipped, badgeForUnreachable } from '../src/badge.js';
import { summarize } from '../src/summary.js';
import { MESSAGE_INSPECT, MESSAGE_REFRESH, isInspectRequest } from '../src/messages.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const readManifest = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(appRoot, name), 'utf8'));

const chromeManifest = readManifest('manifest.chrome.json');
const firefoxManifest = readManifest('manifest.firefox.json');

describe('origin detection', () => {
  it('accepts an https page and reduces it to its origin', () => {
    expect(inspectableOrigin('https://anchor.example.com/deposit?asset=USDC')).toBe(
      'https://anchor.example.com',
    );
    expect(inspectableOrigin('https://anchor.example.com:8443/x')).toBe(
      'https://anchor.example.com:8443',
    );
  });

  it('refuses plaintext, since SEP-1 forbids it anyway', () => {
    expect(inspectableOrigin('http://anchor.example.com')).toBeUndefined();
  });

  it('refuses browser-internal and non-web pages', () => {
    for (const url of [
      'chrome://extensions',
      'about:blank',
      'file:///tmp/stellar.toml',
      'data:text/plain,hello',
      'chrome-extension://abcdef/popup.html',
      'not a url',
      '',
      undefined,
    ]) {
      expect(inspectableOrigin(url), `${String(url)} should be skipped`).toBeUndefined();
      expect(isInspectableUrl(url)).toBe(false);
    }
  });

  it('skips single-label hosts', () => {
    expect(inspectableOrigin('https://intranet/')).toBeUndefined();
  });

  it('exposes the host and the info file URL', () => {
    expect(hostOf('https://anchor.example.com/')).toBe('anchor.example.com');
    expect(hostOf('chrome://newtab')).toBeUndefined();
    expect(infoFileUrl('https://anchor.example.com')).toBe(
      'https://anchor.example.com/.well-known/stellar.toml',
    );
  });
});

describe('badge state', () => {
  it('shows a green checkmark for a clean file', () => {
    const badge = badgeFor({ ok: true, counts: { error: 0, warning: 0, info: 3 } });
    expect(badge.text).toBe('✓');
    expect(badge.color).toBe(BADGE_COLORS.valid);
    expect(badge.title).toContain('valid');
  });

  it('counts warnings when there are no errors', () => {
    const badge = badgeFor({ ok: true, counts: { error: 0, warning: 4, info: 0 } });
    expect(badge.text).toBe('4');
    expect(badge.color).toBe(BADGE_COLORS.warning);
  });

  it('lets errors win over warnings and counts only the worst severity', () => {
    const badge = badgeFor({ ok: false, counts: { error: 2, warning: 9, info: 0 } });
    expect(badge.text).toBe('2');
    expect(badge.color).toBe(BADGE_COLORS.error);
    expect(badge.title).toBe('2 errors in stellar.toml');
  });

  it('uses the singular in the tooltip for one finding', () => {
    expect(badgeFor({ ok: false, counts: { error: 1, warning: 0, info: 0 } }).title).toBe(
      '1 error in stellar.toml',
    );
  });

  it('never fakes a verdict for a site it could not read', () => {
    const badge = badgeForUnreachable('https://anchor.example.com');
    expect(badge.text).toBe('?');
    expect(badge.color).toBe(BADGE_COLORS.neutral);
    expect(badge.title).toContain('anchor.example.com');
  });

  it('leaves the badge empty for a skipped page', () => {
    const badge = badgeForSkipped();
    expect(badge.text).toBe('');
    expect(badge.title).toContain('Not an https site');
  });
});

describe('isInspectRequest', () => {
  it('accepts the two messages the popup sends', () => {
    expect(isInspectRequest({ type: MESSAGE_INSPECT })).toBe(true);
    expect(isInspectRequest({ type: MESSAGE_REFRESH })).toBe(true);
  });

  it("ignores anything else, including other extensions' messages", () => {
    expect(isInspectRequest({ type: 'something-else' })).toBe(false);
    expect(isInspectRequest(null)).toBe(false);
    expect(isInspectRequest('stellar-toml-lint:inspect')).toBe(false);
  });
});

describe('summarize', () => {
  const SOURCE = `VERSION = "1.0.0"
NETWORK_PASSPHRASE = "not a real passphrase"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

[DOCUMENTATION]
ORG_NAME = "Example Anchor"
ORG_URL = "https://anchor.example.com"
ORG_DESCRIPTION = "A test anchor."

[[CURRENCIES]]
code = "USDC"
issuer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
regulated = true

[[CURRENCIES]]
code = "XLM"
`;

  it('reads the organization and assets out of a real lint result', () => {
    const result = lint(SOURCE);
    const summary = summarize(result);

    expect(summary.orgName).toBe('Example Anchor');
    expect(summary.orgUrl).toBe('https://anchor.example.com');
    expect(summary.orgDescription).toBe('A test anchor.');
    expect(summary.servesSep).toBe(true);
    expect(summary.assets.map((asset) => asset.code)).toEqual(['USDC', 'XLM']);
    expect(summary.assets[0]).toMatchObject({ regulated: true });
    expect(summary.assets[0]?.issuer).toBe(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );
    // XLM is native: no issuer, and not regulated.
    expect(summary.assets[1]?.issuer).toBeUndefined();
    expect(summary.assets[1]?.regulated).toBe(false);
  });

  it('carries the verdict and the counts straight through', () => {
    const result = lint(SOURCE);
    const summary = summarize(result);
    expect(summary.ok).toBe(result.ok);
    expect(summary.counts).toEqual(result.counts);
    expect(summary.findings.length).toBe(result.diagnostics.length);
  });

  it('orders findings error-first so the popup opens on what breaks', () => {
    const summary = summarize(lint(SOURCE));
    const severities = summary.findings.map((finding) => finding.severity);
    const firstWarning = severities.indexOf('warning');
    const lastError = severities.lastIndexOf('error');
    if (firstWarning !== -1 && lastError !== -1) {
      expect(lastError).toBeLessThan(firstWarning);
    }
  });

  it('degrades to an empty summary when nothing parsed', () => {
    const summary = summarize({
      ok: false,
      counts: { error: 1, warning: 0, info: 0 },
      diagnostics: [{ rule: 'file/toml-parse', severity: 'error', message: 'bad toml' }],
    });
    expect(summary.orgName).toBeUndefined();
    expect(summary.assets).toEqual([]);
    expect(summary.servesSep).toBe(false);
    expect(summary.findings).toHaveLength(1);
  });
});

describe('manifests', () => {
  it('both declare Manifest V3 and the same product identity', () => {
    expect(chromeManifest.manifest_version).toBe(3);
    expect(firefoxManifest.manifest_version).toBe(3);
    expect(chromeManifest.name).toBe(firefoxManifest.name);
    expect(chromeManifest.version).toBe(firefoxManifest.version);
    expect(chromeManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('opens the inspector from the action', () => {
    for (const manifest of [chromeManifest, firefoxManifest]) {
      expect(manifest.action.default_popup).toBe('popup.html');
      expect(manifest.action.default_title.length).toBeGreaterThan(0);
    }
  });

  it('requests only the permissions the badge needs', () => {
    for (const manifest of [chromeManifest, firefoxManifest]) {
      expect(manifest.permissions.sort()).toEqual(['storage', 'tabs']);
      // Fetching /.well-known/stellar.toml from arbitrary anchors requires host
      // access; anything narrower would silently never inspect a real site.
      expect(manifest.host_permissions).toContain('https://*/*');
    }
  });

  it("runs the background the way each browser's MV3 supports", () => {
    expect(chromeManifest.background).toEqual({
      service_worker: 'background.js',
      type: 'module',
    });
    // Firefox MV3 backgrounds are script lists, not service workers.
    expect(firefoxManifest.background).toEqual({ scripts: ['background.js'] });
  });

  it('identifies the Firefox build to the add-on store', () => {
    expect(firefoxManifest.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(firefoxManifest.browser_specific_settings.gecko.strict_min_version).toBeDefined();
  });

  it('points every icon at a real PNG of the advertised size', () => {
    for (const manifest of [chromeManifest, firefoxManifest]) {
      for (const [size, relative] of Object.entries(manifest.icons as Record<string, string>)) {
        const path = join(appRoot, relative);
        expect(existsSync(path), `${relative} should exist`).toBe(true);
        const bytes = readFileSync(path);
        expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(bytes.readUInt32BE(16)).toBe(Number(size));
        expect(bytes.readUInt32BE(20)).toBe(Number(size));
      }
      // The action icon set must match the extension icon set, or the toolbar
      // shows a blank square.
      expect(manifest.action.default_icon).toEqual(manifest.icons);
    }
  });
});
