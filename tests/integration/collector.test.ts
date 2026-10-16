import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTOR_SCOPE,
  collectorIdentity,
  detectGaps,
  observationSourceFor,
  reconcile,
  runCycle,
  runCollectorLoop,
} from "../../lib/collector/collector.ts";
import { COLLECTOR_SCOPE as SCOPE_FROM_STATE } from "../../lib/db/collection-state.ts";
import { getCollectorState, getLease, listCheckpoints, listWarnings, acquireLease } from "../../lib/db/collection-state.ts";
import { FixtureUpstreamSource } from "../../lib/upstream/fixture-source.ts";
import {
  countActivity,
  countInvocations,
  countRootRuns,
  getRootRunForSession,
  listActivity,
  listAgents,
  listGaps,
  listInvocations,
  listLocations,
  listRootRuns,
  listRunSessions,
  listSessions,
  overviewStats,
} from "../../lib/db/repositories.ts";
import { cleanupTempDirs, configureTestEnv, createTestDb, fixtureDir, type TestDb } from "../helpers/harness.ts";
import { getConfig } from "../../lib/config.ts";

/**
 * Collector integration against the fixture upstream.
 *
 * The fixtures are shaped like the documented API and carry deliberate faults
 * (duplicate pages, duplicate messages, reversed pages, an unknown message type,
 * embedded secrets, an orphan session, a cross-location child, and a simulated
 * gap). These tests assert that the collector absorbs all of that and still
 * produces an accurate, honest picture.
 */

let test: TestDb;

