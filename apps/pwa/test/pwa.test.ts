import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_SHELL,
  OFFLINE_DATA_ASSETS,
  OFFLINE_ICONS,
  RUNTIME_CACHE_PATTERNS,
  additionalManifestEntries,
  isPrecachePath,
  runtimeCacheFor,
} from '../src/precache.js';
import {
  DuplicateProjectNameError,
  MAX_SOURCE_BYTES,
  MemoryBackend,
  ProjectRepository,
  createBackend,
  nextAvailableName,
} from '../src/projects.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const publicDir = join(appRoot, 'public');

const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8')) as {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** A deterministic clock, so ordering assertions cannot flake on a fast machine. */
function clock(start = 1_000): () => number {
  let value = start;
  return () => (value += 1);
}

describe('web app manifest', () => {
  it('satisfies the installability criteria Chrome enforces', () => {
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url.length).toBeGreaterThan(0);
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('ships both required icon sizes plus a maskable one', () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((icon) => (icon.purpose ?? '').includes('maskable'))).toBe(true);
    for (const icon of manifest.icons) expect(icon.type).toBe('image/png');
  });

  it('points every icon at a real PNG of the advertised size', () => {
    for (const icon of manifest.icons) {
      const path = join(publicDir, icon.src.replace(/^\.\//, ''));
      expect(existsSync(path), `${icon.src} should exist`).toBe(true);

      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(bytes.readUInt32BE(16)).toBe(width);
      expect(bytes.readUInt32BE(20)).toBe(height);
    }
  });
});

describe('offline precache plan', () => {
  it('precaches the schema, the rule catalog, the icons, and the shell', () => {
    const urls = additionalManifestEntries().map((entry) => entry.url);
    for (const asset of [...OFFLINE_DATA_ASSETS, ...OFFLINE_ICONS, ...APP_SHELL]) {
      expect(urls).toContain(asset);
    }
    expect(OFFLINE_DATA_ASSETS).toContain('data/stellar-toml.schema.json');
    expect(OFFLINE_DATA_ASSETS).toContain('data/rules.json');
  });

  it('knows which paths are part of the plan', () => {
    expect(isPrecachePath('index.html')).toBe(true);
    expect(isPrecachePath('data/rules.json')).toBe(true);
    expect(isPrecachePath('not-shipped.js')).toBe(false);
  });

  it('has every planned asset on disk', () => {
    for (const entry of additionalManifestEntries()) {
      const inPublic = existsSync(join(publicDir, entry.url));
      const inRoot = existsSync(join(appRoot, entry.url));
      expect(inPublic || inRoot, `${entry.url} should exist`).toBe(true);
    }
  });

  it('freezes the rule catalog with no timestamp to churn the diff', () => {
    const doc = JSON.parse(readFileSync(join(publicDir, 'data', 'rules.json'), 'utf8')) as Record<
      string,
      unknown
    > & { count: number; rules: { id: string; severity: string; description: string }[] };

    // Regenerating the file must produce byte-identical output, so nothing
    // time-dependent may appear: a build clock would make every run a diff.
    expect(Object.keys(doc).sort()).toEqual(['$comment', 'count', 'rules']);
    expect(doc.count).toBeGreaterThan(50);
    expect(doc.rules).toHaveLength(doc.count);
    expect(doc.rules.map((rule) => rule.id)).toEqual([...doc.rules.map((rule) => rule.id)].sort());
  });

  it('freezes a JSON Schema for stellar.toml', () => {
    const schema = JSON.parse(
      readFileSync(join(publicDir, 'data', 'stellar-toml.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(schema.$schema ?? schema.$comment).toBeDefined();
    expect(schema.type ?? schema.properties).toBeDefined();
  });
});

describe('runtime cache routing', () => {
  it('assigns a WASM request to the engine cache', () => {
    // The linter's browser build is JS today; a future WASM build must not be
    // silently uncached, which is why the route is by extension.
    expect(runtimeCacheFor('https://app.test/assets/lint-9f2.wasm')).toBe('stellar-toml-lint-wasm');
    expect(runtimeCacheFor('https://app.test/assets/lint.wasm?v=2')).toBe('stellar-toml-lint-wasm');
  });

  it('re-reads an inspected info file from the network first', () => {
    expect(runtimeCacheFor('https://anchor.example.com/.well-known/stellar.toml')).toBe(
      'inspected-info-files',
    );
  });

  it('leaves unrelated requests to the browser', () => {
    expect(runtimeCacheFor('https://cdn.test/analytics.js')).toBeUndefined();
  });

  it('bounds every cache so an install cannot grow without limit', () => {
    for (const entry of RUNTIME_CACHE_PATTERNS) {
      expect(entry.maxEntries).toBeGreaterThan(0);
      expect(entry.maxEntries).toBeLessThanOrEqual(128);
    }
  });
});

describe('ProjectRepository', () => {
  it('names a new project after the file it holds', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    expect((await repo.create()).name).toBe('stellar.toml');
    expect((await repo.create()).name).toBe('stellar.toml 2');
    expect((await repo.create()).name).toBe('stellar.toml 3');
  });

  it('rejects a duplicate name, case-insensitively', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    await repo.create('Anchor A');
    await expect(repo.create('anchor a')).rejects.toThrow(DuplicateProjectNameError);
  });

  it('rejects an empty name', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    await expect(repo.create('   ')).rejects.toThrow(/cannot be empty/);
  });

  it('stores and returns the contents it was given', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    const project = await repo.create(undefined, 'VERSION = "1.0.0"\n');
    expect((await repo.get(project.id))?.content).toBe('VERSION = "1.0.0"\n');
  });

  it('bumps updatedAt on save and lists the newest first', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    const first = await repo.create('first', 'a');
    const second = await repo.create('second', 'b');

    expect((await repo.list()).map((project) => project.name)).toEqual(['second', 'first']);

    await repo.save(first.id, 'edited');
    const listed = await repo.list();
    expect(listed[0]?.id).toBe(first.id);
    expect(listed[0]?.content).toBe('edited');
    expect(listed[0]?.updatedAt).toBeGreaterThan(second.updatedAt);
  });

  it('renames without colliding with another project', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    const a = await repo.create('a');
    await repo.create('b');

    expect((await repo.rename(a.id, 'c')).name).toBe('c');
    await expect(repo.rename(a.id, 'b')).rejects.toThrow(DuplicateProjectNameError);
    // Renaming to the same name it already has is fine.
    expect((await repo.rename(a.id, 'c')).name).toBe('c');
  });

  it('refuses contents larger than the linter would ever accept', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    const huge = 'x'.repeat(MAX_SOURCE_BYTES + 1);
    await expect(repo.create('huge', huge)).rejects.toThrow(/at most/);
  });

  it('saves a project at exactly the size limit', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    const project = await repo.create('exact');
    const sized = 'x'.repeat(MAX_SOURCE_BYTES);
    expect((await repo.save(project.id, sized)).content).toHaveLength(MAX_SOURCE_BYTES);
  });

  it('deletes a project and tolerates an unknown id', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    const project = await repo.create('gone');
    await repo.remove(project.id);
    expect(await repo.get(project.id)).toBeUndefined();
    await expect(repo.remove('does-not-exist')).resolves.toBeUndefined();
  });

  it('refuses to save a project that is not there', async () => {
    const repo = new ProjectRepository(new MemoryBackend(), clock());
    await expect(repo.save('missing', 'x')).rejects.toThrow(/No project with id/);
  });
});

