import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  buildApp,
  cookiePair,
  framePayload,
  hasFrame,
  http,
  login,
  makeDataDir,
  readSseFrames,
  removeDataDir,
  runCollectorOnce,
  startServer,
  type ServerHandle,
} from "./harness.ts";
import type { AgentListResponse, OverviewResponse, Paginated, RootRunDetailResponse, RootRunSummary, SessionDetailResponse, StatusResponse } from "../../lib/contracts/api.ts";

/**
 * End-to-end tests against a real production Next.js server.
 *
 * Coverage: the auth boundary, the read API, SSE resume, redaction of stored
 * content, and persistence across a server restart. No browser is available in
 * this environment, so these assert on HTTP rather than rendered UI.
 */

let server: ServerHandle;
let dataDir: string;
let cookie: string;
let anonymousOverview: number;

beforeAll(async () => {
  await buildApp();
  const made = makeDataDir();
  dataDir = made.dir;

  // Collect once so the read API has data to serve.
  const collected = await runCollectorOnce(made.dbPath, made.dir);
  if (collected.code !== 0) {
    throw new Error(`collector failed (${collected.code}):\n${collected.stderr}\n${collected.stdout}`);
  }

  server = await startServer({ dbPath: made.dbPath, dataDir: made.dir, ownerPassword: OWNER_PASSWORD });
  const unauth = await http(`${server.baseUrl}/api/overview`);
  anonymousOverview = unauth.status;
  cookie = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
}, 300_000);

afterAll(async () => {
  await server?.stop();
  if (dataDir !== undefined) removeDataDir(dataDir);
});

describe("authentication boundary", () => {
  it("rejects an unauthenticated API read with 401", () => {
    expect(anonymousOverview).toBe(401);
  });

  it("redirects an unauthenticated page request to the sign-in page", async () => {
    const result = await http(`${server.baseUrl}/`);
    expect([302, 303, 307, 308]).toContain(result.status);
    expect(result.headers.get("location")).toContain("/login");
  });

  it("serves the sign-in page without a session", async () => {
    const result = await http(`${server.baseUrl}/login`);
    expect(result.status).toBe(200);
    expect(result.body).toContain("Sign in");
  });

  it("does not expose protected data in the sign-in page", async () => {
    const result = await http(`${server.baseUrl}/login`);
    expect(result.body).not.toContain("ses_root_alpha");
    expect(result.body).not.toContain("build");
  });

  it("reports unauthenticated state without a session", async () => {
    const result = await http(`${server.baseUrl}/api/auth/session`);
    expect(result.status).toBe(200);
    const body = result.json<{ authenticated: boolean; configured: boolean }>();
    expect(body.authenticated).toBe(false);
    expect(body.configured).toBe(true);
  });

  it("rejects a login with no Origin header", async () => {
    const result = await http(`${server.baseUrl}/api/auth/login`, { method: "POST", body: { password: OWNER_PASSWORD } });
    expect(result.status).toBe(403);
  });

  it("rejects a cross-origin login", async () => {
    const result = await http(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      origin: "https://evil.example",
      body: { password: OWNER_PASSWORD },
    });
    expect(result.status).toBe(403);
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const result = await http(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      origin: server.origin,
      body: { password: "definitely-not-the-password" },
    });
    expect(result.status).toBe(401);
    expect(result.setCookies).toHaveLength(0);
  });

  it("rejects a login body that is not an object", async () => {
    const result = await http(`${server.baseUrl}/api/auth/login`, { method: "POST", origin: server.origin, body: [] });
    expect(result.status).toBe(400);
  });

  it("rejects a login with a missing password field", async () => {
    const result = await http(`${server.baseUrl}/api/auth/login`, { method: "POST", origin: server.origin, body: {} });
    expect(result.status).toBe(400);
  });

  it("issues a hardened session cookie on success", async () => {
    const result = await http(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      origin: server.origin,
      body: { password: OWNER_PASSWORD },
    });
    expect(result.status).toBe(200);
    const setCookie = result.setCookies[0] ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    // Over plain http with the auto policy the cookie is not marked Secure, which
    // is what lets a loopback deployment work at all.
    expect(setCookie).not.toContain("Secure");
    expect(result.json<{ ok: boolean }>().ok).toBe(true);
  });

  it("rejects a forged session cookie", async () => {
    const result = await http(`${server.baseUrl}/api/overview`, { cookie: "orch_session=not-a-real-token" });
    expect(result.status).toBe(401);
  });

  it("accepts the issued session cookie", async () => {
    const result = await http(`${server.baseUrl}/api/overview`, { cookie });
    expect(result.status).toBe(200);
  });
});

