import { describe, expect, it } from "vitest";
import {
  activityDedupeKey,
  buildRunTree,
  dedupeMessages,
  deriveRunStatus,
  fromStoredSession,
  isUsableMessageId,
  isUsableSessionId,
  normaliseMessageOrder,
  normalizeSessionActivity,
  runIdFor,
  sortMessages,
  toRunTreeSession,
  type RunTreeSessionInput,
} from "../../lib/collector/normalize.ts";
import type { UpstreamMessage, UpstreamSessionInfo } from "../../lib/upstream/schema.ts";

const NOW = 1_800_000_000_000;

// --- builders --------------------------------------------------------------

function userMessage(id: string, created: number, text = "hello"): UpstreamMessage {
  return { type: "user", id, created, text };
}

type TestToolPart = ReturnType<typeof toolPart>;
type TestPart = { kind: "text"; text: string } | { kind: "reasoning"; text: string } | TestToolPart;

function assistantMessage(
  id: string,
  created: number,
  agentId: string | null,
  parts: readonly TestPart[] = [],
  options: { readonly completed?: number | null; readonly finish?: string | null } = {},
): UpstreamMessage {
  return {
    type: "assistant",
    id,
    created,
    completed: options.completed ?? null,
    agentId,
    modelProviderId: "anthropic",
    modelId: "claude",
    parts,
    finish: options.finish ?? "stop",
    errorMessage: null,
  };
}

function toolPart(
  id: string,
  name: string,
  status: "streaming" | "running" | "completed" | "error" = "completed",
  created = 0,
): { kind: "tool"; id: string; name: string; status: "streaming" | "running" | "completed" | "error"; inputSummary: string; outputSummary: string | null; errorMessage: string | null; created: number; completed: number | null; redacted: boolean } {
  return {
    kind: "tool",
    id,
    name,
    status,
    inputSummary: '{"command":"ls"}',
    outputSummary: "file.ts",
    errorMessage: status === "error" ? "boom" : null,
    created,
    completed: status === "completed" || status === "error" ? created + 1000 : null,
    redacted: false,
  };
}

function textPart(text: string): { kind: "text"; text: string } {
  return { kind: "text", text };
}

function idleMessage(id: string, created: number, outcome: "succeeded" | "failed" | "interrupted"): UpstreamMessage {
  return { type: "idle", id, created, outcome };
}

// --- identity --------------------------------------------------------------

describe("identity validation", () => {
  it("accepts documented session id shapes", () => {
    expect(isUsableSessionId("ses_root_alpha")).toBe(true);
    expect(isUsableSessionId("sesAbC123")).toBe(true);
    // The documented pattern is only `^ses`, so a longer word beginning with it
    // is a legitimate id as far as upstream is concerned.
    expect(isUsableSessionId("session_1")).toBe(true);
  });

  it("rejects session ids outside the bounded character set", () => {
    expect(isUsableSessionId("")).toBe(false);
    expect(isUsableSessionId("se")).toBe(false);
    expect(isUsableSessionId("xses_root")).toBe(false);
    expect(isUsableSessionId("ses root")).toBe(false);
    expect(isUsableSessionId("ses/root")).toBe(false);
    expect(isUsableSessionId("ses.root")).toBe(false);
  });

  it("accepts documented message id shapes", () => {
    expect(isUsableMessageId("msg_root_alpha_0001")).toBe(true);
    expect(isUsableMessageId("msg_abc")).toBe(true);
  });

  it("rejects message ids that do not match the documented prefix", () => {
    expect(isUsableMessageId("message_1")).toBe(false);
    expect(isUsableMessageId("msg")).toBe(false);
    expect(isUsableMessageId("msg_")).toBe(false);
  });
});

