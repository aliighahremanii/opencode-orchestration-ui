import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTOR_SCOPE,
  acquireLease,
  getCollectorState,
  getLease,
  listCheckpoints,
  listWarnings,
  LeaseLostError,
  recordWarning,
  renewLease,
  setCollectorState,
  withFence,
} from "../../lib/db/collection-state.ts";
import {
  countActiveAgents,
  countInvocationsForRun,
  getRootRun,
  getRootRunForSession,
  listAgents,
  listActivity,
  listGaps,
  listInvocations,
  listLocations,
  listOpenGaps,
  listRootRuns,
  listRunSessions,
  openGap,
  overviewStats,
  recordGap,
  upsertActivityEvent,
  upsertAgent,
  upsertLocation,
} from "../../lib/db/repositories.ts";
import { gapIdFor, locationIdFor, runCycle } from "../../lib/collector/collector.ts";
import { normalizeSessionActivity, runIdFor } from "../../lib/collector/normalize.ts";
import {
  collectorHealth,
  toActivityItem,
  toAgentItem,
  toGapItem,
  toLocationItem,
  toWarningItem,
} from "../../lib/http/dto.ts";
import { currentSchemaVersion } from "../../lib/db/migrations.ts";
import { deterministicId } from "../../lib/util/ids.ts";
import { cleanupTempDirs, configureTestEnv, createTestDb, type TestDb } from "../helpers/harness.ts";
import { validateMessagesResponse } from "../../lib/upstream/schema.ts";
import type {
  UpstreamAgentInfo,
  UpstreamLocationInfo,
  UpstreamMessage,
  UpstreamServerInfo,
  UpstreamSessionInfo,
} from "../../lib/upstream/schema.ts";
import type { AgentList, MessagePage, SessionPage, UpstreamSource } from "../../lib/upstream/source.ts";
import { getConfig } from "../../lib/config.ts";

/**
 * Regression tests for the review findings.
 *
 * Each block names the defect it pins down, so a future change that reintroduces
 * the behaviour fails here rather than in production.
 */

const NOW = 1_800_000_000_000;

const LOCATION: UpstreamLocationInfo = {
  directory: "/srv/demo",
  projectId: "prj_1",
  projectDirectory: "/srv/demo",
  canonical: "/srv/demo",
};

const SERVER_INFO: UpstreamServerInfo = { version: "2.0.28", pid: 1, urls: [], tmpPath: "/tmp" };

function agent(id: string): UpstreamAgentInfo {
  return { id, name: id, mode: "primary", hidden: false, description: null, modelProviderId: null, modelId: null };
}

function session(overrides: Partial<UpstreamSessionInfo> & { id: string }): UpstreamSessionInfo {
  return {
    parentId: null,
    projectId: "prj_1",
    agentId: null,
    modelProviderId: null,
    modelId: null,
    title: null,
    subpath: null,
    outcome: null,
    timeCreated: NOW,
    timeUpdated: NOW,
    timeIdle: null,
    timeArchived: null,
    locationDirectory: "/srv/demo",
    ...overrides,
  };
}

function userMessage(id: string, created: number, text = "hello"): UpstreamMessage {
  return { type: "user", id, created, text };
}

type TestToolPart = {
  kind: "tool";
  id: string;
  name: string;
  status: "streaming" | "running" | "completed" | "error";
  inputSummary: string;
  outputSummary: string | null;
  errorMessage: string | null;
  created: number;
  completed: number | null;
  /** Provenance from schema preprocessing; see `UpstreamAssistantTool.redacted`. */
  redacted: boolean;
};
type TestPart = { kind: "text"; text: string } | TestToolPart;

function assistantMessage(
  id: string,
  created: number,
  agentId: string | null,
  parts: readonly TestPart[] = [],
): UpstreamMessage {
  return {
    type: "assistant",
    id,
    created,
    completed: created + 1000,
    agentId,
    modelProviderId: "anthropic",
    modelId: "claude",
    parts,
    finish: "stop",
    errorMessage: null,
  };
}

function toolPart(id: string, name: string, inputSummary: string): TestToolPart {
  return {
    kind: "tool",
    id,
    name,
    status: "completed",
    inputSummary,
    outputSummary: "ok",
    errorMessage: null,
    created: 0,
    completed: 1000,
    redacted: false,
  };
}

/** A source whose every response is settable, with optional per-call latency. */
class ScriptedSource implements UpstreamSource {
  readonly kind: "fixture" | "live";
  description = "scripted test source";
  sessions: UpstreamSessionInfo[] = [];
  agents: UpstreamAgentInfo[] = [];
  locations: UpstreamLocationInfo[] = [LOCATION];
  messages = new Map<string, { messages: UpstreamMessage[]; nextCursor: string | null }>();
  /** Message types the source reports as unrecognised, surfaced as warnings. */
  unknownTypes: string[] = [];
  delayMs = 0;
  failWith: Error | null = null;
  /** Invoked on every source call, for simulating an event mid-cycle. */
  onCall: (() => void) | null = null;

  constructor(kind: "fixture" | "live" = "fixture") {
    this.kind = kind;
  }

  private async wait(): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.onCall?.();
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async getServerInfo(): Promise<UpstreamServerInfo> {
    await this.wait();
    return SERVER_INFO;
  }

  async listLocations(): Promise<readonly UpstreamLocationInfo[]> {
    await this.wait();
    return this.locations;
  }

  async listAgents(): Promise<AgentList> {
    await this.wait();
    return { location: { directory: LOCATION.directory }, agents: this.agents };
  }

  async listSessions(): Promise<SessionPage> {
    await this.wait();
    const limit = getConfig().collector.sessionPageLimit;
    return { sessions: this.sessions.slice(0, limit), nextCursor: this.sessions.length > limit ? "sessions:more" : null };
  }

  async listMessages(params: { sessionId: string }): Promise<MessagePage> {
    await this.wait();
    const entry = this.messages.get(params.sessionId);
    if (entry === undefined) return { messages: [], nextCursor: null, unknownTypes: this.unknownTypes };
    return { messages: entry.messages, nextCursor: entry.nextCursor, unknownTypes: this.unknownTypes };
  }
}

let test: TestDb;
let source: ScriptedSource;

function makeDeps() {
  return {
    db: test.db,
    source,
    config: getConfig().collector,
    now: () => Date.now(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(() => {
  configureTestEnv({
    ORCH_UPSTREAM_MODE: "fixture",
    ORCH_LEASE_TTL_MS: "30000",
    ORCH_POLL_INTERVAL_MS: "1000",
  });
  test = createTestDb();
  source = new ScriptedSource();
});

afterEach(() => {
  test.close();
  cleanupTempDirs();
  configureTestEnv();
});

// ---------------------------------------------------------------------------
// HIGH 2: a bounded session list must not delete historic root identities
// ---------------------------------------------------------------------------

describe("HIGH 2 — bounded fetch preserves older roots and ancestry", () => {
  it("keeps a run whose root has fallen outside the current fetch window", async () => {
    configureTestEnv({ ORCH_HISTORY_MAX_SESSIONS: "2", ORCH_SESSION_PAGE_LIMIT: "2" });
    test.close();
    test = createTestDb();
    source = new ScriptedSource();

    source.agents = [agent("build")];
    source.messages.set("ses_root", { messages: [userMessage("msg_root_1", NOW)], nextCursor: null });
    source.messages.set("ses_child", { messages: [userMessage("msg_child_1", NOW + 1000)], nextCursor: null });
    source.messages.set("ses_new", { messages: [userMessage("msg_new_1", NOW + 2000)], nextCursor: null });

    // Cycle 1: the window (newest two) covers the root and its child, so both are
    // observed and stored.
    source.sessions = [
      session({ id: "ses_child", parentId: "ses_root", timeUpdated: NOW + 1000 }),
      session({ id: "ses_root", timeUpdated: NOW }),
    ];
    const first = await runCycle(makeDeps(), "c1");
    expect(first?.ok).toBe(true);
    expect(getRootRunForSession(test.db, "ses_root")).not.toBeNull();

    // Cycle 2: a newer session appears, pushing `ses_root` out of the window.
    // It is still stored, so its run identity and ancestry must survive.
    source.sessions = [
      session({ id: "ses_new", timeUpdated: NOW + 2000 }),
      session({ id: "ses_child", parentId: "ses_root", timeUpdated: NOW + 1000 }),
      session({ id: "ses_root", timeUpdated: NOW }),
    ];
    const second = await runCycle(makeDeps(), "c1");
    expect(second?.ok).toBe(true);
    // The window really did exclude the root.
    expect(second?.sessions).toBe(2);

    const rootRun = getRootRunForSession(test.db, "ses_root");
    expect(rootRun).not.toBeNull();
    expect(rootRun?.rootSessionId).toBe("ses_root");

    const members = listRunSessions(test.db, rootRun!.id);
    const ids = members.map((member) => member.session.id).sort();
    expect(ids).toEqual(["ses_child", "ses_root"]);

    // And it must still be listed as a run.
    expect(listRootRuns(test.db, { limit: 50 }).map((run) => run.rootSessionId)).toContain("ses_root");
  });

  it("preserves the run forest across a window that changes completely", async () => {
    configureTestEnv({ ORCH_HISTORY_MAX_SESSIONS: "1", ORCH_SESSION_PAGE_LIMIT: "1" });
    test.close();
    test = createTestDb();
    source = new ScriptedSource();

    source.sessions = [session({ id: "ses_old", timeUpdated: NOW })];
    source.messages.set("ses_old", { messages: [userMessage("msg_old_1", NOW)], nextCursor: null });
    await runCycle(makeDeps(), "c1");
    const oldRunId = getRootRunForSession(test.db, "ses_old")?.id;
    expect(oldRunId).toBeDefined();

    // A later cycle sees only a brand-new session; the old one is no longer in
    // the window but is still stored.
    source.sessions = [session({ id: "ses_brand_new", timeUpdated: NOW + 10_000 })];
    source.messages.set("ses_brand_new", { messages: [userMessage("msg_new_1", NOW + 10_000)], nextCursor: null });
    await runCycle(makeDeps(), "c1");

    expect(getRootRunForSession(test.db, "ses_old")?.id).toBe(oldRunId);
    expect(getRootRunForSession(test.db, "ses_brand_new")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HIGH 3: partial transcript pagination must not be destructive
// ---------------------------------------------------------------------------

describe("HIGH 3 — a partial transcript preserves unseen rows", () => {
  it("keeps existing activity and marks the checkpoint partial when the bound is hit", async () => {
    configureTestEnv({ ORCH_HISTORY_MAX_SESSIONS: "1", ORCH_MESSAGE_PAGE_LIMIT: "1" });
    test.close();
    test = createTestDb();
    source = new ScriptedSource();

    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];

    // Cycle 1: a complete snapshot.
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW), userMessage("msg_2", NOW + 1)], nextCursor: null });
    await runCycle(makeDeps(), "c1");
    const completeCount = listActivity(test.db, { sessionId: "ses_a", limit: 100 }).length;
    expect(completeCount).toBe(2);
    expect(listCheckpoints(test.db).find((c) => c.stream === "messages:ses_a")?.partial).toBe(false);

    // Cycle 2: upstream now reports more history, so the bound is hit.
    source.messages.set("ses_a", { messages: [userMessage("msg_3", NOW + 2)], nextCursor: "messages:9" });
    const result = await runCycle(makeDeps(), "c1");
    expect(result?.partialTranscripts).toBe(1);

    // The earlier rows must NOT have been deleted.
    const afterPartial = listActivity(test.db, { sessionId: "ses_a", limit: 100 });
    expect(afterPartial.length).toBe(3);
    expect(afterPartial.map((event) => event.messageId).sort()).toEqual(["msg_1", "msg_2", "msg_3"]);

    const checkpoint = listCheckpoints(test.db).find((c) => c.stream === "messages:ses_a");
    expect(checkpoint?.partial).toBe(true);
    // The cursor to continue from is preserved rather than nulled.
    expect(checkpoint?.cursor).toBe("messages:9");

    // Cycle 3: a complete snapshot replaces the activity as before.
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW), userMessage("msg_2", NOW + 1), userMessage("msg_3", NOW + 2)], nextCursor: null });
    await runCycle(makeDeps(), "c1");
    expect(listActivity(test.db, { sessionId: "ses_a", limit: 100 }).length).toBe(3);
    const finalCheckpoint = listCheckpoints(test.db).find((c) => c.stream === "messages:ses_a");
    expect(finalCheckpoint?.partial).toBe(false);
    expect(finalCheckpoint?.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HIGH 5: the lease must be maintained through a long cycle
// ---------------------------------------------------------------------------

describe("HIGH 5 — the lease is heartbeated through a long cycle", () => {
  it("does not let a competing collector take over a cycle that outlasts the TTL", async () => {
    // 2000 ms is the documented minimum TTL. Five source calls at 500 ms each
    // make the cycle outlast it.
    configureTestEnv({ ORCH_LEASE_TTL_MS: "2000", ORCH_POLL_INTERVAL_MS: "500" });
    test.close();
    test = createTestDb();
    source = new ScriptedSource();

    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });
    source.delayMs = 500;

    const cycle = runCycle(makeDeps(), "slow-holder");

    // Wait past the original TTL while the cycle is still running.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(getLease(test.db, COLLECTOR_SCOPE)?.holderId).toBe("slow-holder");

    // A rival must be refused: the heartbeat kept the lease alive. Without it the
    // lease would have expired at 2000 ms and this would succeed.
    expect(acquireLease(test.db, COLLECTOR_SCOPE, "rival", 2000, Date.now())).toBeNull();

    const result = await cycle;
    expect(result?.ok).toBe(true);
    expect(getLease(test.db, COLLECTOR_SCOPE)?.holderId).toBe("slow-holder");
    // The epoch never advanced, so no fencing event occurred mid-cycle.
    expect(getLease(test.db, COLLECTOR_SCOPE)?.epoch).toBe(1);
  }, 30_000);

  it("reports a lost lease rather than renewing silently", () => {
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "a", 900, Date.now());
    expect(handle).not.toBeNull();
    // A handle from a superseded epoch cannot renew.
    const stale = { scope: COLLECTOR_SCOPE, holderId: "a", epoch: (handle?.epoch ?? 1) + 5, ttlMs: 900 };
    expect(renewLease(test.db, stale, Date.now())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HIGH 6: collector metadata writes are fenced
// ---------------------------------------------------------------------------

describe("HIGH 6 — a stale collector cannot overwrite current metadata", () => {
  it("refuses a fenced state write once another collector owns the lease", () => {
    // Collector A holds the lease, then loses it to B.
    const stale = acquireLease(test.db, COLLECTOR_SCOPE, "A", 900, 1000);
    expect(stale).not.toBeNull();

    const takeover = acquireLease(test.db, COLLECTOR_SCOPE, "B", 900, 1000 + 900 + 1);
    expect(takeover?.epoch).toBe(2);

    // B records a healthy state.
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: "B",
      epoch: 2,
      lastCycleAt: 5000,
      lastCycleOk: true,
      lastError: null,
      updatedAt: 5000,
      lastSuccessAt: 5000,
    });

    // A tries to stamp its stale error over B's state. The fence must refuse it.
    expect(() =>
      withFence(test.db, stale!, 5001, () => {
        setCollectorState(test.db, {
          scope: COLLECTOR_SCOPE,
          holderId: "A",
          epoch: 1,
          lastCycleAt: 5001,
          lastCycleOk: false,
          lastError: "stale collector error",
          updatedAt: 5001,
        });
      }),
    ).toThrow(LeaseLostError);

    // B's state is intact: no stale error, no epoch regression.
    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.holderId).toBe("B");
    expect(state?.epoch).toBe(2);
    expect(state?.lastCycleOk).toBe(true);
    expect(state?.lastError).toBeNull();
    expect(state?.lastSuccessAt).toBe(5000);
  });

  it("does not let a stale collector overwrite a checkpoint", () => {
    const stale = acquireLease(test.db, COLLECTOR_SCOPE, "A", 900, 1000);
    acquireLease(test.db, COLLECTOR_SCOPE, "B", 900, 1000 + 900 + 1);

    expect(() =>
      withFence(test.db, stale!, 5001, () => {
        test.db
          .prepare(
            "INSERT INTO collector_checkpoints (scope, stream, cursor, last_seen_at, updated_at, partial) VALUES (?, ?, ?, ?, ?, 0)",
          )
          .run(COLLECTOR_SCOPE, "messages:ses_x", "stale-cursor", 1, 5001);
      }),
    ).toThrow(LeaseLostError);

    expect(listCheckpoints(test.db).some((checkpoint) => checkpoint.stream === "messages:ses_x")).toBe(false);
  });

  it("does not record a failure from a collector that lost the lease mid-cycle", async () => {
    // A rival seizes the lease while this cycle is running, as an expired-lease
    // takeover would. The cycle then fails, and its failure state must not be
    // written over the owner's record.
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });
    let seized = false;
    source.onCall = () => {
      if (seized) return;
      seized = true;
      test.db
        .prepare(
          "UPDATE collector_leases SET holder_id = 'rival', epoch = epoch + 1, expires_at = ? WHERE scope = ?",
        )
        .run(Date.now() + 600_000, COLLECTOR_SCOPE);
    };

    const result = await runCycle(makeDeps(), "original");
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);

    // The lease now belongs to the rival.
    expect(getLease(test.db, COLLECTOR_SCOPE)?.holderId).toBe("rival");

    // The stale failure was refused: the pre-cycle state is unchanged, so no
    // `lastCycleOk: false` and no stale error were stamped over it.
    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.holderId).toBe("original");
    expect(state?.lastCycleOk).toBeNull();
    expect(state?.lastError).toBeNull();
  });

  it("stands by instead of writing when another collector holds a live lease", async () => {
    acquireLease(test.db, COLLECTOR_SCOPE, "owner", 60_000, Date.now());
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: "owner",
      epoch: 1,
      lastCycleAt: 1000,
      lastCycleOk: true,
      lastError: null,
      updatedAt: 1000,
      lastSuccessAt: 1000,
    });

    source.sessions = [session({ id: "ses_a" })];
    const result = await runCycle(makeDeps(), "interloper");

    expect(result).toBeNull();
    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.holderId).toBe("owner");
    expect(state?.lastCycleAt).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// HIGH 7: gaps open on failure and resume only after success
