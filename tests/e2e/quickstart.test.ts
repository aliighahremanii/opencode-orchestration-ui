import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  REPO_ROOT,
  buildApp,
  getTestAppDirectory,
  assertIsolatedDotenvReads,
  http,
  login,
  freePort,
  makeDataDir,
  readPackageScript,
  removeDataDir,
  repoPathExists,
  runNpmScript,
  startServerViaNpm,
} from "./harness.ts";
import type { StatusResponse } from "../../lib/contracts/api.ts";
import { expectedSchemaVersion } from "../../lib/db/migrations.ts";

/**
 * Quickstart verification.
 *
 * Regression for the finding that the documented quickstart did not work: the
 * README tells the user to `cp .env.example .env` and then run `npm run migrate`
 * and `npm run collector:once`, but plain Node does not read `.env`. Next.js
 * does. So the collector and the web server ended up on *different* databases —
 * the collector wrote to the `.env` path while the server read its own default,
 * and the dashboard showed nothing.
 *
 * These tests exercise the documented sequence as a user would run it: the npm
 * scripts are spawned by name, with **no** `ORCH_*` variables in the process
 * environment, so anything the processes see must have come from `.env`.
 */

// Never read, copy or temporarily replace the developer's credential file.
const sandbox={dir:getTestAppDirectory()};
const ENV_PATH = path.join(sandbox.dir, ".env");
const DEFAULT_DB_PATH = path.join(sandbox.dir, ".orch-data", "orchestration.sqlite");
beforeAll(async()=>{
  await buildApp();
},300000);

describe("quickstart .env configuration", () => {
  it("builds in an application copy containing only synthetic dotenv, without checkout symlinks",()=>{
    expect(sandbox.dir.startsWith("/tmp/opencode/orchestration-workspace-reset/review-fixes/e2e/")).toBe(true);
    expect(readFileSync(ENV_PATH,"utf8")).toBe("ORCH_E2E_DOTENV_CANARY=synthetic-sandbox-only\n");
    assertIsolatedDotenvReads();
  });
  it("declares --env-file-if-exists=.env on every Node entrypoint", () => {
    // The static half of the guard: a future edit that drops the flag fails here.
    for (const script of ["collector", "collector:once", "migrate", "auth:hash"]) {
      const command = readPackageScript(script);
      expect(command, script).toContain("--env-file-if-exists=.env");
    }
  });

  it("documents the same flag location the tests assert", () => {
    // The flag path is relative to the working directory, which for these
    // scripts is the repository root.
    expect(readPackageScript("collector:once")).toContain("scripts/collector.ts");
    expect(repoPathExists("scripts/collector.ts")).toBe(true);
  });
});