describe("activityDedupeKey", () => {
  it("is stable for the same coordinates", () => {
    const a = activityDedupeKey({ locationId: "loc_1", sessionId: "ses_1", messageId: "msg_1", partIndex: 0, kind: "message-user" });
    const b = activityDedupeKey({ locationId: "loc_1", sessionId: "ses_1", messageId: "msg_1", partIndex: 0, kind: "message-user" });
    expect(a).toBe(b);
  });

  it("differs when any coordinate differs", () => {
    const base = { locationId: "loc_1", sessionId: "ses_1", messageId: "msg_1", partIndex: 0, kind: "message-user" as const };
    expect(activityDedupeKey(base)).not.toBe(activityDedupeKey({ ...base, partIndex: 1 }));
    expect(activityDedupeKey(base)).not.toBe(activityDedupeKey({ ...base, kind: "tool" }));
    expect(activityDedupeKey(base)).not.toBe(activityDedupeKey({ ...base, sessionId: "ses_2" }));
    expect(activityDedupeKey(base)).not.toBe(activityDedupeKey({ ...base, messageId: "msg_2" }));
    expect(activityDedupeKey(base)).not.toBe(activityDedupeKey({ ...base, locationId: "loc_2" }));
  });

  it("does not collide when a field contains the separator character", () => {
    const a = activityDedupeKey({ locationId: "loc", sessionId: "ses_1", messageId: "msg_1", partIndex: 0, kind: "tool" });
    const b = activityDedupeKey({ locationId: "loc", sessionId: "ses", messageId: "1_msg_1", partIndex: 0, kind: "tool" });
    expect(a).not.toBe(b);
  });
});

// --- ordering and duplication ---------------------------------------------

