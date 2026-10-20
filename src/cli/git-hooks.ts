/**
 * Git hook installer for `stellar-toml-lint --install-hook <pre-commit|pre-push>`.
 *
 * Committing draft work locally is normal; pushing it is not. A `pre-commit`
 * hook that blocks every commit asks people to skip it, so the strict,
 * network-touching audit belongs on `pre-push` — the one moment the work is
 * about to leave the machine. This module writes those hooks natively, with no
 * dependency on the `pre-commit` framework, because the people who most need a
 * push gate are the ones running the linter before a domain exists.
 *
 * The generated scripts are POSIX `sh`, deliberately: git runs hooks with
 * `/bin/sh`, and a `#!/usr/bin/env bash` shebang is a promise Windows and
 * minimal container images cannot keep. They shell out to the same
 * `stellar-toml-lint` binary the team already runs, overridable with
 * `STELLAR_TOML_LINT` so a pinned `npx` invocation can be recorded once.
 *
 * A managed hook is recognised by {@link HOOK_MARKER}. That marker is what lets
 * a reinstall be idempotent and an uninstall restore whatever the developer had
 * there before, instead of silently discarding someone else's hook.
 */
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Hooks `--install-hook` knows how to write. */
export const HOOK_NAMES = ['pre-commit', 'pre-push'] as const;

/** A hook name the installer understands. */
export type HookName = (typeof HOOK_NAMES)[number];

/** True when `value` names a hook the installer can write. */
export function isHookName(value: string): value is HookName {
  return (HOOK_NAMES as readonly string[]).includes(value);
}

/**
 * Marks a generated hook as ours. Present in the script body rather than only
 * in a comment header so an editor stripping comments cannot make an uninstall
 * mistake our hook for a hand-written one.
 */
export const HOOK_MARKER = 'stellar-toml-lint:managed-hook';

/** Suffix used to preserve a hook we are about to replace. */
export const BACKUP_SUFFIX = '.stellar-toml-lint.bak';

/** The command the generated hooks run by default, overridable at hook time. */
export const DEFAULT_COMMAND = 'npx --yes stellar-toml-lint';

/** Options shared by install and uninstall. */
export interface HookOptions {
  /** Directory to start the `.git` search from. Defaults to the process cwd. */
  cwd?: string;
  /** Linter command baked into the script. Defaults to {@link DEFAULT_COMMAND}. */
  command?: string;
}

/** Outcome of {@link installHook}. */
export interface InstallResult {
  /** Absolute path of the installed hook. */
  path: string;
  /** The `.git` directory (or worktree gitdir) the hook landed in. */
  gitDir: string;
  /** Absolute path of a preserved pre-existing hook, when there was one. */
  backedUp?: string;
}

/** Outcome of {@link uninstallHook}. */
export interface UninstallResult {
  /** Absolute path examined. */
  path: string;
  /** Whether a file was found at that path at all. */
  present: boolean;
  /** Whether a managed hook was removed. */
  removed: boolean;
  /** Absolute path of a hook restored from backup, when there was one. */
  restored?: string;
}

/**
 * Locates the git directory for `startDir`, walking up to the filesystem root.
 *
 * Handles both layouts git uses: a real `.git` directory, and the pointer file
 * a linked worktree or submodule gets (`gitdir: /path/to/real/gitdir`). Walking
 * up matters because the linter is usually invoked from a subdirectory, and
 * `.git` only sits at the repository root.
 */
