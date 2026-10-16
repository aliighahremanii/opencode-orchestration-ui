import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { openDatabase, type Db } from "../../lib/db/driver.ts";
import {
  appliedMigrations,
  assertDataStepsIdentified,
  checksumOf,
  currentSchemaVersion,
  expectedSchemaVersion,
  MIGRATIONS,
  runMigrations,
} from "../../lib/db/migrations.ts";
import {
  listActivity,
  listAgents,
  listGaps,
  listInvocations,
  listLocations,
  listRootRuns,
  listSessions,
} from "../../lib/db/repositories.ts";
import { listWarnings } from "../../lib/db/collection-state.ts";
import {
  collectorHealth,
  toActivityItem,
  toAgentItem,
  toGapItem,
  toInvocationItem,
  toLocationItem,
  toRunSummary,
  toSessionSummary,
  toWarningItem,
} from "../../lib/http/dto.ts";
import {
  reprocessLegacyRedaction,
  reprocessPersistedRedaction,
  reprocessPersistedRedactionV5,
  reprocessPersistedRedactionV6,
  reprocessPersistedRedactionV7,
  reprocessPersistedRedactionV8,
  reprocessPersistedRedactionV9,
  reprocessPersistedRedactionV10,
  reprocessPersistedRedactionV11,
  reprocessPersistedRedactionV12,
  reprocessPersistedRedactionV13,
  reprocessPersistedRedactionV14,
  reprocessPersistedRedactionV15,
  reprocessPersistedRedactionV16,
  reprocessPersistedRedactionV17,
  reprocessPersistedRedactionV18,
} from "../../lib/db/redaction-reprocess.ts";
import { cleanupTempDirs, createTestDb, makeTempDir, type TestDb } from "../helpers/harness.ts";

/**
 * Migration upgrade path.
 *
 * Migration 2 adds columns to existing tables, which is the case a fresh-database
 * test cannot cover: `CREATE TABLE IF NOT EXISTS` never runs for an existing
 * table, so only an explicit upgrade exercises the `ALTER TABLE` statements.
 *
 * These tests build a database at the *previous* schema version, populate it with
 * data, then upgrade, and assert both that the new columns exist with the right
 * defaults and that pre-existing rows survive with correct semantics.
 */

const V2 = MIGRATIONS.find((migration) => migration.version === 2);
const V3 = MIGRATIONS.find((migration) => migration.version === 3);

/** Build a database with only migration 1 applied, the way an older build left it. */
function createVersionOneDatabase(dbPath: string): Db {
  return createDatabaseAtVersion(dbPath, 1);
}

/**
 * Build a database at an arbitrary earlier schema version, the way the build that
 * shipped that version would have left it. Every migration up to `maxVersion` is
 * applied and recorded, so an upgrade exercises exactly the remaining ones.
 */
