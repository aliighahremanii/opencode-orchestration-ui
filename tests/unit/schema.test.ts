import { describe, expect, it } from "vitest";
import {
  validateAgentList,
  validateLocationInfo,
  validateMessagesResponse,
  validateServerInfo,
  validateSessionsResponse,
} from "../../lib/upstream/schema.ts";

/**
 * Runtime payload validation.
 *
 * These validators are the boundary between an experimental upstream API and
 * persisted records. The tests assert both directions: documented shapes are
 * accepted, and malformed payloads are rejected rather than coerced.
 */

const VALID_SERVER_INFO = {
  version: "2.0.28",
  pid: 4242,
  urls: ["http://127.0.0.1:4096"],
  paths: { tmp: "/tmp/x" },
};

const VALID_LOCATION = {
  directory: "/srv/demo",
  project: { id: "prj_1", directory: "/srv/demo", canonical: "/srv/demo" },
};

const VALID_AGENT_LIST = {
  location: { directory: "/srv/demo" },
  data: [
    {
      id: "build",
      name: "build",
      model: { id: "", providerID: "anthropic" },
      request: {},
      mode: "primary",
      hidden: false,
      permissions: {},
    },
  ],
};

const VALID_SESSION = {
  id: "ses_a",
  projectID: "prj_1",
  agent: "build",
  model: { id: "", providerID: "anthropic" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 100, updated: 200 },
  title: "t",
  location: { directory: "/srv/demo" },
};

function expectOk<T>(result: { ok: true; value: T } | { ok: false; issues: readonly string[] }): T {
  if (!result.ok) throw new Error(`expected a valid payload, got issues: ${result.issues.join("; ")}`);
  return result.value;
}

function expectIssues(result: { ok: true; value: unknown } | { ok: false; issues: readonly string[] }): readonly string[] {
  if (result.ok) throw new Error("expected the payload to be rejected");
  return result.issues;
}

describe("validateServerInfo", () => {
  it("accepts a documented payload", () => {
    const value = expectOk(validateServerInfo(VALID_SERVER_INFO));
    expect(value.version).toBe("2.0.28");
    expect(value.pid).toBe(4242);
    expect(value.tmpPath).toBe("/tmp/x");
  });

  it("ignores unknown extra properties", () => {
    const value = expectOk(validateServerInfo({ ...VALID_SERVER_INFO, futureField: true }));
    expect(value.version).toBe("2.0.28");
  });

  it("rejects a missing required field", () => {
    const issues = expectIssues(validateServerInfo({ pid: 1, urls: [], paths: { tmp: "/t" } }));
    expect(issues.some((issue) => issue.includes("version"))).toBe(true);
  });

  it("rejects a field of the wrong type", () => {
    const issues = expectIssues(validateServerInfo({ ...VALID_SERVER_INFO, pid: "not-a-number" }));
    expect(issues.some((issue) => issue.includes("pid"))).toBe(true);
  });

  it("rejects a non-object payload", () => {
    expect(expectIssues(validateServerInfo("nope")).length).toBeGreaterThan(0);
    expect(expectIssues(validateServerInfo(null)).length).toBeGreaterThan(0);
    expect(expectIssues(validateServerInfo([1, 2])).length).toBeGreaterThan(0);
  });
});

describe("validateLocationInfo", () => {
  it("accepts a documented payload and flattens the project", () => {
    const value = expectOk(validateLocationInfo(VALID_LOCATION));
    expect(value).toEqual({
      directory: "/srv/demo",
      projectId: "prj_1",
      projectDirectory: "/srv/demo",
      canonical: "/srv/demo",
    });
  });

  it("rejects a missing project object", () => {
    expect(expectIssues(validateLocationInfo({ directory: "/x" })).length).toBeGreaterThan(0);
  });
});

describe("validateAgentList", () => {
  it("accepts a documented payload", () => {
    const value = expectOk(validateAgentList(VALID_AGENT_LIST));
    expect(value.agents).toHaveLength(1);
    expect(value.agents[0]?.id).toBe("build");
    expect(value.agents[0]?.mode).toBe("primary");
    expect(value.location.directory).toBe("/srv/demo");
  });

  it("rejects an undocumented mode value", () => {
    const payload = {
      ...VALID_AGENT_LIST,
      data: [{ ...VALID_AGENT_LIST.data[0], mode: "supervisor" }],
    };
    expect(expectIssues(validateAgentList(payload)).some((issue) => issue.includes("mode"))).toBe(true);
  });

  it("rejects a missing hidden flag", () => {
    const payload = {
      ...VALID_AGENT_LIST,
      data: [{ id: "a", name: "a", model: { id: "", providerID: "p" }, request: {}, mode: "all", permissions: {} }],
    };
    expect(expectIssues(validateAgentList(payload)).some((issue) => issue.includes("hidden"))).toBe(true);
  });

  it("accepts an empty agent list", () => {
    const value = expectOk(validateAgentList({ location: { directory: "/x" }, data: [] }));
    expect(value.agents).toEqual([]);
  });
});

