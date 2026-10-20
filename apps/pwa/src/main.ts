/**
 * The offline studio.
 *
 * Three things make this different from the desktop CLI: projects live in
 * IndexedDB and survive a reload, linting runs in a worker so a 100 KB paste
 * does not lock the tab, and the whole thing is registered as a service worker
 * so it opens with the network switched off.
 */
import { registerSW } from 'virtual:pwa-register';
import LintWorker from 'stellar-toml-lint/worker?worker';
import { lintBrowser } from 'stellar-toml-lint/browser';
import { ProjectRepository, createBackend, type TomlProject } from './projects';
import './styles.css';

interface LintFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
  position?: { line: number; column: number };
}

interface LintOutcome {
  ok: boolean;
  counts: { error: number; warning: number; info: number };
  diagnostics: LintFinding[];
}

const STARTER = `VERSION = "1.0.0"
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"

[DOCUMENTATION]
ORG_NAME = "Offline Studio Anchor"
ORG_URL = "https://anchor.example.com"
`;

let worker: Worker | null = null;

/**
 * Lints off the main thread when a worker is available.
 *
 * The worker is the point: a syntax-highlighted 100 KB paste re-lints on every
 * edit, and doing that on the UI thread makes typing feel broken. If worker
 * construction fails (an unusual CSP), the same call runs inline rather than
 * leaving the studio unable to lint.
 */