describe('nextAvailableName', () => {
  it('starts at the plain file name and counts up', () => {
    expect(nextAvailableName([])).toBe('stellar.toml');
    expect(nextAvailableName([{ name: 'stellar.toml' } as never])).toBe('stellar.toml 2');
    expect(nextAvailableName([{ name: 'stellar.toml' }, { name: 'stellar.toml 2' }] as never)).toBe(
      'stellar.toml 3',
    );
  });

  it('treats names case-insensitively', () => {
    expect(nextAvailableName([{ name: 'STELLAR.TOML' } as never])).toBe('stellar.toml 2');
  });
});

describe('createBackend', () => {
  it('falls back to memory when the environment has no IndexedDB', async () => {
    const backend = await createBackend(undefined);
    expect(backend).toBeInstanceOf(MemoryBackend);
  });

  it('falls back to memory when IndexedDB exists but refuses to open', async () => {
    // A private window exposes `indexedDB` and throws on first use, which is
    // exactly why the fallback is chosen by trying rather than feature-detecting.
    const hostile = {
      open() {
        throw new Error('SecurityError: indexedDB is not available in this context');
      },
    } as unknown as IDBFactory;

    const backend = await createBackend(hostile);
    expect(backend).toBeInstanceOf(MemoryBackend);
  });
});
