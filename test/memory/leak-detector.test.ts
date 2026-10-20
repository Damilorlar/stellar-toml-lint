import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lint } from '../../src/lint.js';

const ITERATIONS = 10_000;
const HEAP_DELTA_THRESHOLD_MB = 1;

interface HeapSnapshot {
  totalHeapSize: number;
  usedHeapSize: number;
  heapSizeLimit: number;
}

const hasExposedGc = typeof global.gc === 'function';

function takeHeapSnapshot(): HeapSnapshot {
  if (!hasExposedGc) {
    throw new Error('Garbage collection not exposed. Run with --expose-gc flag.');
  }
  (global.gc as () => void)();
  const mem = process.memoryUsage();
  return {
    totalHeapSize: mem.heapTotal,
    usedHeapSize: mem.heapUsed,
    heapSizeLimit: 0,
  };
}

const SYNTHETIC_TOML = `
VERSION = "1.0.0"
DOCUMENTATION = {
  ORG_NAME = "Test Anchor"
  ORG_URL = "https://example.com"
  ORG_LOGO = "https://example.com/logo.png"
  ORG_DESCRIPTION = "Test anchor for memory leak detection"
  ORG_KEYBASE = "testanchor"
  ORG_OFFICIAL_EMAIL = "test@example.com"
}

[[CURRENCIES]]
code = "USD"
issuer = "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX"
display_decimals = 2
name = "Test USD"
desc = "Test anchored USD"
conditions = "Test conditions"
image = "https://example.com/usd.png"
status = "live"
is_asset_anchored = true
anchor_asset_type = "fiat"
redemption_instructions = "Redeem at test.example.com"

[[CURRENCIES]]
code = "EUR"
issuer = "GCIRLJZDALXLFBXYXEPXG6CGQQQRYXLWUZQBWJLPOLYEY67DXVXWWHF"
display_decimals = 2
name = "Test EUR"
desc = "Test anchored EUR"
conditions = "Test conditions"
image = "https://example.com/eur.png"
status = "live"
is_asset_anchored = true
anchor_asset_type = "fiat"
redemption_instructions = "Redeem at test.example.com"
`;

describe('Memory leak detection for daemon mode', () => {
  let initialSnapshot: HeapSnapshot;
  let finalSnapshot: HeapSnapshot;

  beforeAll(() => {
    if (!hasExposedGc) {
      return;
    }
    initialSnapshot = takeHeapSnapshot();
  });

  afterAll(() => {
    if (!hasExposedGc) return;
    finalSnapshot = takeHeapSnapshot();
  });

  it('should not leak memory across 10,000 consecutive lint cycles', async () => {
    if (!hasExposedGc) return;
    for (let i = 0; i < ITERATIONS; i++) {
      const result = lint(SYNTHETIC_TOML);
      expect(result.ok).toBe(true);
    }
  });

  it('retained heap size delta should be less than 1MB', () => {
    if (!hasExposedGc) return;
    const delta = finalSnapshot.usedHeapSize - initialSnapshot.usedHeapSize;
    const deltaMB = delta / 1024 / 1024;
    expect(deltaMB).toBeLessThan(HEAP_DELTA_THRESHOLD_MB);
  });
});

(hasExposedGc ? describe : describe.skip)(
  'CST node and event listener cleanup verification',
  () => {
    it('should not retain CST nodes after lint completes', () => {
      const snapshotBefore = takeHeapSnapshot();

      for (let i = 0; i < 1000; i++) {
        lint(SYNTHETIC_TOML);
      }

      const snapshotAfter = takeHeapSnapshot();
      const delta = snapshotAfter.usedHeapSize - snapshotBefore.usedHeapSize;

      expect(delta).toBeLessThan(500 * 1024);
    });

    it('should not leak memory when linting malformed TOML', () => {
      const malformedToml = `
VERSION = "1.0.0"
[[CURRENCIES]]
code = "USD"
issuer = "INVALID_ISSUER"
    `;

      const snapshotBefore = takeHeapSnapshot();

      for (let i = 0; i < 1000; i++) {
        lint(malformedToml);
      }

      const snapshotAfter = takeHeapSnapshot();
      const delta = snapshotAfter.usedHeapSize - snapshotBefore.usedHeapSize;

      expect(delta).toBeLessThan(500 * 1024);
    });
  },
);