async function lint(content: string): Promise<LintOutcome> {
  if (worker !== null) {
    try {
      return await new Promise<LintOutcome>((resolve, reject) => {
        const handler = (event: MessageEvent): void => {
          const data = event.data as { type: string; result?: LintOutcome; message?: string };
          if (data.type === 'result' && data.result !== undefined) {
            worker?.removeEventListener('message', handler);
            resolve(data.result);
          } else if (data.type === 'error') {
            worker?.removeEventListener('message', handler);
            reject(new Error(data.message ?? 'The lint worker failed.'));
          }
        };
        worker?.addEventListener('message', handler);
        worker?.postMessage({ type: 'lint', content });
      });
    } catch {
      // Fall through to the inline linter rather than showing a dead button.
    }
  }
  const result = await lintBrowser(content);
  return result as unknown as LintOutcome;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main(): Promise<void> {
  try {
    worker = new LintWorker();
  } catch {
    worker = null;
  }

  const repository = new ProjectRepository(await createBackend());
  const projects = await repository.list();
  if (projects.length === 0) {
    await repository.create(undefined, STARTER);
  }

  const root = document.getElementById('root');
  if (root === null) return;

  root.innerHTML = '';
  root.append(
    el('h1', 'app__title', 'stellar.toml offline studio'),
    el(
      'p',
      'app__lede',
      'Projects live in this browser, not on a server. Everything works with the network off.',
    ),
  );

  const layout = el('div', 'app__layout');
  const sidebar = el('aside', 'app__sidebar');
  const editorPane = el('section', 'app__editor');
  const findingsPane = el('section', 'app__findings');
  layout.append(sidebar, editorPane, findingsPane);
  root.append(layout);

  const status = el('p', 'app__status', '');
  root.append(status);

  const textarea = el('textarea', 'app__textarea');
  textarea.spellCheck = false;
  textarea.rows = 22;

  let current: TomlProject | undefined;

  function renderFindings(outcome: LintOutcome | undefined): void {
    findingsPane.innerHTML = '';
    findingsPane.append(el('h2', undefined, 'Diagnostics'));
    if (outcome === undefined) {
      findingsPane.append(el('p', 'muted', 'Not linted yet.'));
      return;
    }
    findingsPane.append(
      el(
        'p',
        outcome.ok ? 'verdict verdict--ok' : 'verdict verdict--bad',
        `${outcome.counts.error} error(s), ${outcome.counts.warning} warning(s), ${outcome.counts.info} info`,
      ),
    );
    const list = el('ul', 'findings');
    for (const finding of outcome.diagnostics) {
      const item = el('li', `finding finding--${finding.severity}`);
      const where =
        finding.position === undefined
          ? ''
          : `${finding.position.line}:${finding.position.column} `;
      item.append(
        el('code', undefined, `${where}${finding.rule}`),
        el('span', undefined, ` ${finding.message}`),
      );
      if (finding.suggestion !== undefined) {
        item.append(el('em', 'finding__suggestion', finding.suggestion));
      }
      list.append(item);
    }
    findingsPane.append(list);
  }

  async function open(project: TomlProject): Promise<void> {
    current = project;
    textarea.value = project.content;
    renderProjects(await repository.list());
    renderFindings(undefined);
  }

  async function lintCurrent(): Promise<void> {
    if (current === undefined) return;
    status.textContent = 'Linting…';
    try {
      const outcome = await lint(textarea.value);
      renderFindings(outcome);
      status.textContent = 'Linted offline.';
    } catch (error) {
      status.textContent = `Lint failed: ${String(error)}`;
    }
  }

  function renderProjects(all: readonly TomlProject[]): void {
    sidebar.innerHTML = '';
    sidebar.append(el('h2', undefined, 'Projects'));
    const list = el('ul', 'projects');
    for (const project of all) {
      const item = el('li', project.id === current?.id ? 'project project--active' : 'project');
      const openButton = el('button', 'project__open', project.name);
      openButton.type = 'button';
      openButton.addEventListener('click', () => {
        void open(project);
      });
      const removeButton = el('button', 'project__remove', '×');
      removeButton.type = 'button';
      removeButton.title = `Delete ${project.name}`;
      removeButton.addEventListener('click', () => {
        void (async () => {
          await repository.remove(project.id);
          if (current?.id === project.id) {
            current = undefined;
            textarea.value = '';
          }
          renderProjects(await repository.list());
        })();
      });
      item.append(openButton, removeButton);
      list.append(item);
    }
    sidebar.append(list);

    const create = el('button', 'project__create', 'New project');
    create.type = 'button';
    create.addEventListener('click', () => {
      void (async () => {
        const project = await repository.create(undefined, '');
        await open(project);
      })();
    });
    sidebar.append(create);
  }

  const actions = el('div', 'app__actions');
  const lintButton = el('button', undefined, 'Lint');
  lintButton.type = 'button';
  lintButton.addEventListener('click', () => {
    void lintCurrent();
  });
  const saveButton = el('button', undefined, 'Save');
  saveButton.type = 'button';
  saveButton.addEventListener('click', () => {
    void (async () => {
      if (current === undefined) return;
      await repository.save(current.id, textarea.value);
      status.textContent = 'Saved to this browser.';
      renderProjects(await repository.list());
    })();
  });
  const renameButton = el('button', undefined, 'Rename');
  renameButton.type = 'button';
  renameButton.addEventListener('click', () => {
    void (async () => {
      if (current === undefined) return;
      const name = window.prompt('Project name', current.name);
      if (name === null) return;
      try {
        current = await repository.rename(current.id, name);
        renderProjects(await repository.list());
      } catch (error) {
        status.textContent = String(error);
      }
    })();
  });
  actions.append(lintButton, saveButton, renameButton);

  const installButton = el('button', 'app__install', 'Install app');
  installButton.type = 'button';
  installButton.hidden = true;
  installButton.addEventListener('click', () => {
    void deferredPrompt?.prompt();
  });
  actions.append(installButton);

  editorPane.append(el('h2', undefined, 'stellar.toml'), actions, textarea);

  let deferredPrompt: { prompt: () => Promise<void> } | undefined;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as unknown as { prompt: () => Promise<void> };
    installButton.hidden = false;
  });

  // The registration is what makes the whole thing offline-capable; report it
  // honestly instead of claiming readiness the browser has not confirmed.
  const updateSW = registerSW({
    onOfflineReady: () => {
      status.textContent = 'Ready offline. You can disconnect now.';
    },
    onNeedRefresh: () => {
      status.textContent = 'A new version is ready; reload to apply it.';
    },
  });
  void updateSW;

  await open((await repository.list())[0] as TomlProject);
  await lintCurrent();
}

void main();
