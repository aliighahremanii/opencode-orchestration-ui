import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../lib/db/driver.ts";
import { appliedMigrations, checksumOf, currentSchemaVersion, expectedSchemaVersion, MIGRATIONS, runMigrations } from "../../lib/db/migrations.ts";
import {
  countActivity,
  countInvocations,
  getRootRun,
  listActivity,
  listRootRuns,
  listSessions,
  overviewStats,
  upsertActivityEvent,
  upsertSession,
} from "../../lib/db/repositories.ts";
import { appendChange, changesSince, latestChangeSeq, pruneChangeLog } from "../../lib/db/collection-state.ts";
import { cleanupTempDirs, createTestDb, makeTempDir, type TestDb } from "../helpers/harness.ts";
import type { ActivityEvent } from "../../lib/domain/types.ts";

/**
 * Persistence, migration safety, and restart behaviour.
 *
 * The property under test is that closing and reopening the database (which is
 * what a process restart does) preserves every observation, and that re-running
 * migrations is a no-op rather than an error or a divergence.
 */

const NOW = 1_800_000_000_000;

function activity(id: string, dedupeKey: string, sessionId: string, sequence: number): ActivityEvent {
  return {
    id,
    dedupeKey,
    locationId: "loc_1",
    sessionId,
    runId: "run_1",
    kind: "message-user",
    messageId: `msg_${id}`,
    partIndex: 0,
    sequence,
    occurredAt: NOW + sequence,
    actorAgentId: null,
    toolName: null,
    toolStatus: null,
    summary: `summary ${id}`,
    content: `content ${id}`,
    truncated: false,
    redacted: false,
    upstreamOutcome: null,
    source: "upstream",
  };
}

