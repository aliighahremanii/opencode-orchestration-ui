import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { COLLECTOR_SCOPE, closeGapsAfterSuccess, gapIdFor, locationIdFor, runCycle } from "../../lib/collector/collector.ts";
import { acquireLease, getCheckpoint, getCollectorState, listWarnings } from "../../lib/db/collection-state.ts";
import { listActivity, listAgents, listLocations, listOpenGaps, listSessions, openGap } from "../../lib/db/repositories.ts";
import { getConfig } from "../../lib/config.ts";
import { FixtureUpstreamSource } from "../../lib/upstream/fixture-source.ts";
import { UpstreamAuthError, UpstreamHttpError, UpstreamPayloadError, UpstreamUnavailableError, type UpstreamSource } from "../../lib/upstream/source.ts";
import type { UpstreamSessionInfo } from "../../lib/upstream/schema.ts";
import { cleanupTempDirs, configureTestEnv, createTestDb, makeTempDir, type TestDb } from "../helpers/harness.ts";

const GOOD = "/synthetic/present";
const STALE = "/synthetic/removed";
const agent = { id: "build", name: "build", mode: "primary" as const, hidden: false, description: null, modelProviderId: null, modelId: null };
function session(id: string, directory: string): UpstreamSessionInfo {
  return { id, locationDirectory: directory, projectId: "project", parentId: null, agentId: "build", modelProviderId: null,
    modelId: null, title: id, subpath: null, outcome: null, timeCreated: 100, timeUpdated: 200, timeIdle: null, timeArchived: null };
}

let test: TestDb;
let clock: number;
let registryError: Error | null;
let empty: boolean;
let sessions: UpstreamSessionInfo[];
let source: UpstreamSource;
const staleId = () => locationIdFor(STALE, source.connectionId, "upstream");
const staleStream = () => `agents:${staleId()}`;
const checkpoint = (directory: string) => getCheckpoint(test.db, COLLECTOR_SCOPE, `agents:${directory}`);
const deps = () => ({ db: test.db, source, now: () => clock, config: getConfig().collector,
  log: { info: () => {}, warn: () => {}, error: () => {} } });
const cycle = () => runCycle(deps(), "test", { releaseWhenDone: true });

beforeEach(() => {
  configureTestEnv();
  test = createTestDb();
  clock = Date.now();
  registryError = new UpstreamHttpError("/api/agent", 404);
  empty = false;
  sessions = [session("present", GOOD), session("historical", STALE)];
  source = {
    kind: "live", description: "synthetic only",
    getServerInfo: async () => ({ version: "2.0.28", pid: 1, urls: [], tmpPath: "/synthetic" }),
    listLocations: async () => [{ directory: GOOD, projectId: "project", projectDirectory: GOOD, canonical: GOOD }],
    listAgents: async directory => {
      if (directory === STALE && registryError) throw registryError;
      return { location: { directory }, agents: directory === STALE && empty ? [] : [agent] };
    },
    listSessions: async () => ({ sessions, nextCursor: null }),
    listMessages: async ({ sessionId }) => ({ messages: [{ type: "user", id: `msg-${sessionId}`, created: 100, text: "synthetic" }], nextCursor: null, unknownTypes: [] }),
  };
});
afterEach(() => { test.close(); cleanupTempDirs(); configureTestEnv(); });

