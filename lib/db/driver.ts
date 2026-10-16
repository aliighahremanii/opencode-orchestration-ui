import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * SQLite access.
 *
 * The observer uses Node's built-in synchronous SQLite driver (`node:sqlite`).
 * Two separate processes (the web server and the long-lived collector) open the
 * same database file, so every connection must be configured for concurrent
 * multi-process access:
 *
 * - WAL journal mode lets readers proceed while a writer holds the write lock.
 * - A busy timeout makes a second writer wait for the lock instead of failing.
 * - Foreign keys are enforced so dangling references cannot be persisted.
 *
 * Synchronous queries are intentional: they keep write transactions short and
 * predictable, which is what makes the collector's fencing logic auditable.
 */

export type Db = DatabaseSync;

export class DatabaseUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseUnavailableError";
  }
}

const BUSY_TIMEOUT_MS = 10_000;

export function openDatabase(dbPath: string): Db {
  try {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    const journalMode = db.prepare("PRAGMA journal_mode = WAL").get() as
      | { journal_mode?: string }
      | undefined;
    const effective = journalMode?.journal_mode ?? "unknown";
    if (dbPath !== ":memory:" && effective !== "wal") {
      // Without WAL the collector and the web process would serialise on a
      // single lock and long reads would block collection. Refuse to run.
      throw new DatabaseUnavailableError(
        `SQLite refused WAL journal mode for ${dbPath} (reported ${effective}); ` +
          "the database must live on a filesystem that supports WAL.",
      );
    }
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
  } catch (cause) {
    if (cause instanceof DatabaseUnavailableError) throw cause;
    throw new DatabaseUnavailableError(
      `Unable to open the SQLite database at ${dbPath}: ${describeError(cause)}`,
      { cause },
    );
  }
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

// --- statement cache -------------------------------------------------------

const statementCache = new WeakMap<Db, Map<string, StatementSync>>();

export function prepare(db: Db, sql: string): StatementSync {
  let perDb = statementCache.get(db);
  if (perDb === undefined) {
    perDb = new Map<string, StatementSync>();
    statementCache.set(db, perDb);
  }
  let stmt = perDb.get(sql);
  if (stmt === undefined) {
    stmt = db.prepare(sql);
    perDb.set(sql, stmt);
  }
  return stmt;
}

/** Run a statement and return the first row, or `undefined`. */
export function queryOne<T>(db: Db, sql: string, params: readonly SqlValue[] = []): T | undefined {
  return prepare(db, sql).get(...params) as T | undefined;
}

/** Run a statement and return every row. */
export function queryAll<T>(db: Db, sql: string, params: readonly SqlValue[] = []): T[] {
  return prepare(db, sql).all(...params) as T[];
}

/** Run a statement that does not return rows. */
export function execute(db: Db, sql: string, params: readonly SqlValue[] = []): { changes: number; lastInsertRowid: number } {
  const result = prepare(db, sql).run(...params);
  return {
    changes: Number(result.changes ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

export type SqlValue = string | number | null | bigint | Uint8Array;

// --- transactions ----------------------------------------------------------

const transactionDepth = new WeakMap<Db, number>();

/**
 * Run `fn` inside `BEGIN IMMEDIATE`.
 *
 * `IMMEDIATE` takes the write lock up front, so two collectors racing to claim
 * the same lease cannot both succeed. Nested calls join the outer transaction
 * rather than starting a second one (SQLite has no nested transactions).
 */
export function immediateTransaction<T>(db: Db, fn: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth > 0) {
    return fn();
  }
  db.exec("BEGIN IMMEDIATE");
  transactionDepth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw cause;
  } finally {
    transactionDepth.set(db, 0);
  }
}

/** Boolean helpers keep the repository layer free of driver-specific coercion. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}