export async function findGitDir(startDir: string = process.cwd()): Promise<string | undefined> {
  let dir = resolve(startDir);

  for (;;) {
    const candidate = join(dir, '.git');
    const asDirectory = await statKind(candidate);
    if (asDirectory === 'directory') return candidate;
    if (asDirectory === 'file') {
      const pointer = await readFile(candidate, 'utf8');
      const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
      if (match?.[1] !== undefined) return resolve(dir, match[1]);
      return undefined;
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `<gitDir>/hooks`, created if it does not exist yet. */
export async function hooksDirectory(gitDir: string): Promise<string> {
  const dir = join(gitDir, 'hooks');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Renders the hook script for `name` without touching the filesystem.
 *
 * Split out from {@link installHook} so the generated shell is unit-testable as
 * a string, since the interesting behaviour lives in the script body rather
 * than in the few lines that write it.
 */
export function renderHookScript(name: HookName, options: HookOptions = {}): string {
  const command = options.command ?? DEFAULT_COMMAND;
  const marker = `# ${HOOK_MARKER} — regenerate with: stellar-toml-lint --install-hook ${name}`;

  if (name === 'pre-commit') {
    return `#!/bin/sh
# stellar-toml-lint pre-commit hook
${marker}
#
# Lints every staged stellar.toml — the staged blob, not the working tree, so
# what is checked is exactly what the commit will contain.
set -u

LINTER="\${STELLAR_TOML_LINT:-${command}}"
status=0

files=$(git diff --cached --name-only --diff-filter=ACMR \\
  | grep -E '(^|/)(\\.well-known/)?stellar\\.toml$' || true)
[ -n "$files" ] || exit 0

for file in $files; do
  echo "stellar-toml-lint: checking $file" >&2
  if ! git show ":$file" | $LINTER -; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "stellar-toml-lint: commit aborted — fix the findings above, or commit with --no-verify." >&2
  exit 1
fi
exit 0
`;
  }

  return `#!/bin/sh
# stellar-toml-lint pre-push hook
${marker}
#
# Lints every stellar.toml in the commit range being pushed and aborts the push
# (exit 1) when SEP-1 problems are found. A push that touches no stellar.toml is
# a no-op, so draft work still leaves the machine untouched.
set -u

LINTER="\${STELLAR_TOML_LINT:-${command}}"
ZERO=0000000000000000000000000000000000000000
status=0
found=0

# One line per ref: <local ref> <local sha> <remote ref> <remote sha>.
while read -r _local_ref local_sha _remote_ref remote_sha || [ -n "\${_local_ref:-}" ]; do
  [ -n "\${local_sha:-}" ] || continue
  [ "$local_sha" != "$ZERO" ] || continue

  if [ "\${remote_sha:-$ZERO}" = "$ZERO" ]; then
    # New branch: only the commits no remote has yet, including a root commit
    # that has no parent to diff against.
    files=$(git log --name-only --pretty=format: --diff-filter=ACMR \\
      "$local_sha" --not --remotes 2>/dev/null)
  else
    files=$(git diff --name-only --diff-filter=ACMR \\
      "$remote_sha..$local_sha" 2>/dev/null)
  fi

  files=$(printf '%s\\n' "$files" \\
    | grep -E '(^|/)(\\.well-known/)?stellar\\.toml$' || true)
  [ -n "$files" ] || continue

  for file in $files; do
    found=1
    echo "stellar-toml-lint: checking $file" >&2
    if ! git show "$local_sha:$file" | $LINTER -; then
      status=1
    fi
  done
done

if [ "$status" -ne 0 ]; then
  echo "stellar-toml-lint: push aborted — fix the findings above, or push with --no-verify." >&2
  exit 1
fi

if [ "$found" -eq 0 ]; then
  echo "stellar-toml-lint: no stellar.toml in this push" >&2
fi
exit 0
`;
}

/**
 * Installs (or refreshes) a managed hook.
 *
 * A pre-existing hook that we did not write is moved aside to
 * `<name>{@link BACKUP_SUFFIX}` first and never overwritten a second time, so
 * reinstalling cannot destroy the original. Throws when there is no repository
 * to install into — a silently skipped install is the failure mode this whole
 * feature exists to prevent.
 */
export async function installHook(
  name: HookName,
  options: HookOptions = {},
): Promise<InstallResult> {
  const gitDir = await findGitDir(options.cwd);
  if (gitDir === undefined) {
    throw new Error(
      'Not inside a Git repository — found no .git directory from here. Run this from your project checkout.',
    );
  }

  const dir = await hooksDirectory(gitDir);
  const path = join(dir, name);
  const result: InstallResult = { path, gitDir };

  if (await isManaged(path)) {
    // Ours already: refresh in place, no backup churn.
  } else if (await exists(path)) {
    const backup = `${path}${BACKUP_SUFFIX}`;
    if (!(await exists(backup))) {
      await rename(path, backup);
      result.backedUp = backup;
    } else {
      // A backup already exists, so this is a hook we replaced before; keep the
      // original and drop the current file rather than clobbering the backup.
      await unlink(path);
      result.backedUp = backup;
    }
  }

  await writeFile(path, renderHookScript(name, options), { mode: 0o755 });
  // `mode` above is masked by the umask on some platforms; chmod is the promise
  // git actually needs, since it refuses to run a hook that is not executable.
  await chmod(path, 0o755);

  return result;
}

/**
 * Removes a managed hook, restoring the backup taken at install time when there
 * is one. Leaves a hook we did not write alone: `removed` comes back `false`
 * rather than a foreign hook being deleted.
 */
export async function uninstallHook(
  name: HookName,
  options: HookOptions = {},
): Promise<UninstallResult> {
  const gitDir = await findGitDir(options.cwd);
  if (gitDir === undefined) {
    throw new Error(
      'Not inside a Git repository — found no .git directory from here. Run this from your project checkout.',
    );
  }

  const path = join(gitDir, 'hooks', name);
  const result: UninstallResult = { path, present: false, removed: false };

  if (!(await exists(path))) return result;
  result.present = true;

  if (!(await isManaged(path))) return result;

  await unlink(path);
  result.removed = true;

  const backup = `${path}${BACKUP_SUFFIX}`;
  if (await exists(backup)) {
    await rename(backup, path);
    result.restored = path;
  }

  return result;
}

/** `stat` reduced to the two kinds the `.git` search cares about. */
async function statKind(path: string): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
    return undefined;
  } catch {
    return undefined;
  }
}

/** Whether a path exists at all, treating any error as "no". */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether the file at `path` is a hook this tool installed. */
async function isManaged(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  try {
    const body = await readFile(path, 'utf8');
    return body.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}
