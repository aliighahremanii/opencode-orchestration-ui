import { beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { OWNER_PASSWORD, buildApp, http, login, makeDataDir, removeDataDir, startServer, type ServerHandle } from "./harness.ts";

const ARTIFACTS = process.env.AUTH_E2E_ARTIFACTS ?? "/tmp/opencode/orchestration-workspace-reset/auth-io";
const BLOCKING_DIAGNOSTIC = /Blocking Route|current time|Date\.now\(\)|blocking-route|sync-io/i;

beforeAll(async () => { await mkdir(ARTIFACTS, { recursive: true }); await buildApp(); }, 300_000);

describe("auth runtime I/O boundary with Cache Components and partial prefetching", () => {
  for (const mode of ["dev", "start"] as const) {
    it(`renders gated pages without clock/prerender diagnostics in next ${mode}`, async () => {
      const made = makeDataDir("auth-io-");
      let server: ServerHandle | undefined;
      const observations: { path: string; attempt: number; status: number; diagnostic: boolean }[] = [];
      try {
        server = await startServer({ dbPath: made.dbPath, dataDir: made.dir, ownerPassword: OWNER_PASSWORD, mode });
        const cookie = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
        // Both cold and warm requests: partial runtime prerender can fail even
        // when the route returns 200. Consume the entire streamed body and check
        // server output as well as status, never merely the static shell.
        for (const route of ["/", "/activity", "/agents", "/demo", "/overview", "/runs", "/runs/run_synthetic", "/sessions/ses_synthetic", "/status"]) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await http(`${server.baseUrl}${route}`, { cookie });
            observations.push({ path: route, attempt, status: response.status, diagnostic: BLOCKING_DIAGNOSTIC.test(response.body) });
            expect(response.status).toBe(200);
            expect(response.body.includes("Sign-in required"), `${route} authenticated page`).toBe(false);
            expect(BLOCKING_DIAGNOSTIC.test(response.body), `${route} streamed diagnostic`).toBe(false);
          }
        }
        const denied = await http(`${server.baseUrl}/activity`, { cookie: "orch_session=synthetic-forged-token" });
        expect(denied.body.includes("Sign-in required")).toBe(true);
        expect(BLOCKING_DIAGNOSTIC.test(denied.body)).toBe(false);
        await server.stop();
        expect(server.output()).not.toMatch(BLOCKING_DIAGNOSTIC);
      } finally {
        await server?.stop();
        // No cookies, auth responses, credentials or response captures persisted.
        await writeFile(`${ARTIFACTS}/${mode}.log`, server?.output() ?? "Server did not start.");
        await writeFile(`${ARTIFACTS}/${mode}-results.json`, JSON.stringify(observations, null, 2));
        removeDataDir(made.dir);
      }
    }, 180_000);
  }
});
