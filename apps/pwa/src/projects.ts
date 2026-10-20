/**
 * Multi-project storage for the offline studio.
 *
 * An auditor works on several `stellar.toml` files at once — an anchor, two
 * issuers, a validator — and needs each one back exactly as it was left, on a
 * laptop that has not seen a network in hours. That is a job for IndexedDB:
 * the storage survives a reload, a crash, and a flight, and it is the only
 * structured store a browser gives a page without a server.
 *
 * The interesting logic — naming, ordering, size limits, rename collisions —
 * is separated from IndexedDB behind {@link ProjectBackend}, because
 * `indexedDB` does not exist in Node and the behaviour is what needs pinning
 * down in tests. {@link MemoryBackend} is both the test double and the real
 * fallback for a private window, where IndexedDB throws on open.
 */

/** One named `stellar.toml` the user is working on. */
export interface TomlProject {
  /** Stable identifier; also the IndexedDB key. */
  id: string;
  /** User-visible name. Unique, case-insensitively. */
  name: string;
  /** The file contents. */
  content: string;
  /** Epoch milliseconds of the last write, for "recently opened" ordering. */
  updatedAt: number;
}

/** The persistence primitive a {@link ProjectRepository} sits on. */
export interface ProjectBackend {
  readAll(): Promise<TomlProject[]>;
  read(id: string): Promise<TomlProject | undefined>;
  write(project: TomlProject): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The linter's own file ceiling; a larger buffer would never be accepted. */
export const MAX_SOURCE_BYTES = 100 * 1024;

/** Default name stem, so the first project is not called "untitled". */
export const DEFAULT_NAME_STEM = 'stellar.toml';

/** Thrown for a name that collides with an existing project. */
export class DuplicateProjectNameError extends Error {
  constructor(name: string) {
    super(`A project named "${name}" already exists.`);
    this.name = 'DuplicateProjectNameError';
  }
}

/**
 * Project operations over a backend.
 *
 * `now` is injected so ordering is deterministic under test and so a clock
 * change cannot make a saved project sort before the one it replaced.
 */
export class ProjectRepository {
  constructor(
    private readonly backend: ProjectBackend,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Every project, most recently updated first. */
  async list(): Promise<TomlProject[]> {
    const projects = await this.backend.readAll();
    return [...projects].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  /** One project by id. */
  async get(id: string): Promise<TomlProject | undefined> {
    return this.backend.read(id);
  }

  /**
   * Creates a project, naming it `stellar.toml` (then `stellar.toml 2`, ...)
   * unless a name is given. A supplied name must not collide.
   */
  async create(name?: string, content = ''): Promise<TomlProject> {
    assertSize(content);
    const existing = await this.backend.readAll();
    const resolved = name === undefined ? nextAvailableName(existing) : name.trim();
    if (resolved === '') throw new Error('A project name cannot be empty.');
    assertUnique(existing, resolved, undefined);

    const project: TomlProject = {
      id: newId(),
      name: resolved,
      content,
      updatedAt: this.now(),
    };
    await this.backend.write(project);
    return project;
  }

  /** Overwrites a project's contents, bumping its timestamp. */
  async save(id: string, content: string): Promise<TomlProject> {
    assertSize(content);
    const project = await this.require(id);
    const updated: TomlProject = { ...project, content, updatedAt: this.now() };
    await this.backend.write(updated);
    return updated;
  }

  /** Renames a project; the new name must not collide with another project. */
  async rename(id: string, name: string): Promise<TomlProject> {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('A project name cannot be empty.');
    const project = await this.require(id);
    const existing = await this.backend.readAll();
    assertUnique(existing, trimmed, id);

    const updated: TomlProject = { ...project, name: trimmed };
    await this.backend.write(updated);
    return updated;
  }

  /** Deletes a project. Deleting an unknown id is not an error. */
  async remove(id: string): Promise<void> {
    await this.backend.remove(id);
  }

  private async require(id: string): Promise<TomlProject> {
    const project = await this.backend.read(id);
    if (project === undefined) throw new Error(`No project with id "${id}".`);
    return project;
  }
}

/** In-memory backend: the test double, and the private-window fallback. */
export class MemoryBackend implements ProjectBackend {
  private readonly projects = new Map<string, TomlProject>();

  async readAll(): Promise<TomlProject[]> {
    return [...this.projects.values()].map((project) => ({ ...project }));
  }

  async read(id: string): Promise<TomlProject | undefined> {
    const project = this.projects.get(id);
    return project === undefined ? undefined : { ...project };
  }

  async write(project: TomlProject): Promise<void> {
    this.projects.set(project.id, { ...project });
  }

  async remove(id: string): Promise<void> {
    this.projects.delete(id);
  }
}

/** Default object store and database names. */
export const DB_NAME = 'stellar-toml-lint';
export const STORE_NAME = 'projects';

/**
 * IndexedDB backend.
 *
 * Everything the DOM API makes awkward — the request/transaction dance, the
 * `onupgradeneeded` schema creation — is confined to this class, so the
 * repository above stays readable and browser-free.
 */
export class IndexedDbBackend implements ProjectBackend {
  constructor(
    private readonly factory: IDBFactory,
    private readonly dbName: string = DB_NAME,
    private readonly storeName: string = STORE_NAME,
  ) {}

  async readAll(): Promise<TomlProject[]> {
    const db = await this.open();
    return request<TomlProject[]>(
      db.transaction(this.storeName, 'readonly').objectStore(this.storeName).getAll(),
    );
  }

  async read(id: string): Promise<TomlProject | undefined> {
    const db = await this.open();
    return request<TomlProject | undefined>(
      db.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(id),
    );
  }

  async write(project: TomlProject): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(this.storeName, 'readwrite');
    tx.objectStore(this.storeName).put(project);
    await transactionDone(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(this.storeName, 'readwrite');
    tx.objectStore(this.storeName).delete(id);
    await transactionDone(tx);
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
    });
  }
}

/**
 * Picks a store the current environment can actually use.
 *
 * A private window exposes `indexedDB` and then throws on the first open, so
 * the fallback is chosen by trying, not by feature-detecting.
 */
export async function createBackend(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<ProjectBackend> {
  if (factory === undefined) return new MemoryBackend();
  try {
    const backend = new IndexedDbBackend(factory);
    await backend.readAll();
    return backend;
  } catch {
    return new MemoryBackend();
  }
}

/** `stellar.toml`, then `stellar.toml 2`, `stellar.toml 3`, ... */
export function nextAvailableName(existing: readonly TomlProject[]): string {
  const taken = new Set(existing.map((project) => project.name.toLowerCase()));
  if (!taken.has(DEFAULT_NAME_STEM.toLowerCase())) return DEFAULT_NAME_STEM;
  for (let n = 2; ; n++) {
    const candidate = `${DEFAULT_NAME_STEM} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function assertUnique(
  existing: readonly TomlProject[],
  name: string,
  ignoreId: string | undefined,
): void {
  const collision = existing.some(
    (project) =>
      project.id !== ignoreId && project.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (collision) throw new DuplicateProjectNameError(name.trim());
}

function assertSize(content: string): void {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `The file is ${bytes} bytes; the linter accepts at most ${MAX_SOURCE_BYTES}. Large files are rejected before they are stored so the offline cache cannot be filled by one paste.`,
    );
  }
}

function newId(): string {
  if (globalThis.crypto?.randomUUID !== undefined) return globalThis.crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}