function createDatabaseAtVersion(dbPath: string, maxVersion: number): Db {
  const db = openDatabase(dbPath);
  // Replicate the bootstrap the migrator does, then apply the migrations in order.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS migration_lock (
             id INTEGER PRIMARY KEY CHECK (id = 1), locked_at INTEGER NOT NULL, locked_by TEXT NOT NULL)`);
  for (const migration of MIGRATIONS) {
    if (migration.version > maxVersion) break;
    for (const statement of migration.statements) {
      db.exec(statement);
    }
    db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
      migration.version,
      migration.name,
      checksumOf(migration),
      1000,
    );
  }
  return db;
}

afterEach(() => {
  cleanupTempDirs();
});

describe("migration upgrade v1 -> v2", () => {
  it("has a version 2 migration to test", () => {
    expect(V2).toBeDefined();
    expect(V2?.version).toBe(2);
  });

  it("reports version 1 before the upgrade", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      expect(currentSchemaVersion(db)).toBe(1);
      expect(appliedMigrations(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("applies version 2 and records it", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());
      expect(appliedMigrations(db).map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    } finally {
      db.close();
    }
  });

  it("is idempotent when re-run after the upgrade", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      runMigrations(db, "test");
      const second = runMigrations(db, "test");
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    } finally {
      db.close();
    }
  });

  it("adds the new columns with safe defaults", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      runMigrations(db, "test");

      const columnsOf = (table: string): Set<string> =>
        new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
        );

      expect(columnsOf("collector_state").has("last_success_at")).toBe(true);
      expect(columnsOf("collector_checkpoints").has("partial")).toBe(true);
      expect(columnsOf("agents").has("active")).toBe(true);
      expect(columnsOf("collection_gaps").has("open")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("treats a pre-existing checkpoint as complete, not partial", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      // A row written by the older build, before the `partial` column existed.
      db.prepare(
        "INSERT INTO collector_checkpoints (scope, stream, cursor, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("collector", "messages:ses_old", null, 5000, 5000);

      runMigrations(db, "test");

      const row = db
        .prepare("SELECT partial FROM collector_checkpoints WHERE stream = ?")
        .get("messages:ses_old") as { partial: number } | undefined;
      // The default must be `complete`: an old checkpoint made no partial claim.
      expect(row?.partial).toBe(0);
    } finally {
      db.close();
    }
  });

  it("treats a pre-existing agent as currently effective", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      db.prepare(
        `INSERT INTO agents (location_id, agent_id, name, mode, hidden, description, model_provider_id, model_id, source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, 'upstream', 1, 1)`,
      ).run("loc_1", "build", "build", "primary");

      runMigrations(db, "test");

      const row = db.prepare("SELECT active FROM agents WHERE agent_id = ?").get("build") as { active: number } | undefined;
      // An agent stored by the older build was effective when it was stored.
      expect(row?.active).toBe(1);
    } finally {
      db.close();
    }
  });

  it("treats a pre-existing gap as closed, not open", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      db.prepare(
        `INSERT INTO collection_gaps (id, scope, stream, started_at, ended_at, reason, detected_at, resumed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run("gap_old", "collector", "cycle", 100, 200, "historic gap", 200);

      runMigrations(db, "test");

      const row = db.prepare("SELECT open FROM collection_gaps WHERE id = ?").get("gap_old") as { open: number } | undefined;
      // A gap the older build had already marked resumed must not become open.
      expect(row?.open).toBe(0);
    } finally {
      db.close();
    }
  });

  it("preserves a pre-existing collector state row and leaves last_success_at unset", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      db.prepare(
        `INSERT INTO collector_state (scope, holder_id, epoch, last_cycle_at, last_cycle_ok, last_error, updated_at)
         VALUES (?, ?, ?, ?, 1, NULL, ?)`,
      ).run("collector", "old-holder", 4, 9000, 9000);

      runMigrations(db, "test");

      const row = db.prepare("SELECT * FROM collector_state WHERE scope = ?").get("collector") as
        | { holder_id: string; epoch: number; last_cycle_at: number; last_success_at: number | null }
        | undefined;
      expect(row?.holder_id).toBe("old-holder");
      expect(row?.epoch).toBe(4);
      expect(row?.last_cycle_at).toBe(9000);
      // There is no earlier success to claim, so coverage starts from unknown.
      expect(row?.last_success_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("keeps existing observations readable after the upgrade", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      db.prepare(
        `INSERT INTO sessions (id, location_id, project_id, parent_id, agent_id, model_provider_id, model_id, title,
           subpath, upstream_outcome, time_created, time_updated, time_idle, time_archived, source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, 'upstream', ?, ?)`,
      ).run("ses_old", "loc_1", "prj_1", "build", "Old session", 1, 2, 1, 2);
      db.prepare(
        `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
           sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
           upstream_outcome, source, ingested_at)
         VALUES (?, ?, ?, ?, NULL, 'message-user', ?, 0, 0, ?, NULL, NULL, NULL, ?, ?, 0, 0, NULL, 'upstream', ?)`,
      ).run("act_old", "key_old", "loc_1", "ses_old", "msg_old", 5, "old summary", "old content", 5);

      runMigrations(db, "test");

      const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get("ses_old") as { title: string } | undefined;
      expect(session?.title).toBe("Old session");
      const activity = db.prepare("SELECT summary FROM activity_events WHERE id = ?").get("act_old") as
        | { summary: string }
        | undefined;
      expect(activity?.summary).toBe("old summary");
    } finally {
      db.close();
    }
  });

  it("upgrades a populated database opened through the normal test harness", () => {
    // The harness migrates on creation, so this asserts the fresh path reaches
    // the same version as the upgrade path.
    const test: TestDb = createTestDb();
    try {
      expect(currentSchemaVersion(test.db)).toBe(expectedSchemaVersion());
      expect(appliedMigrations(test.db).map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    } finally {
      test.close();
    }
  });

  it("rejects a database whose applied migration 1 was modified", () => {
    const dir = makeTempDir();
    const db = createVersionOneDatabase(`${dir}/upgrade.sqlite`);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

/**
 * Migration 3 re-runs the redactor over text an earlier build persisted before it
 * understood camelCase secret keys. It is schema-neutral: its job is to repair
 * already-stored rows, not to change the schema.
 */
describe("migration upgrade v2 -> v3 (camelCase redaction reprocessing)", () => {
  const SECRET_ACCESS = "opaque-access-token-1234567890";
  const SECRET_CLIENT = "opaque-client-secret-abcdefgh";

  /** Populate a version-2 database with rows that still hold a camelCase secret. */
  function seedSecrets(db: Db): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', 'msg_1', 0, 0, 1, NULL, NULL, NULL, ?, ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(
      "act_1",
      "key_1",
      `input: {"accessToken":"${SECRET_ACCESS}"}`,
      `config {"clientSecret":"${SECRET_CLIENT}"} written`,
    );
    db.prepare(
      `INSERT INTO sessions (id, location_id, project_id, parent_id, agent_id, model_provider_id, model_id, title,
         subpath, upstream_outcome, time_created, time_updated, time_idle, time_archived, source, first_seen_at, last_seen_at)
       VALUES ('ses_1', 'loc_1', 'prj_1', NULL, 'build', NULL, NULL, ?, NULL, NULL, 1, 2, NULL, NULL, 'upstream', 1, 2)`,
    ).run(`session titled accessToken=${SECRET_ACCESS}`);
    db.prepare(
      `INSERT INTO agents (location_id, agent_id, name, mode, hidden, description, model_provider_id, model_id, source, first_seen_at, last_seen_at, active)
       VALUES ('loc_1', 'build', 'build', 'primary', 0, ?, NULL, NULL, 'upstream', 1, 1, 1)`,
    ).run(`description with {"clientSecret":"${SECRET_CLIENT}"}`);
    db.prepare(
      `INSERT INTO invocations (id, run_id, session_id, location_id, agent_id, model_provider_id, model_id, started_at,
         ended_at, trigger_message_id, assistant_message_id, tool_call_count, upstream_outcome, confidence,
         evidence_json, source, first_seen_at, last_seen_at)
       VALUES ('inv_1', 'run_1', 'ses_1', 'loc_1', 'build', NULL, NULL, 1, NULL, NULL, 'msg_1', 0, NULL, 'verified', ?, 'upstream', 1, 1)`,
    ).run(JSON.stringify({ rule: "assistant-message-agent-field", assistantMessageId: "msg_1", accessToken: SECRET_ACCESS }));
  }

  function storedText(db: Db): string {
    const parts: string[] = [];
    for (const row of db.prepare("SELECT summary, content FROM activity_events").all() as { summary: string; content: string | null }[]) {
      parts.push(row.summary, row.content ?? "");
    }
    for (const row of db.prepare("SELECT title FROM sessions").all() as { title: string | null }[]) parts.push(row.title ?? "");
    for (const row of db.prepare("SELECT description FROM agents").all() as { description: string | null }[]) parts.push(row.description ?? "");
    for (const row of db.prepare("SELECT evidence_json FROM invocations").all() as { evidence_json: string }[]) parts.push(row.evidence_json);
    return parts.join("\n");
  }

  it("has a version 3 migration to test", () => {
    expect(V3).toBeDefined();
    expect(V3?.version).toBe(3);
  });

  it("applies version 3 after version 2 and records it", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      expect(currentSchemaVersion(db)).toBe(2);
      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());
    } finally {
      db.close();
    }
  });

  it("removes a camelCase secret that an earlier build persisted, without deleting history", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      seedSecrets(db);
      // The secret really is present before the upgrade — otherwise the test would
      // pass vacuously.
      expect(storedText(db)).toContain(SECRET_ACCESS);
      expect(storedText(db)).toContain(SECRET_CLIENT);

      runMigrations(db, "test");

      const text = storedText(db);
      expect(text).not.toContain(SECRET_ACCESS);
      expect(text).not.toContain(SECRET_CLIENT);
      expect(text).toContain("[redacted]");

      // No row and no field was deleted: the surrounding history survives.
      expect((db.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM invocations").get() as { n: number }).n).toBe(1);

      const session = db.prepare("SELECT title FROM sessions WHERE id = 'ses_1'").get() as { title: string };
      expect(session.title).toContain("session titled");
      const agent = db.prepare("SELECT description FROM agents WHERE agent_id = 'build'").get() as { description: string };
      expect(agent.description).toContain("description with");
    } finally {
      db.close();
    }
  });

  it("keeps the evidence blob valid JSON after reprocessing", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      seedSecrets(db);
      runMigrations(db, "test");

      const row = db.prepare("SELECT evidence_json FROM invocations WHERE id = 'inv_1'").get() as { evidence_json: string };
      const parsed = JSON.parse(row.evidence_json) as { rule: string; assistantMessageId: string };
      // The structure and the non-secret fields are intact; only the secret leaf
      // changed. Redacting the serialised form instead would have produced
      // invalid JSON.
      expect(parsed.rule).toBe("assistant-message-agent-field");
      expect(parsed.assistantMessageId).toBe("msg_1");
      expect(row.evidence_json).not.toContain(SECRET_ACCESS);
    } finally {
      db.close();
    }
  });

  it("replaces a whole object value under a credential key, not just a scalar", () => {
    // Follow-up finding: the value rules only understood scalars, so a whole
    // object under a credential key survived — and replacing only its opening
    // brace corrupted the payload. The reprocessor now parses the value and
    // replaces the entire (possibly nested) value.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      const SECRET = "opaque-structured-secret-000111222333";
      db.prepare(
        `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
           sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
           upstream_outcome, source, ingested_at)
         VALUES ('act_1', 'key_1', 'loc_1', 'ses_1', NULL, 'message-assistant', 'msg_1', 0, 0, 1, NULL, NULL, NULL, ?, ?, 0, 0, NULL, 'upstream', 1)`,
      ).run(`input: {"accessToken":{"nested":{"deep":"${SECRET}"}}}`, `config {"SecretKey":{"value":"${SECRET}"}}`);
      expect(storedText(db)).toContain(SECRET);

      runMigrations(db, "test");

      expect(storedText(db)).not.toContain(SECRET);
      // The surrounding JSON is still parseable: the whole value was replaced.
      const summary = (db.prepare("SELECT summary FROM activity_events WHERE id = 'act_1'").get() as { summary: string }).summary;
      expect(summary).toBe('input: {"accessToken":"[redacted]"}');
      const content = (db.prepare("SELECT content FROM activity_events WHERE id = 'act_1'").get() as { content: string }).content;
      expect(content).toBe('config {"SecretKey":"[redacted]"}');
    } finally {
      db.close();
    }
  });

  it("replaces a credential nested inside an encoded JSON value", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      const SECRET = "opaque-encoded-secret-000111222333";
      const content = JSON.stringify({ args: ["--config", JSON.stringify({ secretAccessKey: { value: SECRET } })] });
      db.prepare(
        `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
           sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
           upstream_outcome, source, ingested_at)
         VALUES ('act_1', 'key_1', 'loc_1', 'ses_1', NULL, 'message-assistant', 'msg_1', 0, 0, 1, NULL, NULL, NULL, 'plain summary', ?, 0, 0, NULL, 'upstream', 1)`,
      ).run(content);
      expect(storedText(db)).toContain(SECRET);

      runMigrations(db, "test");

      const after = (db.prepare("SELECT content FROM activity_events WHERE id = 'act_1'").get() as { content: string }).content;
      expect(after).not.toContain(SECRET);
      const parsed = JSON.parse(after) as { args: string[] };
      expect(parsed.args[0]).toBe("--config");
      expect(parsed.args[1]).toContain("[redacted]");
      expect(parsed.args[1]).not.toContain(SECRET);
    } finally {
      db.close();
    }
  });

  it("does not rewrite structured content that holds no credential", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      const content = '{"author":{"a":1},"tokenCount":5}';
      db.prepare(
        `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
           sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
           upstream_outcome, source, ingested_at)
         VALUES ('act_1', 'key_1', 'loc_1', 'ses_1', NULL, 'message-user', 'msg_1', 0, 0, 1, NULL, NULL, NULL, 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
      ).run(content);

      runMigrations(db, "test");

      const row = db.prepare("SELECT content FROM activity_events WHERE id = 'act_1'").get() as { content: string };
      expect(row.content).toBe(content);
    } finally {
      db.close();
    }
  });

  it("is a no-op on data that is already redacted", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      db.prepare(
        `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
           sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
           upstream_outcome, source, ingested_at)
         VALUES ('act_1', 'key_1', 'loc_1', 'ses_1', NULL, 'message-user', 'msg_1', 0, 0, 1, NULL, NULL, NULL, 'already [redacted] here', NULL, 0, 1, NULL, 'upstream', 1)`,
      ).run();

      runMigrations(db, "test");

      const row = db.prepare("SELECT summary FROM activity_events WHERE id = 'act_1'").get() as { summary: string };
      expect(row.summary).toBe("already [redacted] here");
    } finally {
      db.close();
    }
  });

  it("leaves an unparseable evidence blob untouched rather than destroying it", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      db.prepare(
        `INSERT INTO invocations (id, run_id, session_id, location_id, agent_id, model_provider_id, model_id, started_at,
           ended_at, trigger_message_id, assistant_message_id, tool_call_count, upstream_outcome, confidence,
           evidence_json, source, first_seen_at, last_seen_at)
         VALUES ('inv_1', 'run_1', 'ses_1', 'loc_1', 'build', NULL, NULL, 1, NULL, NULL, 'msg_1', 0, NULL, 'verified', '{not json', 'upstream', 1, 1)`,
      ).run();

      runMigrations(db, "test");

      const row = db.prepare("SELECT evidence_json FROM invocations WHERE id = 'inv_1'").get() as { evidence_json: string };
      expect(row.evidence_json).toBe("{not json");
    } finally {
      db.close();
    }
  });

  it("does not rewrite identity or join keys", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      // An identity-shaped value that a naive free-text redactor might touch.
      db.prepare(
        `INSERT INTO sessions (id, location_id, project_id, parent_id, agent_id, model_provider_id, model_id, title,
           subpath, upstream_outcome, time_created, time_updated, time_idle, time_archived, source, first_seen_at, last_seen_at)
         VALUES ('ses_token_id', 'loc_1', 'prj_1', NULL, 'accessToken-agent', NULL, NULL, NULL, NULL, NULL, 1, 2, NULL, NULL, 'upstream', 1, 2)`,
      ).run();

      runMigrations(db, "test");

      const row = db.prepare("SELECT id, agent_id FROM sessions WHERE id = 'ses_token_id'").get() as {
        id: string;
        agent_id: string;
      };
      // Join keys are compared for equality and must not be rewritten.
      expect(row.id).toBe("ses_token_id");
      expect(row.agent_id).toBe("accessToken-agent");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The versioned data-step identity
// ---------------------------------------------------------------------------

const V4 = MIGRATIONS.find((migration) => migration.version === 4);
const V5 = MIGRATIONS.find((migration) => migration.version === 5);
const V6 = MIGRATIONS.find((migration) => migration.version === 6);
const V7 = MIGRATIONS.find((migration) => migration.version === 7);
const V8 = MIGRATIONS.find((migration) => migration.version === 8);
const V9 = MIGRATIONS.find((migration) => migration.version === 9);
const V10 = MIGRATIONS.find((migration) => migration.version === 10);
const V11 = MIGRATIONS.find((migration) => migration.version === 11);
const V12 = MIGRATIONS.find((migration) => migration.version === 12);
const V13 = MIGRATIONS.find((migration) => migration.version === 13);
const V14 = MIGRATIONS.find((migration) => migration.version === 14);
const V15 = MIGRATIONS.find((migration) => migration.version === 15);
const V16 = MIGRATIONS.find((migration) => migration.version === 16);
const V17 = MIGRATIONS.find((migration) => migration.version === 17);
const V18 = MIGRATIONS.find((migration) => migration.version === 18);

/**
 * The checksums migrations 1–3 recorded when they shipped.
 *
 * Hard-coded on purpose. These values are stored in every database that applied
 * those migrations, so they are a contract rather than an implementation
 * detail: a formula change that silently alters one of them has to fail here,
 * not on a deployed database that can no longer start.
 */
const FROZEN_CHECKSUMS: Readonly<Record<number, string>> = {
  1: "45101ac052f9408eabac374c0a66fbbba68eb0408ffbea584c0f3492b0662112",
  2: "32113fbb04e3379373d5839f91fcd9cf8345075a9bca8f9b03929986d2d4865b",
  3: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

function recordedChecksum(db: Db, version: number): string | null {
  const row = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(version) as
    | { checksum: string }
    | undefined;
  return row?.checksum ?? null;
}

describe("migration data-step identity and checksum immutability", () => {
  it("keeps the frozen statements-only checksum for migrations 1 to 3", () => {
    for (const [version, expected] of Object.entries(FROZEN_CHECKSUMS)) {
      const migration = MIGRATIONS.find((entry) => entry.version === Number(version));
      expect(migration, `migration ${version}`).toBeDefined();
      // The legacy formula is exactly sha256(statements.join(";\n")), with no
      // data-step component. Adding one would invalidate every applied database.
      expect(checksumOf(migration!), `migration ${version}`).toBe(expected);
      expect(checksumOf(migration!)).toBe(
        createHash("sha256").update(migration!.statements.join(";\n")).digest("hex"),
      );
      expect(migration!.dataStepVersion, `migration ${version} declares no dataStepVersion`).toBeUndefined();
    }
  });

  it("folds the declared data-step version into migration 4's checksum", () => {
    expect(V4).toBeDefined();
    expect(V4?.dataStepVersion).toBe(1);

    const versioned = checksumOf(V4!);
    const statementsOnly = createHash("sha256").update(V4!.statements.join(";\n")).digest("hex");
    // The identity covers the behaviour, not just the (empty) SQL.
    expect(versioned).not.toBe(statementsOnly);
    // Changing the declared behaviour changes the identity.
    expect(checksumOf({ ...V4!, dataStepVersion: 2 })).not.toBe(versioned);
    // And the statements still participate.
    expect(checksumOf({ ...V4!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("folds the declared data-step version into migration 5's checksum", () => {
    expect(V5).toBeDefined();
    expect(V5?.version).toBe(5);
    expect(V5?.reprocess).toBeTypeOf("function");
    expect(V5?.dataStepVersion).toBe(1);

    const versioned = checksumOf(V5!);
    const statementsOnly = createHash("sha256").update(V5!.statements.join(";\n")).digest("hex");
    // The identity covers the behaviour, not just the (empty) SQL.
    expect(versioned).not.toBe(statementsOnly);
    // Changing the declared behaviour changes the identity, so a database that
    // somehow applied the previous behaviour is rejected rather than silently
    // running the old code.
    expect(checksumOf({ ...V5!, dataStepVersion: 2 })).not.toBe(versioned);
    // And the statements still participate.
    expect(checksumOf({ ...V5!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("gives every versioned data step an identity", () => {
    // The shipped set satisfies the rule...
    for (const migration of MIGRATIONS) {
      if (migration.version < 4 || migration.reprocess === undefined) continue;
      expect(migration.dataStepVersion, `migration ${migration.version}`).toBeTypeOf("number");
    }
    // ...and a step that breaks it is refused before anything is applied.
    expect(() =>
      assertDataStepsIdentified([
        { version: 9, name: "unidentified-data-step", statements: [], reprocess: () => {} },
      ]),
    ).toThrow(/dataStepVersion/);
    // A versioned step is accepted, and a legacy step (before the rule) is exempt.
    expect(() =>
      assertDataStepsIdentified([
        { version: 9, name: "identified", statements: [], reprocess: () => {}, dataStepVersion: 1 },
        { version: 3, name: "legacy", statements: [], reprocess: () => {} },
      ]),
    ).not.toThrow();
  });

  it("upgrades a v3 database without re-recording its legacy checksums", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      // The legacy rows are untouched, and v4 and v5 were recorded under their
      // versioned identities.
      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
    } finally {
      db.close();
    }
  });

  it("rejects a database that applied migration 4 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      // As if an earlier build had applied v4 by the legacy statements-only
      // formula: same version, different behaviour. It must be refused rather
      // than silently trusted.
      const statementsOnly = createHash("sha256").update(V4!.statements.join(";\n")).digest("hex");
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 4").run(statementsOnly);
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });

  it("rejects a database whose migration 4 recorded a different data-step version", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 4").run(
        checksumOf({ ...V4!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Shared fixtures for the display-redaction migrations (v4 and v5)
// ---------------------------------------------------------------------------

const AWS = "opaque-aws-secret-000111222333";
const ACCESS = "opaque-access-token-444555666777";
const CAMEL = "opaque-client-secret-777888999000";
const PASCAL = "opaque-pascal-secret-111222333444";
const SNAKE = "opaque-snake-secret-555666777888";
const SECRETS = [AWS, ACCESS, CAMEL, PASCAL, SNAKE];

/**
 * Seed a v3 database with a credential in every display column migration 4
 * has to repair.
 *
 * Each credential appears in a form the redactor must understand: a compound
 * key in camelCase (`secretAccessKey`), PascalCase (`SecretAccessKey`), a
 * snake_case key, and a whole object or array value under a credential key.
 */
function seedEveryDisplayField(db: Db): void {
  db.prepare(
    `INSERT INTO locations (id, directory, project_id, canonical, subpath, source, first_seen_at, last_seen_at)
     VALUES ('loc_1', '/srv/demo', 'prj_1', ?, NULL, 'upstream', 1, 1)`,
  ).run(`canonical secretAccessKey=${AWS}`);

  db.prepare(
    `INSERT INTO agents (location_id, agent_id, name, mode, hidden, description, model_provider_id, model_id, source, first_seen_at, last_seen_at, active)
     VALUES ('loc_1', 'build', ?, 'primary', 0, ?, ?, ?, 'upstream', 1, 1, 1)`,
  ).run(
    `api_key=${ACCESS}`,
    `registry config {"clientSecret":"${CAMEL}"}`,
    `secretAccessKey=${AWS}`,
    `SecretKey=${PASCAL}`,
  );

  db.prepare(
    `INSERT INTO sessions (id, location_id, project_id, parent_id, agent_id, model_provider_id, model_id, title,
       subpath, upstream_outcome, time_created, time_updated, time_idle, time_archived, source, first_seen_at, last_seen_at)
     VALUES ('ses_1', 'loc_1', 'prj_1', NULL, 'build', ?, ?, ?, ?, NULL, 1, 2, NULL, NULL, 'upstream', 1, 2)`,
  ).run(
    `secretAccessKey=${AWS}`,
    `SecretKey=${PASCAL}`,
    `session titled {"clientSecret":"${CAMEL}"}`,
    `sub accessToken=${ACCESS}`,
  );

  db.prepare(
    `INSERT INTO root_runs (id, location_id, root_session_id, title, started_at, last_activity_at, status, agent_id,
       session_count, source, first_seen_at, last_seen_at)
     VALUES ('run_1', 'loc_1', 'ses_1', ?, 1, 2, 'unknown', 'build', 1, 'upstream', 1, 2)`,
  ).run(`run {"SecretAccessKey":{"value":"${AWS}"}}`);

  db.prepare(
    `INSERT INTO invocations (id, run_id, session_id, location_id, agent_id, model_provider_id, model_id, started_at,
       ended_at, trigger_message_id, assistant_message_id, tool_call_count, upstream_outcome, confidence,
       evidence_json, source, first_seen_at, last_seen_at)
     VALUES ('inv_1', 'run_1', 'ses_1', 'loc_1', 'build', ?, ?, 1, NULL, NULL, 'msg_1', 0, NULL, 'verified', ?, 'upstream', 1, 1)`,
  ).run(
    `secretAccessKey=${AWS}`,
    `{"SecretKey":"${PASCAL}"}`,
    JSON.stringify({ rule: "assistant-message-agent-field", assistantMessageId: "msg_1", accessToken: ACCESS }),
  );

  // activity_events: one row per credential shape, plus the flag cases.
  const insertActivity = db.prepare(
    `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
       sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
       upstream_outcome, source, ingested_at)
     VALUES (?, ?, 'loc_1', 'ses_1', 'run_1', 'message-assistant', ?, 0, 0, 1, ?, ?, 'completed', ?, ?, 0, ?, NULL, 'upstream', 1)`,
  );
  // Structured value under a credential key, in JSON content.
  insertActivity.run(
    "act_structured",
    "key_structured",
    "msg_a",
    "build",
    "secretAccessKey",
    `input: {"accessToken":{"nested":"${ACCESS}"}}`,
    `{"credentials":{"SecretAccessKey":{"value":"${AWS}"}}}`,
    0,
  );
  // PascalCase compound key, labelled, plus a secret-bearing tool name.
  insertActivity.run(
    "act_pascal",
    "key_pascal",
    "msg_b",
    "build",
    `secretAccessKey=${AWS}`,
    `SecretAccessKey: ${PASCAL}`,
    null,
    0,
  );
  // snake_case key whose value is an array.
  insertActivity.run(
    "act_snake_array",
    "key_snake",
    "msg_c",
    null,
    null,
    `config {"secret_access_key":["${SNAKE}"]}`,
    null,
    0,
  );
  // Already flagged with clean text: the badge must not be cleared.
  insertActivity.run("act_flagged_clean", "key_flagged", "msg_d", null, null, "already clean summary", null, 1);
  // Not flagged with clean text: the badge must not be raised.
  insertActivity.run("act_clean", "key_clean", "msg_e", "build", "read", "ordinary summary", null, 0);

  db.prepare(
    `INSERT INTO collection_gaps (id, scope, stream, started_at, ended_at, reason, detected_at, resumed, open)
     VALUES ('gap_1', 'collector', 'cycle', 1, NULL, ?, 1, 0, 1)`,
  ).run(`upstream failed: api_key=${ACCESS}`);

  db.prepare(
    `INSERT INTO collector_warnings (id, scope, kind, detail, occurrences, first_seen_at, last_seen_at)
     VALUES ('warn_1', 'collector', 'unknown-message-type', ?, 1, 1, 1)`,
  ).run(`unknown type {"SecretKey":"${PASCAL}"}`);

  db.prepare(
    `INSERT INTO collector_state (scope, holder_id, epoch, last_cycle_at, last_cycle_ok, last_error, updated_at, last_success_at)
     VALUES ('collector', 'holder', 1, 1, 0, ?, 1, NULL)`,
  ).run(`UpstreamError: {"clientSecret":"${CAMEL}"}`);
}

/**
 * Every string the dashboard can render, built through the real DTOs.
 *
 * Using the DTOs (rather than raw SQL) is what makes this a statement about
 * the API surface: if a display field is missed, it shows up here.
 */
function apiVisibleText(db: Db): string {
  const parts: string[] = [];
  for (const event of listActivity(db, { limit: 100 })) parts.push(JSON.stringify(toActivityItem(event)));
  for (const session of listSessions(db, { limit: 100 })) {
    parts.push(JSON.stringify(toSessionSummary(session, null, null, null)));
  }
  for (const agent of listAgents(db)) parts.push(JSON.stringify(toAgentItem(agent, null, 0)));
  for (const run of listRootRuns(db, { limit: 100 })) parts.push(JSON.stringify(toRunSummary(run, null, 0)));
  for (const invocation of listInvocations(db, { limit: 100 })) parts.push(JSON.stringify(toInvocationItem(invocation)));
  for (const gap of listGaps(db, 100)) parts.push(JSON.stringify(toGapItem(gap)));
  for (const warning of listWarnings(db, 100)) parts.push(JSON.stringify(toWarningItem(warning)));
  for (const location of listLocations(db)) parts.push(JSON.stringify(toLocationItem(location, 1, 1)));
  parts.push(JSON.stringify(collectorHealth(db, 1000)));
  return parts.join("\n");
}

function rowCounts(db: Db): Record<string, number> {
  const tables = [
    "activity_events",
    "sessions",
    "agents",
    "root_runs",
    "invocations",
    "locations",
    "collection_gaps",
    "collector_warnings",
    "collector_state",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}
// ---------------------------------------------------------------------------
// Migration 4: every retained display field, plus the activity redacted badge
// ---------------------------------------------------------------------------

describe("migration upgrade v3 -> v4 (display redaction reprocessing)", () => {

  it("has a version 4 migration with an identified data step", () => {
    expect(V4).toBeDefined();
    expect(V4?.version).toBe(4);
    expect(V4?.reprocess).toBeTypeOf("function");
    expect(V4?.dataStepVersion).toBe(1);
  });

  it("repairs every display field without a collection cycle", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      const before = apiVisibleText(db);
      // The credentials really are visible before the upgrade, so the test
      // cannot pass vacuously.
      for (const secret of SECRETS) expect(before, secret).toContain(secret);

      // No collector runs here: the migration alone must sanitise the database.
      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      for (const secret of SECRETS) {
        expect(after, secret).not.toContain(secret);
      }
      expect(after).toContain("[redacted]");

      // Raw storage is clean too, not just the DTOs.
      const raw = db
        .prepare(
          `SELECT summary || ' ' || COALESCE(content, '') || ' ' || COALESCE(tool_name, '') AS text FROM activity_events
           UNION ALL SELECT COALESCE(title, '') FROM sessions
           UNION ALL SELECT COALESCE(description, '') FROM agents
           UNION ALL SELECT COALESCE(title, '') FROM root_runs
           UNION ALL SELECT COALESCE(evidence_json, '') FROM invocations
           UNION ALL SELECT COALESCE(canonical, '') FROM locations
           UNION ALL SELECT reason FROM collection_gaps
           UNION ALL SELECT detail FROM collector_warnings
           UNION ALL SELECT COALESCE(last_error, '') FROM collector_state`,
        )
        .all() as { text: string }[];
      const joined = raw.map((row) => row.text).join("\n");
      for (const secret of SECRETS) expect(joined, secret).not.toContain(secret);
    } finally {
      db.close();
    }
  });

  it("raises the redacted badge on an event it repairs and never clears it", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      runMigrations(db, "test");

      const flags = db.prepare("SELECT id, redacted FROM activity_events ORDER BY id").all() as {
        id: string;
        redacted: number;
      }[];
      const byId = new Map(flags.map((row) => [row.id, row.redacted]));
      // Repaired rows are flagged.
      expect(byId.get("act_structured")).toBe(1);
      expect(byId.get("act_pascal")).toBe(1);
      expect(byId.get("act_snake_array")).toBe(1);
      // An already-flagged row is not cleared...
      expect(byId.get("act_flagged_clean")).toBe(1);
      // ...and an untouched, unflagged row is not raised.
      expect(byId.get("act_clean")).toBe(0);

      // The stored flag is what the timeline badge renders, so assert it through
      // the DTO the component reads.
      const items = listActivity(db, { limit: 100 }).map(toActivityItem);
      const badge = new Map(items.map((item) => [item.id, item.redacted]));
      expect(badge.get("act_structured")).toBe(true);
      expect(badge.get("act_pascal")).toBe(true);
      expect(badge.get("act_flagged_clean")).toBe(true);
      expect(badge.get("act_clean")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("keeps a repaired structured value valid JSON", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      runMigrations(db, "test");

      const content = (db.prepare("SELECT content FROM activity_events WHERE id = 'act_structured'").get() as {
        content: string;
      }).content;
      expect(JSON.parse(content)).toEqual({ credentials: { SecretAccessKey: "[redacted]" } });

      const evidence = (db.prepare("SELECT evidence_json FROM invocations WHERE id = 'inv_1'").get() as {
        evidence_json: string;
      }).evidence_json;
      const parsed = JSON.parse(evidence) as { rule: string; assistantMessageId: string; accessToken: string };
      expect(parsed.rule).toBe("assistant-message-agent-field");
      expect(parsed.assistantMessageId).toBe("msg_1");
      expect(parsed.accessToken).toBe("[redacted]");
    } finally {
      db.close();
    }
  });

  it("deletes no row and no field", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      const before = rowCounts(db);
      runMigrations(db, "test");
      expect(rowCounts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second pass rewrites nothing", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      runMigrations(db, "test");

      const after = apiVisibleText(db);
      // The migration already ran the data step; running it again must converge.
      expect(reprocessPersistedRedaction(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      // And running migrations again applies nothing.
      expect(runMigrations(db, "test").applied).toEqual([]);
      expect(apiVisibleText(db)).toBe(after);
    } finally {
      db.close();
    }
  });

  it("leaves migration 3's frozen data step covering only its original fields", () => {
    // The legacy step must not have grown: migration 3 is applied already, so a
    // change to it would be a silent behaviour change under a recorded identity.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      // Apply only the legacy step.
      reprocessLegacyRedaction(db);

      const untouched = db.prepare("SELECT tool_name FROM activity_events WHERE id = 'act_pascal'").get() as {
        tool_name: string;
      };
      // `tool_name` is a migration-4 addition; the legacy step never covered it.
      expect(untouched.tool_name).toContain(AWS);
      const runTitle = db.prepare("SELECT title FROM root_runs WHERE id = 'run_1'").get() as { title: string };
      expect(runTitle.title).toContain(AWS);

      // The full step does cover them.
      reprocessPersistedRedaction(db);
      expect(
        (db.prepare("SELECT tool_name FROM activity_events WHERE id = 'act_pascal'").get() as { tool_name: string })
          .tool_name,
      ).toBe("secretAccessKey=[redacted]");
      expect(
        (db.prepare("SELECT title FROM root_runs WHERE id = 'run_1'").get() as { title: string }).title,
      ).not.toContain(AWS);
    } finally {
      db.close();
    }
  });

  it("repairs snake_case, camelCase and PascalCase keys in every form", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      seedEveryDisplayField(db);
      runMigrations(db, "test");

      const title = (db.prepare("SELECT title FROM sessions WHERE id = 'ses_1'").get() as { title: string }).title;
      expect(title).not.toContain(CAMEL);
      expect(title).toContain("[redacted]");

      const subpath = (db.prepare("SELECT subpath FROM sessions WHERE id = 'ses_1'").get() as { subpath: string }).subpath;
      expect(subpath).not.toContain(ACCESS);

      const summary = (db.prepare("SELECT summary FROM activity_events WHERE id = 'act_snake_array'").get() as {
        summary: string;
      }).summary;
      expect(summary).not.toContain(SNAKE);
      // The whole array value was replaced, not just the opening bracket.
      expect(summary).toBe('config {"secret_access_key":"[redacted]"}');

      const modelId = (db.prepare("SELECT model_id FROM invocations WHERE id = 'inv_1'").get() as { model_id: string })
        .model_id;
      expect(modelId).not.toContain(PASCAL);
    } finally {
      db.close();
    }
  });

  it("repairs escaped and double-encoded JSON persisted in an activity field", () => {
    // A persisted tool input is JSON that has already been `JSON.stringify`d, so
    // the JSON it contains appears escaped — once, or (after a second
    // serialisation) twice. The reprocessor must parse both forms.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 3);
    try {
      const insert = db.prepare(
        `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
           sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
           upstream_outcome, source, ingested_at)
         VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'tool', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
      );
      // A JSON *string* whose content is itself JSON: the double-encoded form.
      const doubleEncoded = JSON.stringify(JSON.stringify({ secretAccessKey: { value: AWS } }));
      // Escaped once inside an object, as a tool argument list would be.
      const escaped = JSON.stringify({ args: ["--config", JSON.stringify({ accessToken: { nested: ACCESS } })] });
      insert.run("act_double", "key_double", "msg_d1", doubleEncoded);
      insert.run("act_escaped", "key_escaped", "msg_e1", escaped);

      // Both forms really do carry the secret before the upgrade.
      const before = apiVisibleText(db);
      expect(before).toContain(AWS);
      expect(before).toContain(ACCESS);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      expect(after).not.toContain(AWS);
      expect(after).not.toContain(ACCESS);

      // The escaped form stays valid JSON with its structure intact.
      const escapedAfter = (db.prepare("SELECT content FROM activity_events WHERE id = 'act_escaped'").get() as {
        content: string;
      }).content;
      const parsed = JSON.parse(escapedAfter) as { args: string[] };
      expect(parsed.args[0]).toBe("--config");
      expect(parsed.args[1]).toContain("[redacted]");

      // And the double-encoded form parses back to a redacted JSON string.
      const doubleAfter = (db.prepare("SELECT content FROM activity_events WHERE id = 'act_double'").get() as {
        content: string;
      }).content;
      expect(doubleAfter).not.toContain(AWS);
      expect(JSON.parse(doubleAfter) as string).toContain("[redacted]");

      // Both rows were flagged, because both had display text rewritten.
      const flags = db
        .prepare("SELECT id, redacted FROM activity_events WHERE id IN ('act_double', 'act_escaped')")
        .all() as { id: string; redacted: number }[];
      expect(flags.every((row) => row.redacted === 1)).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 5: converge stored data on the corrected redaction policy, and make