describe("unavailable location registry", () => {
  it("commits both locations and their sessions/messages, without claiming failed registry coverage", async () => {
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 2, agents: 1, sessions: 2, messages: 2, activityEvents: 2, gapsRecorded: 1 });
    expect(listLocations(test.db)).toHaveLength(2);
    expect(listSessions(test.db, { limit: 10 })).toHaveLength(2);
    expect(listActivity(test.db, { sessionId: "historical", limit: 10 })).toHaveLength(1);
    expect(test.db.prepare("SELECT * FROM workspace_identity WHERE location_id = ?").get(staleId())).toBeDefined();
    expect(checkpoint(GOOD)?.updatedAt).toBe(clock);
    expect(checkpoint(STALE)).toBeNull();
    expect(getCheckpoint(test.db, COLLECTOR_SCOPE, "messages:historical")).not.toBeNull();
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)).toMatchObject({ lastCycleOk: false, lastSuccessAt: null });
    expect(listOpenGaps(test.db)).toMatchObject([{ stream: staleStream(), resumed: false }]);
  });

  it("preserves last successful agents, timestamps/checkpoint and outage start across retries", async () => {
    registryError = null;
    expect((await cycle())?.ok).toBe(true);
    const agents = listAgents(test.db).filter(a => a.locationId === staleId());
    const previous = checkpoint(STALE);
    const success = getCollectorState(test.db, COLLECTOR_SCOPE)?.lastSuccessAt;
    registryError = new UpstreamHttpError("/api/agent", 404);
    clock += 1000;
    expect((await cycle())?.gapsRecorded).toBe(1);
    const gap = listOpenGaps(test.db)[0];
    clock += 1000;
    expect((await cycle())?.gapsRecorded).toBe(0);
    expect(listAgents(test.db).filter(a => a.locationId === staleId())).toEqual(agents);
    expect(checkpoint(STALE)).toEqual(previous);
    expect(checkpoint(GOOD)?.updatedAt).toBe(clock);
    expect(listOpenGaps(test.db)).toEqual([gap]);
    expect(gap?.startedAt).toBe(previous?.updatedAt);
    expect(listWarnings(test.db, 20).filter(w => w.kind === "agent-registry-unavailable")).toMatchObject([{ occurrences: 1 }]);
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastSuccessAt).toBe(success);
  });

  it("recovers only the observed registry; successful empty snapshot deactivates previous membership", async () => {
    registryError = null;
    await cycle();
    registryError = new UpstreamHttpError("/api/agent", 404);
    clock += 100;
    await cycle();
    const otherStream = "agents:unobserved-location";
    openGap(test.db, { id: gapIdFor(COLLECTOR_SCOPE, otherStream, clock), scope: COLLECTOR_SCOPE, stream: otherStream,
      startedAt: clock, detectedAt: clock, reason: "synthetic independent registry" });
    registryError = null;
    empty = true;
    clock += 100;
    expect((await cycle())?.ok).toBe(false);
    expect(listOpenGaps(test.db).map(g => g.stream)).toEqual([otherStream]);
    expect(listAgents(test.db).filter(a => a.locationId === staleId())).toMatchObject([{ active: false }]);
    expect(checkpoint(STALE)?.updatedAt).toBe(clock);
    expect(listWarnings(test.db, 20).some(w => w.kind === "agent-registry-unavailable")).toBe(true);
  });

  it("returns healthy after same-location recovery", async () => {
    await cycle();
    registryError = null;
    clock += 100;
    expect((await cycle())?.ok).toBe(true);
    expect(listOpenGaps(test.db)).toEqual([]);
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastSuccessAt).toBe(clock);
  });

  it("does not close another scope's gap for the same location stream", async () => {
    await cycle();
    openGap(test.db, { id: "other-scope-gap", scope: "other-scope", stream: staleStream(),
      startedAt: clock, detectedAt: clock, reason: "synthetic other scope" });
    registryError = null;
    clock += 100;
    expect((await cycle())?.ok).toBe(true);
    expect(listOpenGaps(test.db)).toMatchObject([{ id: "other-scope-gap", scope: "other-scope", stream: staleStream() }]);
  });

  it("does not close the registry gap or advance its checkpoint on a rolled-back recovery", async () => {
    await cycle();
    const gap = listOpenGaps(test.db)[0];
    registryError = null;
    test.db.exec(`CREATE TRIGGER reject_registry BEFORE INSERT ON agents WHEN NEW.location_id = '${staleId()}'
      BEGIN SELECT RAISE(ABORT, 'synthetic registry rollback'); END`);
    clock += 100;
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 1, agents: 1, sessions: 0 });
    expect(listOpenGaps(test.db).find(g => g.stream === staleStream())).toEqual(gap);
    expect(checkpoint(STALE)).toBeNull();
    expect(listAgents(test.db).filter(a => a.locationId === staleId())).toEqual([]);
  });

  it("keeps out-of-window registry gaps open and health failed", async () => {
    await cycle();
    sessions = [session("present", GOOD)];
    clock += 100;
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 1, sessions: 1, messages: 1 });
    expect(listOpenGaps(test.db).map(g => g.stream)).toEqual([staleStream()]);
    const handle = acquireLease(test.db, COLLECTOR_SCOPE, "test", 60_000, clock)!;
    closeGapsAfterSuccess(test.db, handle, clock);
    expect(listOpenGaps(test.db).map(g => g.stream)).toEqual([staleStream()]);
  });

  it.each([
    new UpstreamAuthError("/api/agent"), new UpstreamHttpError("/api/agent", 500),
    new UpstreamUnavailableError("/api/agent", new Error("network")),
    new UpstreamPayloadError("/api/agent", ["bad payload"]), new UpstreamHttpError("/api/session", 404),
    Object.assign(new Error("lookalike"), { path: "/api/agent", status: 404 }),
  ])("keeps %s fatal and reports only earlier commits", async error => {
    registryError = error;
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 1, agents: 1, sessions: 0, messages: 0 });
    expect(result?.error).toContain(error.message);
    expect(checkpoint(GOOD)).not.toBeNull();
    expect(listOpenGaps(test.db).map(g => g.stream)).toEqual(["cycle"]);
  });

  it("opens a fatal cycle gap even when a registry gap exists, retaining earlier transcript counts", async () => {
    const messages = source.listMessages;
    source.listMessages = async params => {
      if (params.sessionId === "historical") throw new UpstreamHttpError("/api/session/historical/message", 404);
      return messages(params);
    };
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 2, agents: 1, sessions: 2, messages: 1, activityEvents: 1, gapsRecorded: 2 });
    expect(listOpenGaps(test.db).map(g => g.stream).sort()).toEqual([staleStream(), "cycle"].sort());
  });

  it("excludes a rolled-back session batch from counts", async () => {
    sessions[1] = { ...sessions[1]!, locationDirectory: GOOD, projectId: "conflicting-project" };
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 1, agents: 1, sessions: 0, messages: 0 });
    expect(listSessions(test.db, { limit: 10 })).toEqual([]);
  });

  it("excludes rolled-back transcript diagnostics and observations", async () => {
    test.db.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END");
    source.listMessages = async () => ({ messages: [{ type: "user", id: "m", created: 100, text: "x" }], nextCursor: null, unknownTypes: ["future"] });
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, sessions: 2, messages: 0, activityEvents: 0, duplicateMessages: 0, unknownMessageTypes: [] });
    expect(listActivity(test.db, { limit: 10 })).toEqual([]);
    expect(getCheckpoint(test.db, COLLECTOR_SCOPE, "messages:present")).toBeNull();
  });

  it("fences failed-registry identity, warnings, gaps and checkpoints after lease loss", async () => {
    const agents = source.listAgents;
    source.listAgents = async directory => {
      if (directory === STALE) test.db.prepare("UPDATE collector_leases SET holder_id = 'new-owner', epoch = epoch + 1").run();
      return agents(directory);
    };
    const result = await cycle();
    expect(result).toMatchObject({ ok: false, locations: 1, agents: 1, sessions: 0, gapsRecorded: 0 });
    expect(listLocations(test.db)).toHaveLength(1);
    expect(test.db.prepare("SELECT * FROM workspace_identity WHERE location_id = ?").get(staleId())).toBeUndefined();
    expect(listWarnings(test.db, 20)).toEqual([]);
    expect(listOpenGaps(test.db)).toEqual([]);
    expect(checkpoint(STALE)).toBeNull();
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastCycleOk).toBeNull();
  });
});