describe("read API", () => {
  it("reports fixture provenance on the overview", async () => {
    const result = await http(`${server.baseUrl}/api/overview`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<OverviewResponse>();
    expect(body.source.mode).toBe("fixture");
    expect(body.source.observationSource).toBe("fixture");
    expect(body.counts.rootRuns).toBe(4);
    expect(body.counts.sessions).toBe(7);
    expect(body.counts.agents).toBe(9);
    expect(body.counts.activity).toBeGreaterThan(0);
    expect(body.counts.invocations).toBeGreaterThan(0);
  });

  it("labels run status as upstream-reported rather than a verdict", async () => {
    const body = (await http(`${server.baseUrl}/api/overview`, { cookie })).json<OverviewResponse>();
    const statuses = body.recentRuns.map((run) => run.status);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(["recently-active", "reported-idle", "reported-succeeded", "reported-failed", "reported-interrupted", "unknown"]).toContain(status);
    }
  });

  it("lists root runs with pagination metadata", async () => {
    const result = await http(`${server.baseUrl}/api/runs?limit=2`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<Paginated<RootRunSummary>>();
    expect(body.data).toHaveLength(2);
    expect(body.page.total).toBe(4);
    expect(body.page.limit).toBe(2);
  });

  it("searches runs by title", async () => {
    const result = await http(`${server.baseUrl}/api/runs?search=lease`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<Paginated<RootRunSummary>>();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((run) => (run.title ?? "").toLowerCase().includes("lease"))).toBe(true);
  });

  it("filters runs by status", async () => {
    const result = await http(`${server.baseUrl}/api/runs?status=reported-failed`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<Paginated<RootRunSummary>>();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((run) => run.status === "reported-failed")).toBe(true);
  });

  it("rejects an invalid status filter", async () => {
    const result = await http(`${server.baseUrl}/api/runs?status=nonsense`, { cookie });
    expect(result.status).toBe(400);
  });

  it("rejects an invalid pagination limit", async () => {
    expect((await http(`${server.baseUrl}/api/runs?limit=0`, { cookie })).status).toBe(400);
    expect((await http(`${server.baseUrl}/api/runs?limit=abc`, { cookie })).status).toBe(400);
    expect((await http(`${server.baseUrl}/api/runs?offset=-1`, { cookie })).status).toBe(400);
  });

  it("serves a run detail with the observed session hierarchy", async () => {
    const runs = (await http(`${server.baseUrl}/api/runs?limit=50`, { cookie })).json<Paginated<RootRunSummary>>();
    const alpha = runs.data.find((run) => run.rootSessionId === "ses_root_alpha");
    expect(alpha).toBeDefined();

    const result = await http(`${server.baseUrl}/api/runs/${alpha!.id}`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<RootRunDetailResponse>();
    expect(body.sessions).toHaveLength(4);

    const depths = new Map(body.sessions.map((session) => [session.sessionId, session.depth]));
    expect(depths.get("ses_root_alpha")).toBe(0);
    expect(depths.get("ses_child_alpha1")).toBe(1);
    expect(depths.get("ses_grandchild_alpha2a")).toBe(2);
  });

  it("returns invocations with their evidence", async () => {
    const runs = (await http(`${server.baseUrl}/api/runs?limit=50`, { cookie })).json<Paginated<RootRunSummary>>();
    const alpha = runs.data.find((run) => run.rootSessionId === "ses_root_alpha")!;
    const body = (await http(`${server.baseUrl}/api/runs/${alpha.id}`, { cookie })).json<RootRunDetailResponse>();

    expect(body.invocations.length).toBeGreaterThan(0);
    for (const invocation of body.invocations) {
      expect(invocation.confidence).toBe("verified");
      const evidence = invocation.evidence as { rule?: string; assistantMessageId?: string };
      expect(evidence.rule).toBe("assistant-message-agent-field");
      expect(evidence.assistantMessageId).toBeDefined();
    }
  });

  it("flags an orphan session rather than inventing a parent", async () => {
    const runs = (await http(`${server.baseUrl}/api/runs?limit=50`, { cookie })).json<Paginated<RootRunSummary>>();
    const orphan = runs.data.find((run) => run.rootSessionId === "ses_orphan_gamma");
    expect(orphan).toBeDefined();
    const body = (await http(`${server.baseUrl}/api/runs/${orphan!.id}`, { cookie })).json<RootRunDetailResponse>();
    expect(body.sessions).toHaveLength(1);
    expect(body.run.sessionCount).toBe(1);
  });

  it("returns 404 for an unknown run", async () => {
    const result = await http(`${server.baseUrl}/api/runs/run_does_not_exist`, { cookie });
    expect(result.status).toBe(404);
  });

  it("rejects a run id outside the bounded character set", async () => {
    const result = await http(`${server.baseUrl}/api/runs/${encodeURIComponent("bad id!")}`, { cookie });
    expect(result.status).toBe(400);
  });

  it("lists sessions and filters to roots", async () => {
    const all = (await http(`${server.baseUrl}/api/sessions?limit=50`, { cookie })).json<Paginated<{ id: string }>>();
    expect(all.page.total).toBe(7);
    const roots = (await http(`${server.baseUrl}/api/sessions?parentId=null&limit=50`, { cookie })).json<Paginated<{ id: string }>>();
    expect(roots.page.total).toBe(2);
  });

  it("serves a session detail with its run link", async () => {
    const result = await http(`${server.baseUrl}/api/sessions/ses_root_alpha`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<SessionDetailResponse>();
    expect(body.session.id).toBe("ses_root_alpha");
    expect(body.session.rootRunId).not.toBeNull();
    expect(body.activity.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown session", async () => {
    expect((await http(`${server.baseUrl}/api/sessions/ses_missing`, { cookie })).status).toBe(404);
  });

  it("lists effective agents including hidden ones, with observed invocation counts", async () => {
    const result = await http(`${server.baseUrl}/api/agents`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<AgentListResponse>();
    expect(body.agents).toHaveLength(9);
    expect(body.agents.some((agent) => agent.hidden)).toBe(true);
    expect(body.locations).toHaveLength(2);
    // A defined but never-observed agent must report zero invocations.
    const unobserved = body.agents.find((agent) => agent.agentId === "internal-audit");
    expect(unobserved?.observedInvocationCount).toBe(0);
    // An observed agent must report a positive count.
    expect(body.agents.some((agent) => agent.observedInvocationCount > 0)).toBe(true);
  });

  it("searches activity and filters by kind", async () => {
    const all = (await http(`${server.baseUrl}/api/activity?limit=200`, { cookie })).json<Paginated<{ kind: string }>>();
    expect(all.page.total).toBeGreaterThan(0);

    const tools = (await http(`${server.baseUrl}/api/activity?kind=tool&limit=200`, { cookie })).json<Paginated<{ kind: string }>>();
    expect(tools.data.every((event) => event.kind === "tool")).toBe(true);
  });

  it("rejects an unknown activity kind", async () => {
    expect((await http(`${server.baseUrl}/api/activity?kind=telepathy`, { cookie })).status).toBe(400);
  });

  it("reports collection status with checkpoints, gaps, warnings and limits", async () => {
    const result = await http(`${server.baseUrl}/api/status`, { cookie });
    expect(result.status).toBe(200);
    const body = result.json<StatusResponse>();
    expect(body.database.ready).toBe(true);
    expect(body.database.schemaVersion).toBeGreaterThan(0);
    expect(body.database.ownerConfigured).toBe(true);
    expect(body.checkpoints.length).toBeGreaterThan(0);
    expect(body.gaps.length).toBeGreaterThan(0);
    expect(body.warnings.some((warning) => warning.kind === "unknown-message-type")).toBe(true);
    expect(body.limitations.length).toBeGreaterThan(0);
    // The limitation text must state the read-only and fixture-mode facts.
    expect(body.limitations.join(" ")).toContain("GET");
    expect(body.limitations.join(" ")).toContain("fixture");
  });

  it("never returns the embedded fixture secrets", async () => {
    const endpoints = ["/api/overview", "/api/activity?limit=200", "/api/status", "/api/agents"];
    for (const endpoint of endpoints) {
      const result = await http(`${server.baseUrl}${endpoint}`, { cookie });
      expect(result.body, endpoint).not.toContain("sk-live-abcdef0123456789abcdef0123456789");
      expect(result.body, endpoint).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0");
    }
  });

  it("marks redacted and truncated stored content explicitly", async () => {
    const body = (await http(`${server.baseUrl}/api/activity?limit=200`, { cookie })).json<
      Paginated<{ redacted: boolean; content: string | null }>
    >();
    const redacted = body.data.filter((event) => event.redacted);
    expect(redacted.length).toBeGreaterThan(0);
    for (const event of redacted) {
      expect(event.content ?? "").not.toContain("sk-live-");
    }
  });

  it("sets no-store on every API response", async () => {
    const result = await http(`${server.baseUrl}/api/overview`, { cookie });
    expect(result.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects an unsupported method on a read endpoint", async () => {
    const result = await http(`${server.baseUrl}/api/runs`, { method: "DELETE", cookie, origin: server.origin });
    expect(result.status).toBe(405);
  });

  it("does not expose an upstream URL in any response", async () => {
    const body = (await http(`${server.baseUrl}/api/status`, { cookie })).body;
    expect(body).not.toContain("4096");
    expect(body).not.toContain("127.0.0.1");
  });
});

describe("change stream", () => {
  it("rejects an unauthenticated stream with 401", async () => {
    const result = await http(`${server.baseUrl}/api/events`, { redirect: "manual" });
    expect(result.status).toBe(401);
  });

  it("rejects an invalid resume cursor", async () => {
    const result = await http(`${server.baseUrl}/api/events?since=-5`, { cookie, redirect: "manual" });
    expect(result.status).toBe(400);
  });

  it("accepts a resume cursor far beyond the old one-million cap", async () => {
    // Regression: `since` was capped at 1,000,000, which rejects a legitimate
    // cursor once the change log has grown past it.
    const result = await http(`${server.baseUrl}/api/events?since=1000001`, { cookie, redirect: "manual" });
    expect(result.status).toBe(200);
  });

  it("accepts the largest safely representable cursor", async () => {
    const result = await http(`${server.baseUrl}/api/events?since=9007199254740991`, { cookie, redirect: "manual" });
    expect(result.status).toBe(200);
  });

  it("rejects a cursor that cannot be represented exactly", async () => {
    const result = await http(`${server.baseUrl}/api/events?since=99999999999999999999`, { cookie, redirect: "manual" });
    expect(result.status).toBe(400);
  });

  it("rejects a non-numeric cursor", async () => {
    for (const bad of ["abc", "1e5", "1.5", "0x10", "+5", " 5"]) {
      const result = await http(`${server.baseUrl}/api/events?since=${encodeURIComponent(bad)}`, { cookie, redirect: "manual" });
      expect(result.status, bad).toBe(400);
    }
  });

  it("sends a hello frame carrying the latest sequence and a retry hint", async () => {
    const frames = await readSseFrames(`${server.baseUrl}/api/events`, cookie, {
      until: (read) => hasFrame(read, "event: hello"),
      timeoutMs: 15_000,
    });
    expect(hasFrame(frames, "event: hello")).toBe(true);
    // The retry hint belongs to the same frame as the hello, not a separate one.
    expect(frames[0]).toContain("retry: 3000");
    const payload = framePayload<{ latestSeq: number; resumeFrom: number }>(frames, "hello");
    expect(payload?.latestSeq).toBeGreaterThan(0);
    expect(payload?.resumeFrom).toBe(0);
  });

  it("delivers a change after new data is collected", async () => {
    // Resume from the current head, then collect again, and expect a change frame.
    const hello = await readSseFrames(`${server.baseUrl}/api/events`, cookie, {
      until: (read) => hasFrame(read, "event: hello"),
      timeoutMs: 15_000,
    });
    const head = framePayload<{ latestSeq: number }>(hello, "hello");
    expect(head).not.toBeNull();

    const collected = await runCollectorOnce(server.dbPath, server.dataDir);
    expect(collected.code).toBe(0);

    const frames = await readSseFrames(`${server.baseUrl}/api/events?since=${head!.latestSeq}`, cookie, {
      until: (read) => hasFrame(read, "event: change"),
      timeoutMs: 20_000,
    });
    expect(hasFrame(frames, "event: change")).toBe(true);

    const change = framePayload<{ seq: number; kind: string }>(frames, "change");
    expect(change?.seq).toBeGreaterThan(head!.latestSeq);
    expect(typeof change?.kind).toBe("string");
  });

  it("terminates an open stream when the session is revoked", async () => {
    // Regression: an already-open stream used to keep delivering data after the
    // session was revoked or expired.
    const fresh = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    const reading = readSseFrames(`${server.baseUrl}/api/events`, fresh, {
      until: (frames) => hasFrame(frames, "auth-expired"),
      timeoutMs: 30_000,
    });

    // Let the stream establish, then revoke the session out from under it.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const logout = await http(`${server.baseUrl}/api/auth/logout`, { method: "POST", cookie: fresh, origin: server.origin });
    expect(logout.status).toBe(200);

    const frames = await reading;
    expect(hasFrame(frames, "auth-expired")).toBe(true);
    const payload = framePayload<{ reason: string }>(frames, "auth-expired");
    expect(payload?.reason).toBe("revoked");
  }, 60_000);

  it("also serves the app without a session after a stream ends on revocation", async () => {
    const fresh = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    await http(`${server.baseUrl}/api/auth/logout`, { method: "POST", cookie: fresh, origin: server.origin });
    expect((await http(`${server.baseUrl}/api/overview`, { cookie: fresh })).status).toBe(401);
  });

  it("replays nothing when the caller is already current", async () => {
    const hello = await readSseFrames(`${server.baseUrl}/api/events`, cookie, {
      until: (read) => hasFrame(read, "event: hello"),
      timeoutMs: 15_000,
    });
    const head = framePayload<{ latestSeq: number }>(hello, "hello");
    const frames = await readSseFrames(`${server.baseUrl}/api/events?since=${head!.latestSeq}`, cookie, {
      // Nothing to deliver: wait out a short window and assert no change arrived.
      until: () => false,
      timeoutMs: 3_000,
    });
    expect(hasFrame(frames, "event: change")).toBe(false);
  });
});

describe("session lifecycle", () => {
  it("revokes the session on sign-out and rejects the old cookie", async () => {
    const fresh = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    expect((await http(`${server.baseUrl}/api/overview`, { cookie: fresh })).status).toBe(200);

    const logout = await http(`${server.baseUrl}/api/auth/logout`, { method: "POST", cookie: fresh, origin: server.origin });
    expect(logout.status).toBe(200);
    const cleared = logout.setCookies[0] ?? "";
    expect(cleared).toContain("Max-Age=0");

    expect((await http(`${server.baseUrl}/api/overview`, { cookie: fresh })).status).toBe(401);
  });

  it("rejects a sign-out with no Origin header", async () => {
    const result = await http(`${server.baseUrl}/api/auth/logout`, { method: "POST", cookie });
    expect(result.status).toBe(403);
  });

  it("leaves the original session usable after another session signs out", async () => {
    const other = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    await http(`${server.baseUrl}/api/auth/logout`, { method: "POST", cookie: other, origin: server.origin });
    expect((await http(`${server.baseUrl}/api/overview`, { cookie })).status).toBe(200);
  });
});

describe("restart persistence", () => {
  it("serves the same observations after a server restart", async () => {
    const before = (await http(`${server.baseUrl}/api/overview`, { cookie })).json<OverviewResponse>();
    await server.stop();

    server = await startServer({ dbPath: server.dbPath, dataDir: server.dataDir, ownerPassword: OWNER_PASSWORD });
    // The session row survived the restart, so the existing cookie still works.
    const after = await http(`${server.baseUrl}/api/overview`, { cookie });
    expect(after.status).toBe(200);
    const body = after.json<OverviewResponse>();
    expect(body.counts.sessions).toBe(before.counts.sessions);
    expect(body.counts.rootRuns).toBe(before.counts.rootRuns);
    expect(body.counts.invocations).toBe(before.counts.invocations);
  }, 120_000);
});

describe("fail-closed behaviour", () => {
  it("refuses to serve data when no owner credential is configured", async () => {
    const made = makeDataDir("orch-e2e-nocred-");
    const other = await startServer({ dbPath: made.dbPath, dataDir: made.dir, ownerPassword: null });
    try {
      const overview = await http(`${other.baseUrl}/api/overview`);
      expect(overview.status).toBe(503);
      expect(overview.json<{ code: string }>().code).toBe("auth-not-configured");

      const loginAttempt = await http(`${other.baseUrl}/api/auth/login`, {
        method: "POST",
        origin: other.origin,
        body: { password: "anything" },
      });
      expect(loginAttempt.status).toBe(503);
      expect(loginAttempt.setCookies).toHaveLength(0);

      const session = await http(`${other.baseUrl}/api/auth/session`);
      const state = session.json<{ configured: boolean; reason: string | null }>();
      expect(state.configured).toBe(false);
      expect(state.reason).toContain("ORCH_OWNER_PASSWORD");
    } finally {
      await other.stop();
      removeDataDir(made.dir);
    }
  }, 120_000);

  it("marks the cookie Secure when a public https origin is configured", async () => {
    const made = makeDataDir("orch-e2e-secure-");
    const other = await startServer({
      dbPath: made.dbPath,
      dataDir: made.dir,
      ownerPassword: OWNER_PASSWORD,
      publicOrigin: "https://code.example.com",
    });
    try {
      const result = await http(`${other.baseUrl}/api/auth/login`, {
        method: "POST",
        origin: other.origin,
        body: { password: OWNER_PASSWORD },
      });
      expect(result.status).toBe(200);
      expect(result.setCookies[0] ?? "").toContain("Secure");
    } finally {
      await other.stop();
      removeDataDir(made.dir);
    }
  }, 120_000);
});