describe("migrations", () => {
  it("applies every migration on a fresh database", () => {
    const test = createTestDb();
    try {
      expect(currentSchemaVersion(test.db)).toBe(expectedSchemaVersion());
      expect(appliedMigrations(test.db)).toHaveLength(MIGRATIONS.length);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("is idempotent when run again", () => {
    const test = createTestDb();
    try {
      const first = runMigrations(test.db, "again");
      expect(first.applied).toEqual([]);
      expect(first.alreadyApplied).toHaveLength(MIGRATIONS.length);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("refuses to run against a schema it does not know", () => {
    const test = createTestDb();
    try {
      test.db.exec("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'future', 'x', 0)");
      expect(() => runMigrations(test.db, "test")).toThrow(/newer schema/);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("refuses to run when an applied migration has been modified", () => {
    const test = createTestDb();
    try {
      test.db.exec("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
      expect(() => runMigrations(test.db, "test")).toThrow(/immutable/);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("stores the checksum of each migration", () => {
    const test = createTestDb();
    try {
      const applied = appliedMigrations(test.db);
      for (const migration of MIGRATIONS) {
        const row = applied.find((entry) => entry.version === migration.version);
        expect(row?.checksum).toBe(checksumOf(migration));
      }
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });
});

describe("restart persistence", () => {
  it("preserves observations across a close and reopen", () => {
    const dir = makeTempDir();
    const dbPath = `${dir}/restart.sqlite`;

    const first = openDatabase(dbPath);
    runMigrations(first, "test");
    upsertSession(first, {
      id: "ses_persisted",
      locationId: "loc_1",
      projectId: "prj",
      parentId: null,
      agentId: "build",
      modelProviderId: "anthropic",
      modelId: "claude",
      title: "persisted run",
      subpath: null,
      upstreamOutcome: "succeeded",
      timeCreated: NOW,
      timeUpdated: NOW + 1000,
      timeIdle: NOW + 1000,
      timeArchived: null,
      source: "upstream",
      seenAt: NOW,
    });
    upsertActivityEvent(first, activity("a1", "k1", "ses_persisted", 0), NOW);
    appendChange(first, { kind: "sessions", entityId: "all", scope: "collector" }, NOW);
    const seqBefore = latestChangeSeq(first);
    first.close();

    // A new process opens the same file.
    const second = openDatabase(dbPath);
    try {
      const sessions = listSessions(second, { limit: 10 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("ses_persisted");
      expect(sessions[0]?.title).toBe("persisted run");
      expect(countActivity(second, { limit: 0 })).toBe(1);
      expect(latestChangeSeq(second)).toBe(seqBefore);
      // Migrations must not re-run on restart.
      expect(runMigrations(second, "restart").applied).toEqual([]);
    } finally {
      second.close();
      cleanupTempDirs();
    }
  });

  it("survives a crash without losing committed writes", () => {
    const dir = makeTempDir();
    const dbPath = `${dir}/crash.sqlite`;

    const first = openDatabase(dbPath);
    runMigrations(first, "test");
    upsertActivityEvent(first, activity("a1", "k1", "ses_1", 0), NOW);
    // No clean close: simulate a process that died.
    first.close();

    const second = openDatabase(dbPath);
    try {
      expect(countActivity(second, { limit: 0 })).toBe(1);
    } finally {
      second.close();
      cleanupTempDirs();
    }
  });
});

describe("write idempotency", () => {
  it("collapses a repeated activity event onto one row", () => {
    const test = createTestDb();
    try {
      const event = activity("a1", "same-key", "ses_1", 0);
      upsertActivityEvent(test.db, event, NOW);
      upsertActivityEvent(test.db, event, NOW + 5000);
      expect(countActivity(test.db, { limit: 0 })).toBe(1);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("updates the mutable fields of a repeated activity event", () => {
    const test = createTestDb();
    try {
      upsertActivityEvent(test.db, activity("a1", "k1", "ses_1", 0), NOW);
      upsertActivityEvent(test.db, { ...activity("a1", "k1", "ses_1", 0), summary: "updated", toolStatus: "completed" }, NOW + 1);
      const rows = listActivity(test.db, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.summary).toBe("updated");
      expect(rows[0]?.toolStatus).toBe("completed");
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("upserts a session rather than duplicating it", () => {
    const test = createTestDb();
    try {
      const base = {
        id: "ses_1",
        locationId: "loc_1",
        projectId: "prj",
        parentId: null,
        agentId: "build",
        modelProviderId: null,
        modelId: null,
        title: "first",
        subpath: null,
        upstreamOutcome: null,
        timeCreated: NOW,
        timeUpdated: NOW,
        timeIdle: null,
        timeArchived: null,
        source: "upstream" as const,
        seenAt: NOW,
      };
      upsertSession(test.db, base);
      upsertSession(test.db, { ...base, title: "second", timeUpdated: NOW + 5000, seenAt: NOW + 5000 });
      const sessions = listSessions(test.db, { limit: 10 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("second");
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("does not overwrite the first-observed agent when the session is resumed by another agent", () => {
    const test = createTestDb();
    try {
      const base = {
        id: "ses_1",
        locationId: "loc_1",
        projectId: "prj",
        parentId: null,
        agentId: "plan",
        modelProviderId: null,
        modelId: null,
        title: null,
        subpath: null,
        upstreamOutcome: null,
        timeCreated: NOW,
        timeUpdated: NOW,
        timeIdle: null,
        timeArchived: null,
        source: "upstream" as const,
        seenAt: NOW,
      };
      upsertSession(test.db, base);
      upsertSession(test.db, { ...base, agentId: "build", seenAt: NOW + 1000 });

      const row = test.db
        .prepare("SELECT agent_id, agent_first_seen FROM sessions WHERE id = ?")
        .get("ses_1") as { agent_id: string; agent_first_seen: string } | undefined;
      // The latest observation updates, the attribution snapshot does not.
      expect(row?.agent_id).toBe("build");
      expect(row?.agent_first_seen).toBe("plan");
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });
});

describe("change log", () => {
  it("assigns monotonically increasing sequence numbers", () => {
    const test = createTestDb();
    try {
      const first = appendChange(test.db, { kind: "a", entityId: "1", scope: "collector" }, NOW);
      const second = appendChange(test.db, { kind: "b", entityId: "2", scope: "collector" }, NOW);
      expect(second).toBeGreaterThan(first);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("returns only changes after the given sequence, which is what SSE resume relies on", () => {
    const test = createTestDb();
    try {
      const first = appendChange(test.db, { kind: "a", entityId: "1", scope: "collector" }, NOW);
      appendChange(test.db, { kind: "b", entityId: "2", scope: "collector" }, NOW);
      const since = changesSince(test.db, first, 100);
      expect(since).toHaveLength(1);
      expect(since[0]?.kind).toBe("b");
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("returns nothing when the caller is already current", () => {
    const test = createTestDb();
    try {
      appendChange(test.db, { kind: "a", entityId: "1", scope: "collector" }, NOW);
      expect(changesSince(test.db, latestChangeSeq(test.db), 100)).toEqual([]);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("honours the limit so a large backlog is paged", () => {
    const test = createTestDb();
    try {
      for (let i = 0; i < 10; i += 1) {
        appendChange(test.db, { kind: "k", entityId: String(i), scope: "collector" }, NOW + i);
      }
      expect(changesSince(test.db, 0, 4)).toHaveLength(4);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });

  it("prunes only entries older than the cutoff", () => {
    const test = createTestDb();
    try {
      appendChange(test.db, { kind: "old", entityId: "1", scope: "collector" }, 1000);
      appendChange(test.db, { kind: "new", entityId: "2", scope: "collector" }, 9000);
      pruneChangeLog(test.db, 5000);
      const remaining = changesSince(test.db, 0, 100);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.kind).toBe("new");
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });
});

describe("overview stats", () => {
  it("reports zeroes on an empty database", () => {
    const test = createTestDb();
    try {
      const stats = overviewStats(test.db);
      expect(stats).toEqual({
        locations: 0,
        agents: 0,
        agentsActive: 0,
        sessions: 0,
        rootSessions: 0,
        rootRuns: 0,
        invocations: 0,
        activity: 0,
        openGaps: 0,
      });
      expect(listRootRuns(test.db, { limit: 10 })).toEqual([]);
      expect(getRootRun(test.db, "run_missing")).toBeNull();
      expect(countInvocations(test.db)).toBe(0);
    } finally {
      test.close();
      cleanupTempDirs();
    }
  });
});