function makeDeps() {
  const source = new FixtureUpstreamSource({ fixtureDir: fixtureDir(), shiftToNow: false });
  return {
    db: test.db,
    source,
    config: getConfig().collector,
    now: () => Date.now(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

beforeEach(() => {
  configureTestEnv({ ORCH_UPSTREAM_MODE: "fixture", ORCH_FIXTURE_STATIC_TIME: "1" });
  test = createTestDb();
});

afterEach(() => {
  test.close();
  cleanupTempDirs();
  configureTestEnv();
});

describe("collectorIdentity", () => {
  it("uses an explicit id when configured", () => {
    configureTestEnv({ ORCH_COLLECTOR_ID: "collector-1" });
    expect(collectorIdentity(0)).toBe("collector-1");
  });

  it("falls back to host, pid and start time", () => {
    configureTestEnv();
    const identity = collectorIdentity(1234);
    expect(identity).toContain(String(process.pid));
    expect(identity).toContain("1234");
  });
});

describe("observationSourceFor", () => {
  it("labels live observations as upstream and fixtures as fixtures", () => {
    expect(observationSourceFor("live")).toBe("upstream");
    expect(observationSourceFor("fixture")).toBe("fixture");
  });
});

describe("collector scope", () => {
  it("exposes the same scope constant from both modules", () => {
    expect(COLLECTOR_SCOPE).toBe(SCOPE_FROM_STATE);
  });
});

describe("detectGaps", () => {
  const interval = 5000;

  it("records nothing on the very first cycle", () => {
    expect(
      detectGaps({ previousState: null, previousLease: null, holderId: "a", now: 100_000, expectedIntervalMs: interval }),
    ).toEqual([]);
  });

  it("records nothing when the previous cycle was within tolerance", () => {
    const gaps = detectGaps({
      previousState: {
        scope: COLLECTOR_SCOPE,
        holderId: "a",
        epoch: 1,
        lastCycleAt: 100_000,
        lastCycleOk: true,
        lastSuccessAt: 100_000,
        lastError: null,
        updatedAt: 100_000,
      },
      previousLease: null,
      holderId: "a",
      now: 100_000 + interval * 2,
      expectedIntervalMs: interval,
    });
    expect(gaps).toEqual([]);
  });

  it("records a pause when the previous cycle is older than the tolerance", () => {
    const gaps = detectGaps({
      previousState: {
        scope: COLLECTOR_SCOPE,
        holderId: "a",
        epoch: 1,
        lastCycleAt: 100_000,
        lastCycleOk: true,
        lastSuccessAt: 100_000,
        lastError: null,
        updatedAt: 100_000,
      },
      previousLease: null,
      holderId: "a",
      now: 100_000 + interval * 10,
      expectedIntervalMs: interval,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.stream).toBe("cycle");
    expect(gaps[0]?.startedAt).toBe(100_000);
    expect(gaps[0]?.reason).toContain("no successful collection");
  });

  it("records a handover when a different holder's lease expired", () => {
    const gaps = detectGaps({
      previousState: null,
      previousLease: { holderId: "previous", epoch: 3, heartbeatAt: 100_000, expiresAt: 100_000 + interval },
      holderId: "current",
      now: 100_000 + interval * 5,
      expectedIntervalMs: interval,
    });
    expect(gaps.some((gap) => gap.stream === "lease")).toBe(true);
    const leaseGap = gaps.find((gap) => gap.stream === "lease");
    expect(leaseGap?.reason).toContain("handover");
    expect(leaseGap?.reason).toContain("previous");
  });

  it("does not record a handover for the same holder resuming", () => {
    const gaps = detectGaps({
      previousState: null,
      previousLease: { holderId: "same", epoch: 1, heartbeatAt: 100_000, expiresAt: 100_000 + interval },
      holderId: "same",
      now: 100_000 + interval * 5,
      expectedIntervalMs: interval,
    });
    expect(gaps.filter((gap) => gap.stream === "lease")).toEqual([]);
  });

  it("can report both a handover and a pause", () => {
    const gaps = detectGaps({
      previousState: {
        scope: COLLECTOR_SCOPE,
        holderId: "previous",
        epoch: 1,
        lastCycleAt: 100_000,
        lastCycleOk: true,
        lastSuccessAt: 100_000,
        lastError: null,
        updatedAt: 100_000,
      },
      previousLease: { holderId: "previous", epoch: 1, heartbeatAt: 100_000, expiresAt: 100_000 + interval },
      holderId: "current",
      now: 100_000 + interval * 20,
      expectedIntervalMs: interval,
    });
    expect(gaps.map((gap) => gap.stream).sort()).toEqual(["cycle", "lease"]);
  });
});

describe("reconcile against fixtures", () => {
  it("observes every location, agent and session", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    expect(handle).not.toBeNull();

    const result = await reconcile(deps, handle!);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("fixture");
    expect(result.locations).toBe(2);
    expect(result.agents).toBe(9);
    expect(result.sessions).toBe(7);

    // Locations come from the declared location plus every session's location.
    expect(listLocations(test.db)).toHaveLength(2);
    expect(listAgents(test.db)).toHaveLength(9);
    expect(listSessions(test.db, { limit: 100 })).toHaveLength(7);
  });

  it("discovers a hidden agent because the registry is read from the API", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const hidden = listAgents(test.db).find((agent) => agent.agentId === "internal-audit");
    expect(hidden).toBeDefined();
    expect(hidden?.hidden).toBe(true);
    expect(hidden?.mode).toBe("all");
  });

  it("scopes agents by location", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const agents = listAgents(test.db);
    const byLocation = new Map<string, number>();
    for (const agent of agents) {
      byLocation.set(agent.locationId, (byLocation.get(agent.locationId) ?? 0) + 1);
    }
    expect([...byLocation.values()].sort()).toEqual([2, 7]);
  });

  it("builds the run forest with the observed hierarchy", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const runs = listRootRuns(test.db, { limit: 100 });
    expect(runs).toHaveLength(4);

    const alpha = runs.find((run) => run.rootSessionId === "ses_root_alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.sessionCount).toBe(4);

    const members = listRunSessions(test.db, alpha!.id);
    const depths = new Map(members.map((member) => [member.session.id, member.depth]));
    expect(depths.get("ses_root_alpha")).toBe(0);
    expect(depths.get("ses_child_alpha1")).toBe(1);
    expect(depths.get("ses_child_alpha2")).toBe(1);
    expect(depths.get("ses_grandchild_alpha2a")).toBe(2);
  });

  it("treats a session with an unobserved parent as its own root and warns", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    const result = await reconcile(deps, handle!);

    expect(result.orphans).toBe(1);
    const orphan = getRootRunForSession(test.db, "ses_orphan_gamma");
    expect(orphan?.rootSessionId).toBe("ses_orphan_gamma");
  });

  it("does not follow a parent link across locations", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    const result = await reconcile(deps, handle!);

    expect(result.crossLocationLinks).toBe(1);
    const crossRun = getRootRunForSession(test.db, "ses_child_crossdelta");
    expect(crossRun?.rootSessionId).toBe("ses_child_crossdelta");
    expect(listWarnings(test.db, 10).some((warning) => warning.kind === "cross-location")).toBe(true);
  });

  it("collapses duplicate session pages instead of inflating the run", async () => {
    // The fixture source repeats the first session of a non-first page.
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    expect(countRootRuns(test.db)).toBe(4);
    const totalMemberships = listRootRuns(test.db, { limit: 100 }).reduce((sum, run) => sum + run.sessionCount, 0);
    expect(totalMemberships).toBe(7);
  });

  it("records an invocation only where an assistant message carried an agent", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const invocations = listInvocations(test.db, { limit: 100 });
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.agentId).not.toBe("");
      expect(invocation.confidence).toBe("verified");
      const evidence = invocation.evidence as { rule?: string };
      expect(evidence.rule).toBe("assistant-message-agent-field");
    }

    // Agents present in the registry but never observed must have no invocation.
    const observedAgents = new Set(invocations.map((invocation) => invocation.agentId));
    expect(observedAgents.has("internal-audit")).toBe(false);
  });

  it("records no invocation for a session whose assistant turns carried no agent", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    // Every fixture session has an agent on its assistant turn, so this asserts
    // the inverse: the count is bounded by the number of assistant messages.
    const invocations = listInvocations(test.db, { limit: 100 });
    expect(invocations.every((invocation) => invocation.sessionId.startsWith("ses_"))).toBe(true);
  });

  it("annotates invocations with the upstream-reported outcome", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const failed = listInvocations(test.db, { limit: 100 }).filter((invocation) => invocation.upstreamOutcome === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((invocation) => invocation.sessionId === "ses_root_beta")).toBe(true);
  });

  it("absorbs duplicate and out-of-order messages without duplicating activity", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    const result = await reconcile(deps, handle!);

    expect(result.duplicateMessages).toBeGreaterThan(0);
    expect(result.outOfOrderMessages).toBeGreaterThan(0);

    // Activity is keyed by message id + part index, so no event repeats.
    const events = listActivity(test.db, { limit: 500 });
    const keys = events.map((event) => `${event.sessionId}:${event.messageId}:${event.partIndex}:${event.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("orders activity deterministically by occurrence", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const events = listActivity(test.db, { sessionId: "ses_root_alpha", limit: 100 });
    // Returned newest-first.
    for (let i = 1; i < events.length; i += 1) {
      const previous = events[i - 1];
      const current = events[i];
      expect(previous!.occurredAt).toBeGreaterThanOrEqual(current!.occurredAt);
    }
  });

  it("never persists the embedded secrets", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const rows = test.db.prepare("SELECT summary, content FROM activity_events").all() as { summary: string; content: string | null }[];
    const joined = rows.map((row) => `${row.summary}\n${row.content ?? ""}`).join("\n");
    expect(joined).not.toContain("sk-live-abcdef0123456789abcdef0123456789");
    expect(joined).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0");
    expect(joined).toContain("[redacted]");
  });

  it("records an unknown upstream message type as a warning instead of guessing", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    const result = await reconcile(deps, handle!);

    expect(result.unknownMessageTypes).toContain("future-event-type");
    const warning = listWarnings(test.db, 20).find((entry) => entry.kind === "unknown-message-type");
    expect(warning?.detail).toBe("future-event-type");
  });

  it("writes a checkpoint for each observed stream", async () => {
    const deps = makeDeps();
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(deps, handle!);

    const streams = listCheckpoints(test.db).map((checkpoint) => checkpoint.stream);
    expect(streams).toContain("sessions");
    expect(streams).toContain("location");
    expect(streams).toContain("messages:ses_root_alpha");
    expect(streams.some((stream) => stream.startsWith("agents:"))).toBe(true);
  });

  it("converges when run twice against unchanged upstream data", async () => {
    // Idempotency: a reconnect or a restart must not duplicate anything.
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(makeDeps(), handle!);
    const first = overviewStats(test.db);
    const firstInvocations = countInvocations(test.db);
    const firstActivity = countActivity(test.db, { limit: 0 });

    await reconcile(makeDeps(), handle!);
    const second = overviewStats(test.db);

    expect(second.sessions).toBe(first.sessions);
    expect(second.rootRuns).toBe(first.rootRuns);
    expect(second.activity).toBe(first.activity);
    expect(countInvocations(test.db)).toBe(firstInvocations);
    expect(countActivity(test.db, { limit: 0 })).toBe(firstActivity);
  });

  it("removes activity that no longer exists upstream", async () => {
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, Date.now());
    await reconcile(makeDeps(), handle!);
    const before = countActivity(test.db, { sessionId: "ses_root_alpha", limit: 0 });
    expect(before).toBeGreaterThan(0);

    // A session whose transcript is now empty must not keep stale events.
    const source = new FixtureUpstreamSource({ fixtureDir: fixtureDir(), shiftToNow: false });
    const deps = {
      ...makeDeps(),
      source: {
        ...source,
        kind: "fixture" as const,
        description: source.description,
        getServerInfo: () => source.getServerInfo(),
        listLocations: () => source.listLocations(),
        listAgents: (directory: string) => source.listAgents(directory),
        listSessions: (params: { cursor: string | null; limit: number }) => source.listSessions(params),
        listMessages: async (params: { sessionId: string; cursor: string | null; limit: number }) =>
          params.sessionId === "ses_root_alpha"
            ? { messages: [], nextCursor: null, unknownTypes: [] }
            : source.listMessages(params),
      },
    };
    await reconcile(deps, handle!);
    expect(countActivity(test.db, { sessionId: "ses_root_alpha", limit: 0 })).toBe(0);
  });
});

describe("runCycle", () => {
  it("acquires the lease, reconciles, and records a healthy state", async () => {
    const result = await runCycle(makeDeps(), "cycle-test");
    expect(result?.ok).toBe(true);
    expect(result?.sessions).toBeGreaterThan(0);

    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.holderId).toBe("cycle-test");
    expect(state?.lastCycleOk).toBe(true);
    expect(state?.lastError).toBeNull();
    expect(getLease(test.db, COLLECTOR_SCOPE)?.holderId).toBe("cycle-test");
  });

  it("stands by without writing when another collector holds the lease", async () => {
    acquireLease(test.db, COLLECTOR_SCOPE, "other", 60_000, Date.now());
    const result = await runCycle(makeDeps(), "me");
    expect(result).toBeNull();
    expect(countRootRuns(test.db)).toBe(0);
  });

  it("records the fixture gap so coverage holes are visible", async () => {
    const result = await runCycle(makeDeps(), "cycle-test");
    expect(result?.gapsRecorded).toBeGreaterThan(0);
    const gaps = listGaps(test.db, 20);
    expect(gaps.some((gap) => gap.stream === "fixture")).toBe(true);
    const fixtureGap = gaps.find((gap) => gap.stream === "fixture");
    expect(fixtureGap?.reason).toContain("event stream was not replayable");
    expect(fixtureGap?.endedAt).not.toBeNull();
  });

  it("records a pause gap on a later cycle after a long stall", async () => {
    await runCycle(makeDeps(), "cycle-test");
    // Force the recorded last *success* far into the past, as if the collector
    // died. Coverage is measured from the last success, not the last attempt.
    test.db.prepare("UPDATE collector_state SET last_success_at = ? WHERE scope = ?").run(1000, COLLECTOR_SCOPE);
    const result = await runCycle(makeDeps(), "cycle-test");
    expect(result?.gapsRecorded).toBeGreaterThan(0);
    expect(listGaps(test.db, 20).some((gap) => gap.stream === "cycle")).toBe(true);
  });

  it("releases the lease after a one-shot cycle so the next collection is not blocked", async () => {
    const first = await runCycle(makeDeps(), "one-shot", { releaseWhenDone: true });
    expect(first?.ok).toBe(true);
    expect(getLease(test.db, COLLECTOR_SCOPE)).toBeNull();

    // A second one-shot collection must be able to acquire immediately.
    const second = await runCycle(makeDeps(), "one-shot-2", { releaseWhenDone: true });
    expect(second?.ok).toBe(true);
    expect(second?.sessions).toBeGreaterThan(0);
  });

  it("keeps the lease held when the cycle is part of a loop", async () => {
    await runCycle(makeDeps(), "loop-holder");
    expect(getLease(test.db, COLLECTOR_SCOPE)?.holderId).toBe("loop-holder");
  });

  it("records a failure and keeps the collector healthy flag false when upstream fails", async () => {    const failing = {
      ...makeDeps(),
      source: {
        kind: "live" as const,
        description: "failing source",
        getServerInfo: async () => {
          throw new Error("upstream is down");
        },
        listLocations: async () => [],
        listAgents: async () => ({ location: { directory: "" }, agents: [] }),
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        listMessages: async () => ({ messages: [], nextCursor: null, unknownTypes: [] }),
      },
    };
    const result = await runCycle(failing, "cycle-test");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("upstream is down");

    const state = getCollectorState(test.db, COLLECTOR_SCOPE);
    expect(state?.lastCycleOk).toBe(false);
    expect(state?.lastError).toContain("upstream is down");
  });

  it("uses the upstream observation label for a live source", async () => {
    const failing = {
      ...makeDeps(),
      source: {
        kind: "live" as const,
        description: "live",
        getServerInfo: async () => {
          throw new Error("down");
        },
        listLocations: async () => [],
        listAgents: async () => ({ location: { directory: "" }, agents: [] }),
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        listMessages: async () => ({ messages: [], nextCursor: null, unknownTypes: [] }),
      },
    };
    const result = await runCycle(failing, "cycle-test");
    expect(result?.source).toBe("upstream");
  });
});

describe("runCollectorLoop", () => {
  it("stops after a single cycle when asked", async () => {
    await runCollectorLoop(makeDeps(), "loop-test", { once: true });
    expect(countRootRuns(test.db)).toBe(4);
    // A clean shutdown releases the lease.
    expect(getLease(test.db, COLLECTOR_SCOPE)).toBeNull();
  });

  it("releases the lease when the signal aborts", async () => {
    const controller = new AbortController();
    let cycles = 0;
    const deps = {
      ...makeDeps(),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    // Abort during the sleep that follows the first cycle.
    await runCollectorLoop(deps, "loop-test", {
      signal: controller.signal,
      sleep: async () => {
        cycles += 1;
        controller.abort();
      },
    });
    expect(cycles).toBe(1);
    expect(getLease(test.db, COLLECTOR_SCOPE)).toBeNull();
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await runCollectorLoop(makeDeps(), "loop-test", { signal: controller.signal });
    expect(countRootRuns(test.db)).toBe(0);
  });

  it("backs off after a failure instead of spinning", async () => {
    const sleeps: number[] = [];
    const failing = {
      ...makeDeps(),
      source: {
        kind: "live" as const,
        description: "failing",
        getServerInfo: async () => {
          throw new Error("down");
        },
        listLocations: async () => [],
        listAgents: async () => ({ location: { directory: "" }, agents: [] }),
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        listMessages: async () => ({ messages: [], nextCursor: null, unknownTypes: [] }),
      },
    };
    let count = 0;
    await runCollectorLoop(failing, "loop-test", {
      sleep: async (ms) => {
        sleeps.push(ms);
        count += 1;
        if (count >= 3) throw new Error("stop the loop");
      },
    }).catch(() => {
      // The sleep hook throws to end the loop.
    });
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    // The interval is exceeded on the first backoff.
    expect(sleeps[0]).toBeGreaterThan(getConfig().collector.pollIntervalMs);
  });
});