describe("validateSessionsResponse", () => {
  it("accepts a documented payload", () => {
    const value = expectOk(validateSessionsResponse({ data: [VALID_SESSION], cursor: { next: "abc" } }));
    expect(value.sessions).toHaveLength(1);
    expect(value.sessions[0]?.id).toBe("ses_a");
    expect(value.sessions[0]?.parentId).toBeNull();
    expect(value.nextCursor).toBe("abc");
  });

  it("accepts an explicit null parentID and a null cursor", () => {
    const value = expectOk(validateSessionsResponse({ data: [{ ...VALID_SESSION, parentID: null }], cursor: { next: null } }));
    expect(value.sessions[0]?.parentId).toBeNull();
    expect(value.nextCursor).toBeNull();
  });

  it("captures an explicit outcome and idle timestamp", () => {
    const payload = {
      data: [{ ...VALID_SESSION, outcome: "succeeded", time: { created: 1, updated: 2, idle: 3 } }],
      cursor: {},
    };
    const value = expectOk(validateSessionsResponse(payload));
    expect(value.sessions[0]?.outcome).toBe("succeeded");
    expect(value.sessions[0]?.timeIdle).toBe(3);
  });

  it("rejects an undocumented outcome value", () => {
    const payload = { data: [{ ...VALID_SESSION, outcome: "cancelled" }], cursor: {} };
    expect(expectIssues(validateSessionsResponse(payload)).some((issue) => issue.includes("outcome"))).toBe(true);
  });

  it("rejects a session missing its time object", () => {
    const { time: _time, ...withoutTime } = VALID_SESSION;
    expect(expectIssues(validateSessionsResponse({ data: [withoutTime], cursor: {} })).length).toBeGreaterThan(0);
  });

  it("rejects a non-array data field", () => {
    expect(expectIssues(validateSessionsResponse({ data: {}, cursor: {} })).length).toBeGreaterThan(0);
  });
});