describe("sortMessages", () => {
  it("orders by creation time ascending", () => {
    const sorted = sortMessages([userMessage("msg_c", 300), userMessage("msg_a", 100), userMessage("msg_b", 200)]);
    expect(sorted.map((m) => m.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  it("breaks ties deterministically by id", () => {
    const sorted = sortMessages([userMessage("msg_z", 100), userMessage("msg_a", 100), userMessage("msg_m", 100)]);
    expect(sorted.map((m) => m.id)).toEqual(["msg_a", "msg_m", "msg_z"]);
  });

  it("does not mutate its input", () => {
    const input = [userMessage("msg_b", 200), userMessage("msg_a", 100)];
    const copy = [...input];
    sortMessages(input);
    expect(input).toEqual(copy);
  });
});

describe("dedupeMessages", () => {
  it("collapses a repeated id and reports the count", () => {
    const result = dedupeMessages([userMessage("msg_a", 100, "first"), userMessage("msg_a", 100, "second")]);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  it("keeps the last observed state for a repeated id", () => {
    // An assistant message is re-observed as it streams; the later copy is the
    // fresher snapshot.
    const result = dedupeMessages([
      assistantMessage("msg_a", 100, "build", [textPart("partial")]),
      assistantMessage("msg_a", 100, "build", [textPart("complete answer")]),
    ]);
    expect(result.unique).toHaveLength(1);
    const message = result.unique[0];
    expect(message?.type).toBe("assistant");
    if (message?.type === "assistant") {
      expect(message.parts[0]).toEqual({ kind: "text", text: "complete answer" });
    }
  });

  it("preserves first-arrival order of distinct ids", () => {
    const result = dedupeMessages([userMessage("msg_c", 300), userMessage("msg_a", 100), userMessage("msg_b", 200)]);
    expect(result.unique.map((m) => m.id)).toEqual(["msg_c", "msg_a", "msg_b"]);
  });

  it("counts every extra occurrence", () => {
    const result = dedupeMessages([userMessage("msg_a", 1), userMessage("msg_a", 1), userMessage("msg_a", 1)]);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicateCount).toBe(2);
  });
});

describe("normaliseMessageOrder", () => {
  it("sorts and reports how many arrivals were older than their predecessor", () => {
    const result = normaliseMessageOrder([userMessage("msg_c", 300), userMessage("msg_a", 100), userMessage("msg_b", 200)]);
    expect(result.sorted.map((m) => m.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
    // c(300) then a(100) is one descent; a(100) then b(200) is ordered.
    expect(result.outOfOrderCount).toBe(1);
  });

  it("counts every descent in a fully reversed sequence", () => {
    const result = normaliseMessageOrder([userMessage("msg_c", 300), userMessage("msg_b", 200), userMessage("msg_a", 100)]);
    expect(result.outOfOrderCount).toBe(2);
  });

  it("reports zero for already-ordered input", () => {
    const result = normaliseMessageOrder([userMessage("msg_a", 100), userMessage("msg_b", 200), userMessage("msg_c", 300)]);
    expect(result.outOfOrderCount).toBe(0);
  });

  it("deduplicates while ordering", () => {
    const result = normaliseMessageOrder([userMessage("msg_b", 200), userMessage("msg_a", 100), userMessage("msg_b", 200)]);
    expect(result.sorted).toHaveLength(2);
    expect(result.duplicateCount).toBe(1);
  });

  it("handles an empty list", () => {
    const result = normaliseMessageOrder([]);
    expect(result.sorted).toEqual([]);
    expect(result.outOfOrderCount).toBe(0);
    expect(result.duplicateCount).toBe(0);
  });
});

// --- activity + invocation normalization -----------------------------------

describe("normalizeSessionActivity", () => {
  const base = {
    locationId: "loc_1",
    sessionId: "ses_1",
    runId: "run_1",
    source: "upstream" as const,
    contentMaxChars: 2000,
    ingestedAt: NOW,
  };

  it("creates one activity event per message, numbered in order", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [userMessage("msg_a", 100), assistantMessage("msg_b", 200, "build", [textPart("done")])],
    });
    expect(result.events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(result.events.map((event) => event.kind)).toEqual(["message-user", "message-assistant"]);
  });

  it("assigns a stable id derived from the dedupe key", () => {
    const first = normalizeSessionActivity({ ...base, messages: [userMessage("msg_a", 100)] });
    const second = normalizeSessionActivity({ ...base, messages: [userMessage("msg_a", 100)] });
    expect(first.events[0]?.id).toBe(second.events[0]?.id);
    expect(first.events[0]?.dedupeKey).toBe(second.events[0]?.dedupeKey);
  });

  it("emits one event per assistant tool part, in part order", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [
        assistantMessage("msg_a", 100, "build", [textPart("t"), toolPart("t1", "read", "completed", 100), toolPart("t2", "bash", "error", 150)]),
      ],
    });
    const tools = result.events.filter((event) => event.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((event) => event.toolName)).toEqual(["read", "bash"]);
    expect(tools.map((event) => event.toolStatus)).toEqual(["completed", "error"]);
    expect(tools.map((event) => event.partIndex)).toEqual([2, 3]);
  });

  it("uses the tool's own timestamps, not the message's", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [assistantMessage("msg_a", 100, "build", [toolPart("t1", "read", "completed", 777)])],
    });
    const tool = result.events.find((event) => event.kind === "tool");
    expect(tool?.occurredAt).toBe(777);
  });

  it("creates an invocation only when the assistant message carries an agent", () => {
    const withAgent = normalizeSessionActivity({ ...base, messages: [assistantMessage("msg_a", 100, "build", [textPart("x")])] });
    expect(withAgent.invocations).toHaveLength(1);

    const withoutAgent = normalizeSessionActivity({ ...base, messages: [assistantMessage("msg_a", 100, null, [textPart("x")])] });
    expect(withoutAgent.invocations).toHaveLength(0);
  });

  it("does not create an invocation when there is no run", () => {
    const result = normalizeSessionActivity({
      ...base,
      runId: null,
      messages: [assistantMessage("msg_a", 100, "build", [textPart("x")])],
    });
    expect(result.invocations).toHaveLength(0);
  });

  it("does not create an invocation from a user or system message", () => {
    const result = normalizeSessionActivity({ ...base, messages: [userMessage("msg_a", 100), idleMessage("msg_b", 200, "succeeded")] });
    expect(result.invocations).toHaveLength(0);
  });

  it("records the evidence that justified the invocation", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [
        userMessage("msg_trigger", 100),
        assistantMessage("msg_a", 200, "builder-complex", [toolPart("t1", "edit", "completed", 200), toolPart("t2", "bash", "completed", 250)], {
          completed: 300,
        }),
      ],
    });
    const invocation = result.invocations[0];
    expect(invocation?.agentId).toBe("builder-complex");
    expect(invocation?.confidence).toBe("verified");
    expect(invocation?.toolCallCount).toBe(2);
    expect(invocation?.endedAt).toBe(300);
    expect(invocation?.triggerMessageId).toBe("msg_trigger");

    const evidence = JSON.parse(invocation?.evidenceJson ?? "{}") as Record<string, unknown>;
    expect(evidence.rule).toBe("assistant-message-agent-field");
    expect(evidence.assistantMessageId).toBe("msg_a");
    expect(evidence.agentField).toBe("builder-complex");
    expect(evidence.toolCallIds).toEqual(["t1", "t2"]);
  });

  it("links an invocation to the nearest preceding user or system message", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [
        userMessage("msg_first", 100),
        assistantMessage("msg_a", 200, "build", [textPart("x")]),
        userMessage("msg_second", 300),
        assistantMessage("msg_b", 400, "plan", [textPart("y")]),
      ],
    });
    expect(result.invocations[0]?.triggerMessageId).toBe("msg_first");
    expect(result.invocations[1]?.triggerMessageId).toBe("msg_second");
  });

  it("annotates an invocation with the upstream outcome that followed it", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [userMessage("msg_u", 100), assistantMessage("msg_a", 200, "build", [textPart("x")]), idleMessage("msg_i", 900, "failed")],
    });
    expect(result.invocations[0]?.upstreamOutcome).toBe("failed");
  });

  it("leaves the outcome null when upstream never reported one", () => {
    const result = normalizeSessionActivity({ ...base, messages: [userMessage("msg_u", 100), assistantMessage("msg_a", 200, "build", [textPart("x")])] });
    expect(result.invocations[0]?.upstreamOutcome).toBeNull();
  });

  it("does not let an earlier idle report leak onto a later invocation", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [
        userMessage("msg_u1", 100),
        assistantMessage("msg_a1", 200, "build", [textPart("x")]),
        idleMessage("msg_i1", 300, "succeeded"),
        userMessage("msg_u2", 400),
        assistantMessage("msg_a2", 500, "build", [textPart("y")]),
      ],
    });
    // The first invocation is followed by an idle report, so it is annotated.
    expect(result.invocations[0]?.upstreamOutcome).toBe("succeeded");
    // The second has no report *after* it. An outcome observed before an
    // invocation is not evidence about that invocation, so it must stay unknown
    // rather than borrowing the earlier success. A resumed session must not
    // appear to have succeeded before it produced anything.
    expect(result.invocations[1]?.upstreamOutcome).toBeNull();
  });

  it("keeps an invocation unknown when the only report precedes it", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [
        idleMessage("msg_i1", 100, "failed"),
        userMessage("msg_u", 200),
        assistantMessage("msg_a", 300, "build", [textPart("x")]),
      ],
    });
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.upstreamOutcome).toBeNull();
  });

  it("derives a stable invocation id from location, session and message", () => {
    const first = normalizeSessionActivity({ ...base, messages: [assistantMessage("msg_a", 100, "build", [textPart("x")])] });
    const second = normalizeSessionActivity({ ...base, messages: [assistantMessage("msg_a", 100, "build", [textPart("x")])] });
    expect(first.invocations[0]?.id).toBe(second.invocations[0]?.id);
  });

  it("reports the duplicate and out-of-order counts it absorbed", () => {
    const result = normalizeSessionActivity({
      ...base,
      messages: [userMessage("msg_c", 300), userMessage("msg_a", 100), userMessage("msg_a", 100)],
    });
    expect(result.duplicateMessageCount).toBe(1);
    expect(result.outOfOrderCount).toBe(1);
  });

  it("redacts and truncates stored content while keeping the summary", () => {
    const result = normalizeSessionActivity({
      ...base,
      contentMaxChars: 40,
      messages: [userMessage("msg_a", 100, "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv and then more text")],
    });
    const event = result.events[0];
    expect(event?.redacted).toBe(true);
    expect(event?.content ?? "").not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(event?.summary ?? "").not.toContain("ghp_abcdefghijklmnopqrstuv");
  });

  it("summarises an idle message as an upstream report, not a verdict", () => {
    const result = normalizeSessionActivity({ ...base, messages: [idleMessage("msg_i", 100, "succeeded")] });
    expect(result.events[0]?.summary).toContain("upstream reported outcome: succeeded");
    expect(result.events[0]?.upstreamOutcome).toBe("succeeded");
  });

  it("handles an empty message list", () => {
    const result = normalizeSessionActivity({ ...base, messages: [] });
    expect(result.events).toEqual([]);
    expect(result.invocations).toEqual([]);
  });
});