it("fixture missing mapping is typed 404, while an explicitly mapped empty registry succeeds", async () => {
  const directory = makeTempDir("registry-fixture-");
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ description: "synthetic", referenceNow: 0,
    serverInfo: "unused", location: "unused", sessions: "unused", sessionPageSize: 1, messagePageSize: 1,
    agentLists: { [GOOD]: "empty.json" } }));
  writeFileSync(path.join(directory, "empty.json"), JSON.stringify({ location: { directory: GOOD }, data: [] }));
  const fixture = new FixtureUpstreamSource({ fixtureDir: directory });
  await expect(fixture.listAgents(STALE)).rejects.toBeInstanceOf(UpstreamHttpError);
  await expect(fixture.listAgents(STALE)).rejects.toMatchObject({ path: "/api/agent", status: 404 });
  await expect(fixture.listAgents(GOOD)).resolves.toMatchObject({ agents: [] });
});

it("real one-shot CLI uses GET only, persists historical transcripts and exits 1 until registry recovery", async () => {
  const requests: { method: string | undefined; path: string; directory: string | null }[] = [];
  let missing = true;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const directory = url.searchParams.get("location[directory]");
    requests.push({ method: req.method, path: url.pathname, directory });
    res.setHeader("Content-Type", "application/json");
    let payload: unknown;
    switch (url.pathname) {
      case "/api/info": payload = { version: "2.0.28", pid: 1, urls: [], paths: { tmp: "/synthetic" } }; break;
      case "/api/location": payload = { directory: GOOD, project: { id: "project", directory: GOOD, canonical: GOOD } }; break;
      case "/api/project": payload = [{ id: "project", canonical: GOOD }]; break;
      case "/api/worktree": payload = []; break;
      case "/api/vcs": payload = { location: { directory }, data: {} }; break;
      case "/api/agent":
        if (directory === STALE && missing) { res.statusCode = 404; payload = { name: "LocationNotFoundError" }; }
        else payload = { location: { directory }, data: [agent] };
        break;
      case "/api/session": payload = { data: sessions.map(s => ({ id: s.id, projectID: s.projectId,
        location: { directory: s.locationDirectory }, time: { created: s.timeCreated, updated: s.timeUpdated } })) }; break;
      case "/api/session/present/message":
      case "/api/session/historical/message":
        payload = { data: [{ type: "user", id: "message", text: "synthetic", time: { created: 100 } }] }; break;
      default: res.statusCode = 500; payload = { error: "unexpected test request" };
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fake server address");
    const run = () => new Promise<{ code: string | number; stdout: string; stderr: string }>(resolve => {
      // No dotenv flags, inherited credentials or NODE_OPTIONS; CWD/DB are disposable.
      execFile(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.resolve("scripts/collector.ts"), "--once"], {
        cwd: test.dir, timeout: 15_000, env: { NODE_ENV: "test", ORCH_UPSTREAM_MODE: "live", ORCH_UPSTREAM_BASE_URL: `http://127.0.0.1:${address.port}`,
          ORCH_DB_PATH: test.dbPath, ORCH_DATA_DIR: test.dir },
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    });
    const failed = await run();
    expect(failed.code, failed.stderr + failed.stdout).toBe(1);
    expect(listSessions(test.db, { limit: 10 })).toHaveLength(2);
    expect(listActivity(test.db, { limit: 10 })).toHaveLength(2);
    expect(listOpenGaps(test.db)).toHaveLength(1);
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastCycleOk).toBe(false);
    expect(requests.some(r => r.path === "/api/agent" && r.directory === STALE)).toBe(true);
    missing = false;
    const recovered = await run();
    expect(recovered.code, recovered.stderr + recovered.stdout).toBe(0);
    expect(listOpenGaps(test.db)).toEqual([]);
    expect(getCollectorState(test.db, COLLECTOR_SCOPE)?.lastCycleOk).toBe(true);
    expect(requests.every(r => r.method === "GET")).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
