import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../lib/db/driver.ts";
import { runMigrations } from "../../lib/db/migrations.ts";
import { resetConfigForTests } from "../../lib/config.ts";

/**
 * Test harness.
 *
 * Each test file gets its own SQLite file under the OS temp directory, so tests
 * never share state and never touch the repository's real data directory.
 */

const created: string[] = [];

export function makeTempDir(prefix = "orch-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export interface TestDb {
  readonly db: Db;
  readonly dbPath: string;
  readonly dir: string;
  close(): void;
}

export function createTestDb(options: { readonly migrate?: boolean } = {}): TestDb {
  const dir = makeTempDir();
  const dbPath = path.join(dir, "test.sqlite");
  const db = openDatabase(dbPath);
  if (options.migrate !== false) {
    runMigrations(db, "test");
  }
  return {
    db,
    dbPath,
    dir,
    close() {
      try {
        db.close();
      } catch {
        // Ignore double-close.
      }
    },
  };
}

/**
 * Configure the process for a test.
 *
 * Every value is set explicitly so a developer's shell environment cannot change
 * the outcome, and the memoised config is cleared so the new values take effect.
 */
export function configureTestEnv(overrides: Record<string, string | undefined> = {}): void {
  const keys = [
    "ORCH_DATA_DIR",
    "ORCH_DB_PATH",
    "ORCH_UPSTREAM_MODE",
    "ORCH_UPSTREAM_BASE_URL",
    "ORCH_UPSTREAM_USERNAME",
    "ORCH_UPSTREAM_PASSWORD",
    "ORCH_OWNER_PASSWORD",
    "ORCH_OWNER_PASSWORD_HASH",
    "ORCH_COOKIE_NAME",
    "ORCH_COOKIE_SECURE",
    "ORCH_PUBLIC_ORIGIN",
    "ORCH_SESSION_TTL_HOURS",
    "ORCH_FIXTURE_DIR",
    "ORCH_FIXTURE_STATIC_TIME",
    "ORCH_POLL_INTERVAL_MS",
    "ORCH_LEASE_TTL_MS",
    "ORCH_SESSION_PAGE_LIMIT",
    "ORCH_MESSAGE_PAGE_LIMIT",
    "ORCH_HISTORY_MAX_SESSIONS",
    "ORCH_CONTENT_MAX_CHARS",
    "ORCH_SSE_POLL_MS",
    "ORCH_SSE_HEARTBEAT_MS",
    "ORCH_SSE_MAX_MS",
    "ORCH_COLLECTOR_ID",
    "ORCH_ROLE",
  ];
  for (const key of keys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetConfigForTests();
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: the OS temp directory is cleaned up eventually.
    }
  }
}

export function fixtureDir(): string {
  return path.join(process.cwd(), "fixtures");
}