// the historical `redacted` badge honest.
// ---------------------------------------------------------------------------

describe("migration upgrade v3 -> v5 and v4 -> v5 (redaction convergence and the historical badge)", () => {
  const LIVE = "opaque-live-value-000111222333";
  const PASSWORD = "correct[42]horse";

  /** One activity row, with the display text and badge under test. */
  function insertActivity(db: Db, id: string, summary: string, content: string | null, redacted: number): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', ?, ?, 0, ?, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, summary, content, redacted);
  }

  it("has a version 5 migration with an identified data step", () => {
    expect(V5).toBeDefined();
    expect(V5?.version).toBe(5);
    expect(V5?.reprocess).toBeTypeOf("function");
    expect(V5?.dataStepVersion).toBe(1);
  });

  it("flags a row migration 3 repaired but never badged", () => {
    // Migration 3 rewrote activity display text with the older redactor, but it
    // predates the badge: a row it repaired kept `redacted = 0`. Migration 4 then
    // saw already-clean text and changed nothing, so the row stayed unflagged and
    // the timeline presented sanitised text as if it were verbatim. Migration 5
    // has to raise that badge.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 2);
    try {
      insertActivity(db, "act_v3", `api_key=${ACCESS}`, null, 0);

      // Apply migration 3's data step exactly as it shipped.
      reprocessLegacyRedaction(db);
      const repaired = db.prepare("SELECT summary, redacted FROM activity_events WHERE id = 'act_v3'").get() as {
        summary: string;
        redacted: number;
      };
      expect(repaired.summary).not.toContain(ACCESS);
      expect(repaired.summary).toContain("[redacted]");
      // The premise of the finding: the text was repaired, the badge was not.
      expect(repaired.redacted).toBe(0);

      runMigrations(db, "test");

      const after = db.prepare("SELECT summary, redacted FROM activity_events WHERE id = 'act_v3'").get() as {
        summary: string;
        redacted: number;
      };
      // The text is untouched by the badge repair...
      expect(after.summary).toBe(repaired.summary);
      // ...and the badge now matches what the row shows.
      expect(after.redacted).toBe(1);

      // Visible through the API with no collection cycle.
      const item = listActivity(db, { limit: 100 })
        .map(toActivityItem)
        .find((entry) => entry.id === "act_v3");
      expect(item?.redacted).toBe(true);
      expect(JSON.stringify(item)).not.toContain(ACCESS);
    } finally {
      db.close();
    }
  });

  it("repairs a legacy malformed mixed payload and flags it", () => {
    // A previous build ran the scalar rules before the structured pass, so a
    // scalar value inside a structured payload became a bare `[redacted]`. That
    // made the payload unparseable, so the *other* credential it contained was
    // never removed and is still stored. Migration 5 must reach it.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      const malformed = `{"accessToken":{"value":"${LIVE}","password":[redacted]}}`;
      insertActivity(db, "act_malformed", "summary", malformed, 0);

      // The premise: the surviving credential is visible and the row is unflagged.
      const before = apiVisibleText(db);
      expect(before).toContain(LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = db.prepare("SELECT content, redacted FROM activity_events WHERE id = 'act_malformed'").get() as {
        content: string;
        redacted: number;
      };
      // The surviving credential is gone, the fragment is valid JSON again, and
      // the badge reports that the text is not the verbatim upstream record.
      expect(after.content).not.toContain(LIVE);
      expect(JSON.parse(after.content)).toEqual({ accessToken: "[redacted]" });
      expect(after.redacted).toBe(1);

      expect(apiVisibleText(db)).not.toContain(LIVE);
    } finally {
      db.close();
    }
  });

  it("reprocesses every display field from v4", () => {
    // Migration 5 re-runs the repair over migration 4's whole column set, so a
    // database that already applied v4 still converges on the corrected policy.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      seedEveryDisplayField(db);
      const before = apiVisibleText(db);
      // The credentials really are visible before the upgrade, so the test cannot
      // pass vacuously.
      for (const secret of SECRETS) expect(before, secret).toContain(secret);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).toContain("[redacted]");

      // Raw storage is clean too, not just the DTOs.
      const raw = db
        .prepare(
          `SELECT summary || ' ' || COALESCE(content, '') || ' ' || COALESCE(tool_name, '') AS text FROM activity_events
           UNION ALL SELECT COALESCE(title, '') FROM sessions
           UNION ALL SELECT COALESCE(description, '') FROM agents
           UNION ALL SELECT COALESCE(model_provider_id, '') FROM agents
           UNION ALL SELECT COALESCE(title, '') FROM root_runs
           UNION ALL SELECT COALESCE(evidence_json, '') FROM invocations
           UNION ALL SELECT COALESCE(canonical, '') FROM locations
           UNION ALL SELECT reason FROM collection_gaps
           UNION ALL SELECT detail FROM collector_warnings
           UNION ALL SELECT COALESCE(last_error, '') FROM collector_state`,
        )
        .all() as { text: string }[];
      const joined = raw.map((row) => row.text).join("\n");
      for (const secret of SECRETS) expect(joined, secret).not.toContain(secret);
    } finally {
      db.close();
    }
  });

  it("keeps an existing true badge true and a clean row unflagged", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      seedEveryDisplayField(db);
      runMigrations(db, "test");

      const flags = db.prepare("SELECT id, redacted FROM activity_events ORDER BY id").all() as {
        id: string;
        redacted: number;
      }[];
      const byId = new Map(flags.map((row) => [row.id, row.redacted]));
      // Rows repaired by this pass are flagged.
      expect(byId.get("act_structured")).toBe(1);
      expect(byId.get("act_pascal")).toBe(1);
      expect(byId.get("act_snake_array")).toBe(1);
      // An already-flagged row is not cleared...
      expect(byId.get("act_flagged_clean")).toBe(1);
      // ...and a row whose text holds nothing credential-shaped stays unflagged.
      expect(byId.get("act_clean")).toBe(0);

      const badge = new Map(listActivity(db, { limit: 100 }).map((entry) => [entry.id, toActivityItem(entry).redacted]));
      expect(badge.get("act_flagged_clean")).toBe(true);
      expect(badge.get("act_clean")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second pass rewrites nothing", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      seedEveryDisplayField(db);
      insertActivity(db, "act_malformed", "summary", `{"accessToken":{"value":"${LIVE}","password":[redacted]}}`, 0);
      runMigrations(db, "test");

      const after = apiVisibleText(db);
      expect(reprocessPersistedRedactionV5(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      // Running migrations again applies nothing and changes nothing.
      expect(runMigrations(db, "test").applied).toEqual([]);
      expect(apiVisibleText(db)).toBe(after);
    } finally {
      db.close();
    }
  });

  it("deletes no row and no field", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      seedEveryDisplayField(db);
      const before = rowCounts(db);
      runMigrations(db, "test");
      expect(rowCounts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("leaves migrations 1 to 4 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      // v4 is already recorded; v5 has not run yet.
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));

      runMigrations(db, "test");

      // Applying v5 re-records nothing: the earlier identities are untouched, so
      // a database that applied them is never invalidated.
      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 5 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 5);
    try {
      // As if an earlier build had applied v5 with different behaviour: same
      // version, different identity. It must be refused rather than silently
      // trusted.
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 5").run(
        checksumOf({ ...V5!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });

  it("repairs a stored credential assignment whose value looks like JSON", () => {
    // Regression: a stored assignment such as `password="correct[42]horse"` split
    // at the `[` inside its value, so no rule saw the complete value and the
    // credential survived every earlier repair pass. Migration 5 converges on the
    // corrected redactor, which owns the whole assignment.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      insertActivity(db, "act_quoted", `login password="${PASSWORD}"`, null, 0);
      insertActivity(db, "act_quoted_json", "summary", `clientSecret='{"value":"${LIVE}"}'`, 0);

      // The credentials really are visible before the upgrade, so the test cannot
      // pass vacuously.
      const before = apiVisibleText(db);
      expect(before).toContain(PASSWORD);
      expect(before).toContain(LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(PASSWORD);
      expect(after).not.toContain(LIVE);
      expect(after).toContain("[redacted]");

      // Raw storage is clean, and the repaired rows carry the badge.
      const raw = db
        .prepare("SELECT summary, content, redacted FROM activity_events WHERE id IN ('act_quoted', 'act_quoted_json')")
        .all() as { summary: string; content: string | null; redacted: number }[];
      const joined = raw.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
      expect(joined).not.toContain(PASSWORD);
      expect(joined).not.toContain(LIVE);
      expect(raw.every((row) => row.redacted === 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("fails closed when a stored value exceeds the structural scan limits", () => {
    // A value whose credential sits past the fragment-attempt cap cannot be
    // inspected, so the repair must replace the uninspected remainder rather than
    // leave it stored.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      const input = '{"a":1}'.repeat(512) + `{"accessToken":{"value":"${LIVE}"}}`;
      insertActivity(db, "act_capped", "summary", input, 0);
      expect(apiVisibleText(db)).toContain(LIVE);

      runMigrations(db, "test");

      const row = db.prepare("SELECT content, redacted FROM activity_events WHERE id = 'act_capped'").get() as {
        content: string;
        redacted: number;
      };
      expect(row.content).not.toContain(LIVE);
      expect(row.content).not.toContain("accessToken");
      expect(row.content).toContain("[redacted:uninspected]");
      expect(row.redacted).toBe(1);
      expect(apiVisibleText(db)).not.toContain(LIVE);
    } finally {
      db.close();
    }
  });

  it("is idempotent on a repaired credential assignment", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      insertActivity(db, "act_quoted", `login password="${PASSWORD}"`, null, 0);
      runMigrations(db, "test");

      const after = apiVisibleText(db);
      expect(reprocessPersistedRedactionV5(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(runMigrations(db, "test").applied).toEqual([]);
      expect(apiVisibleText(db)).toBe(after);
    } finally {
      db.close();
    }
  });

  it("repairs a stored environment-style credential assignment", () => {
    // Regression: the assignment scanner classified labels with the narrower
    // `isSecretKey`, which has no bare `key`, so `OPENAI_KEY="…"` was never
    // recognised and the `[` inside its value split the assignment.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      insertActivity(db, "act_env", `export OPENAI_KEY="${PASSWORD}"`, null, 0);
      insertActivity(db, "act_env_json", "summary", `OPENAI_KEY='{"value":"${LIVE}"}'`, 0);

      const before = apiVisibleText(db);
      expect(before).toContain(PASSWORD);
      expect(before).toContain(LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(PASSWORD);
      expect(after).not.toContain(LIVE);
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare("SELECT summary, content, redacted FROM activity_events WHERE id IN ('act_env', 'act_env_json')")
        .all() as { summary: string; content: string | null; redacted: number }[];
      const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
      expect(joined).not.toContain(PASSWORD);
      expect(joined).not.toContain(LIVE);
      expect(rows.every((row) => row.redacted === 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is idempotent after repairing an environment-style assignment", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      insertActivity(db, "act_env", `export OPENAI_KEY="${PASSWORD}"`, null, 0);
      runMigrations(db, "test");

      const after = apiVisibleText(db);
      expect(reprocessPersistedRedactionV5(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
    } finally {
      db.close();
    }
  });

  it("repairs a stored env-style JSON property, not only the assignment form", () => {
    // Regression: the structured path used the narrower classifier, so an
    // env-style *property name* survived inside stored JSON even though the
    // assignment form was repaired.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 4);
    try {
      insertActivity(
        db,
        "act_env_prop",
        "summary",
        `config {"region":"us-east-1","OPENAI_KEY":"${LIVE}","nested":{"GITHUB_TOKEN":"${PASSWORD}"}}`,
        0,
      );

      const before = apiVisibleText(db);
      expect(before).toContain(LIVE);
      expect(before).toContain(PASSWORD);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(LIVE);
      expect(after).not.toContain(PASSWORD);
      expect(after).toContain("[redacted]");

      // The JSON is still valid and its ordinary siblings survive.
      const row = db.prepare("SELECT content, redacted FROM activity_events WHERE id = 'act_env_prop'").get() as {
        content: string;
        redacted: number;
      };
      const fragment = row.content.slice(row.content.indexOf("{"));
      expect(JSON.parse(fragment)).toEqual({
        region: "us-east-1",
        OPENAI_KEY: "[redacted]",
        nested: { GITHUB_TOKEN: "[redacted]" },
      });
      expect(row.redacted).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 6: repair text the escaped-content gap left behind, for a database
// that already applied migration 5 before the redactor could read an escaped
// (double-encoded) document.
// ---------------------------------------------------------------------------

describe("migration upgrade v5 -> v6 (escaped redaction repair)", () => {
  const ESCAPED_LIVE = "opaque-escaped-live-000111222333";
  const ESCAPED_DOC = 'config: {\\"OPENAI_KEY\\":\\"' + ESCAPED_LIVE + '\\"}';
  // The container form: only the key proves the whole escaped object is a
  // credential, so it exercises the escaped walker rather than the escaped rule.
  const ESCAPED_CONTAINER = 'config: {\\"accessToken\\":{\\"value\\":\\"' + ESCAPED_LIVE + '\\"}}';

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 6 migration with an identified data step", () => {
    expect(V6).toBeDefined();
    expect(V6?.version).toBe(6);
    expect(V6?.reprocess).toBeTypeOf("function");
    expect(V6?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 6's checksum", () => {
    const versioned = checksumOf(V6!);
    const statementsOnly = createHash("sha256").update(V6!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V6!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V6!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 5 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 5);
    try {
      // v5 is already recorded; v6 has not run yet.
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5]);

      // Applying v6 re-records nothing: every earlier identity is untouched.
      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
    } finally {
      db.close();
    }
  });

  it("repairs a stored escaped document that migration 5 left behind", () => {
    // A database that applied v5 before the redactor could read an escaped
    // document still holds the credential; v5 is immutable, so v6 is the repair.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 5);
    try {
      insertEscapedActivity(db, "act_escaped", ESCAPED_DOC);
      insertEscapedActivity(db, "act_escaped_container", ESCAPED_CONTAINER);

      const before = apiVisibleText(db);
      expect(before).toContain(ESCAPED_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(ESCAPED_LIVE);
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare(
          "SELECT id, content, redacted FROM activity_events WHERE id IN ('act_escaped', 'act_escaped_container')",
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(ESCAPED_LIVE);
        expect(row.redacted, row.id).toBe(1);
      }
      expect(rows.find((row) => row.id === "act_escaped")?.content).toContain('{\\"OPENAI_KEY\\":\\"[redacted]\\"}');
      expect(rows.find((row) => row.id === "act_escaped_container")?.content).toContain(
        '{\\"accessToken\\":\\"[redacted]\\"}',
      );
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v5 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 5);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_escaped", ESCAPED_DOC);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(ESCAPED_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(ESCAPED_LIVE);

      // A second pass rewrites nothing, and no row is deleted.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV6(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 6 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 6);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 6").run(
        checksumOf({ ...V6!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 7: repair text the incomplete escaped walker left behind, for a
// database that already applied migration 6 before it was completed.
// ---------------------------------------------------------------------------

describe("migration upgrade v6 -> v7 (escaped sibling and value repair)", () => {
  const SIBLING_TOKEN = "ghp_abcdefghijklmnopqrstuvwx";
  const SUFFIX = "opaque-suffix-000111222333";

  /** The escaped-document text of a value: what a serialised tool input looks like. */
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const SIBLING_DOC = escapedDocument({ OPENAI_KEY: "k", note: SIBLING_TOKEN });
  const QUOTE_DOC = escapedDocument({ password: 'first"' + SUFFIX });
  const ARRAY_DOC = escapedDocument({ GITHUB_TOKEN: [17, 23, 42, 91] });

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 7 migration with an identified data step", () => {
    expect(V7).toBeDefined();
    expect(V7?.version).toBe(7);
    expect(V7?.reprocess).toBeTypeOf("function");
    expect(V7?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 7's checksum", () => {
    const versioned = checksumOf(V7!);
    const statementsOnly = createHash("sha256").update(V7!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V7!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V7!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 6 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 6);
    try {
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6]);

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
    } finally {
      db.close();
    }
  });

  it("repairs a stored escaped document that migration 6 left behind", () => {
    // A database that applied v6 before the escaped walker was completed still
    // holds a sibling token, an escaped-quote value's tail, and a primitive array
    // under a credential key. v6 is immutable, so v7 is the repair.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 6);
    try {
      insertEscapedActivity(db, "act_sibling", SIBLING_DOC);
      insertEscapedActivity(db, "act_quote", QUOTE_DOC);
      insertEscapedActivity(db, "act_array", ARRAY_DOC);

      const before = apiVisibleText(db);
      expect(before).toContain(SIBLING_TOKEN);
      expect(before).toContain(SUFFIX);
      expect(before).toContain("[17,23,42,91]");

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(SIBLING_TOKEN);
      expect(after).not.toContain(SUFFIX);
      expect(after).not.toContain("[17,23,42,91]");
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare(
          "SELECT id, content, redacted FROM activity_events WHERE id IN ('act_sibling', 'act_quote', 'act_array')",
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(SIBLING_TOKEN);
        expect(row.content, row.id).not.toContain(SUFFIX);
        expect(row.content, row.id).not.toContain("[17,23,42,91]");
        expect(row.redacted, row.id).toBe(1);
      }
      expect(rows.find((row) => row.id === "act_array")?.content).toContain('{\\"GITHUB_TOKEN\\":\\"[redacted]\\"}');
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v6 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 6);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_sibling", SIBLING_DOC);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(SIBLING_TOKEN);

      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV7(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 7 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 7);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 7").run(
        checksumOf({ ...V7!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 8: repair the nested-document, long-userinfo and malformed-primitive
// cases a pre-fix migration 7 left behind.
// ---------------------------------------------------------------------------

describe("migration upgrade v7 -> v8 (nested and delimitation repair)", () => {
  const NESTED_LIVE = "opaque-nested-live-000111222333";
  const LONG_USERINFO = "opaque_".repeat(300);
  const MALFORMED = '{\\"password\\":123opaque-suffix-000111222333}';

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const NESTED_DOC = escapedDocument({
    OPENAI_KEY: "k",
    note: JSON.stringify({ OPENAI_KEY: [17, 23, 42, 91], accessToken: NESTED_LIVE }),
  });
  const URL_DOC = `clone https://alice:${LONG_USERINFO}@example.com/repo`;

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 8 migration with an identified data step", () => {
    expect(V8).toBeDefined();
    expect(V8?.version).toBe(8);
    expect(V8?.reprocess).toBeTypeOf("function");
    expect(V8?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 8's checksum", () => {
    const versioned = checksumOf(V8!);
    const statementsOnly = createHash("sha256").update(V8!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V8!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V8!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 7 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 7);
    try {
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7]);

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));
    } finally {
      db.close();
    }
  });

  it("repairs a nested document, an over-long userinfo and a malformed primitive", () => {
    // A database that applied v7 before these cases were handled still holds them;
    // v7 is immutable, so v8 is the repair.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 7);
    try {
      insertEscapedActivity(db, "act_nested", NESTED_DOC);
      insertEscapedActivity(db, "act_url", URL_DOC);
      insertEscapedActivity(db, "act_malformed", MALFORMED);

      const before = apiVisibleText(db);
      expect(before).toContain("[17,23,42,91]");
      expect(before).toContain(NESTED_LIVE);
      expect(before).toContain(LONG_USERINFO);
      expect(before).toContain("opaque-suffix");

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain("[17,23,42,91]");
      expect(after).not.toContain(NESTED_LIVE);
      expect(after).not.toContain(LONG_USERINFO);
      expect(after).not.toContain("opaque-suffix");
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare(
          "SELECT id, content, redacted FROM activity_events WHERE id IN ('act_nested', 'act_url', 'act_malformed')",
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain("[17,23,42,91]");
        expect(row.content, row.id).not.toContain(NESTED_LIVE);
        expect(row.content, row.id).not.toContain(LONG_USERINFO);
        expect(row.content, row.id).not.toContain("opaque-suffix");
        expect(row.redacted, row.id).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v7 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 7);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_nested", NESTED_DOC);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain("[17,23,42,91]");

      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV8(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 8 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 8);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 8").run(
        checksumOf({ ...V8!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 9: repair the plaintext-beside-a-quoted-phrase case a pre-fix
// migration 8 left behind.
// ---------------------------------------------------------------------------

describe("migration upgrade v8 -> v9 (escaped plaintext repair)", () => {
  const PLAINTEXT_LIVE = "ghp_abcdefghijklmnopqrstuvwx";

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const AFTER_QUOTES = escapedDocument({ note: `say "hello" ${PLAINTEXT_LIVE}` });
  const BEFORE_QUOTES = escapedDocument({ note: `password=${PLAINTEXT_LIVE} and "quoted"` });

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 9 migration with an identified data step", () => {
    expect(V9).toBeDefined();
    expect(V9?.version).toBe(9);
    expect(V9?.reprocess).toBeTypeOf("function");
    expect(V9?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 9's checksum", () => {
    const versioned = checksumOf(V9!);
    const statementsOnly = createHash("sha256").update(V9!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V9!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V9!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 8 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 8);
    try {
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));
      expect(recordedChecksum(db, 9)).toBe(checksumOf(V9!));
    } finally {
      db.close();
    }
  });

  it("repairs a credential in the plaintext beside an escaped quoted phrase", () => {
    // A database that applied v8 before this was handled still holds the token;
    // v8 is immutable, so v9 is the repair.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 8);
    try {
      insertEscapedActivity(db, "act_after", AFTER_QUOTES);
      insertEscapedActivity(db, "act_before", BEFORE_QUOTES);

      const before = apiVisibleText(db);
      expect(before).toContain(PLAINTEXT_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(PLAINTEXT_LIVE);
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare("SELECT id, content, redacted FROM activity_events WHERE id IN ('act_after', 'act_before')")
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(PLAINTEXT_LIVE);
        expect(row.redacted, row.id).toBe(1);
      }
      // The quoted phrase survives as text.
      expect(rows.find((row) => row.id === "act_after")?.content).toContain("hello");
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v8 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 8);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_after", AFTER_QUOTES);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(PLAINTEXT_LIVE);

      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV9(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 9 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 9);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 9").run(
        checksumOf({ ...V9!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 10: repair a credential assignment inside an escaped ordinary string
// that a pre-fix migration 9 left behind.
// ---------------------------------------------------------------------------

describe("migration upgrade v9 -> v10 (escaped assignment repair)", () => {
  const ASSIGN_LIVE = "synthetic-assign-live-000111222333";

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const CONTAINER_DOC = escapedDocument({ note: "password=[17,23,42,91]" });
  const STRING_DOC = escapedDocument({ note: `password="${ASSIGN_LIVE}"` });

  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 10 migration with an identified data step", () => {
    expect(V10).toBeDefined();
    expect(V10?.version).toBe(10);
    expect(V10?.reprocess).toBeTypeOf("function");
    expect(V10?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 10's checksum", () => {
    const versioned = checksumOf(V10!);
    const statementsOnly = createHash("sha256").update(V10!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V10!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V10!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 9 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 9);
    try {
      expect(recordedChecksum(db, 9)).toBe(checksumOf(V9!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));
      expect(recordedChecksum(db, 9)).toBe(checksumOf(V9!));
      expect(recordedChecksum(db, 10)).toBe(checksumOf(V10!));
    } finally {
      db.close();
    }
  });

  it("repairs a credential assignment inside an escaped string", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 9);
    try {
      insertEscapedActivity(db, "act_container", CONTAINER_DOC);
      insertEscapedActivity(db, "act_string", STRING_DOC);

      const before = apiVisibleText(db);
      expect(before).toContain("[17,23,42,91]");
      expect(before).toContain(ASSIGN_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain("[17,23,42,91]");
      expect(after).not.toContain(ASSIGN_LIVE);
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare("SELECT id, content, redacted FROM activity_events WHERE id IN ('act_container', 'act_string')")
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain("[17,23,42,91]");
        expect(row.content, row.id).not.toContain(ASSIGN_LIVE);
        expect(row.redacted, row.id).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v9 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 9);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_container", CONTAINER_DOC);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain("[17,23,42,91]");

      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV10(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 10 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 10);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 10").run(
        checksumOf({ ...V10!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 11: repair the escaped-level assignment grammar a pre-fix migration
// 10 left behind — a quoted label, a bare value containing brackets, a container
// followed by a suffix, and a mismatched closer.
// ---------------------------------------------------------------------------

describe("migration upgrade v10 -> v11 (assignment grammar repair)", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  /**
   * The four shapes the assignment-grammar fix closes, each in the escaped form a
   * serialised tool input takes. A v10 database still holds them verbatim: v10's
   * assignment pass recognised only a bare label with a container value, consumed a
   * bare value up to its first bracket, accepted a container without checking what
   * followed it, and treated a mismatched closer as complete.
   */
  const QUOTED_LABEL = escapedDocument({ note: "'password': [17,23,42,91]" });
  const BARE_BRACKETS = escapedDocument({ note: "password=correct[42]horse" });
  const CONTAINER_SUFFIX = escapedDocument({ note: "password=[1,2]opaque-suffix" });
  const MISMATCHED = escapedDocument({ note: "password=[1,2}" });

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 11 migration with an identified data step", () => {
    expect(V11).toBeDefined();
    expect(V11?.version).toBe(11);
    expect(V11?.reprocess).toBeTypeOf("function");
    expect(V11?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 11's checksum", () => {
    const versioned = checksumOf(V11!);
    const statementsOnly = createHash("sha256").update(V11!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V11!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V11!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 10 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 10);
    try {
      expect(recordedChecksum(db, 10)).toBe(checksumOf(V10!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));
      expect(recordedChecksum(db, 9)).toBe(checksumOf(V9!));
      expect(recordedChecksum(db, 10)).toBe(checksumOf(V10!));
      expect(recordedChecksum(db, 11)).toBe(checksumOf(V11!));
    } finally {
      db.close();
    }
  });

  it("repairs all four assignment-grammar shapes a v10 database still holds", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 10);
    try {
      insertEscapedActivity(db, "act_quoted_label", QUOTED_LABEL);
      insertEscapedActivity(db, "act_bare_brackets", BARE_BRACKETS);
      insertEscapedActivity(db, "act_container_suffix", CONTAINER_SUFFIX);
      insertEscapedActivity(db, "act_mismatched", MISMATCHED);

      // The credentials really are visible before the upgrade, so the test cannot
      // pass vacuously.
      const before = apiVisibleText(db);
      expect(before).toContain("[17,23,42,91]");
      expect(before).toContain("correct[42]horse");
      expect(before).toContain("opaque-suffix");
      expect(before).toContain("[1,2}");

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain("[17,23,42,91]");
      expect(after).not.toContain("correct[42]horse");
      expect(after).not.toContain("opaque-suffix");
      expect(after).not.toContain("[1,2}");
      // A delimited value becomes `[redacted]`; a value that cannot be delimited
      // fails closed to `[redacted:uninspected]`.
      expect(after).toContain("[redacted]");
      expect(after).toContain("[redacted:uninspected]");

      const rows = db
        .prepare(
          `SELECT id, content, redacted FROM activity_events
           WHERE id IN ('act_quoted_label', 'act_bare_brackets', 'act_container_suffix', 'act_mismatched')`,
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain("[17,23,42,91]");
        expect(row.content, row.id).not.toContain("correct[42]horse");
        expect(row.content, row.id).not.toContain("opaque-suffix");
        expect(row.content, row.id).not.toContain("[1,2}");
        expect(row.redacted, row.id).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v10 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 10);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_quoted_label", QUOTED_LABEL);
      insertEscapedActivity(db, "act_container_suffix", CONTAINER_SUFFIX);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain("[17,23,42,91]");
      expect(before).toContain("opaque-suffix");

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain("[17,23,42,91]");
      expect(after).not.toContain("opaque-suffix");

      // Redaction is idempotent, so re-running the data step changes nothing and
      // deletes no row.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV11(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 11 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 11);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 11").run(
        checksumOf({ ...V11!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 12: repair the escaped-level walker a pre-fix migration 11 left
// behind — an incomplete value boundary, a Unicode-escaped credential key, and
// the nested nonsensitive containers it rescanned.
// ---------------------------------------------------------------------------

describe("migration upgrade v11 -> v12 (boundary and escaped-key repair)", () => {
  const BOUNDARY_LIVE = "opaque-boundary-live-000111222333";
  const UNICODE_LIVE = "opaque-unicode-live-444555666777";
  const NESTED_LIVE = "ghp_abcdefghijklmnopqrstuvwx";

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  function nestedObject(depth: number, leaf: unknown): unknown {
    let node = leaf;
    for (let i = 0; i < depth; i += 1) node = { a: node };
    return node;
  }

  /**
   * The three shapes a v11 database still holds verbatim. v11 accepted a closing
   * quote as proof that the assignment had ended, so it redacted `"abc"` and left
   * the continuation; it could not decode a `\uXXXX` escape in a key, so the value
   * under `access\u0054oken` was never classified; and it rescanned nested
   * nonsensitive containers once per enclosing level.
   */
  const BOUNDARY = `{\\"password\\":\\"abc\\"${BOUNDARY_LIVE}}`;
  const UNICODE_KEY = `{\\"access\\u0054oken\\":\\"${UNICODE_LIVE}\\"}`;
  const NESTED = escapedDocument(nestedObject(6, { k: NESTED_LIVE }));

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 12 migration with an identified data step", () => {
    expect(V12).toBeDefined();
    expect(V12?.version).toBe(12);
    expect(V12?.reprocess).toBeTypeOf("function");
    expect(V12?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 12's checksum", () => {
    const versioned = checksumOf(V12!);
    const statementsOnly = createHash("sha256").update(V12!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V12!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V12!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 11 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 11);
    try {
      expect(recordedChecksum(db, 11)).toBe(checksumOf(V11!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([12, 13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));
      expect(recordedChecksum(db, 9)).toBe(checksumOf(V9!));
      expect(recordedChecksum(db, 10)).toBe(checksumOf(V10!));
      expect(recordedChecksum(db, 11)).toBe(checksumOf(V11!));
      expect(recordedChecksum(db, 12)).toBe(checksumOf(V12!));
    } finally {
      db.close();
    }
  });

  it("repairs all three shapes a v11 database still holds", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 11);
    try {
      insertEscapedActivity(db, "act_boundary", BOUNDARY);
      insertEscapedActivity(db, "act_unicode", UNICODE_KEY);
      insertEscapedActivity(db, "act_nested", NESTED);

      // The credentials really are visible before the upgrade, so the test cannot
      // pass vacuously.
      const before = apiVisibleText(db);
      expect(before).toContain(BOUNDARY_LIVE);
      expect(before).toContain(UNICODE_LIVE);
      expect(before).toContain(NESTED_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([12, 13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(BOUNDARY_LIVE);
      expect(after).not.toContain(UNICODE_LIVE);
      expect(after).not.toContain(NESTED_LIVE);
      // The boundary case fails closed; the other two are delimited and replaced.
      expect(after).toContain("[redacted:uninspected]");
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare(
          `SELECT id, content, redacted FROM activity_events
           WHERE id IN ('act_boundary', 'act_unicode', 'act_nested')`,
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(BOUNDARY_LIVE);
        expect(row.content, row.id).not.toContain(UNICODE_LIVE);
        expect(row.content, row.id).not.toContain(NESTED_LIVE);
        expect(row.redacted, row.id).toBe(1);
      }
      // The raw key spelling survives; only the value was replaced.
      expect(rows.find((row) => row.id === "act_unicode")?.content).toContain("access\\u0054oken");
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v11 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 11);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_boundary", BOUNDARY);
      insertEscapedActivity(db, "act_nested", NESTED);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(BOUNDARY_LIVE);
      expect(before).toContain(NESTED_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(BOUNDARY_LIVE);
      expect(after).not.toContain(NESTED_LIVE);

      // Redaction is idempotent, so re-running the data step changes nothing and
      // deletes no row.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV12(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 12 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 12);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 12").run(
        checksumOf({ ...V12!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 13: repair the five shapes a pre-fix migration 12 left behind — a
// brace inside a plain container string, a key escape hidden one layer deeper, a
// bare assignment with a quoted continuation, and an unterminated private-key
// block.
// ---------------------------------------------------------------------------

describe("migration upgrade v12 -> v13 (container strings and key escapes)", () => {
  const CONTAINER_LIVE = "opaque-container-live-000111222333";
  const NESTED_ESCAPE_LIVE = "opaque-nested-escape-444555666777";
  const BARE_CONTINUATION_LIVE = "opaque-bare-continuation-888999000111";
  const PEM_LIVE = "opaque-pem-live-222333444555";

  /**
   * The shapes a v12 database still holds verbatim.
   *
   * - a brace inside an ordinary quoted string closed the container early;
   * - `access\\u0054oken` is `accessToken` with the escape one layer deeper;
   * - a bare assignment followed by a quoted continuation was redacted only up to
   *   the quote;
   * - a private-key block with no `END` had no delimited body.
   */
  const CONTAINER_STRING = `password={"value":"},${CONTAINER_LIVE}"}`;
  const NESTED_ESCAPE = `{"access\\\\u0054oken":"${NESTED_ESCAPE_LIVE}"}`;
  const BARE_CONTINUATION = `password=prefix"${BARE_CONTINUATION_LIVE}"`;
  const PEM_INCOMPLETE = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_LIVE}`;

  /** One activity row, with the display text and badge under test. */
  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 13 migration with an identified data step", () => {
    expect(V13).toBeDefined();
    expect(V13?.version).toBe(13);
    expect(V13?.reprocess).toBeTypeOf("function");
    expect(V13?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 13's checksum", () => {
    const versioned = checksumOf(V13!);
    const statementsOnly = createHash("sha256").update(V13!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V13!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V13!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 12 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 12);
    try {
      expect(recordedChecksum(db, 12)).toBe(checksumOf(V12!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([13, 14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      expect(recordedChecksum(db, 4)).toBe(checksumOf(V4!));
      expect(recordedChecksum(db, 5)).toBe(checksumOf(V5!));
      expect(recordedChecksum(db, 6)).toBe(checksumOf(V6!));
      expect(recordedChecksum(db, 7)).toBe(checksumOf(V7!));
      expect(recordedChecksum(db, 8)).toBe(checksumOf(V8!));
      expect(recordedChecksum(db, 9)).toBe(checksumOf(V9!));
      expect(recordedChecksum(db, 10)).toBe(checksumOf(V10!));
      expect(recordedChecksum(db, 11)).toBe(checksumOf(V11!));
      expect(recordedChecksum(db, 12)).toBe(checksumOf(V12!));
      expect(recordedChecksum(db, 13)).toBe(checksumOf(V13!));
    } finally {
      db.close();
    }
  });

  it("repairs all four shapes a v12 database still holds", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 12);
    try {
      insertEscapedActivity(db, "act_container_string", CONTAINER_STRING);
      insertEscapedActivity(db, "act_nested_escape", NESTED_ESCAPE);
      insertEscapedActivity(db, "act_bare_continuation", BARE_CONTINUATION);
      insertEscapedActivity(db, "act_pem_incomplete", PEM_INCOMPLETE);

      // The credentials really are visible before the upgrade, so the test cannot
      // pass vacuously.
      const before = apiVisibleText(db);
      for (const secret of [CONTAINER_LIVE, NESTED_ESCAPE_LIVE, BARE_CONTINUATION_LIVE, PEM_LIVE]) {
        expect(before, secret).toContain(secret);
      }

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([13, 14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      for (const secret of [CONTAINER_LIVE, NESTED_ESCAPE_LIVE, BARE_CONTINUATION_LIVE, PEM_LIVE]) {
        expect(after, secret).not.toContain(secret);
      }
      expect(after).toContain("[redacted]");
      expect(after).toContain("[redacted:uninspected]");

      const rows = db
        .prepare(
          `SELECT id, content, redacted FROM activity_events
           WHERE id IN ('act_container_string', 'act_nested_escape', 'act_bare_continuation', 'act_pem_incomplete')`,
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        for (const secret of [CONTAINER_LIVE, NESTED_ESCAPE_LIVE, BARE_CONTINUATION_LIVE, PEM_LIVE]) {
          expect(row.content, `${row.id}/${secret}`).not.toContain(secret);
        }
        expect(row.redacted, row.id).toBe(1);
      }
      // The nested-escape key's raw spelling survives; only the value was replaced.
      expect(rows.find((row) => row.id === "act_nested_escape")?.content).toContain("access\\\\u0054oken");
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v12 and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 12);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_container_string", CONTAINER_STRING);
      insertEscapedActivity(db, "act_pem_incomplete", PEM_INCOMPLETE);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(CONTAINER_LIVE);
      expect(before).toContain(PEM_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(CONTAINER_LIVE);
      expect(after).not.toContain(PEM_LIVE);

      // Redaction is idempotent, so re-running the data step changes nothing and
      // deletes no row.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV13(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 13 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 13);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 13").run(
        checksumOf({ ...V13!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 14: repair the two gaps migration 13 left — a bounded preceding-key
// lookup that failed open on a long key or long whitespace run, and the partial
// redaction an older build wrote (`password=[redacted],<leaked tail>`), which the
// current redactor accepted as a complete value.
// ---------------------------------------------------------------------------

describe("migration upgrade v13 -> v14 (bounded lookup and partial redaction)", () => {
  const LONG_KEY_LIVE = "opaque-long-key-live-000111222333";
  const PARTIAL_LIVE = "opaque-partial-live-444555666777";

  /**
   * The exact partial artifact the old build wrote: a credential container whose
   * prefix was redacted, leaving the rest of the value in the text. This is the
   * *actual* defective string a v13 database still holds.
   */
  const PARTIAL_ARTIFACT = `password=[redacted],${PARTIAL_LIVE}"}`;

  /** The exact long-key/whitespace shape that made the bounded lookup fail open. */
  const LONG_KEY = `password.${"a".repeat(64)}=${" ".repeat(257)}${JSON.stringify({ value: LONG_KEY_LIVE })}`;

  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 14 migration with an identified data step", () => {
    expect(V14).toBeDefined();
    expect(V14?.version).toBe(14);
    expect(V14?.reprocess).toBeTypeOf("function");
    expect(V14?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 14's checksum", () => {
    const versioned = checksumOf(V14!);
    const statementsOnly = createHash("sha256").update(V14!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V14!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V14!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 13 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 13);
    try {
      expect(recordedChecksum(db, 13)).toBe(checksumOf(V13!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([14, 15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      for (const [version, migration] of [
        [4, V4], [5, V5], [6, V6], [7, V7], [8, V8], [9, V9], [10, V10], [11, V11], [12, V12], [13, V13],
      ] as const) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(checksumOf(migration!));
      }
      expect(recordedChecksum(db, 14)).toBe(checksumOf(V14!));
    } finally {
      db.close();
    }
  });

  it("repairs the actual partial-redaction artifact a v13 database holds", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 13);
    try {
      insertEscapedActivity(db, "act_partial", PARTIAL_ARTIFACT);
      insertEscapedActivity(db, "act_long_key", LONG_KEY);

      // The leaked values really are visible before the upgrade, so the test cannot
      // pass vacuously.
      const before = apiVisibleText(db);
      expect(before).toContain(PARTIAL_LIVE);
      expect(before).toContain(LONG_KEY_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([14, 15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(PARTIAL_LIVE);
      expect(after).not.toContain(LONG_KEY_LIVE);
      expect(after).toContain("[redacted:uninspected]");

      const rows = db
        .prepare(
          `SELECT id, content, redacted FROM activity_events WHERE id IN ('act_partial', 'act_long_key')`,
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(PARTIAL_LIVE);
        expect(row.content, row.id).not.toContain(LONG_KEY_LIVE);
        // The badge is raised so the timeline does not present the text as verbatim.
        expect(row.redacted, row.id).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v13, keeps every row, and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 13);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_partial", PARTIAL_ARTIFACT);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(PARTIAL_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(PARTIAL_LIVE);

      // No row is deleted, and re-running the data step changes nothing.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV14(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 14 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 14);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 14").run(
        checksumOf({ ...V14!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 15: repair what migration 14's artifact recovery left — a leaked
// suffix that contains whitespace (14 stopped at the first space, or skipped
// entirely when the comma was followed by one), and the valid JSON siblings 14
// deleted because it ran before the structured parse.
// ---------------------------------------------------------------------------

describe("migration upgrade v14 -> v15 (whitespace artifact and JSON siblings)", () => {
  const WS_LIVE = "opaque-whitespace-live-000111222333";
  const V14_LEFTOVER_LIVE = "opaque-v14-leftover-444555666777";
  const SIBLING_LIVE = "opaque-sibling-live-888999000111";

  /**
   * The exact rows a v14 database holds.
   *
   * - migration 14 skipped the artifact entirely when a space followed the comma,
   *   so the raw legacy artifact is still stored;
   * - when the tail began with a non-space, 14 consumed only up to the first space
   *   and left the rest behind its marker;
   * - and 14's prepass ran before the structured parse, so a valid document with a
   *   bare placeholder value lost its siblings and was truncated mid-document.
   */
  const V14_SKIPPED_ARTIFACT = `password=[redacted], multi word ${WS_LIVE}"}`;
  const V14_PARTIAL_LEFTOVER = `password=[redacted:uninspected] ${V14_LEFTOVER_LIVE}"}`;
  const V14_TRUNCATED_JSON = '{"password":[redacted:uninspected]';
  /** A structured row a v14 database may hold, with a legitimate sibling. */
  const V14_VALID_JSON = `{"password":[redacted],"region":"${SIBLING_LIVE}"}`;

  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 15 migration with an identified data step", () => {
    expect(V15).toBeDefined();
    expect(V15?.version).toBe(15);
    expect(V15?.reprocess).toBeTypeOf("function");
    expect(V15?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 15's checksum", () => {
    const versioned = checksumOf(V15!);
    const statementsOnly = createHash("sha256").update(V15!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V15!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V15!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 14 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 14);
    try {
      expect(recordedChecksum(db, 14)).toBe(checksumOf(V14!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([15, 16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      for (const [version, migration] of [
        [4, V4], [5, V5], [6, V6], [7, V7], [8, V8], [9, V9], [10, V10], [11, V11], [12, V12], [13, V13], [14, V14],
      ] as const) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(checksumOf(migration!));
      }
      expect(recordedChecksum(db, 15)).toBe(checksumOf(V15!));
    } finally {
      db.close();
    }
  });

  it("removes the leaked whitespace suffix a v14 database still holds", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 14);
    try {
      insertEscapedActivity(db, "act_v14_skipped", V14_SKIPPED_ARTIFACT);
      insertEscapedActivity(db, "act_v14_leftover", V14_PARTIAL_LEFTOVER);

      // The leaked values really are visible before the upgrade, so the test cannot
      // pass vacuously.
      const before = apiVisibleText(db);
      expect(before).toContain(WS_LIVE);
      expect(before).toContain(V14_LEFTOVER_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([15, 16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(WS_LIVE);
      expect(after).not.toContain(V14_LEFTOVER_LIVE);
      expect(after).not.toContain("multi word");
      expect(after).toContain("[redacted:uninspected]");

      const rows = db
        .prepare(
          `SELECT id, content, redacted FROM activity_events WHERE id IN ('act_v14_skipped', 'act_v14_leftover')`,
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(WS_LIVE);
        expect(row.content, row.id).not.toContain(V14_LEFTOVER_LIVE);
        expect(row.redacted, row.id).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("preserves a valid structured row's sibling and keeps it parseable", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 14);
    try {
      insertEscapedActivity(db, "act_valid_json", V14_VALID_JSON);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      // The legitimate sibling survives, and the document is repaired to valid JSON.
      expect(after).toContain(SIBLING_LIVE);
      expect(after).toContain('\\"password\\":\\"[redacted]\\"');

      const row = db
        .prepare("SELECT content, redacted FROM activity_events WHERE id = 'act_valid_json'")
        .get() as { content: string; redacted: number };
      // The document was not truncated and its structure is intact.
      expect(row.content).toContain(SIBLING_LIVE);
      expect(row.content).toContain("[redacted]");
      expect(row.content).not.toContain("[redacted:uninspected]");
      expect(row.content.endsWith("}")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not further damage a row migration 14 already truncated", () => {
    // Migration 14's prepass deleted the sibling before this fix shipped, so the
    // data is already gone; the repair must at least leave no credential and change
    // nothing on a second pass.
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 14);
    try {
      insertEscapedActivity(db, "act_truncated_json", V14_TRUNCATED_JSON);

      runMigrations(db, "test");
      const after = apiVisibleText(db);

      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV15(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v14, keeps every row, and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 14);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_v14_skipped", V14_SKIPPED_ARTIFACT);
      insertEscapedActivity(db, "act_valid_json", V14_VALID_JSON);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(WS_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(WS_LIVE);

      // No row is deleted, and re-running the data step changes nothing.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV15(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 15 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 15);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 15").run(
        checksumOf({ ...V15!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 16: re-run the repair with the linear artifact recovery. Migration
// 15's recovery re-scanned the remaining suffix for each marker, which is
// quadratic on marker-heavy text, and its work was omitted from the shared scan
// budget. The stored shapes are recovered identically, so this step exists to
// bring a version-15 database onto the current code.
// ---------------------------------------------------------------------------

describe("migration upgrade v15 -> v16 (linear artifact recovery)", () => {
  const ARTIFACT_LIVE = "opaque-artifact-live-000111222333";
  const SIBLING_LIVE = "opaque-sibling-live-444555666777";

  /** A stored row a version-15 build may have left unconverted. */
  const UNCONVERTED_ARTIFACT = `password=[redacted], multi word ${ARTIFACT_LIVE}"}`;
  /** A structured row whose sibling must survive. */
  const STRUCTURED_ROW = `{"password":[redacted],"region":"${SIBLING_LIVE}"}`;
  /** A marker-heavy row: the shape that made the recovery quadratic. */
  const MARKER_HEAVY = `note=${"[redacted] ".repeat(4_000)}`;

  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 16 migration with an identified data step", () => {
    expect(V16).toBeDefined();
    expect(V16?.version).toBe(16);
    expect(V16?.reprocess).toBeTypeOf("function");
    expect(V16?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 16's checksum", () => {
    const versioned = checksumOf(V16!);
    const statementsOnly = createHash("sha256").update(V16!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V16!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V16!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 15 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 15);
    try {
      expect(recordedChecksum(db, 15)).toBe(checksumOf(V15!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([16, 17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      for (const [version, migration] of [
        [4, V4], [5, V5], [6, V6], [7, V7], [8, V8], [9, V9], [10, V10], [11, V11], [12, V12], [13, V13], [14, V14],
        [15, V15],
      ] as const) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(checksumOf(migration!));
      }
      expect(recordedChecksum(db, 16)).toBe(checksumOf(V16!));
    } finally {
      db.close();
    }
  });

  it("repairs an unconverted artifact row and preserves a structured sibling", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 15);
    try {
      insertEscapedActivity(db, "act_unconverted", UNCONVERTED_ARTIFACT);
      insertEscapedActivity(db, "act_structured", STRUCTURED_ROW);

      const before = apiVisibleText(db);
      expect(before).toContain(ARTIFACT_LIVE);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([16, 17, 18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(ARTIFACT_LIVE);
      expect(after).not.toContain("multi word");
      expect(after).toContain("[redacted:uninspected]");
      // The legitimate sibling survives the repair.
      expect(after).toContain(SIBLING_LIVE);

      const rows = db
        .prepare("SELECT id, content, redacted FROM activity_events WHERE id IN ('act_unconverted', 'act_structured')")
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      const unconverted = rows.find((row) => row.id === "act_unconverted");
      expect(unconverted?.content).not.toContain(ARTIFACT_LIVE);
      expect(unconverted?.redacted).toBe(1);
      expect(rows.find((row) => row.id === "act_structured")?.content).toContain(SIBLING_LIVE);
    } finally {
      db.close();
    }
  });

  it("repairs a marker-heavy row without stalling", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 15);
    try {
      insertEscapedActivity(db, "act_marker_heavy", MARKER_HEAVY);

      const started = Date.now();
      const result = runMigrations(db, "test");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.applied).toEqual([16, 17, 18]);

      const row = db
        .prepare("SELECT content, redacted FROM activity_events WHERE id = 'act_marker_heavy'")
        .get() as { content: string; redacted: number };
      // The text holds only ordinary markers, so no credential is introduced or
      // removed; past the fragment-attempt cap the scan fails closed, which is the
      // conservative outcome and introduces nothing.
      expect(row.content === MARKER_HEAVY || row.content === "[redacted:uninspected]").toBe(true);
      // The badge is raised because the row carries a redaction marker, which is the
      // documented, conservative direction (see invariant 19).
      expect(row.redacted).toBe(1);
    } finally {
      db.close();
    }
  });

  it("leaves a below-cap marker-heavy row byte for byte", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 15);
    try {
      const belowCap = `note=${"[redacted] ".repeat(100)}`;
      insertEscapedActivity(db, "act_below_cap", belowCap);

      runMigrations(db, "test");

      const row = db
        .prepare("SELECT content FROM activity_events WHERE id = 'act_below_cap'")
        .get() as { content: string };
      expect(row.content).toBe(belowCap);
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v15, keeps every row, and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 15);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_unconverted", UNCONVERTED_ARTIFACT);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(ARTIFACT_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(ARTIFACT_LIVE);

      // No row is deleted, and re-running the data step changes nothing.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV16(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 16 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 16);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 16").run(
        checksumOf({ ...V16!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 17: repair what version 16's recovery destroyed. Version 16 ran the
// legacy-tail recovery whenever the whole stored value failed to parse, so
// recoverable JSON embedded in prose was consumed and its siblings deleted. The
// structural pass now preserves them while a genuine artifact is still failed
// closed.
// ---------------------------------------------------------------------------

describe("migration upgrade v16 -> v17 (embedded JSON protection)", () => {
  const SIBLING_LIVE = "opaque-sibling-live-000111222333";
  const TAIL_LIVE = "opaque-tail-live-444555666777";

  /**
   * The exact rows a version-16 database holds.
   *
   * - v16 consumed the recoverable document embedded in prose, so the row it wrote
   *   is the truncated form with the sibling gone;
   * - an actual malformed artifact was, and still is, failed closed;
   * - a structured row with a sibling must keep that sibling.
   */
  const V16_TRUNCATED = 'config {"password":[redacted:uninspected]';
  const V16_ARTIFACT = `log password=[redacted:uninspected]`;
  const V16_STRUCTURED = `config {"password":[redacted],"region":"${SIBLING_LIVE}"}`;
  const V16_PLAIN_ARTIFACT = `password=[redacted], multi word ${TAIL_LIVE}"}`;

  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 17 migration with an identified data step", () => {
    expect(V17).toBeDefined();
    expect(V17?.version).toBe(17);
    expect(V17?.reprocess).toBeTypeOf("function");
    expect(V17?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 17's checksum", () => {
    const versioned = checksumOf(V17!);
    const statementsOnly = createHash("sha256").update(V17!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V17!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V17!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 16 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 16);
    try {
      expect(recordedChecksum(db, 16)).toBe(checksumOf(V16!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([17, 18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      for (const [version, migration] of [
        [4, V4], [5, V5], [6, V6], [7, V7], [8, V8], [9, V9], [10, V10], [11, V11], [12, V12], [13, V13], [14, V14],
        [15, V15], [16, V16],
      ] as const) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(checksumOf(migration!));
      }
      expect(recordedChecksum(db, 17)).toBe(checksumOf(V17!));
    } finally {
      db.close();
    }
  });

  it("preserves a recoverable embedded document's sibling and the text around it", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 16);
    try {
      insertEscapedActivity(db, "act_structured", V16_STRUCTURED);

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([17, 18]);

      const row = db
        .prepare("SELECT content, redacted FROM activity_events WHERE id = 'act_structured'")
        .get() as { content: string; redacted: number };
      // The sibling survives and the document is repaired, not truncated.
      expect(row.content).toContain(SIBLING_LIVE);
      expect(row.content).toContain('{"password":"[redacted]","region":"' + SIBLING_LIVE + '"}');
      expect(row.content).not.toContain("[redacted:uninspected]");
      expect(row.content.endsWith("}")).toBe(true);
      expect(row.redacted).toBe(1);

      const after = apiVisibleText(db);
      expect(after).toContain(SIBLING_LIVE);
    } finally {
      db.close();
    }
  });

  it("keeps a genuine malformed artifact failed closed", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 16);
    try {
      insertEscapedActivity(db, "act_plain_artifact", V16_PLAIN_ARTIFACT);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      expect(after).not.toContain(TAIL_LIVE);
      expect(after).not.toContain("multi word");
      expect(after).toContain("[redacted:uninspected]");
    } finally {
      db.close();
    }
  });

  it("leaves an already-failed-closed v16 row stable and keeps every row", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 16);
    try {
      insertEscapedActivity(db, "act_truncated", V16_TRUNCATED);
      insertEscapedActivity(db, "act_artifact", V16_ARTIFACT);

      runMigrations(db, "test");
      const after = apiVisibleText(db);

      // The sibling v16 deleted cannot be recovered — the text is gone — but the
      // repair introduces nothing and is stable on a second pass.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV17(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 17 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 17);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 17").run(
        checksumOf({ ...V17!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 18: repair a long credential key the lookup could not see. Version 17
// kept only the last 64 characters of a key run, so a long credential key whose
// sensitive prefix was earlier was read as a non-credential suffix and its quoted
// value was split around the `[42]` inside it.
// ---------------------------------------------------------------------------

describe("migration upgrade v17 -> v18 (whole-key examination)", () => {
  const SUFFIX_LIVE = "suffix-opaque-live-000111222333";
  const VALUE = `="prefix[42]${SUFFIX_LIVE}"`;
  const LIMIT = 256;
  const keyOf = (length: number): string => `password.${"z".repeat(length - "password.".length)}`;

  /**
   * The exact rows a version-17 database holds: the assignment was never recognised,
   * so the credential sits verbatim in the stored text.
   */
  const V17_LONG_KEY = `password.${"z".repeat(64)}${VALUE}`;
  const V17_OVER_BOUND = `${keyOf(LIMIT + 1)}${VALUE}`;

  function insertEscapedActivity(db: Db, id: string, content: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index,
         sequence, occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
         upstream_outcome, source, ingested_at)
       VALUES (?, ?, 'loc_1', 'ses_1', NULL, 'message-assistant', ?, 0, 0, 1, NULL, NULL, 'completed', 'summary', ?, 0, 0, NULL, 'upstream', 1)`,
    ).run(id, `key_${id}`, `msg_${id}`, content);
  }

  it("has a version 18 migration with an identified data step", () => {
    expect(V18).toBeDefined();
    expect(V18?.version).toBe(18);
    expect(V18?.reprocess).toBeTypeOf("function");
    expect(V18?.dataStepVersion).toBe(1);
  });

  it("folds the declared data-step version into migration 18's checksum", () => {
    const versioned = checksumOf(V18!);
    const statementsOnly = createHash("sha256").update(V18!.statements.join(";\n")).digest("hex");
    expect(versioned).not.toBe(statementsOnly);
    expect(checksumOf({ ...V18!, dataStepVersion: 2 })).not.toBe(versioned);
    expect(checksumOf({ ...V18!, statements: ["SELECT 1"] })).not.toBe(versioned);
  });

  it("leaves migrations 1 to 17 recorded under their frozen identities", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 17);
    try {
      expect(recordedChecksum(db, 17)).toBe(checksumOf(V17!));

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([18]);
      expect(result.alreadyApplied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(currentSchemaVersion(db)).toBe(expectedSchemaVersion());

      for (const version of [1, 2, 3]) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(FROZEN_CHECKSUMS[version]);
      }
      for (const [version, migration] of [
        [4, V4], [5, V5], [6, V6], [7, V7], [8, V8], [9, V9], [10, V10], [11, V11], [12, V12], [13, V13], [14, V14],
        [15, V15], [16, V16], [17, V17],
      ] as const) {
        expect(recordedChecksum(db, version), `recorded v${version}`).toBe(checksumOf(migration!));
      }
      expect(recordedChecksum(db, 18)).toBe(checksumOf(V18!));
    } finally {
      db.close();
    }
  });

  it("repairs the actual long-key credential a v17 database holds", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 17);
    try {
      insertEscapedActivity(db, "act_long_key", V17_LONG_KEY);
      insertEscapedActivity(db, "act_over_bound", V17_OVER_BOUND);

      // The credential really is visible before the upgrade, so the test cannot pass
      // vacuously.
      const before = apiVisibleText(db);
      expect(before).toContain(SUFFIX_LIVE);
      expect(before).toContain("[42]");

      const result = runMigrations(db, "test");
      expect(result.applied).toEqual([18]);

      const after = apiVisibleText(db);
      expect(after).not.toContain(SUFFIX_LIVE);
      expect(after).not.toContain("[42]");
      expect(after).toContain("[redacted]");

      const rows = db
        .prepare(
          `SELECT id, content, redacted FROM activity_events WHERE id IN ('act_long_key', 'act_over_bound')`,
        )
        .all() as { id: string; content: string; redacted: number }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content, row.id).not.toContain(SUFFIX_LIVE);
        expect(row.content, row.id).not.toContain("[42]");
        // The badge is raised so the timeline does not present the text as verbatim.
        expect(row.redacted, row.id).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("repairs every display field from v17, keeps every row, and is idempotent", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 17);
    try {
      seedEveryDisplayField(db);
      insertEscapedActivity(db, "act_long_key", V17_LONG_KEY);
      const before = apiVisibleText(db);
      for (const secret of SECRETS) expect(before, secret).toContain(secret);
      expect(before).toContain(SUFFIX_LIVE);

      runMigrations(db, "test");

      const after = apiVisibleText(db);
      for (const secret of SECRETS) expect(after, secret).not.toContain(secret);
      expect(after).not.toContain(SUFFIX_LIVE);

      // No row is deleted, and re-running the data step changes nothing.
      const counts = rowCounts(db);
      expect(reprocessPersistedRedactionV18(db)).toBe(0);
      expect(apiVisibleText(db)).toBe(after);
      expect(rowCounts(db)).toEqual(counts);
      expect(runMigrations(db, "test").applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects a database that recorded migration 18 under a different data-step identity", () => {
    const dir = makeTempDir();
    const db = createDatabaseAtVersion(`${dir}/upgrade.sqlite`, 18);
    try {
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 18").run(
        checksumOf({ ...V18!, dataStepVersion: 2 }),
      );
      expect(() => runMigrations(db, "test")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});