describe("quickstart sequence end to end", () => {
  const made = makeDataDir("orch-quickstart-");
  let server: Awaited<ReturnType<typeof startServerViaNpm>> | null = null;

  afterAll(async () => {
    await server?.stop();
    removeDataDir(made.dir);
  });

  it("runs the documented sequence and both processes agree on one database", async () => {
    // Step 2 of the quickstart: a .env that points at a specific database and
    // enables fixture mode. Nothing here is exported to the spawned processes by
    // the test itself.
    writeFileSync(
      ENV_PATH,
      [
        `ORCH_DATA_DIR=${made.dir}`,
        `ORCH_DB_PATH=${made.dbPath}`,
        "ORCH_UPSTREAM_MODE=fixture",
        `ORCH_FIXTURE_DIR=${path.join(sandbox.dir, "fixtures")}`,
        "ORCH_FIXTURE_STATIC_TIME=1",
        `ORCH_OWNER_PASSWORD=${OWNER_PASSWORD}`,
        "ORCH_COOKIE_SECURE=never",
      ].join("\n") + "\n",
      "utf8",
    );

    // Step 3: migrate. Run through npm, with no ORCH_* in the environment.
    const migrated = await runNpmScript("migrate",[],{},{cwd:sandbox.dir});
    expect(migrated.code, `migrate failed:\n${migrated.stderr}`).toBe(0);
    expect(existsSync(made.dbPath)).toBe(true);

    const migrateReport = JSON.parse(migrated.stdout.slice(migrated.stdout.indexOf("{"))) as {
      dbPath: string;
      schemaVersion: number;
      ownerConfigured: boolean;
    };
    // The migration tool saw the .env paths, not the defaults.
    expect(migrateReport.dbPath).toBe(made.dbPath);
    expect(migrateReport.schemaVersion).toBe(expectedSchemaVersion());
    expect(migrateReport.ownerConfigured).toBe(true);

    // Step 4: collect once. Also through npm.
    const collected = await runNpmScript("collector:once",[],{},{cwd:sandbox.dir});
    expect(collected.code, `collector:once failed:\n${collected.stderr}`).toBe(0);
    expect(collected.stdout).toContain("single cycle finished");
    expect(existsSync(made.dbPath)).toBe(true);

    // The collector's own startup log names the database it opened, which is the
    // most direct evidence available: it proves the process read `.env` rather
    // than falling back to the default data directory. That fallback is exactly
    // the bug being pinned down here.
    expect(collected.stdout).toContain(made.dbPath);
    expect(collected.stdout).not.toContain(DEFAULT_DB_PATH);

    // And the fallback location was genuinely never created. This is now a
    // meaningful assertion rather than an incidental one: the build no longer
    // creates the data directory either, so its absence isolates the collector's
    // own path resolution.
    expect(existsSync(DEFAULT_DB_PATH)).toBe(false);
    expect(existsSync(path.join(sandbox.dir, ".orch-data"))).toBe(false);

    // Step 5: start the web server, again with no ORCH_* in the environment.
    const port = await freePort();
    server = await startServerViaNpm({ port,cwd:sandbox.dir });

    const cookie = await login(server.baseUrl, OWNER_PASSWORD, server.baseUrl);
    const status = await http(`${server.baseUrl}/api/status`, { cookie });
    expect(status.status).toBe(200);
    const body = status.json<StatusResponse>();

    // Both processes resolved the same database file, which is the whole point.
    expect(body.database.dbPath).toBe(made.dbPath);
    expect(body.database.ready).toBe(true);
    expect(body.database.schemaVersion).toBe(expectedSchemaVersion());

    // And the dashboard can actually see what the collector wrote, so the
    // quickstart produces a working application rather than an empty one.
    const overview = await http(`${server.baseUrl}/api/overview`, { cookie });
    const counts = overview.json<{ counts: { sessions: number; rootRuns: number; invocations: number } }>().counts;
    expect(counts.sessions).toBeGreaterThan(0);
    expect(counts.rootRuns).toBeGreaterThan(0);
    expect(counts.invocations).toBeGreaterThan(0);

    // Stop here rather than in the shared teardown, so the next test starts from
    // a clean state and no server outlives this test.
    await server.stop();
    server = null;
  }, 300_000);

  it("fails closed on a fresh database when .env supplies no owner credential", async () => {
    // A fresh directory, so no credential exists yet. The documented behaviour
    // is that every data route refuses rather than serving anonymously.
    //
    // Note this needs a *fresh* database: the credential is stored as a hash, so
    // once the owner has signed in it survives removing the variable. That is
    // intended, and it is why this test does not simply reuse the database from
    // the test above.
    const fresh = makeDataDir("orch-quickstart-nocred-");
    try {
      writeFileSync(
        ENV_PATH,
        [
          `ORCH_DATA_DIR=${fresh.dir}`,
          `ORCH_DB_PATH=${fresh.dbPath}`,
          "ORCH_UPSTREAM_MODE=fixture",
          `ORCH_FIXTURE_DIR=${path.join(sandbox.dir, "fixtures")}`,
          "ORCH_COOKIE_SECURE=never",
        ].join("\n") + "\n",
        "utf8",
      );

      // Step 3 of the quickstart: migrate. The migration tool must report that
      // no credential exists yet.
      const migrated = await runNpmScript("migrate",[],{},{cwd:sandbox.dir});
      expect(migrated.code, `migrate failed:\n${migrated.stderr}`).toBe(0);
      const report = JSON.parse(migrated.stdout.slice(migrated.stdout.indexOf("{"))) as {
        ownerConfigured: boolean;
        warnings: string[];
      };
      expect(report.ownerConfigured).toBe(false);
      expect(report.warnings.join(" ")).toContain("ORCH_OWNER_PASSWORD");

      const port = await freePort();
      const second = await startServerViaNpm({ port,cwd:sandbox.dir });
      try {
        const overview = await http(`${second.baseUrl}/api/overview`);
        expect(overview.status).toBe(503);
        expect(overview.json<{ code: string }>().code).toBe("auth-not-configured");

        // Sign-in is refused too, and issues no cookie.
        const attempt = await http(`${second.baseUrl}/api/auth/login`, {
          method: "POST",
          origin: second.baseUrl,
          body: { password: "anything" },
        });
        expect(attempt.status).toBe(503);
        expect(attempt.setCookies).toHaveLength(0);

        // The sign-in page reports the problem instead of failing opaquely.
        const session = await http(`${second.baseUrl}/api/auth/session`);
        const state = session.json<{ configured: boolean; authenticated: boolean; reason: string | null }>();
        expect(state.configured).toBe(false);
        expect(state.authenticated).toBe(false);
        expect(state.reason).toContain("ORCH_OWNER_PASSWORD");
      } finally {
        await second.stop();
      }
    } finally {
      removeDataDir(fresh.dir);
    }
  }, 240_000);
});

describe("quickstart prerequisites", () => {
  it("ships the .env.example the quickstart tells the user to copy", async () => {
    await buildApp();
    const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    // The variables the quickstart explicitly tells the user to set.
    expect(example).toContain("ORCH_OWNER_PASSWORD");
    expect(example).toContain("ORCH_UPSTREAM_MODE");
    expect(example).toContain("ORCH_DATA_DIR");
    // And the ones this test relies on.
    expect(example).toContain("ORCH_DB_PATH");
    expect(example).toContain("ORCH_COOKIE_SECURE");
  }, 300_000);
});