// --- ancestry --------------------------------------------------------------

function session(overrides: Partial<RunTreeSessionInput> & { sessionId: string }): RunTreeSessionInput {
  return {
    parentId: null,
    locationId: "loc_1",
    title: null,
    agentId: null,
    upstreamOutcome: null,
    timeCreated: 1000,
    timeUpdated: 2000,
    timeIdle: null,
    source: "upstream",
    ...overrides,
  };
}

describe("runIdFor", () => {
  it("is deterministic per location and root session", () => {
    expect(runIdFor("loc_1", "ses_a")).toBe(runIdFor("loc_1", "ses_a"));
    expect(runIdFor("loc_1", "ses_a")).not.toBe(runIdFor("loc_1", "ses_b"));
    expect(runIdFor("loc_1", "ses_a")).not.toBe(runIdFor("loc_2", "ses_a"));
  });
});

describe("buildRunTree", () => {
  it("groups descendants under their root with the right depth", () => {
    const result = buildRunTree(
      [
        session({ sessionId: "ses_root" }),
        session({ sessionId: "ses_child", parentId: "ses_root" }),
        session({ sessionId: "ses_grandchild", parentId: "ses_child" }),
      ],
      { now: NOW },
    );
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.rootSessionId).toBe("ses_root");
    expect(result.runs[0]?.sessionCount).toBe(3);
    const depths = new Map(result.memberships.map((m) => [m.sessionId, m.depth]));
    expect(depths.get("ses_root")).toBe(0);
    expect(depths.get("ses_child")).toBe(1);
    expect(depths.get("ses_grandchild")).toBe(2);
  });

  it("treats a session whose parent was not observed as its own root and reports it", () => {
    const result = buildRunTree([session({ sessionId: "ses_orphan", parentId: "ses_missing" })], {
      now: NOW,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.rootSessionId).toBe("ses_orphan");
    expect(result.orphans).toEqual([{ sessionId: "ses_orphan", parentId: "ses_missing", reason: "parent-not-observed" }]);
  });

  it("does not follow a parent link that crosses locations", () => {
    const result = buildRunTree(
      [
        session({ sessionId: "ses_parent", locationId: "loc_1" }),
        session({ sessionId: "ses_other", parentId: "ses_parent", locationId: "loc_2" }),
      ],
      { now: NOW },
    );
    expect(result.runs).toHaveLength(2);
    expect(result.crossLocation).toEqual([{ sessionId: "ses_other", parentId: "ses_parent" }]);
    // The cross-location session must not be counted inside the parent's run.
    const parentRun = result.runs.find((run) => run.rootSessionId === "ses_parent");
    expect(parentRun?.sessionCount).toBe(1);
  });

  it("derives each run's source from its root observation, not the collector's mode", () => {
    // The run forest is rebuilt from stored sessions. A run whose root was
    // observed from fixtures must stay labelled `fixture` even though the
    // collector may now be running live.
    const result = buildRunTree(
      [
        session({ sessionId: "ses_fixture_root", source: "fixture" }),
        session({ sessionId: "ses_live_root", source: "upstream" }),
      ],
      { now: NOW },
    );
    expect(result.runs.find((run) => run.rootSessionId === "ses_fixture_root")?.source).toBe("fixture");
    expect(result.runs.find((run) => run.rootSessionId === "ses_live_root")?.source).toBe("upstream");
  });

  it("does not follow a parent link that crosses a provenance boundary", () => {
    // A fixture session is never attached under an upstream parent (or the
    // reverse), so a rebuilt run cannot blend the two and relabel one.
    const result = buildRunTree(
      [
        session({ sessionId: "ses_parent", source: "upstream" }),
        session({ sessionId: "ses_child", parentId: "ses_parent", source: "fixture" }),
      ],
      { now: NOW },
    );
    expect(result.crossSource).toEqual([{ sessionId: "ses_child", parentId: "ses_parent" }]);
    // The fixture child becomes its own root and keeps its own provenance.
    const childRun = result.runs.find((run) => run.rootSessionId === "ses_child");
    expect(childRun?.source).toBe("fixture");
    expect(childRun?.sessionCount).toBe(1);
    // The parent run does not absorb the fixture child.
    const parentRun = result.runs.find((run) => run.rootSessionId === "ses_parent");
    expect(parentRun?.sessionCount).toBe(1);
  });

  it("terminates and reports a cyclic parent chain", () => {
    const result = buildRunTree(
      [session({ sessionId: "ses_a", parentId: "ses_b" }), session({ sessionId: "ses_b", parentId: "ses_a" })],
      { now: NOW },
    );
    expect(result.cycles.length).toBeGreaterThan(0);
    // Every session still lands in exactly one run.
    expect(result.memberships).toHaveLength(2);
  });

  it("deduplicates a repeated session instead of double counting it", () => {
    // Regression: a duplicated session page previously inflated sessionCount,
    // orphan count and cross-location links.
    const duplicate = session({ sessionId: "ses_root", parentId: null });
    const result = buildRunTree(
      [duplicate, session({ sessionId: "ses_child", parentId: "ses_root" }), { ...duplicate }],
      { now: NOW },
    );
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.sessionCount).toBe(2);
    expect(result.memberships).toHaveLength(2);
    expect(result.orphans).toEqual([]);
  });

  it("deduplicates a repeated orphan so it is reported once", () => {
    const orphan = session({ sessionId: "ses_orphan", parentId: "ses_missing" });
    const result = buildRunTree([orphan, { ...orphan }], { now: NOW });
    expect(result.orphans).toHaveLength(1);
    expect(result.runs).toHaveLength(1);
  });

  it("uses the maximum descendant update time as the run's last activity", () => {
    const result = buildRunTree(
      [
        session({ sessionId: "ses_root", timeUpdated: 5000 }),
        session({ sessionId: "ses_child", parentId: "ses_root", timeUpdated: 9000 }),
      ],
      { now: NOW },
    );
    expect(result.runs[0]?.lastActivityAt).toBe(9000);
  });

  it("orders runs by most recent activity", () => {
    const result = buildRunTree(
      [session({ sessionId: "ses_old", timeUpdated: 1000 }), session({ sessionId: "ses_new", timeUpdated: 9000 })],
      { now: NOW },
    );
    expect(result.runs.map((run) => run.rootSessionId)).toEqual(["ses_new", "ses_old"]);
  });

  it("handles an empty session list", () => {
    const result = buildRunTree([], { now: NOW });
    expect(result.runs).toEqual([]);
    expect(result.memberships).toEqual([]);
  });
});

