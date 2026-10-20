/* eslint-disable no-undef -- Node globals; the same escape hatch scripts/build-browser.js uses. */
/**
 * Freezes the linter's own rule catalog and `stellar.toml` JSON Schema into the
 * PWA's `public/` directory.
 *
 * The offline studio has to answer "which rules exist?" and "what fields are
 * allowed?" on a machine with no network. Both answers already exist in the
 * published package, so they are generated from it rather than retyped —
 * a copy is exactly the thing that silently drifts from the checker and makes
 * an offline audit say the file is fine when it is not.
 *
 * Run `npm run build` at the repository root first: this reads `dist/`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repoRoot = join(appDir, '..', '..');
const outDir = join(appDir, 'public', 'data');

const distIndex = join(repoRoot, 'dist', 'index.js');
try {
  readFileSync(distIndex);
} catch {
  process.stderr.write(
    `Could not read ${distIndex}. Run "npm run build" at the repository root first.\n`,
  );
  process.exit(1);
}

const { getTomlJsonSchema } = await import(pathToFileURL(join(repoRoot, 'dist', 'schema.js')).href);
const { allRules } = await import(pathToFileURL(join(repoRoot, 'dist', 'rules', 'index.js')).href);

mkdirSync(outDir, { recursive: true });

// Sorted and free of timestamps, so regenerating never produces a spurious diff.
const rules = [...allRules]
  .map((rule) => ({
    id: rule.id,
    severity: rule.severity,
    ...(rule.category === undefined ? {} : { category: rule.category }),
    description: rule.description,
  }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const rulesDoc = {
  $comment:
    'Generated from the stellar-toml-lint rule registry by apps/pwa/scripts/generate-offline-data.mjs. Do not edit by hand.',
  count: rules.length,
  rules,
};

const schema = getTomlJsonSchema();

writeFileSync(join(outDir, 'rules.json'), `${JSON.stringify(rulesDoc, null, 2)}\n`);
writeFileSync(
  join(outDir, 'stellar-toml.schema.json'),
  `${JSON.stringify({ $comment: rulesDoc.$comment, ...schema }, null, 2)}\n`,
);

process.stdout.write(
  `wrote public/data/rules.json (${rules.length} rules) and public/data/stellar-toml.schema.json\n`,
);