describe("validateMessagesResponse", () => {
  it("accepts a user message", () => {
    const value = expectOk(validateMessagesResponse({ data: [{ id: "msg_a", type: "user", time: { created: 1 }, text: "hi" }] }));
    expect(value.messages[0]?.type).toBe("user");
  });

  it("accepts an assistant message with text, reasoning and tool parts", () => {
    const payload = {
      data: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 1, completed: 2 },
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [
            { type: "text", text: "hello" },
            { type: "reasoning", text: "thinking" },
            {
              type: "tool",
              id: "t1",
              name: "read",
              time: { created: 1, completed: 2 },
              state: { status: "completed", input: { path: "/x" }, content: [{ type: "text", text: "ok" }] },
            },
          ],
        },
      ],
      cursor: {},
    };
    const value = expectOk(validateMessagesResponse(payload));
    const message = value.messages[0];
    expect(message?.type).toBe("assistant");
    if (message?.type === "assistant") {
      expect(message.agentId).toBe("build");
      expect(message.parts.map((part) => part.kind)).toEqual(["text", "reasoning", "tool"]);
      const tool = message.parts[2];
      expect(tool?.kind).toBe("tool");
      if (tool?.kind === "tool") {
        expect(tool.status).toBe("completed");
        expect(tool.outputSummary).toBe("ok");
      }
    }
  });

  it("records a tool error message", () => {
    const payload = {
      data: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 1 },
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [
            {
              type: "tool",
              id: "t1",
              name: "bash",
              time: { created: 1 },
              state: { status: "error", input: {}, error: { type: "e", message: "permission denied" } },
            },
          ],
        },
      ],
      cursor: {},
    };
    const value = expectOk(validateMessagesResponse(payload));
    const message = value.messages[0];
    if (message?.type === "assistant") {
      const tool = message.parts[0];
      if (tool?.kind === "tool") {
        expect(tool.status).toBe("error");
        expect(tool.errorMessage).toBe("permission denied");
      }
    }
  });

  it("accepts every documented message type", () => {
    const payload = {
      data: [
        { id: "msg_1", type: "user", time: { created: 1 }, text: "u" },
        { id: "msg_2", type: "system", time: { created: 2 }, text: "s" },
        { id: "msg_3", type: "synthetic", time: { created: 3 }, text: "y" },
        { id: "msg_4", type: "skill", time: { created: 4 }, name: "n", text: "t" },
        { id: "msg_5", type: "shell", time: { created: 5 }, shellID: "sh", command: "ls", status: "exited", exit: 0 },
        { id: "msg_6", type: "compaction", time: { created: 6 }, status: "completed", reason: "auto", summary: "s", recent: "" },
        { id: "msg_7", type: "idle", time: { created: 7 }, outcome: "succeeded" },
        { id: "msg_8", type: "agent-switched", time: { created: 8 }, agent: "build" },
        { id: "msg_9", type: "model-switched", time: { created: 9 }, model: { id: "m", providerID: "p" } },
        { id: "msg_10", type: "location-switched", time: { created: 10 }, location: { directory: "/x" } },
        { id: "msg_11", type: "assistant", time: { created: 11 }, agent: "build", model: { id: "m", providerID: "p" }, content: [] },
      ],
      cursor: {},
    };
    const value = expectOk(validateMessagesResponse(payload));
    expect(value.messages).toHaveLength(11);
    expect(value.unknownTypes).toEqual([]);
  });

  it("reports an unknown message type instead of guessing at it", () => {
    const payload = { data: [{ id: "msg_x", type: "future-thing", time: { created: 1 } }], cursor: {} };
    const value = expectOk(validateMessagesResponse(payload));
    expect(value.messages).toHaveLength(0);
    expect(value.unknownTypes).toEqual(["future-thing"]);
  });

  it("keeps known messages when an unknown type appears alongside them", () => {
    const payload = {
      data: [
        { id: "msg_a", type: "user", time: { created: 1 }, text: "u" },
        { id: "msg_b", type: "future-thing", time: { created: 2 } },
      ],
      cursor: {},
    };
    const value = expectOk(validateMessagesResponse(payload));
    expect(value.messages).toHaveLength(1);
    expect(value.unknownTypes).toEqual(["future-thing"]);
  });

  it("redacts a credential hidden in a tool input before it is serialised", () => {
    // Regression: the tool input used to be serialised first, and only a
    // text-shaped redactor ran afterwards, so a whole object under a credential
    // key survived into `inputSummary` (and from there into the database).
    const SECRET = "opaque-aws-secret-000111222333";
    const payload = {
      data: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 1, completed: 2 },
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [
            {
              type: "tool",
              id: "t1",
              name: "aws",
              time: { created: 1, completed: 2 },
              state: {
                status: "completed",
                input: { region: "us-east-1", credentials: { SecretAccessKey: { value: SECRET, nested: { deep: SECRET } } } },
                content: [{ type: "text", text: "ok" }],
              },
            },
          ],
        },
      ],
      cursor: {},
    };
    const value = expectOk(validateMessagesResponse(payload));
    const message = value.messages[0];
    expect(JSON.stringify(message)).not.toContain(SECRET);
    if (message?.type === "assistant") {
      const tool = message.parts[0];
      if (tool?.kind === "tool") {
        expect(tool.inputSummary).toContain("[redacted]");
        // The serialised input is still valid JSON, with the non-secret fields
        // preserved.
        expect(JSON.parse(tool.inputSummary)).toEqual({
          region: "us-east-1",
          credentials: { SecretAccessKey: "[redacted]" },
        });
      }
    }
  });

  it("redacts a structured credential in a tool's output content", () => {
    // The output path is redacted the same way as the input: the content entries
    // are redacted key-aware before they are joined into a summary, so a secret
    // carried in a text chunk or under a sensitive key cannot survive.
    const SECRET = "opaque-output-secret-000111222333";
    const payload = {
      data: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 1, completed: 2 },
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [
            {
              type: "tool",
              id: "t1",
              name: "read",
              time: { created: 1, completed: 2 },
              state: {
                status: "completed",
                input: { path: "/etc/config" },
                content: [
                  { type: "text", text: `config {"SecretKey":{"value":"${SECRET}"}}` },
                  { type: "text", secretAccessKey: { nested: SECRET } },
                ],
              },
            },
          ],
        },
      ],
      cursor: {},
    };
    const value = expectOk(validateMessagesResponse(payload));
    const message = value.messages[0];
    expect(JSON.stringify(message)).not.toContain(SECRET);
    if (message?.type === "assistant") {
      const tool = message.parts[0];
      if (tool?.kind === "tool") {
        expect(tool.outputSummary).toContain("[redacted]");
        expect(tool.outputSummary).not.toContain(SECRET);
      }
    }
  });

  it("rejects an unknown assistant part type", () => {
    const payload = {
      data: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 1 },
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [{ type: "image", data: "..." }],
        },
      ],
      cursor: {},
    };
    expect(expectIssues(validateMessagesResponse(payload)).some((issue) => issue.includes("part type"))).toBe(true);
  });

  it("rejects an undocumented idle outcome", () => {
    const payload = { data: [{ id: "msg_a", type: "idle", time: { created: 1 }, outcome: "maybe" }], cursor: {} };
    expect(expectIssues(validateMessagesResponse(payload)).some((issue) => issue.includes("outcome"))).toBe(true);
  });

  it("rejects a message missing its id", () => {
    const payload = { data: [{ type: "user", time: { created: 1 }, text: "u" }], cursor: {} };
    expect(expectIssues(validateMessagesResponse(payload)).some((issue) => issue.includes("id"))).toBe(true);
  });

  it("accepts an empty page with a null cursor", () => {
    const value = expectOk(validateMessagesResponse({ data: [], cursor: { next: null } }));
    expect(value.messages).toEqual([]);
    expect(value.nextCursor).toBeNull();
  });
});