describe("deriveRunStatus", () => {
  const root = session({ sessionId: "ses_root" });

  it("reports an explicit upstream outcome as reported, never as a local verdict", () => {
    expect(deriveRunStatus({ ...root, upstreamOutcome: "succeeded" }, 0, NOW)).toBe("reported-succeeded");
    expect(deriveRunStatus({ ...root, upstreamOutcome: "failed" }, 0, NOW)).toBe("reported-failed");
    expect(deriveRunStatus({ ...root, upstreamOutcome: "interrupted" }, 0, NOW)).toBe("reported-interrupted");
  });

  it("reports idle as reported idle", () => {
    expect(deriveRunStatus({ ...root, timeIdle: 1234 }, 0, NOW)).toBe("reported-idle");
  });

  it("labels recent activity as an observation, not completion", () => {
    expect(deriveRunStatus(root, NOW - 1000, NOW)).toBe("recently-active");
  });

  it("falls back to unknown when there is no report and no recent activity", () => {
    expect(deriveRunStatus(root, NOW - 60 * 60 * 1000, NOW)).toBe("unknown");
  });

  it("prefers an explicit upstream outcome over idleness", () => {
    expect(deriveRunStatus({ ...root, upstreamOutcome: "failed", timeIdle: 1 }, 0, NOW)).toBe("reported-failed");
  });
});

