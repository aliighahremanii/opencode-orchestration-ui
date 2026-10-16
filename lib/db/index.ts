import { ConfigError, getConfig } from "../config.ts";
import { getOwner, setOwner } from "./auth-store.ts";
import { openDatabase, type Db } from "./driver.ts";
import { currentSchemaVersion, expectedSchemaVersion, runMigrations } from "./migrations.ts";
import { hashPassword, isSupportedPasswordHash, verifyPassword } from "../auth/password.ts";

/**
 * Process-wide database handle.
 *
 * Both the web server and the collector call this. Opening the database also
 * applies pending migrations (lock-guarded, so concurrent starts are safe) and
 * resolves the owner credential.
 *
 * Any failure is recorded and re-thrown, and the recorded state is surfaced at
 * `/status` and on `/login` so an operator can see *why* the application is
 * refusing to serve data instead of getting an opaque 500.
 */

export interface DatabaseState {
  readonly ready: boolean;
  readonly error: string | null;
  readonly schemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly ownerConfigured: boolean;
  readonly dbPath: string;
  readonly warnings: readonly string[];
}

interface MutableState {
  db: Db | null;
  error: Error | null;
  warnings: string[];
}

const state: MutableState = { db: null, error: null, warnings: [] };

function resolveOwnerCredential(db: Db, now: number): void {
  const config = getConfig();
  const { ownerPasswordHash, ownerPassword } = config.auth;

  if (ownerPasswordHash !== null) {
    if (!isSupportedPasswordHash(ownerPasswordHash)) {
      throw new ConfigError(
        "ORCH_OWNER_PASSWORD_HASH",
        "not a supported scrypt hash; expected the form scrypt$N$r$p$<salt>:<key> (generate one with `npm run auth:hash`)",
      );
    }
    setOwner(db, ownerPasswordHash, "scrypt", now);
    return;
  }

  const existing = getOwner(db);
  if (ownerPassword !== null) {
    if (existing === null) {
      setOwner(db, hashPassword(ownerPassword), "scrypt", now);
      state.warnings.push(
        "Bootstrapped the owner credential from ORCH_OWNER_PASSWORD. " +
          "The plaintext variable can now be removed; only the stored hash is used.",
      );
      return;
    }
    if (!verifyPassword(ownerPassword, existing.password_hash)) {
      state.warnings.push(
        "ORCH_OWNER_PASSWORD does not match the stored owner credential. " +
          "The stored credential is authoritative; clear the stored credential to reset it.",
      );
    }
    return;
  }

  if (existing === null) {
    state.warnings.push(
      "No owner credential configured. The dashboard fails closed: every data page and API " +
        "returns 503 until ORCH_OWNER_PASSWORD or ORCH_OWNER_PASSWORD_HASH is set.",
    );
  }
}

function bootstrap(): Db {
  const config = getConfig();
  const db = openDatabase(config.dbPath);
  try {
    const role = process.env.ORCH_ROLE ?? "unknown";
    runMigrations(db, role);
    resolveOwnerCredential(db, Date.now());
    return db;
  } catch (cause) {
    try {
      db.close();
    } catch {
      // Ignore: the bootstrap error is what matters.
    }
    throw cause;
  }
}

export function ensureDatabaseReady(): Db {
  if (state.db !== null) return state.db;
  if (state.error !== null) throw state.error;
  try {
    const db = bootstrap();
    state.db = db;
    return db;
  } catch (cause) {
    state.error = cause instanceof Error ? cause : new Error(String(cause));
    throw state.error;
  }
}

export function getDatabaseState(): DatabaseState {
  let dbPath = "(unresolved)";
  let expected = 0;
  let configError: string | null = null;
  try {
    dbPath = getConfig().dbPath;
    expected = expectedSchemaVersion();
  } catch (cause) {
    configError = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }

  const failure = state.error === null ? configError : `${state.error.name}: ${state.error.message}`;

  if (state.db === null) {
    return {
      ready: false,
      error: failure,
      schemaVersion: 0,
      expectedSchemaVersion: expected,
      ownerConfigured: false,
      dbPath,
      warnings: state.warnings,
    };
  }
  return {
    ready: true,
    error: failure,
    schemaVersion: currentSchemaVersion(state.db),
    expectedSchemaVersion: expected,
    ownerConfigured: getOwner(state.db) !== null,
    dbPath,
    warnings: state.warnings,
  };
}

/** Test helper: close and forget the handle so a new path can be opened. */
export function closeDatabase(): void {
  if (state.db !== null) {
    try {
      state.db.close();
    } catch {
      // Ignore close failures during teardown.
    }
  }
  state.db = null;
  state.error = null;
  state.warnings = [];
}