// ---------------------------------------------------------------------------

describe("HIGH 7 — a gap stays open across failures and closes only on success", () => {
  it("opens a gap on the first failure and closes it after a successful cycle", async () => {
    source.failWith = new Error("upstream is down");

    const failed = await runCycle(makeDeps(), "c1");
    expect(failed?.ok).toBe(false);

    // The outage is visible immediately, not only once it exceeds the tolerance.
    const open = listOpenGaps(test.db, COLLECTOR_SCOPE);
    expect(open).toHaveLength(1);
    expect(open[0]?.resumed).toBe(false);
    expect(open[0]?.open).toBe(true);
    expect(open[0]?.reason).toContain("upstream is down");
    expect(open[0]?.endedAt).toBeNull();
    expect(overviewStats(test.db).openGaps).toBe(1);

    // A second failure re-asserts the same gap rather than adding another.
    await runCycle(makeDeps(), "c1");
    expect(listOpenGaps(test.db, COLLECTOR_SCOPE)).toHaveLength(1);
    expect(listGaps(test.db, 50).filter((gap) => gap.open)).toHaveLength(1);

    // The failure must not erase the record of the last success.
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastCycleOk).toBe(false);

    // Success closes it.
    source.failWith = null;
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });

    const succeeded = await runCycle(makeDeps(), "c1");
    expect(succeeded?.ok).toBe(true);
    expect(listOpenGaps(test.db, COLLECTOR_SCOPE)).toHaveLength(0);

    const closed = listGaps(test.db, 50).find((gap) => gap.stream === "cycle");
    expect(closed?.open).toBe(false);
    expect(closed?.resumed).toBe(true);
    expect(closed?.endedAt).not.toBeNull();
    expect(overviewStats(test.db).openGaps).toBe(0);
  });

  it("does not mark a gap resumed before a successful cycle", async () => {
    source.failWith = new Error("still down");
    await runCycle(makeDeps(), "c1");
    await runCycle(makeDeps(), "c1");

    for (const gap of listGaps(test.db, 50)) {
      if (gap.stream === "cycle") {
        expect(gap.resumed).toBe(false);
        expect(gap.open).toBe(true);
      }
    }
  });

  it("measures the pause from the last success, not the last attempt", async () => {
    // A successful cycle records a success point.
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });
    await runCycle(makeDeps(), "c1");
    const successAt = getCollectorState(test.db, COLLECTOR_SCOPE)?.lastSuccessAt;
    expect(successAt).not.toBeNull();

    // Fail repeatedly. `lastCycleAt` moves forward each time, but the success
    // point must not, or a sustained outage would never be recorded.
    source.failWith = new Error("down");
    await runCycle(makeDeps(), "c1");
    await runCycle(makeDeps(), "c1");

    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    // The success point must not move, however many attempts follow it.
    expect(state?.lastSuccessAt).toBe(successAt);
    expect(state?.lastCycleAt).toBeGreaterThanOrEqual(successAt!);
    expect(state?.lastCycleOk).toBe(false);
    expect(listOpenGaps(test.db, COLLECTOR_SCOPE)).toHaveLength(1);
  });

  it("closes gaps only after a cycle succeeds", async () => {
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "c1", 60_000, Date.now());
    expect(handle).not.toBeNull();

    // Open a gap directly, as the failure path does.
    const { openGap } = await import("../../lib/db/repositories.ts");
    withFence(test.db, handle!, Date.now(), () => {
      openGap(test.db, {
        id: "gap_test",
        scope: COLLECTOR_SCOPE,
        stream: "cycle",
        startedAt: 1000,
        reason: "test",
        detectedAt: 1000,
      });
    });
    expect(listOpenGaps(test.db, COLLECTOR_SCOPE)).toHaveLength(1);

    // A failing cycle must leave it open.
    source.failWith = new Error("down");
    await runCycle(makeDeps(), "c1");
    expect(listOpenGaps(test.db, COLLECTOR_SCOPE).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HIGH 8: agent membership is reconciled on a successful snapshot
// ---------------------------------------------------------------------------

describe("HIGH 8 — an agent the API stops reporting is no longer effective", () => {
  it("marks a removed agent inactive while retaining it as history", async () => {
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build"), agent("retired")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });

    await runCycle(makeDeps(), "c1");
    expect(listAgents(test.db).every((entry) => entry.active)).toBe(true);
    expect(countActiveAgents(test.db)).toBe(2);

    // The API stops reporting `retired`.
    source.agents = [agent("build")];
    await runCycle(makeDeps(), "c1");

    const agents = listAgents(test.db);
    expect(agents).toHaveLength(2);
    const retired = agents.find((entry) => entry.agentId === "retired");
    expect(retired).toBeDefined();
    expect(retired?.active).toBe(false);
    // The row is retained, not deleted, so its history survives.
    expect(agents.find((entry) => entry.agentId === "build")?.active).toBe(true);
    expect(countActiveAgents(test.db)).toBe(1);
    expect(overviewStats(test.db).agentsActive).toBe(1);
    expect(overviewStats(test.db).agents).toBe(2);
  });

  it("reactivates an agent that the API reports again", async () => {
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build"), agent("flaky")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });

    await runCycle(makeDeps(), "c1");
    source.agents = [agent("build")];
    await runCycle(makeDeps(), "c1");
    expect(listAgents(test.db).find((entry) => entry.agentId === "flaky")?.active).toBe(false);

    source.agents = [agent("build"), agent("flaky")];
    await runCycle(makeDeps(), "c1");
    expect(listAgents(test.db).find((entry) => entry.agentId === "flaky")?.active).toBe(true);
  });

  it("does not deactivate every agent when the snapshot is empty", async () => {
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });
    await runCycle(makeDeps(), "c1");

    // An empty snapshot is a real statement: nothing is currently effective.
    source.agents = [];
    await runCycle(makeDeps(), "c1");
    expect(countActiveAgents(test.db)).toBe(0);
    expect(listAgents(test.db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM 12: collector liveness is reported from the lease
// ---------------------------------------------------------------------------

describe("MEDIUM 12 — collector health reflects the lease, not a stale state row", () => {
  it("reports never-started with no lease and no state", () => {
    expect(collectorHealth(test.db, Date.now()).state).toBe("never-started");
  });

  it("reports running while a live lease is held", () => {
    acquireLease(test.db, COLLECTOR_SCOPE, "a", 60_000, Date.now());
    expect(collectorHealth(test.db, Date.now()).state).toBe("running");
  });

  it("reports stale when the lease has expired", () => {
    acquireLease(test.db, COLLECTOR_SCOPE, "a", 1000, 1000);
    expect(collectorHealth(test.db, 1000 + 1001).state).toBe("stale");
  });

  it("reports stopped when no lease is held but a cycle was recorded", () => {
    // Regression: a state row with no lease used to be reported as `running`,
    // claiming liveness from a record that has no live owner.
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: "a",
      epoch: 1,
      lastCycleAt: 1000,
      lastCycleOk: true,
      lastError: null,
      updatedAt: 1000,
      lastSuccessAt: 1000,
    });
    const health = collectorHealth(test.db, 5000);
    expect(health.state).toBe("stopped");
    expect(health.leaseExpiresAt).toBeNull();
    expect(health.lastSuccessAt).toBe(1000);
  });

  it("reports stopped after a clean shutdown releases the lease", async () => {
    source.sessions = [session({ id: "ses_a" })];
    source.agents = [agent("build")];
    source.messages.set("ses_a", { messages: [userMessage("msg_1", NOW)], nextCursor: null });

    await runCycle(makeDeps(), "c1", { releaseWhenDone: true });
    expect(getLease(test.db, COLLECTOR_SCOPE)).toBeNull();
    expect(collectorHealth(test.db, Date.now()).state).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// HIGH 1: camelCase secret keys must be redacted before they are persisted
// ---------------------------------------------------------------------------

describe("HIGH 1 — camelCase secret keys never reach storage or the API", () => {
  const ACCESS = "opaque-access-token-000111222333";
  const CLIENT = "opaque-client-secret-444555666777";

  it("redacts a camelCase secret at the normalization stage", () => {
    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_sec",
      runId: runIdFor(locationId, "ses_sec"),
      source: "upstream",
      contentMaxChars: 2000,
      ingestedAt: NOW,
      messages: [
        userMessage("msg_u1", NOW, `please use {"accessToken":"${ACCESS}"}`),
        assistantMessage("msg_a1", NOW + 1000, "build", [toolPart("tool_1", "bash", `{"clientSecret":"${CLIENT}"}`)]),
      ],
    });
    const text = JSON.stringify(normalized);
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(CLIENT);
    expect(text).toContain("[redacted]");
  });

  it("never persists or serves a camelCase secret through the collector", async () => {
    source.sessions = [session({ id: "ses_sec" })];
    source.agents = [
      { id: "build", name: "build", mode: "primary", hidden: false, description: `registry config {"clientSecret":"${CLIENT}"}`, modelProviderId: null, modelId: null },
    ];
    source.messages.set("ses_sec", {
      messages: [
        userMessage("msg_u1", NOW, `please use {"accessToken":"${ACCESS}"}`),
        assistantMessage("msg_a1", NOW + 1000, "build", [toolPart("tool_1", "bash", `{"clientSecret":"${CLIENT}"}`)]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    // 1. Raw database: nothing credential-shaped is stored anywhere.
    const activityRows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joinedActivity = activityRows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(joinedActivity).not.toContain(ACCESS);
    expect(joinedActivity).not.toContain(CLIENT);
    expect(joinedActivity).toContain("[redacted]");

    const agentRow = test.db.prepare("SELECT description FROM agents WHERE agent_id = 'build'").get() as {
      description: string | null;
    };
    expect(agentRow.description ?? "").not.toContain(CLIENT);

    // 2. Read model: the repository returns the redacted form.
    const stored = listActivity(test.db, { sessionId: "ses_sec", limit: 100 });
    for (const event of stored) {
      expect(`${event.summary}\n${event.content ?? ""}`).not.toContain(ACCESS);
      expect(`${event.summary}\n${event.content ?? ""}`).not.toContain(CLIENT);
    }

    // 3. API output: the DTO the browser receives carries no secret either.
    for (const item of stored.map(toActivityItem)) {
      expect(`${item.summary}\n${item.content ?? ""}`).not.toContain(ACCESS);
      expect(`${item.summary}\n${item.content ?? ""}`).not.toContain(CLIENT);
    }
    expect(JSON.stringify(stored.map(toActivityItem))).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// HIGH 2: a rebuilt hierarchy must repoint retained activity and invocations
// ---------------------------------------------------------------------------

describe("HIGH 2 — retained run references follow a rebuilt hierarchy", () => {
  it("repoints a child observed later, even when it is outside the fetch window", async () => {
    // Regression: a child first observed without its parent became its own orphan
    // root. When the parent was later observed, the orphan run was deleted but the
    // child's stored activity and invocations still carried the deleted run's id,
    // so they vanished from the run detail page, timeline and counts.
    configureTestEnv({ ORCH_HISTORY_MAX_SESSIONS: "1", ORCH_SESSION_PAGE_LIMIT: "1" });
    test.close();
    test = createTestDb();
    source = new ScriptedSource();

    const locationId = locationIdFor("/srv/demo");
    const orphanRunId = runIdFor(locationId, "ses_c");
    const parentRunId = runIdFor(locationId, "ses_p");

    source.agents = [agent("build")];
    source.messages.set("ses_c", {
      messages: [userMessage("msg_c_u1", NOW + 1000, "child work"), assistantMessage("msg_c_a1", NOW + 2000, "build")],
      nextCursor: null,
    });

    // Cycle 1: only the child is in the window, and its parent has not been seen.
    source.sessions = [session({ id: "ses_c", parentId: "ses_p", timeUpdated: NOW + 2000 })];
    const first = await runCycle(makeDeps(), "c1");
    expect(first?.ok).toBe(true);
    expect(getRootRunForSession(test.db, "ses_c")?.id).toBe(orphanRunId);
    expect(listActivity(test.db, { sessionId: "ses_c", limit: 100 })).toHaveLength(2);
    expect(countInvocationsForRun(test.db, orphanRunId)).toBe(1);

    // Cycle 2: the parent appears. The window holds only the parent, so the
    // child's transcript is not re-fetched at all.
    source.sessions = [session({ id: "ses_p", timeUpdated: NOW })];
    const second = await runCycle(makeDeps(), "c1");
    expect(second?.ok).toBe(true);

    // The orphan run is gone; the child now belongs to the parent's run.
    expect(getRootRun(test.db, orphanRunId)).toBeNull();
    expect(getRootRunForSession(test.db, "ses_c")?.id).toBe(parentRunId);
    expect(listRunSessions(test.db, parentRunId).map((member) => member.session.id).sort()).toEqual(["ses_c", "ses_p"]);

    // The child's retained records followed it: run detail, timeline and counts
    // include them.
    const runActivity = listActivity(test.db, { runId: parentRunId, limit: 100 });
    expect(runActivity).toHaveLength(2);
    expect(runActivity.every((event) => event.sessionId === "ses_c")).toBe(true);
    expect(countInvocationsForRun(test.db, parentRunId)).toBe(1);
    expect(listInvocations(test.db, { runId: parentRunId, limit: 100 }).map((invocation) => invocation.sessionId)).toEqual(["ses_c"]);

    // Nothing is left pointing at the deleted run.
    expect(listActivity(test.db, { runId: orphanRunId, limit: 100 })).toHaveLength(0);
    expect(listInvocations(test.db, { runId: orphanRunId, limit: 100 })).toHaveLength(0);
    // And the orphan run is no longer listed.
    expect(listRootRuns(test.db, { limit: 50 }).map((run) => run.id)).toEqual([parentRunId]);
  });

  it("repoints activity omitted from a partial transcript without recreating it", async () => {
    configureTestEnv({ ORCH_HISTORY_MAX_SESSIONS: "2", ORCH_SESSION_PAGE_LIMIT: "2", ORCH_MESSAGE_PAGE_LIMIT: "1" });
    test.close();
    test = createTestDb();
    source = new ScriptedSource();

    const locationId = locationIdFor("/srv/demo");
    const orphanRunId = runIdFor(locationId, "ses_c");
    const parentRunId = runIdFor(locationId, "ses_p");

    source.agents = [agent("build")];
    source.messages.set("ses_c", {
      messages: [
        userMessage("msg_c_u1", NOW + 1000),
        userMessage("msg_c_u2", NOW + 2000),
        assistantMessage("msg_c_a1", NOW + 3000, "build"),
      ],
      nextCursor: null,
    });

    // Cycle 1: the child alone, with a complete transcript.
    source.sessions = [session({ id: "ses_c", parentId: "ses_p", timeUpdated: NOW + 3000 })];
    await runCycle(makeDeps(), "c1");
    expect(getRootRunForSession(test.db, "ses_c")?.id).toBe(orphanRunId);
    expect(listActivity(test.db, { sessionId: "ses_c", limit: 100 })).toHaveLength(3);

    // Cycle 2: the parent appears, and the child's transcript is only partly paged,
    // so its earlier rows are preserved rather than replaced.
    source.sessions = [
      session({ id: "ses_p", timeUpdated: NOW }),
      session({ id: "ses_c", parentId: "ses_p", timeUpdated: NOW + 3000 }),
    ];
    source.messages.set("ses_c", { messages: [userMessage("msg_c_u1", NOW + 1000)], nextCursor: "messages:more" });
    const second = await runCycle(makeDeps(), "c1");
    expect(second?.partialTranscripts).toBe(1);

    // All three retained rows survived, and every one of them was repointed — the
    // rows the partial fetch did not reach included.
    const activity = listActivity(test.db, { sessionId: "ses_c", limit: 100 });
    expect(activity).toHaveLength(3);
    expect(activity.every((event) => event.runId === parentRunId)).toBe(true);
    expect(listActivity(test.db, { runId: orphanRunId, limit: 100 })).toHaveLength(0);
  });

  it("is idempotent: a second rebuild with no hierarchy change rewrites nothing", async () => {
    source.sessions = [session({ id: "ses_p", timeUpdated: NOW }), session({ id: "ses_c", parentId: "ses_p", timeUpdated: NOW + 1000 })];
    source.agents = [agent("build")];
    source.messages.set("ses_c", { messages: [assistantMessage("msg_c_a1", NOW + 1000, "build")], nextCursor: null });
    await runCycle(makeDeps(), "c1");

    const parentRunId = getRootRunForSession(test.db, "ses_p")!.id;
    const before = listActivity(test.db, { sessionId: "ses_c", limit: 100 }).map((event) => event.runId);
    expect(before).toEqual([parentRunId]);

    await runCycle(makeDeps(), "c1");
    const after = listActivity(test.db, { sessionId: "ses_c", limit: 100 }).map((event) => event.runId);
    expect(after).toEqual([parentRunId]);
    expect(countInvocationsForRun(test.db, parentRunId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HIGH 3: provenance survives a switch from fixtures to a live collector
// ---------------------------------------------------------------------------

describe("HIGH 3 — fixture data stays marked as a fixture after a live collector runs", () => {
  it("keeps fixture sessions, runs and events labelled as fixtures", async () => {
    // Cycle 1: a fixture observation.
    source.sessions = [session({ id: "ses_fixture_root", timeUpdated: NOW })];
    source.agents = [agent("build")];
    source.messages.set("ses_fixture_root", {
      messages: [userMessage("msg_f_u1", NOW, "fixture work"), assistantMessage("msg_f_a1", NOW + 1000, "build")],
      nextCursor: null,
    });
    const first = await runCycle(makeDeps(), "c1");
    expect(first?.source).toBe("fixture");

    const fixtureRunId = getRootRunForSession(test.db, "ses_fixture_root")?.id;
    expect(fixtureRunId).toBeDefined();
    expect(getRootRun(test.db, fixtureRunId!)?.source).toBe("fixture");

    // Cycle 2: the collector is reconfigured for a live upstream, which reports a
    // different session. The fixture session is not re-reported, so it must stay
    // exactly as it was observed.
    source = new ScriptedSource("live");
    source.sessions = [session({ id: "ses_live_root", timeUpdated: NOW + 10_000 })];
    source.agents = [agent("build")];
    source.messages.set("ses_live_root", {
      messages: [userMessage("msg_l_u1", NOW + 10_000, "live work")],
      nextCursor: null,
    });
    const second = await runCycle(makeDeps(), "c1");
    expect(second?.ok).toBe(true);
    expect(second?.source).toBe("upstream");

    // The fixture run is still labelled a fixture and still rooted at its session.
    const fixtureRun = getRootRun(test.db, fixtureRunId!);
    expect(fixtureRun?.source).toBe("fixture");
    expect(fixtureRun?.rootSessionId).toBe("ses_fixture_root");

    // The live session's own run is labelled upstream.
    const liveRunId = getRootRunForSession(test.db, "ses_live_root")?.id;
    expect(getRootRun(test.db, liveRunId!)?.source).toBe("upstream");

    // The stored fixture session kept its provenance.
    const fixtureSessionSource = (test.db.prepare("SELECT source FROM sessions WHERE id = ?").get("ses_fixture_root") as {
      source: string;
    }).source;
    expect(fixtureSessionSource).toBe("fixture");

    // No fixture event is presented as upstream.
    const fixtureEventSources = (
      test.db.prepare("SELECT DISTINCT source FROM activity_events WHERE session_id = ?").all("ses_fixture_root") as {
        source: string;
      }[]
    ).map((row) => row.source);
    expect(fixtureEventSources).toEqual(["fixture"]);

    // The fixture run's timeline is still readable and still a fixture.
    const fixtureTimeline = listActivity(test.db, { runId: fixtureRunId!, limit: 100 });
    expect(fixtureTimeline.length).toBeGreaterThan(0);
    expect(fixtureTimeline.every((event) => event.source === "fixture")).toBe(true);

    // And the fixture run was not absorbed into the live run.
    expect(listRunSessions(test.db, fixtureRunId!).map((member) => member.session.id)).toEqual(["ses_fixture_root"]);
    expect(listRunSessions(test.db, liveRunId!).map((member) => member.session.id)).toEqual(["ses_live_root"]);
  });

  it("does not attach a live session under a fixture parent", async () => {
    // A fixture parent is stored first.
    source.sessions = [session({ id: "ses_fixture_root", timeUpdated: NOW })];
    source.messages.set("ses_fixture_root", { messages: [userMessage("msg_f", NOW)], nextCursor: null });
    await runCycle(makeDeps(), "c1");

    // The live collector reports a child whose parent is the fixture session. The
    // parent is not re-reported by the live source; the link crosses a provenance
    // boundary, so it must not be followed.
    source = new ScriptedSource("live");
    source.sessions = [session({ id: "ses_live_child", parentId: "ses_fixture_root", timeUpdated: NOW + 5000 })];
    source.messages.set("ses_live_child", { messages: [userMessage("msg_lc", NOW + 5000)], nextCursor: null });
    const second = await runCycle(makeDeps(), "c1");
    expect(second?.crossSourceLinks).toBe(1);

    const childRun = getRootRunForSession(test.db, "ses_live_child");
    expect(childRun?.rootSessionId).toBe("ses_live_child");
    expect(childRun?.source).toBe("upstream");
    // The fixture parent's run is unchanged and does not contain the live child.
    const fixtureRun = getRootRunForSession(test.db, "ses_fixture_root");
    expect(fixtureRun?.source).toBe("fixture");
    expect(listRunSessions(test.db, fixtureRun!.id).map((member) => member.session.id)).toEqual(["ses_fixture_root"]);
    // The fixture session's own activity was left untouched by the live cycle.
    expect(listActivity(test.db, { sessionId: "ses_fixture_root", limit: 100 }).every((event) => event.source === "fixture")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HIGH 1 follow-up: a whole structured value under a credential key must be
// removed *before* it is serialised, all the way to the API DTO
// ---------------------------------------------------------------------------

describe("HIGH 1 follow-up — a structured credential never reaches storage or the API", () => {
  const AWS_SECRET = "opaque-aws-secret-000111222333";
  const NESTED_SECRET = "opaque-nested-secret-444555666777";

  /** A raw assistant tool part, shaped like the documented upstream payload. */
  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_a1",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_1",
              name: "aws",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  it("carries a redacted structured value from schema validation to the API DTO", () => {
    // Regression: the tool input was serialised before redaction, and the value
    // rules only understood scalars, so a whole object under a credential key
    // survived into `inputSummary`, the database, and the DTO.
    const validated = validateMessagesResponse(
      rawToolPayload({
        region: "us-east-1",
        credentials: { SecretAccessKey: { value: AWS_SECRET, nested: { deep: AWS_SECRET } } },
      }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    // 1. Schema validation: the serialised tool input no longer holds the secret.
    expect(JSON.stringify(validated.value.messages)).not.toContain(AWS_SECRET);

    // 2. Normalisation.
    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_structured",
      runId: runIdFor(locationId, "ses_structured"),
      source: "upstream",
      contentMaxChars: 2000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    expect(JSON.stringify(normalized)).not.toContain(AWS_SECRET);

    // 3. SQLite persistence.
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);
    const stored = listActivity(test.db, { sessionId: "ses_structured", limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    const storedText = stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n");
    expect(storedText).not.toContain(AWS_SECRET);
    expect(storedText).toContain("[redacted]");

    // 4. API DTO: the browser receives no secret either.
    const items = stored.map(toActivityItem);
    expect(JSON.stringify(items)).not.toContain(AWS_SECRET);
    expect(JSON.stringify(items)).toContain("[redacted]");
  });

  it("removes a credential from a nested encoded tool input and keeps the rest", () => {
    const validated = validateMessagesResponse(
      rawToolPayload({
        args: ["--config", JSON.stringify({ secretAccessKey: { value: NESTED_SECRET } })],
        author: "Ada Lovelace",
      }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const serialised = JSON.stringify(validated.value.messages);
    expect(serialised).not.toContain(NESTED_SECRET);
    // The ordinary, non-secret content survives.
    expect(serialised).toContain("Ada Lovelace");
    expect(serialised).toContain("--config");
  });

  it("never persists a compound key's structured value through the collector", async () => {
    source.sessions = [session({ id: "ses_sec2" })];
    source.agents = [agent("build")];
    source.messages.set("ses_sec2", {
      messages: [
        assistantMessage("msg_a1", NOW + 1000, "build", [
          toolPart("tool_1", "aws", `{"SecretKey":{"value":"${AWS_SECRET}"}}`),
        ]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(joined).not.toContain(AWS_SECRET);

    for (const item of listActivity(test.db, { sessionId: "ses_sec2", limit: 100 }).map(toActivityItem)) {
      expect(`${item.summary}\n${item.content ?? ""}`).not.toContain(AWS_SECRET);
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction durability: the persistence boundary itself redacts, so a writer
// that does not go through the collector cannot reintroduce a credential after
// migration 4 has run.
// ---------------------------------------------------------------------------

describe("persistence boundary — every diagnostic writer stores only redacted text", () => {
  const PLAIN = "opaque-plain-secret-000111222333";
  const NESTED = "opaque-nested-secret-444555666777";

  it("redacts locations.canonical without touching the id or the directory", () => {
    const directory = "/srv/plain";
    const id = locationIdFor(directory);
    upsertLocation(test.db, {
      id,
      directory,
      projectId: "prj_1",
      canonical: `canonical api_key=${PLAIN}`,
      subpath: null,
      source: "upstream",
      seenAt: NOW,
    });

    const row = test.db.prepare("SELECT id, directory, canonical FROM locations WHERE id = ?").get(id) as {
      id: string;
      directory: string;
      canonical: string;
    };
    expect(row.canonical).not.toContain(PLAIN);
    expect(row.canonical).toContain("[redacted]");
    // The identity and the input the id is derived from are preserved exactly:
    // redacting the directory would desynchronise the row from its own id.
    expect(row.id).toBe(id);
    expect(row.directory).toBe(directory);
    expect(listLocations(test.db).map((location) => location.directory)).toEqual([directory]);
  });

  it("redacts locations.canonical on the conflict-update path too", () => {
    const directory = "/srv/conflict";
    const id = locationIdFor(directory);
    const base = { id, directory, projectId: "prj_1", subpath: null, source: "upstream" as const };

    upsertLocation(test.db, { ...base, canonical: "clean", seenAt: NOW });
    // A later snapshot re-reports the location with a credential in its canonical
    // path; the ON CONFLICT update must store the redacted form, not the raw one.
    upsertLocation(test.db, { ...base, canonical: `recanon api_key=${PLAIN}`, seenAt: NOW + 1 });

    const row = test.db.prepare("SELECT id, directory, canonical FROM locations WHERE id = ?").get(id) as {
      id: string;
      directory: string;
      canonical: string;
    };
    expect(row.canonical).not.toContain(PLAIN);
    expect(row.canonical).toContain("[redacted]");
    expect(row.id).toBe(id);
    expect(row.directory).toBe(directory);
    expect(test.db.prepare("SELECT COUNT(*) AS n FROM locations").get()).toEqual({ n: 1 });
  });

  it("redacts collector_state.last_error, keeping null null and an empty value empty", () => {
    const base = {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      updatedAt: NOW,
    };

    setCollectorState(test.db, { ...base, lastError: null });
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError).toBeNull();

    setCollectorState(test.db, { ...base, lastError: "", updatedAt: NOW + 1 });
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError).toBe("");

    // Plain prose that quotes a credential, on the conflict-update path.
    setCollectorState(test.db, { ...base, lastError: `UpstreamError: api_key=${PLAIN}`, updatedAt: NOW + 2 });
    const plain = getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError ?? "";
    expect(plain).not.toContain(PLAIN);
    expect(plain).toContain("[redacted]");

    // A serialised error body: the credential hides behind a key, and the rest of
    // the payload survives.
    setCollectorState(test.db, {
      ...base,
      lastError: JSON.stringify({ error: "unauthorized", clientSecret: NESTED }),
      updatedAt: NOW + 3,
    });
    const nested = getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError ?? "";
    expect(nested).not.toContain(NESTED);
    expect(JSON.parse(nested)).toEqual({ error: "unauthorized", clientSecret: "[redacted]" });

    // The DTO the status page reads is redacted as well.
    expect(JSON.stringify(collectorHealth(test.db, NOW))).not.toContain(NESTED);
  });

  it("redacts collector_warnings.detail while keeping the id derived from the original text", () => {
    const detail = `unknown type api_key=${PLAIN}`;
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "unknown-message-type", detail }, NOW);

    const warnings = listWarnings(test.db, 100);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).not.toContain(PLAIN);
    expect(warnings[0]?.detail).toContain("[redacted]");
    // The id is the hash of the *original* detail, so a repeat occurrence joins
    // the same row rather than creating a second one.
    expect(warnings[0]?.id).toBe(deterministicId("warn", [COLLECTOR_SCOPE, "unknown-message-type", detail]));

    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "unknown-message-type", detail }, NOW + 1);
    const after = listWarnings(test.db, 100);
    expect(after).toHaveLength(1);
    expect(after[0]?.occurrences).toBe(2);
  });

  it("keeps two distinct warnings distinct even when they redact to the same text", () => {
    // Dedup is by the original detail. If it were by the stored (redacted) text
    // these two problems would collapse into one row and the second would vanish.
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `api_key=${PLAIN}` }, NOW);
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `api_key=${NESTED}` }, NOW);

    const warnings = listWarnings(test.db, 100);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((warning) => warning.detail === "api_key=[redacted]")).toBe(true);
    expect(new Set(warnings.map((warning) => warning.id)).size).toBe(2);
  });

  it("redacts a gap's reason on insert and on the re-assert update", () => {
    const id = "gap_direct";
    const base = { id, scope: COLLECTOR_SCOPE, stream: "cycle", startedAt: NOW, detectedAt: NOW };

    recordGap(test.db, {
      ...base,
      endedAt: null,
      reason: `collection failed: api_key=${PLAIN}`,
      resumed: false,
      open: true,
    });
    const opened = listGaps(test.db, 100).find((gap) => gap.id === id);
    expect(opened?.reason).not.toContain(PLAIN);
    expect(opened?.reason).toContain("[redacted]");
    expect(opened?.stream).toBe("cycle");

    // The conflict path re-asserts the same row with a new, structured reason.
    recordGap(test.db, {
      ...base,
      endedAt: NOW + 5,
      reason: JSON.stringify({ error: "still down", accessToken: NESTED }),
      resumed: true,
      open: false,
    });
    const reasserted = listGaps(test.db, 100).find((gap) => gap.id === id);
    expect(reasserted?.reason).not.toContain(NESTED);
    expect(reasserted?.reason).toContain("[redacted]");
    expect(reasserted?.endedAt).toBe(NOW + 5);
    expect(listGaps(test.db, 100)).toHaveLength(1);
  });

  it("redacts an open gap's reason on insert and on re-assert", () => {
    const id = "gap_open_direct";
    const base = { id, scope: COLLECTOR_SCOPE, stream: "cycle", startedAt: NOW };

    openGap(test.db, { ...base, reason: `collection failed: api_key=${PLAIN}`, detectedAt: NOW });
    const opened = listGaps(test.db, 100).find((gap) => gap.id === id);
    expect(opened?.reason).not.toContain(PLAIN);
    expect(opened?.reason).toContain("[redacted]");
    expect(opened?.open).toBe(true);
    expect(opened?.resumed).toBe(false);

    openGap(test.db, {
      ...base,
      reason: `still failing {"clientSecret":"${NESTED}"}`,
      detectedAt: NOW + 1,
    });
    const reasserted = listGaps(test.db, 100).find((gap) => gap.id === id);
    expect(reasserted?.reason).not.toContain(NESTED);
    expect(reasserted?.reason).toContain("[redacted]");
    expect(listGaps(test.db, 100)).toHaveLength(1);
  });

  it("serves none of the stored diagnostics through the API DTOs", () => {
    const directory = "/srv/api";
    const id = locationIdFor(directory);
    upsertLocation(test.db, {
      id,
      directory,
      projectId: "prj_1",
      canonical: `canonical api_key=${PLAIN}`,
      subpath: null,
      source: "upstream",
      seenAt: NOW,
    });
    recordGap(test.db, {
      id: "gap_api",
      scope: COLLECTOR_SCOPE,
      stream: "cycle",
      startedAt: NOW,
      endedAt: null,
      reason: `collection failed: api_key=${PLAIN}`,
      detectedAt: NOW,
      resumed: false,
      open: true,
    });
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `{"clientSecret":"${NESTED}"}` }, NOW);
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      lastError: `UpstreamError: api_key=${PLAIN}`,
      updatedAt: NOW,
    });

    const api = [
      ...listLocations(test.db).map((location) => JSON.stringify(toLocationItem(location, 0, 0))),
      ...listGaps(test.db, 100).map((gap) => JSON.stringify(toGapItem(gap))),
      ...listWarnings(test.db, 100).map((warning) => JSON.stringify(toWarningItem(warning))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");

    for (const secret of [PLAIN, NESTED]) expect(api, secret).not.toContain(secret);
    expect(api).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// Redaction durability: a collector cycle that runs *after* migration 4 stores
// only redacted values, and its ids and joins are unchanged.
// ---------------------------------------------------------------------------

describe("redaction durability — a collector cycle after migration 4 stores only redacted values", () => {
  const LOCATION_SECRET = "opaque-location-secret-000111222333";
  const WARNING_SECRET = "opaque-warning-secret-444555666777";
  const CYCLE_SECRET = "opaque-cycle-secret-888999000111";

  it("redacts every diagnostic field a cycle writes, and leaves the ids and joins intact", async () => {
    // The harness runs every migration, so migration 4's data step has already
    // run: this exercises the write path a later cycle uses, not the migration.
    expect(currentSchemaVersion(test.db)).toBe(18);

    const directory = "/srv/demo";
    const locationId = locationIdFor(directory);

    // A successful cycle whose location canonical and unknown-message warning both
    // carry a credential.
    source.locations = [{ ...LOCATION, canonical: `canonical api_key=${LOCATION_SECRET}` }];
    source.sessions = [session({ id: "ses_cycle" })];
    source.agents = [agent("build")];
    source.unknownTypes = [`mystery-type api_key=${WARNING_SECRET}`];
    source.messages.set("ses_cycle", { messages: [userMessage("msg_1", NOW)], nextCursor: null });

    const succeeded = await runCycle(makeDeps(), "c1");
    expect(succeeded?.ok).toBe(true);

    // 1. Raw storage: no credential survives in the fields this cycle wrote.
    const location = test.db.prepare("SELECT id, directory, canonical FROM locations WHERE id = ?").get(locationId) as {
      id: string;
      directory: string;
      canonical: string;
    };
    expect(location.canonical).not.toContain(LOCATION_SECRET);
    expect(location.canonical).toContain("[redacted]");
    // The id and the directory it is derived from are untouched, so the session's
    // join to this location still resolves.
    expect(location.id).toBe(locationId);
    expect(location.directory).toBe(directory);
    const sessionLocation = (
      test.db.prepare("SELECT location_id FROM sessions WHERE id = 'ses_cycle'").get() as { location_id: string }
    ).location_id;
    expect(sessionLocation).toBe(locationId);

    const warning = listWarnings(test.db, 100).find((entry) => entry.kind === "unknown-message-type");
    expect(warning?.detail).not.toContain(WARNING_SECRET);
    expect(warning?.detail).toContain("[redacted]");
    // The warning's id still derives from the original detail, so the dedup key is
    // unchanged by redaction.
    expect(warning?.id).toBe(
      deterministicId("warn", [COLLECTOR_SCOPE, "unknown-message-type", `mystery-type api_key=${WARNING_SECRET}`]),
    );

    // 2. A failed cycle writes the error and the gap reason.
    source.failWith = new Error(`boom api_key=${CYCLE_SECRET}`);
    const failed = await runCycle(makeDeps(), "c1");
    expect(failed?.ok).toBe(false);

    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.lastError ?? "").not.toContain(CYCLE_SECRET);
    expect(state?.lastError ?? "").toContain("[redacted]");

    const open = listOpenGaps(test.db, COLLECTOR_SCOPE);
    expect(open).toHaveLength(1);
    expect(open[0]?.reason).not.toContain(CYCLE_SECRET);
    expect(open[0]?.reason).toContain("[redacted]");
    // The gap's id is still derived from its window, not from its text.
    expect(open[0]?.id).toBe(gapIdFor(COLLECTOR_SCOPE, "cycle", open[0]!.startedAt));

    // A second failure re-asserts the same gap rather than opening another.
    await runCycle(makeDeps(), "c1");
    expect(listOpenGaps(test.db, COLLECTOR_SCOPE)).toHaveLength(1);

    // 3. The API surface the dashboard reads carries no secret either.
    const api = [
      ...listLocations(test.db).map((entry) => JSON.stringify(toLocationItem(entry, 0, 0))),
      ...listGaps(test.db, 100).map((entry) => JSON.stringify(toGapItem(entry))),
      ...listWarnings(test.db, 100).map((entry) => JSON.stringify(toWarningItem(entry))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");
    for (const secret of [LOCATION_SECRET, WARNING_SECRET, CYCLE_SECRET]) {
      expect(api, secret).not.toContain(secret);
    }
    expect(api).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// HIGH — an agent's model provider is an arbitrary upstream label and must be
// redacted at the write boundary, like every other display-only field.
// ---------------------------------------------------------------------------

describe("agent model provider is redacted at the persistence boundary", () => {
  const PROVIDER_SECRET = "opaque-provider-secret-000111222333";
  const MODEL_SECRET = "opaque-model-secret-444555666777";

  function agentDefinition(overrides: Partial<Parameters<typeof upsertAgent>[1]> = {}) {
    return {
      locationId: "loc_agents",
      agentId: "build",
      name: "build",
      mode: "primary" as const,
      hidden: false,
      description: null,
      modelProviderId: null,
      modelId: null,
      active: true,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      source: "upstream" as const,
      ...overrides,
    };
  }

  it("redacts the provider and model labels on insert and on update", () => {
    upsertAgent(test.db, agentDefinition({ modelProviderId: "anthropic", modelId: "claude" }));
    expect(listAgents(test.db)[0]?.modelProviderId).toBe("anthropic");

    // The API now reports a label that carries a credential; the ON CONFLICT
    // update must store the redacted form, not the raw one.
    upsertAgent(
      test.db,
      agentDefinition({
        modelProviderId: `api_key=${PROVIDER_SECRET}`,
        modelId: `SecretKey=${MODEL_SECRET}`,
      }),
    );

    const row = test.db
      .prepare("SELECT location_id, agent_id, model_provider_id, model_id FROM agents WHERE agent_id = 'build'")
      .get() as { location_id: string; agent_id: string; model_provider_id: string; model_id: string };

    expect(row.model_provider_id).not.toContain(PROVIDER_SECRET);
    expect(row.model_id).not.toContain(MODEL_SECRET);
    expect(row.model_provider_id).toContain("[redacted]");
    expect(row.model_id).toContain("[redacted]");
    // The identity is untouched, so the agent's join keys still resolve.
    expect(row.location_id).toBe("loc_agents");
    expect(row.agent_id).toBe("build");

    // And the agents DTO the browser reads is clean too.
    const api = JSON.stringify(listAgents(test.db).map((entry) => toAgentItem(entry, null, 0)));
    expect(api).not.toContain(PROVIDER_SECRET);
    expect(api).not.toContain(MODEL_SECRET);
    expect(api).toContain("[redacted]");
  });

  it("never persists an agent's provider label through a collector cycle", async () => {
    source.sessions = [session({ id: "ses_agents" })];
    source.agents = [
      {
        id: "build",
        name: "build",
        mode: "primary",
        hidden: false,
        description: null,
        modelProviderId: `api_key=${PROVIDER_SECRET}`,
        modelId: `SecretKey=${MODEL_SECRET}`,
      },
    ];
    source.messages.set("ses_agents", { messages: [userMessage("msg_1", NOW)], nextCursor: null });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const row = test.db
      .prepare("SELECT model_provider_id, model_id FROM agents WHERE agent_id = 'build'")
      .get() as { model_provider_id: string; model_id: string };
    expect(row.model_provider_id).not.toContain(PROVIDER_SECRET);
    expect(row.model_id).not.toContain(MODEL_SECRET);

    const api = JSON.stringify(listAgents(test.db).map((entry) => toAgentItem(entry, null, 0)));
    expect(api).not.toContain(PROVIDER_SECRET);
    expect(api).not.toContain(MODEL_SECRET);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM — a tool call whose input was redacted *before* it was serialised still
// reports that redaction happened, so the timeline badge stays honest.
// ---------------------------------------------------------------------------

describe("pre-serialisation tool redaction keeps the activity badge honest", () => {
  const TOOL_SECRET = "opaque-tool-input-secret-000111222333";

  /** A raw assistant message with one tool part, shaped like the documented payload. */
  function rawAssistantWithTool(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_tool",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_1",
              name: "aws",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  it("carries the provenance from schema validation into the activity badge", () => {
    const validated = validateMessagesResponse(
      rawAssistantWithTool({ credentials: { SecretAccessKey: { value: TOOL_SECRET } } }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_tool",
      runId: runIdFor(locationId, "ses_tool"),
      source: "upstream",
      contentMaxChars: 2000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });

    const toolEvent = normalized.events.find((event) => event.kind === "tool");
    expect(toolEvent).toBeDefined();
    // The credential is gone from the stored text...
    expect(toolEvent?.content ?? "").not.toContain(TOOL_SECRET);
    // ...and the badge says so, even though the collector's own redactor saw
    // already-clean text and could not have detected the removal itself.
    expect(toolEvent?.redacted).toBe(true);
  });

  it("drives the badge from the carried provenance, not from the already-clean text", () => {
    // Proves the flag is load-bearing: the stored text is identical in both
    // cases (the credential is already gone), so only the provenance can
    // distinguish "redacted upstream" from "never needed redaction".
    const validated = validateMessagesResponse(
      rawAssistantWithTool({ credentials: { SecretAccessKey: { value: TOOL_SECRET } } }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const locationId = locationIdFor("/srv/demo");
    const normalize = (redacted: boolean) =>
      normalizeSessionActivity({
        locationId,
        sessionId: "ses_tool_prov",
        runId: runIdFor(locationId, "ses_tool_prov"),
        source: "upstream",
        contentMaxChars: 2000,
        ingestedAt: NOW,
        messages: validated.value.messages.map((message) =>
          message.type !== "assistant"
            ? message
            : {
                ...message,
                parts: message.parts.map((part) => (part.kind === "tool" ? { ...part, redacted } : part)),
              },
        ),
      }).events.find((event) => event.kind === "tool");

    const withProvenance = normalize(true);
    const withoutProvenance = normalize(false);
    expect(withProvenance?.content).toBe(withoutProvenance?.content);
    expect(withProvenance?.redacted).toBe(true);
    expect(withoutProvenance?.redacted).toBe(false);
  });

  it("does not raise the badge on an ordinary tool call", () => {
    const validated = validateMessagesResponse(rawAssistantWithTool({ command: "ls -la", cwd: "/srv/demo" }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_tool_clean",
      runId: runIdFor(locationId, "ses_tool_clean"),
      source: "upstream",
      contentMaxChars: 2000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });

    const toolEvent = normalized.events.find((event) => event.kind === "tool");
    expect(toolEvent?.redacted).toBe(false);
    expect(toolEvent?.content ?? "").toContain("ls -la");
  });

  it("persists the badge through the collector and serves it in the DTO", async () => {
    const validated = validateMessagesResponse(
      rawAssistantWithTool({ credentials: { SecretAccessKey: { value: TOOL_SECRET } } }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    source.sessions = [session({ id: "ses_tool" })];
    source.agents = [agent("build")];
    source.messages.set("ses_tool", { messages: validated.value.messages, nextCursor: null });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db
      .prepare("SELECT summary, content, redacted FROM activity_events WHERE kind = 'tool'")
      .all() as { summary: string; content: string | null; redacted: number }[];
    expect(rows).toHaveLength(1);
    expect(`${rows[0]?.summary}\n${rows[0]?.content ?? ""}`).not.toContain(TOOL_SECRET);
    expect(rows[0]?.redacted).toBe(1);

    const items = listActivity(test.db, { sessionId: "ses_tool", limit: 100 })
      .map(toActivityItem)
      .filter((item) => item.kind === "tool");
    expect(items).toHaveLength(1);
    expect(items[0]?.redacted).toBe(true);
    expect(JSON.stringify(items)).not.toContain(TOOL_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Redaction of a credential assignment whose value merely looks like JSON, and
// fail-closed behaviour when the structural scan hits its limits. Both are
// enforced end to end: normalisation, storage, and the API DTO.
// ---------------------------------------------------------------------------

describe("a credential assignment whose value looks like JSON never reaches storage or the API", () => {
  const PASSWORD = "correct[42]horse";
  const INNER = "opaque-live-value-000111222333";

  it("redacts a quoted JSON-looking value at the normalization stage", () => {
    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_quoted",
      runId: runIdFor(locationId, "ses_quoted"),
      source: "upstream",
      contentMaxChars: 2000,
      ingestedAt: NOW,
      messages: [
        userMessage("msg_q1", NOW, `login password="${PASSWORD}"`),
        userMessage("msg_q2", NOW + 1, `clientSecret='{"value":"${INNER}"}'`),
      ],
    });

    const text = JSON.stringify(normalized);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(INNER);
    expect(text).toContain("[redacted]");
    expect(normalized.events.every((event) => event.redacted)).toBe(true);
  });

  it("redacts it through a collector cycle, raw storage and the DTO", async () => {
    source.sessions = [session({ id: "ses_quoted" })];
    source.agents = [agent("build")];
    source.messages.set("ses_quoted", {
      messages: [
        userMessage("msg_q1", NOW, `login password="${PASSWORD}"`),
        userMessage("msg_q2", NOW + 1, `clientSecret='{"value":"${INNER}"}'`),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const stored = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(INNER);
    expect(stored).toContain("[redacted]");

    const items = listActivity(test.db, { sessionId: "ses_quoted", limit: 100 }).map(toActivityItem);
    const api = JSON.stringify(items);
    expect(api).not.toContain(PASSWORD);
    expect(api).not.toContain(INNER);
    expect(items.every((item) => item.redacted)).toBe(true);
  });

  it("fails closed when the structural scan hits its attempt limit", async () => {
    // The credential sits past the fragment-attempt cap, so the scanner cannot
    // inspect it. It must be dropped rather than stored. The content cap is raised
    // so the bounded-scan marker is not itself truncated away.
    configureTestEnv({ ORCH_CONTENT_MAX_CHARS: "20000" });
    const harmless = '{"a":1}'.repeat(512);
    source.sessions = [session({ id: "ses_cap" })];
    source.agents = [agent("build")];
    source.messages.set("ses_cap", {
      messages: [userMessage("msg_cap", NOW, `${harmless}{"accessToken":{"value":"${INNER}"}}`)],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const stored = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    // The secret is gone, and so is the uninspected structure that held it — the
    // remainder was replaced, not merely skipped.
    expect(stored).not.toContain(INNER);
    expect(stored).not.toContain("accessToken");
    expect(stored).toContain("[redacted:uninspected]");

    const api = JSON.stringify(listActivity(test.db, { sessionId: "ses_cap", limit: 100 }).map(toActivityItem));
    expect(api).not.toContain(INNER);
    expect(api).toContain("[redacted:uninspected]");
  });
});

// ---------------------------------------------------------------------------
// Environment-style assignment keys, and fail-closed assignment delimiting.
// Both are enforced end to end: raw storage, normalisation, diagnostics, DTO.
// ---------------------------------------------------------------------------

describe("environment-style credential keys are redacted end to end", () => {
  const PASSWORD = "correct[42]horse";
  const LIVE = "opaque-live-value-000111222333";

  it("redacts an env-style quoted value at the normalization stage", () => {
    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_env",
      runId: runIdFor(locationId, "ses_env"),
      source: "upstream",
      contentMaxChars: 2000,
      ingestedAt: NOW,
      messages: [
        userMessage("msg_e1", NOW, `export OPENAI_KEY="${PASSWORD}"`),
        userMessage("msg_e2", NOW + 1, `OPENAI_KEY='{"value":"${LIVE}"}'`),
      ],
    });

    const text = JSON.stringify(normalized);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(LIVE);
    expect(text).toContain("[redacted]");
  });

  it("redacts an env-style key through a collector cycle and the DTO", async () => {
    source.sessions = [session({ id: "ses_env" })];
    source.agents = [agent("build")];
    source.messages.set("ses_env", {
      messages: [
        userMessage("msg_e1", NOW, `export OPENAI_KEY="${PASSWORD}"`),
        userMessage("msg_e2", NOW + 1, `GITHUB_TOKEN='{"value":"${LIVE}"}'`),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const stored = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(LIVE);

    const api = JSON.stringify(listActivity(test.db, { sessionId: "ses_env", limit: 100 }).map(toActivityItem));
    expect(api).not.toContain(PASSWORD);
    expect(api).not.toContain(LIVE);
    expect(api).toContain("[redacted]");
  });

  it("redacts an env-style key in every diagnostic writer", () => {
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      lastError: `UpstreamError: OPENAI_KEY="${PASSWORD}"`,
      updatedAt: NOW,
    });
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `OPENAI_KEY='{"value":"${LIVE}"}'` }, NOW);
    openGap(test.db, {
      id: "gap_env",
      scope: COLLECTOR_SCOPE,
      stream: "cycle",
      startedAt: NOW,
      reason: `collection failed: GITHUB_TOKEN="${PASSWORD}"`,
      detectedAt: NOW,
    });

    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.lastError ?? "").not.toContain(PASSWORD);
    expect(state?.lastError ?? "").toContain("[redacted]");

    const diagnostics = [
      ...listWarnings(test.db, 100).map((warning) => JSON.stringify(toWarningItem(warning))),
      ...listGaps(test.db, 100).map((gap) => JSON.stringify(toGapItem(gap))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");
    for (const secret of [PASSWORD, LIVE]) expect(diagnostics, secret).not.toContain(secret);
    expect(diagnostics).toContain("[redacted]");
  });

  it("keeps a benign env-style assignment intact end to end", async () => {
    source.sessions = [session({ id: "ses_env_ok" })];
    source.agents = [agent("build")];
    source.messages.set("ses_env_ok", {
      messages: [userMessage("msg_ok", NOW, 'OPENAI_MODEL="gpt-4" LOG_LEVEL="debug"')],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).toContain("gpt-4");
    expect(stored).toContain("debug");
  });

  it("drops a recognised value it cannot delimit within budget", async () => {
    // The container cannot be delimited in the remaining budget, so the value is
    // replaced wholesale rather than partially consumed and left unrecognisable.
    const input = "{".repeat(8) + ` password={"value":"${LIVE}"}` + "x".repeat(13000);
    source.sessions = [session({ id: "ses_budget" })];
    source.agents = [agent("build")];
    source.messages.set("ses_budget", { messages: [userMessage("msg_b", NOW, input)], nextCursor: null });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const stored = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(stored).not.toContain(LIVE);
    expect(stored).not.toContain("value");

    const api = JSON.stringify(listActivity(test.db, { sessionId: "ses_budget", limit: 100 }).map(toActivityItem));
    expect(api).not.toContain(LIVE);
  });

  it("masks an env-style JSON property through schema, collector, storage and the DTO", async () => {
    // The structured path (`redactStructuredLeaves`) used the narrower classifier,
    // so an env-style *property name* was masked in assignment form but not inside
    // JSON. This drives the whole path: schema validation redacts the tool input
    // before it is serialised, normalisation keeps it, SQLite stores it, and the
    // DTO the browser reads carries no secret.
    const validated = validateMessagesResponse({
      data: [
        {
          id: "msg_env_json",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_env",
              name: "deploy",
              time: { created: NOW, completed: NOW + 1000 },
              state: {
                status: "completed",
                input: { region: "us-east-1", OPENAI_KEY: LIVE, nested: { GITHUB_TOKEN: PASSWORD } },
                content: [{ type: "text", text: "ok" }],
              },
            },
          ],
        },
      ],
      cursor: {},
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    // 1. Schema validation: the serialised tool input no longer holds either value.
    expect(JSON.stringify(validated.value.messages)).not.toContain(LIVE);
    expect(JSON.stringify(validated.value.messages)).not.toContain(PASSWORD);
    expect(JSON.stringify(validated.value.messages)).toContain("us-east-1");

    source.sessions = [session({ id: "ses_env_json" })];
    source.agents = [agent("build")];
    source.messages.set("ses_env_json", { messages: validated.value.messages, nextCursor: null });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    // 2. Raw storage.
    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain(LIVE);
    expect(stored).not.toContain(PASSWORD);

    // 3. API DTO.
    const items = listActivity(test.db, { sessionId: "ses_env_json", limit: 100 }).map(toActivityItem);
    expect(JSON.stringify(items)).not.toContain(LIVE);
    expect(JSON.stringify(items)).not.toContain(PASSWORD);
    expect(JSON.stringify(items)).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// Escaped (double-encoded) JSON: the form a serialised tool input takes. It must
// be redacted on the whole path — schema, normalisation, diagnostics, storage,
// the activity DTO — and it must not be corrupted on the way.
// ---------------------------------------------------------------------------

describe("escaped JSON documents are redacted end to end", () => {
  const OPAQUE = "opaque-secret-value-000111222333";
  const ESCAPED = 'config: {\\"OPENAI_KEY\\":\\"' + OPAQUE + '\\"}';
  // The container form: the key is the only evidence that the whole escaped
  // object is a credential, so it exercises the escaped walker rather than the
  // escaped scalar rule.
  const ESCAPED_CONTAINER = 'config: {\\"accessToken\\":{\\"value\\":\\"' + OPAQUE + '\\"}}';

  /** A raw assistant tool part whose input is an escaped JSON document. */
  function rawAssistantWithEscapedInput(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_esc",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_esc",
              name: "deploy",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  it("redacts an escaped document at the schema-validation stage", () => {
    for (const document of [ESCAPED, ESCAPED_CONTAINER]) {
      const validated = validateMessagesResponse(rawAssistantWithEscapedInput(document));
      expect(validated.ok, document).toBe(true);
      if (!validated.ok) return;
      expect(JSON.stringify(validated.value.messages), document).not.toContain(OPAQUE);
    }
  });

  it("redacts it through normalisation, storage and the activity DTO", async () => {
    const validated = validateMessagesResponse(rawAssistantWithEscapedInput(ESCAPED));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_esc",
      runId: runIdFor(locationId, "ses_esc"),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    expect(JSON.stringify(normalized)).not.toContain(OPAQUE);

    source.sessions = [session({ id: "ses_esc" })];
    source.agents = [agent("build")];
    source.messages.set("ses_esc", {
      messages: [
        ...validated.value.messages,
        userMessage("msg_esc_user", NOW + 1, ESCAPED),
        userMessage("msg_esc_container", NOW + 2, ESCAPED_CONTAINER),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain(OPAQUE);
    expect(stored).toContain("[redacted]");

    const items = listActivity(test.db, { sessionId: "ses_esc", limit: 100 }).map(toActivityItem);
    const api = JSON.stringify(items);
    expect(api).not.toContain(OPAQUE);
    expect(api).toContain("[redacted]");
    // The escaping level survived, so the stored text is still a valid escaped document.
    expect(stored).toContain('{\\"OPENAI_KEY\\":\\"[redacted]\\"}');
  });

  /** The escaped-document text of a value: what a serialised tool input looks like. */
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const GHP = "ghp_abcdefghijklmnopqrstuvwx";

  it("redacts a provider token in an ordinary sibling of a credential key", async () => {
    // Regression: once any sensitive value in the escaped fragment changed, the
    // whole fragment was emitted and the scalar rules were skipped — so a token in
    // a sibling field survived next to the credential that had been removed.
    const document = escapedDocument({ OPENAI_KEY: "opaque-key", note: GHP });
    const validated = validateMessagesResponse(rawAssistantWithEscapedInput(document));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(JSON.stringify(validated.value.messages)).not.toContain(GHP);

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_esc_sibling",
      runId: runIdFor(locationId, "ses_esc_sibling"),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    expect(JSON.stringify(normalized)).not.toContain(GHP);

    source.sessions = [session({ id: "ses_esc_sibling" })];
    source.agents = [agent("build")];
    source.messages.set("ses_esc_sibling", { messages: validated.value.messages, nextCursor: null });
    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain(GHP);
    expect(JSON.stringify(listActivity(test.db, { sessionId: "ses_esc_sibling", limit: 100 }).map(toActivityItem))).not.toContain(GHP);
  });

  it("redacts a whole escaped primitive array and an escaped-quote value", async () => {
    const arrayDoc = escapedDocument({ OPENAI_KEY: [17, 23, 42, 91] });
    const quoteDoc = escapedDocument({ password: 'first"opaque-suffix' });
    const validated = validateMessagesResponse(
      rawAssistantWithEscapedInput({ arrayDoc, quoteDoc, region: "us-east-1" }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    source.sessions = [session({ id: "ses_esc_values" })];
    source.agents = [agent("build")];
    source.messages.set("ses_esc_values", {
      messages: [...validated.value.messages, userMessage("msg_esc_values", NOW + 1, arrayDoc), userMessage("msg_esc_quote", NOW + 2, quoteDoc)],
      nextCursor: null,
    });
    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain("opaque-suffix");
    expect(stored).not.toContain("[17,23,42,91]");
    expect(JSON.stringify(listActivity(test.db, { sessionId: "ses_esc_values", limit: 100 }).map(toActivityItem))).not.toContain(
      "opaque-suffix",
    );
  });

  it("redacts an escaped document in every diagnostic writer", () => {
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      lastError: `UpstreamError: ${ESCAPED}`,
      updatedAt: NOW,
    });
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `mystery ${ESCAPED}` }, NOW);
    openGap(test.db, {
      id: "gap_esc",
      scope: COLLECTOR_SCOPE,
      stream: "cycle",
      startedAt: NOW,
      reason: `collection failed: ${ESCAPED}`,
      detectedAt: NOW,
    });

    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError ?? "").not.toContain(OPAQUE);
    const diagnostics = [
      ...listWarnings(test.db, 100).map((warning) => JSON.stringify(toWarningItem(warning))),
      ...listGaps(test.db, 100).map((gap) => JSON.stringify(toGapItem(gap))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");
    expect(diagnostics).not.toContain(OPAQUE);
    expect(diagnostics).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// Nested encoded documents, unbounded URL userinfo, and malformed escaped
// primitives: each must be redacted — or fail closed — on the whole path, and
// never left raw in storage or in the API.
// ---------------------------------------------------------------------------

describe("nested and malformed escaped payloads end to end", () => {
  const NESTED_SECRET = "opaque-nested-value-000111222333";
  const URL_SECRET = "opaque_".repeat(300);
  const MALFORMED = '{\\"password\\":123opaque-suffix-000111222333}';

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  /** A raw assistant tool part whose input is an escaped JSON document. */
  function rawAssistant(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_deep",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_deep",
              name: "deploy",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  it("redacts a credential nested inside an ordinary string value", () => {
    const document = escapedDocument({
      OPENAI_KEY: "k",
      note: JSON.stringify({ OPENAI_KEY: [17, 23, 42, 91], accessToken: NESTED_SECRET }),
    });
    const validated = validateMessagesResponse(rawAssistant(document));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const serialised = JSON.stringify(validated.value.messages);
    expect(serialised).not.toContain(NESTED_SECRET);
    expect(serialised).not.toContain("[17,23,42,91]");
  });

  it("redacts an over-long URL userinfo and a malformed primitive through the collector", async () => {
    const validated = validateMessagesResponse(
      rawAssistant({
        clone: `https://alice:${URL_SECRET}@example.com/repo`,
        malformed: MALFORMED,
      }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(JSON.stringify(validated.value.messages)).not.toContain(URL_SECRET);
    expect(JSON.stringify(validated.value.messages)).not.toContain("opaque-suffix");

    source.sessions = [session({ id: "ses_deep" })];
    source.agents = [agent("build")];
    source.messages.set("ses_deep", { messages: validated.value.messages, nextCursor: null });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain(URL_SECRET);
    expect(stored).not.toContain("opaque-suffix");

    const api = JSON.stringify(listActivity(test.db, { sessionId: "ses_deep", limit: 100 }).map(toActivityItem));
    expect(api).not.toContain(URL_SECRET);
    expect(api).not.toContain("opaque-suffix");
  });

  it("redacts these shapes in every diagnostic writer", () => {
    const nested = escapedDocument({ note: JSON.stringify({ GITHUB_TOKEN: [1, 2] }) });
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      lastError: `UpstreamError: ${nested}`,
      updatedAt: NOW,
    });
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `clone https://alice:${URL_SECRET}@x/y` }, NOW);
    openGap(test.db, {
      id: "gap_deep",
      scope: COLLECTOR_SCOPE,
      stream: "cycle",
      startedAt: NOW,
      reason: `collection failed: ${MALFORMED}`,
      detectedAt: NOW,
    });

    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError ?? "").not.toContain("[1,2]");
    const diagnostics = [
      ...listWarnings(test.db, 100).map((warning) => JSON.stringify(toWarningItem(warning))),
      ...listGaps(test.db, 100).map((gap) => JSON.stringify(toGapItem(gap))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");
    expect(diagnostics).not.toContain(URL_SECRET);
    expect(diagnostics).not.toContain("opaque-suffix");
  });
});

// ---------------------------------------------------------------------------
// Plaintext beside an escaped quoted phrase, and a pathological credential label:
// both must be handled on the whole path — schema, normalisation, diagnostics,
// storage, the activity DTO — without stalling on the label.
// ---------------------------------------------------------------------------

describe("plaintext around escaped quoted prose end to end", () => {
  const GHP = "ghp_abcdefghijklmnopqrstuvwx";
  const PASSWORD = "synthetic-value-000111222333";

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  /** A raw assistant tool part whose input is an escaped JSON document. */
  function rawAssistant(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_plain",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_plain",
              name: "deploy",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  const TOKEN_DOC = escapedDocument({ note: `say "hello" ${GHP}` });
  const PASSWORD_DOC = escapedDocument({ note: `password=${PASSWORD} and "quoted"` });

  it("redacts both shapes at the schema-validation stage", () => {
    for (const document of [TOKEN_DOC, PASSWORD_DOC]) {
      const validated = validateMessagesResponse(rawAssistant(document));
      expect(validated.ok, document).toBe(true);
      if (!validated.ok) return;
      const serialised = JSON.stringify(validated.value.messages);
      expect(serialised, document).not.toContain(GHP);
      expect(serialised, document).not.toContain(PASSWORD);
    }
  });

  it("redacts them through the collector, storage and the activity DTO", async () => {
    const validated = validateMessagesResponse(rawAssistant({ token: TOKEN_DOC, password: PASSWORD_DOC }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_plain",
      runId: runIdFor(locationId, "ses_plain"),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    expect(JSON.stringify(normalized)).not.toContain(GHP);
    expect(JSON.stringify(normalized)).not.toContain(PASSWORD);

    source.sessions = [session({ id: "ses_plain" })];
    source.agents = [agent("build")];
    source.messages.set("ses_plain", {
      messages: [...validated.value.messages, userMessage("msg_plain_user", NOW + 1, TOKEN_DOC)],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain(GHP);
    expect(stored).not.toContain(PASSWORD);

    const api = JSON.stringify(listActivity(test.db, { sessionId: "ses_plain", limit: 100 }).map(toActivityItem));
    expect(api).not.toContain(GHP);
    expect(api).not.toContain(PASSWORD);
    expect(api).toContain("[redacted]");
  });

  it("redacts them in every diagnostic writer", () => {
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      lastError: `UpstreamError: ${TOKEN_DOC}`,
      updatedAt: NOW,
    });
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `mystery ${PASSWORD_DOC}` }, NOW);
    openGap(test.db, {
      id: "gap_plain",
      scope: COLLECTOR_SCOPE,
      stream: "cycle",
      startedAt: NOW,
      reason: `collection failed: ${TOKEN_DOC}`,
      detectedAt: NOW,
    });

    const diagnostics = [
      getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError ?? "",
      ...listWarnings(test.db, 100).map((warning) => JSON.stringify(toWarningItem(warning))),
      ...listGaps(test.db, 100).map((gap) => JSON.stringify(toGapItem(gap))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");
    expect(diagnostics).not.toContain(GHP);
    expect(diagnostics).not.toContain(PASSWORD);
  });

  it("does not stall on a pathological credential label", () => {
    // The label shape used to make the classifier quadratic; a payload containing
    // one must be handled in bounded time rather than wedging a collector cycle.
    const label = "aSecretX".repeat(20_000) + "!";
    const started = Date.now();
    const validated = validateMessagesResponse(rawAssistant(`${label}="x"`));
    expect(validated.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// A credential assignment inside an escaped ordinary string, and a repeated
// credential label: both must be handled on the whole path — schema,
// normalisation, diagnostics, storage, the activity DTO — and must not stall.
// ---------------------------------------------------------------------------

describe("escaped assignments inside ordinary string content end to end", () => {
  const CONTAINER = "[17,23,42,91]";
  const OPAQUE = "synthetic-opaque-value-000111222333";

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  function rawAssistant(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_assign",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_assign",
              name: "deploy",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  const CONTAINER_DOC = escapedDocument({ note: `password=${CONTAINER}` });
  const STRING_DOC = escapedDocument({ note: `password="${OPAQUE}"` });

  it("redacts both shapes at the schema-validation stage", () => {
    for (const document of [CONTAINER_DOC, STRING_DOC]) {
      const validated = validateMessagesResponse(rawAssistant(document));
      expect(validated.ok, document).toBe(true);
      if (!validated.ok) return;
      const serialised = JSON.stringify(validated.value.messages);
      expect(serialised, document).not.toContain(CONTAINER);
      expect(serialised, document).not.toContain(OPAQUE);
    }
  });

  it("redacts them through the collector, storage and the activity DTO", async () => {
    const validated = validateMessagesResponse(rawAssistant({ a: CONTAINER_DOC, b: STRING_DOC }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_assign",
      runId: runIdFor(locationId, "ses_assign"),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    expect(JSON.stringify(normalized)).not.toContain(CONTAINER);
    expect(JSON.stringify(normalized)).not.toContain(OPAQUE);

    source.sessions = [session({ id: "ses_assign" })];
    source.agents = [agent("build")];
    source.messages.set("ses_assign", {
      messages: [...validated.value.messages, userMessage("msg_assign_user", NOW + 1, CONTAINER_DOC)],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const stored = (test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[])
      .map((row) => `${row.summary}\n${row.content ?? ""}`)
      .join("\n");
    expect(stored).not.toContain(CONTAINER);
    expect(stored).not.toContain(OPAQUE);

    const api = JSON.stringify(listActivity(test.db, { sessionId: "ses_assign", limit: 100 }).map(toActivityItem));
    expect(api).not.toContain(CONTAINER);
    expect(api).not.toContain(OPAQUE);
    expect(api).toContain("[redacted]");
  });

  it("redacts them in every diagnostic writer", () => {
    setCollectorState(test.db, {
      scope: COLLECTOR_SCOPE,
      holderId: null,
      epoch: 1,
      lastCycleAt: NOW,
      lastCycleOk: false,
      lastError: `UpstreamError: ${CONTAINER_DOC}`,
      updatedAt: NOW,
    });
    recordWarning(test.db, { scope: COLLECTOR_SCOPE, kind: "cycle", detail: `mystery ${STRING_DOC}` }, NOW);
    openGap(test.db, {
      id: "gap_assign",
      scope: COLLECTOR_SCOPE,
      stream: "cycle",
      startedAt: NOW,
      reason: `collection failed: ${CONTAINER_DOC}`,
      detectedAt: NOW,
    });

    const diagnostics = [
      getCollectorState(test.db, COLLECTOR_SCOPE)?.lastError ?? "",
      ...listWarnings(test.db, 100).map((warning) => JSON.stringify(toWarningItem(warning))),
      ...listGaps(test.db, 100).map((gap) => JSON.stringify(toGapItem(gap))),
      JSON.stringify(collectorHealth(test.db, NOW)),
    ].join("\n");
    expect(diagnostics).not.toContain(CONTAINER);
    expect(diagnostics).not.toContain(OPAQUE);
  });

  it("does not stall on a payload of repeated credential labels", () => {
    const label = "api_key.".repeat(20_000) + "!";
    const started = Date.now();
    const validated = validateMessagesResponse(rawAssistant(`${label}="x"`));
    expect(validated.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// Residual findings: an incomplete value boundary, a Unicode-escaped credential
// key, and nested nonsensitive containers. Each must be removed at every layer —
// schema validation, normalisation, SQLite, and the API DTO — so no raw value can
// reach the browser.
// ---------------------------------------------------------------------------

describe("residual redaction findings — boundaries, escaped keys, nested containers", () => {
  const BOUNDARY_LIVE = "opaque-boundary-live-000111222333";
  const UNICODE_LIVE = "opaque-unicode-live-444555666777";
  const NESTED_LIVE = "ghp_abcdefghijklmnopqrstuvwx";

  /** A raw assistant tool part, shaped like the documented upstream payload. */
  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r1",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r1",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  /** The escaped form a serialised tool input takes. */
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  function nestedObject(depth: number, leaf: unknown): unknown {
    let node = leaf;
    for (let i = 0; i < depth; i += 1) node = { a: node };
    return node;
  }

  /** Validate, normalise, persist and read back one tool input; return every surface. */
  function roundTrip(input: unknown, sessionId: string) {
    const validated = validateMessagesResponse(rawToolPayload(input));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validation failed");

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId: runIdFor(locationId, sessionId),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId, limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    const items = stored.map(toActivityItem);
    return {
      validated: JSON.stringify(validated.value.messages),
      normalized: JSON.stringify(normalized),
      stored: stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n"),
      api: JSON.stringify(items),
    };
  }

  it("removes a credential whose delimited value is followed by a continuation", () => {
    // Regression: `password="abc"opaque` redacted only `"abc"` and stranded the
    // continuation with no key in front of it.
    const surfaces = roundTrip({ note: `password="abc"${BOUNDARY_LIVE}` }, "ses_boundary");

    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, layer).not.toContain(BOUNDARY_LIVE);
    }
    // The scan failed closed rather than keeping the tail.
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("removes a credential under a Unicode-escaped key", () => {
    // `{\"access\u0054oken\":\"…\"}` is the escaped spelling of `accessToken`.
    const doc = `{\\"access\\u0054oken\\":\\"${UNICODE_LIVE}\\"}`;
    const surfaces = roundTrip({ note: doc }, "ses_unicode");

    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, layer).not.toContain(UNICODE_LIVE);
    }
    expect(surfaces.stored).toContain("[redacted]");
  });

  it("removes a credential near the end of a nested container", () => {
    const doc = escapedDocument(nestedObject(6, { k: NESTED_LIVE }));
    const surfaces = roundTrip({ note: doc }, "ses_nested");

    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, layer).not.toContain(NESTED_LIVE);
    }
    expect(surfaces.stored).toContain("[redacted]");
    expect(surfaces.stored).not.toContain("[redacted:uninspected]");
  });

  it("fails closed on nesting past the depth cap, and still leaks nothing", () => {
    const doc = escapedDocument(nestedObject(40, { k: NESTED_LIVE }));
    const surfaces = roundTrip({ note: doc }, "ses_deep");

    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, layer).not.toContain(NESTED_LIVE);
    }
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("never persists any of the three shapes through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual", {
      messages: [
        assistantMessage("msg_r1", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `password="abc"${BOUNDARY_LIVE}`),
          toolPart("tool_2", "curl", `{\\"access\\u0054oken\\":\\"${UNICODE_LIVE}\\"}`),
          toolPart("tool_3", "scan", escapedDocument(nestedObject(6, { k: NESTED_LIVE }))),
        ]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    for (const secret of [BOUNDARY_LIVE, UNICODE_LIVE, NESTED_LIVE]) {
      expect(joined, secret).not.toContain(secret);
    }

    for (const item of listActivity(test.db, { sessionId: "ses_residual", limit: 100 }).map(toActivityItem)) {
      const text = `${item.summary}\n${item.content ?? ""}`;
      for (const secret of [BOUNDARY_LIVE, UNICODE_LIVE, NESTED_LIVE]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Second residual round: a brace inside a container's quoted string, a key escape
// hidden one layer deeper, a bare assignment with a quoted continuation, and an
// incomplete private-key block. Each must be removed at every layer — schema
// validation, normalisation, SQLite, and the API DTO.
// ---------------------------------------------------------------------------

describe("second residual round — container strings, nested escapes, bare continuations, PEM", () => {
  const CONTAINER_LIVE = "opaque-container-live-000111222333";
  const NESTED_ESCAPE_LIVE = "opaque-nested-escape-444555666777";
  const BARE_CONTINUATION_LIVE = "opaque-bare-continuation-888999000111";
  const PEM_LIVE = "opaque-pem-live-222333444555";

  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r2",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r2",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  function roundTrip(input: unknown, sessionId: string) {
    const validated = validateMessagesResponse(rawToolPayload(input));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validation failed");

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId: runIdFor(locationId, sessionId),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId, limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    return {
      validated: JSON.stringify(validated.value.messages),
      normalized: JSON.stringify(normalized),
      stored: stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n"),
      api: JSON.stringify(stored.map(toActivityItem)),
    };
  }

  function expectAbsent(surfaces: Record<string, string>, secret: string): void {
    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, `${layer}:${secret}`).not.toContain(secret);
    }
  }

  it("removes a credential whose container holds a brace inside a quoted string", () => {
    const surfaces = roundTrip({ note: `password={"value":"},${CONTAINER_LIVE}"}` }, "ses_container_string");
    expectAbsent(surfaces, CONTAINER_LIVE);
    expect(surfaces.stored).toContain("[redacted]");
  });

  it("removes a credential under a key whose escape resolves one layer deeper", () => {
    const input = String.raw`{"access\\u0054oken":"${NESTED_ESCAPE_LIVE}"}`;
    const surfaces = roundTrip({ note: input }, "ses_nested_escape");
    expectAbsent(surfaces, NESTED_ESCAPE_LIVE);
    expect(surfaces.stored).toContain("[redacted]");
  });

  it("removes a bare assignment with a quoted continuation", () => {
    const surfaces = roundTrip({ note: `password=prefix"${BARE_CONTINUATION_LIVE}"` }, "ses_bare_continuation");
    expectAbsent(surfaces, BARE_CONTINUATION_LIVE);
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("removes an incomplete private-key block", () => {
    const surfaces = roundTrip({ note: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_LIVE}` }, "ses_pem_incomplete");
    expectAbsent(surfaces, PEM_LIVE);
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("never persists any of the four shapes through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual2" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual2", {
      messages: [
        assistantMessage("msg_r2", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `password={"value":"},${CONTAINER_LIVE}"}`),
          toolPart("tool_2", "curl", String.raw`{"access\\u0054oken":"${NESTED_ESCAPE_LIVE}"}`),
          toolPart("tool_3", "scan", `password=prefix"${BARE_CONTINUATION_LIVE}"`),
          toolPart("tool_4", "openssl", `-----BEGIN RSA PRIVATE KEY-----\n${PEM_LIVE}`),
        ]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    for (const secret of [CONTAINER_LIVE, NESTED_ESCAPE_LIVE, BARE_CONTINUATION_LIVE, PEM_LIVE]) {
      expect(joined, secret).not.toContain(secret);
    }

    for (const item of listActivity(test.db, { sessionId: "ses_residual2", limit: 100 }).map(toActivityItem)) {
      const text = `${item.summary}\n${item.content ?? ""}`;
      for (const secret of [CONTAINER_LIVE, NESTED_ESCAPE_LIVE, BARE_CONTINUATION_LIVE, PEM_LIVE]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });

  it("does not stall on a large repeated private-key marker through a cycle", async () => {
    source.sessions = [session({ id: "ses_pem_flood" })];
    source.agents = [agent("build")];
    source.messages.set("ses_pem_flood", {
      messages: [
        assistantMessage("msg_r2", NOW + 1000, "build", [
          toolPart("tool_1", "openssl", "-----BEGIN PRIVATE KEY".repeat(5_000)),
        ]),
      ],
      nextCursor: null,
    });

    const started = Date.now();
    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    // An incomplete block fails closed, so no marker text survives either.
    expect(joined).not.toContain("-----BEGIN");
    expect(joined).toContain("[redacted:uninspected]");
  });
});

// ---------------------------------------------------------------------------
// Third residual round: a bounded preceding-key lookup that failed open on a long
// key or long whitespace run, and the partial redaction an older build wrote
// (`password=[redacted],<leaked tail>`), which the current redactor accepted as a
// complete value. Both must be removed at every layer.
// ---------------------------------------------------------------------------

describe("third residual round — bounded lookup and partial redaction", () => {
  const LONG_KEY_LIVE = "opaque-long-key-live-000111222333";
  const PARTIAL_LIVE = "opaque-partial-live-444555666777";

  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r3",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r3",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  function roundTrip(input: unknown, sessionId: string) {
    const validated = validateMessagesResponse(rawToolPayload(input));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validation failed");

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId: runIdFor(locationId, sessionId),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId, limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    return {
      validated: JSON.stringify(validated.value.messages),
      normalized: JSON.stringify(normalized),
      stored: stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n"),
      api: JSON.stringify(stored.map(toActivityItem)),
    };
  }

  function expectAbsent(surfaces: Record<string, string>, secret: string): void {
    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, `${layer}:${secret}`).not.toContain(secret);
    }
  }

  it("removes a credential behind a long key separated by more whitespace than the bound", () => {
    // The key is longer than the assignment lookup can examine whole, so the
    // assignment fails closed rather than being classified from a truncated suffix.
    const overBound = `password.${"z".repeat(257)}=${" ".repeat(257)}${JSON.stringify({ value: LONG_KEY_LIVE })}`;
    const overBoundSurfaces = roundTrip({ note: overBound }, "ses_long_key");
    expectAbsent(overBoundSurfaces, LONG_KEY_LIVE);
    expect(overBoundSurfaces.stored).toContain("[redacted:uninspected]");

    // A non-sensitive key with a longer-than-bound whitespace gap exercises the
    // preceding-key lookup, which also fails closed.
    const gapSurfaces = roundTrip(
      { note: `region=${" ".repeat(257)}${JSON.stringify({ value: LONG_KEY_LIVE })}` },
      "ses_long_gap",
    );
    expectAbsent(gapSurfaces, LONG_KEY_LIVE);
    expect(gapSurfaces.stored).toContain("[redacted:uninspected]");
  });

  it("removes the partial redaction an older build wrote", () => {
    const surfaces = roundTrip({ note: `password=[redacted],${PARTIAL_LIVE}"}` }, "ses_partial");
    expectAbsent(surfaces, PARTIAL_LIVE);
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("does not over-redact a nearby benign structured value", () => {
    const surfaces = roundTrip({ region: '{"value":"us-east-1"}', count: "[1,2,3]" }, "ses_benign");
    expect(surfaces.stored).toContain("us-east-1");
    expect(surfaces.stored).toContain("[1,2,3]");
    expect(surfaces.stored).not.toContain("[redacted:uninspected]");
  });

  it("never persists either shape through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual3" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual3", {
      messages: [
        assistantMessage("msg_r3", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `password.${"z".repeat(64)}=${" ".repeat(257)}${JSON.stringify({ value: LONG_KEY_LIVE })}`),
          toolPart("tool_2", "curl", `password=[redacted],${PARTIAL_LIVE}"}`),
        ]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    for (const secret of [LONG_KEY_LIVE, PARTIAL_LIVE]) {
      expect(joined, secret).not.toContain(secret);
    }

    for (const item of listActivity(test.db, { sessionId: "ses_residual3", limit: 100 }).map(toActivityItem)) {
      const text = `${item.summary}\n${item.content ?? ""}`;
      for (const secret of [LONG_KEY_LIVE, PARTIAL_LIVE]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fourth residual round: the artifact recovery stopped at the first whitespace
// (or skipped when a space followed the comma), leaving a multi-word leaked
// suffix; and it ran before the structured parse, so a valid JSON document with a
// bare placeholder value lost its siblings. Both must be right at every layer.
// ---------------------------------------------------------------------------

describe("fourth residual round — whitespace artifact suffix and JSON siblings", () => {
  const WS_LIVE = "opaque-whitespace-live-000111222333";
  const MULTIWORD_LIVE = "opaque-multiword-live-444555666777";
  const SIBLING_LIVE = "opaque-sibling-live-888999000111";

  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r4",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r4",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  function roundTrip(input: unknown, sessionId: string) {
    const validated = validateMessagesResponse(rawToolPayload(input));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validation failed");

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId: runIdFor(locationId, sessionId),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId, limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    return {
      validated: JSON.stringify(validated.value.messages),
      normalized: JSON.stringify(normalized),
      stored: stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n"),
      api: JSON.stringify(stored.map(toActivityItem)),
    };
  }

  function expectAbsent(surfaces: Record<string, string>, secret: string): void {
    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, `${layer}:${secret}`).not.toContain(secret);
    }
  }

  it("removes a leaked suffix that begins with whitespace", () => {
    const surfaces = roundTrip({ note: `password=[redacted], ${WS_LIVE}"}` }, "ses_ws_suffix");
    expectAbsent(surfaces, WS_LIVE);
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("removes a multi-word leaked suffix", () => {
    const surfaces = roundTrip({ note: `password=[redacted],first word ${MULTIWORD_LIVE}` }, "ses_multiword");
    expectAbsent(surfaces, MULTIWORD_LIVE);
    expect(surfaces.stored).not.toContain("first word");
  });

  it("preserves a legitimate JSON sibling while repairing the placeholder", () => {
    const surfaces = roundTrip(
      { note: `{"password":[redacted],"region":"${SIBLING_LIVE}"}` },
      "ses_json_sibling",
    );
    expect(surfaces.stored).toContain(SIBLING_LIVE);
    expect(surfaces.stored).toContain("[redacted]");
    expect(surfaces.stored).not.toContain("[redacted:uninspected]");
  });

  it("never persists either shape through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual4" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual4", {
      messages: [
        assistantMessage("msg_r4", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `password=[redacted], multi word ${WS_LIVE}"}`),
          toolPart("tool_2", "curl", `password=[redacted:uninspected] ${MULTIWORD_LIVE}"}`),
          toolPart("tool_3", "jq", `{"password":[redacted],"region":"${SIBLING_LIVE}"}`),
        ]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    for (const secret of [WS_LIVE, MULTIWORD_LIVE]) {
      expect(joined, secret).not.toContain(secret);
    }

    for (const item of listActivity(test.db, { sessionId: "ses_residual4", limit: 100 }).map(toActivityItem)) {
      const text = `${item.summary}\n${item.content ?? ""}`;
      for (const secret of [WS_LIVE, MULTIWORD_LIVE]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fifth residual round: the legacy artifact recovery re-scanned the remaining
// suffix for each marker, which is quadratic on marker-heavy text and could stall
// a collector cycle. It is now one bounded forward pass whose work is charged to
// the shared budget.
// ---------------------------------------------------------------------------

describe("fifth residual round — marker-heavy text does not stall a cycle", () => {
  const ARTIFACT_LIVE = "opaque-artifact-live-000111222333";

  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r5",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r5",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  it("processes a marker-heavy tool input through the full pipeline in bounded time", () => {
    const heavy = "[redacted] ".repeat(8_000);
    const started = Date.now();

    const validated = validateMessagesResponse(rawToolPayload({ note: heavy }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId: "ses_marker_heavy",
      runId: runIdFor(locationId, "ses_marker_heavy"),
      source: "upstream",
      contentMaxChars: 400_000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId: "ses_marker_heavy", limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    for (const item of stored.map(toActivityItem)) {
      expect(`${item.summary}\n${item.content ?? ""}`.length).toBeGreaterThan(0);
    }

    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("still removes a legacy artifact through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual5" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual5", {
      messages: [
        assistantMessage("msg_r5", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `password=[redacted], multi word ${ARTIFACT_LIVE}"}`),
          toolPart("tool_2", "note", "[redacted] ".repeat(500)),
        ]),
      ],
      nextCursor: null,
    });

    const started = Date.now();
    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(joined).not.toContain(ARTIFACT_LIVE);

    for (const item of listActivity(test.db, { sessionId: "ses_residual5", limit: 100 }).map(toActivityItem)) {
      expect(`${item.summary}\n${item.content ?? ""}`).not.toContain(ARTIFACT_LIVE);
    }
  });
});

// ---------------------------------------------------------------------------
// Sixth residual round: recoverable JSON embedded in prose was consumed by the
// legacy-tail recovery because only the whole input was checked for parseability,
// and the recovery's scan was charged only when it changed the text.
// ---------------------------------------------------------------------------

describe("sixth residual round — embedded JSON survives, recovery work is charged", () => {
  const SIBLING_LIVE = "opaque-sibling-live-000111222333";
  const ARTIFACT_LIVE = "opaque-artifact-live-444555666777";

  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r6",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r6",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  function roundTrip(input: unknown, sessionId: string) {
    const validated = validateMessagesResponse(rawToolPayload(input));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validation failed");

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId: runIdFor(locationId, sessionId),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId, limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    return {
      validated: JSON.stringify(validated.value.messages),
      normalized: JSON.stringify(normalized),
      stored: stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n"),
      api: JSON.stringify(stored.map(toActivityItem)),
    };
  }

  it("preserves an embedded document's sibling through the full pipeline", () => {
    const surfaces = roundTrip(
      { note: `config {"password":[redacted],"region":"${SIBLING_LIVE}"} done` },
      "ses_embedded_json",
    );
    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, layer).toContain(SIBLING_LIVE);
      expect(text, layer).toContain("done");
    }
    expect(surfaces.stored).not.toContain("[redacted:uninspected]");
  });

  it("still removes a malformed artifact from mixed log text", () => {
    const surfaces = roundTrip(
      { note: `log password=[redacted], multi word ${ARTIFACT_LIVE}"}` },
      "ses_mixed_log",
    );
    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, layer).not.toContain(ARTIFACT_LIVE);
      expect(text, layer).not.toContain("multi word");
    }
    expect(surfaces.stored).toContain("[redacted:uninspected]");
  });

  it("never persists a marker-heavy input's tail through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual6" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual6", {
      messages: [
        assistantMessage("msg_r6", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `config {"password":[redacted],"region":"${SIBLING_LIVE}"} done`),
          toolPart("tool_2", "curl", `log password=[redacted], multi word ${ARTIFACT_LIVE}"}`),
        ]),
      ],
      nextCursor: null,
    });

    const started = Date.now();
    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(joined).not.toContain(ARTIFACT_LIVE);
    expect(joined).toContain(SIBLING_LIVE);

    for (const item of listActivity(test.db, { sessionId: "ses_residual6", limit: 100 }).map(toActivityItem)) {
      const text = `${item.summary}\n${item.content ?? ""}`;
      expect(text).not.toContain(ARTIFACT_LIVE);
    }
  });
});

// ---------------------------------------------------------------------------
// Seventh residual round: the assignment key lookup kept only the last 64
// characters of the key run, so a long credential key whose sensitive prefix was
// earlier was read as a non-credential suffix and its quoted value was split
// around the `[42]` inside it.
// ---------------------------------------------------------------------------

describe("seventh residual round — a long credential key is examined whole", () => {
  const SUFFIX_LIVE = "suffix-opaque-live-000111222333";
  const VALUE = `="prefix[42]${SUFFIX_LIVE}"`;
  const LIMIT = 256;
  const keyOf = (length: number): string => `password.${"z".repeat(length - "password.".length)}`;

  function rawToolPayload(input: unknown): unknown {
    return {
      data: [
        {
          id: "msg_r7",
          type: "assistant",
          time: { created: NOW, completed: NOW + 1000 },
          agent: "build",
          model: { id: "claude", providerID: "anthropic" },
          content: [
            {
              type: "tool",
              id: "tool_r7",
              name: "shell",
              time: { created: NOW, completed: NOW + 1000 },
              state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
  }

  function roundTrip(input: unknown, sessionId: string) {
    const validated = validateMessagesResponse(rawToolPayload(input));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validation failed");

    const locationId = locationIdFor("/srv/demo");
    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId: runIdFor(locationId, sessionId),
      source: "upstream",
      contentMaxChars: 4000,
      ingestedAt: NOW,
      messages: validated.value.messages,
    });
    for (const event of normalized.events) upsertActivityEvent(test.db, event, NOW);

    const stored = listActivity(test.db, { sessionId, limit: 100 });
    expect(stored.length).toBeGreaterThan(0);
    return {
      validated: JSON.stringify(validated.value.messages),
      normalized: JSON.stringify(normalized),
      stored: stored.map((event) => `${event.summary}\n${event.content ?? ""}`).join("\n"),
      api: JSON.stringify(stored.map(toActivityItem)),
    };
  }

  function expectAbsent(surfaces: Record<string, string>, secret: string): void {
    for (const [layer, text] of Object.entries(surfaces)) {
      expect(text, `${layer}:${secret}`).not.toContain(secret);
    }
  }

  it("removes the reported long-key credential at every layer", () => {
    const surfaces = roundTrip({ note: `password.${"z".repeat(64)}${VALUE}` }, "ses_long_key_repro");
    expectAbsent(surfaces, SUFFIX_LIVE);
    expectAbsent(surfaces, "[42]");
    expect(surfaces.stored).toContain("[redacted]");
  });

  it("removes a key at the bound and fails closed one character beyond it", () => {
    const atBound = roundTrip({ note: `${keyOf(LIMIT)}${VALUE}` }, "ses_long_key_at_bound");
    expectAbsent(atBound, SUFFIX_LIVE);
    expect(atBound.stored).toContain("[redacted]");
    expect(atBound.stored).not.toContain("[redacted:uninspected]");

    const overBound = roundTrip({ note: `${keyOf(LIMIT + 1)}${VALUE}` }, "ses_long_key_over_bound");
    expectAbsent(overBound, SUFFIX_LIVE);
    expect(overBound.stored).toContain("[redacted:uninspected]");
  });

  it("never persists the long-key credential through a real collector cycle", async () => {
    source.sessions = [session({ id: "ses_residual7" })];
    source.agents = [agent("build")];
    source.messages.set("ses_residual7", {
      messages: [
        assistantMessage("msg_r7", NOW + 1000, "build", [
          toolPart("tool_1", "shell", `password.${"z".repeat(64)}${VALUE}`),
          toolPart("tool_2", "curl", `${keyOf(LIMIT + 1)}${VALUE}`),
        ]),
      ],
      nextCursor: null,
    });

    const result = await runCycle(makeDeps(), "c1");
    expect(result?.ok).toBe(true);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as {
      summary: string;
      content: string | null;
    }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(joined).not.toContain(SUFFIX_LIVE);

    for (const item of listActivity(test.db, { sessionId: "ses_residual7", limit: 100 }).map(toActivityItem)) {
      expect(`${item.summary}\n${item.content ?? ""}`).not.toContain(SUFFIX_LIVE);
    }
  });
});