describe("toRunTreeSession", () => {
  it("maps a validated upstream session onto the tree input", () => {
    const upstream: UpstreamSessionInfo = {
      id: "ses_a",
      parentId: "ses_b",
      projectId: "prj",
      agentId: "build",
      modelProviderId: "anthropic",
      modelId: "claude",
      title: "t",
      subpath: null,
      outcome: "succeeded",
      timeCreated: 1,
      timeUpdated: 2,
      timeIdle: 3,
      timeArchived: null,
      locationDirectory: "/x",
    };
    expect(toRunTreeSession(upstream, "loc_1", "upstream")).toEqual({
      sessionId: "ses_a",
      parentId: "ses_b",
      locationId: "loc_1",
      title: "t",
      agentId: "build",
      upstreamOutcome: "succeeded",
      timeCreated: 1,
      timeUpdated: 2,
      timeIdle: 3,
      source: "upstream",
    });
  });

  it("labels a fixture observation as a fixture", () => {
    const upstream: UpstreamSessionInfo = {
      id: "ses_a",
      parentId: null,
      projectId: "prj",
      agentId: null,
      modelProviderId: null,
      modelId: null,
      title: null,
      subpath: null,
      outcome: null,
      timeCreated: 1,
      timeUpdated: 2,
      timeIdle: null,
      timeArchived: null,
      locationDirectory: "/x",
    };
    expect(toRunTreeSession(upstream, "loc_1", "fixture").source).toBe("fixture");
  });
});

describe("fromStoredSession", () => {
  it("preserves the stored provenance rather than the collector's current mode", () => {
    // This is the regression the finding named: the run forest is rebuilt from
    // stored sessions, so dropping `source` here would relabel every fixture run
    // as upstream as soon as the collector switched to live mode.
    const stored = {
      id: "ses_a",
      parentId: "ses_b",
      locationId: "loc_1",
      title: "t",
      agentId: "build",
      upstreamOutcome: "succeeded" as const,
      timeCreated: 1,
      timeUpdated: 2,
      timeIdle: 3,
      source: "fixture" as const,
    };
    expect(fromStoredSession(stored)).toEqual({
      sessionId: "ses_a",
      parentId: "ses_b",
      locationId: "loc_1",
      title: "t",
      agentId: "build",
      upstreamOutcome: "succeeded",
      timeCreated: 1,
      timeUpdated: 2,
      timeIdle: 3,
      source: "fixture",
    });
  });
});
