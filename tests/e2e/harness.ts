import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGuardLoaded, assertIsolatedRuntime, createIsolatedApp, isolatedAppEnv } from "../helpers/isolated-app.ts";

/**
 * E2E harness.
 *
 * Drives the real production Next.js server over HTTP with Node's built-in
 * `fetch`. No browser is installed in this environment, so these tests assert on
 * HTTP status, headers, cookies, and JSON bodies — not on rendered pixels. That
 * is recorded as a limitation in the final report.
 */

export const REPO_ROOT = process.cwd();
export const OWNER_PASSWORD = "e2e-owner-password-9f2c";
let applicationDirectory:string|undefined;
let build:Promise<void>|undefined;
export function getTestAppDirectory():string {
  return applicationDirectory ??= createIsolatedApp(REPO_ROOT);
}
export function assertIsolatedDotenvReads():void {
  const directory=getTestAppDirectory();assertGuardLoaded(directory);
  const auditPath=path.join(directory,"dotenv-access.jsonl");
  if(!existsSync(auditPath))throw new Error("E2E guard loaded, but no synthetic dotenv read was audited. Check the child runtime and sandbox configuration; do not run Next from the checkout.");
  const audit=readFileSync(auditPath,"utf8").trim().split("\n").map(line=>JSON.parse(line) as {file:string;allowed:boolean});
  if(!audit.some(row=>row.file===".env"&&row.allowed)||audit.some(row=>!row.allowed))
    throw new Error("Next dotenv access escaped the isolated application or instrumentation did not observe the synthetic dotenv.");
}
function appDirectory(cwd?:string):string {
  const owned=getTestAppDirectory();
  if(cwd!==undefined&&cwd!==owned)throw new Error("E2E processes must run in their isolated application copy.");
  return owned;
}

export interface ServerHandle {
  readonly baseUrl: string;
  readonly dbPath: string;
  readonly dataDir: string;
  readonly origin: string;
  /** Output from this disposable test server, for rendering diagnostic checks. */
  output(): string;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return isolatedAppEnv(getTestAppDirectory(),overrides);
}

export async function runCollectorOnce(dbPath: string, dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/collector.ts", "--once"], {
      cwd: appDirectory(),
      env: childEnv({
        ORCH_DB_PATH: dbPath,
        ORCH_DATA_DIR: dataDir,
        ORCH_UPSTREAM_MODE: "fixture",
        ORCH_FIXTURE_DIR: path.join(getTestAppDirectory(), "fixtures"),
        ORCH_FIXTURE_STATIC_TIME: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function buildApp(): Promise<void> {
  const directory=appDirectory();
  assertIsolatedRuntime(directory,process.execPath,"node");
  build ??= new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "build"], {
      cwd: directory,
      env: childEnv({}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try{assertGuardLoaded(directory,child.pid);}catch(error){reject(error);return;}
      if (code === 0) resolve();
      else reject(new Error(`next build failed with code ${code}:\n${output.slice(-4000)}`));
    });
  });
  await build;
  assertIsolatedDotenvReads();
}

export interface StartOptions {
  readonly dbPath: string;
  readonly dataDir: string;
  readonly ownerPassword?: string | null;
  readonly cookieSecure?: string;
  readonly publicOrigin?: string | null;
  readonly mode?: "dev" | "start";
}

export async function startServer(options: StartOptions): Promise<ServerHandle> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const overrides: Record<string, string> = {
    ORCH_DB_PATH: options.dbPath,
    ORCH_DATA_DIR: options.dataDir,
    ORCH_UPSTREAM_MODE: "fixture",
    ORCH_FIXTURE_DIR: path.join(getTestAppDirectory(), "fixtures"),
    ORCH_FIXTURE_STATIC_TIME: "1",
    // Next only sees the copied application's synthetic dotenv, never checkout
    // dotenv. Explicit values isolate each owner's scenario within that sandbox.
    ORCH_OWNER_PASSWORD: "",
    ORCH_OWNER_PASSWORD_HASH: "",
    ORCH_COOKIE_SECURE: options.cookieSecure ?? "auto",
    ORCH_POLL_INTERVAL_MS: "1000",
    ORCH_LEASE_TTL_MS: "15000",
    ORCH_SSE_POLL_MS: "200",
    ORCH_SSE_HEARTBEAT_MS: "1000",
    ORCH_SSE_MAX_MS: "20000",
  };
  if (options.ownerPassword !== null && options.ownerPassword !== undefined) {
    overrides.ORCH_OWNER_PASSWORD = options.ownerPassword;
  }
  if (options.publicOrigin !== null && options.publicOrigin !== undefined) {
    overrides.ORCH_PUBLIC_ORIGIN = options.publicOrigin;
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join("node_modules", "next", "dist", "bin", "next"), options.mode ?? "start", "-p", String(port)],
    {
      cwd: appDirectory(),
      env: childEnv({...overrides,NODE_ENV:options.mode==="dev"?"development":"production"}),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  const handle: ServerHandle = {
    baseUrl: origin,
    dbPath: options.dbPath,
    dataDir: options.dataDir,
    origin,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 10_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
      assertIsolatedDotenvReads();
    },
  };

  await waitForReady(origin, () => output, child);
  assertGuardLoaded(getTestAppDirectory(),child.pid);
  return handle;
}

async function waitForReady(baseUrl: string, getOutput: () => string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited with code ${child.exitCode}:\n${getOutput().slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return;
    } catch {
      // Not listening (or not responding) yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`next start did not become ready:\n${getOutput().slice(-4000)}`);
}

export function makeDataDir(prefix = "orch-e2e-"): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, dbPath: path.join(dir, "e2e.sqlite") };
}

export function removeDataDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

// --- HTTP helpers ----------------------------------------------------------

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly setCookies: readonly string[];
  readonly body: string;
  json<T>(): T;
}

export async function http(
  url: string,
  options: {
    readonly method?: string;
    readonly cookie?: string | null;
    readonly origin?: string | null;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly redirect?: RequestRedirect;
    readonly signal?: AbortSignal;
  } = {},
): Promise<HttpResult> {
  const headers = new Headers(options.headers ?? {});
  if (options.cookie !== null && options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.origin !== null && options.origin !== undefined) headers.set("origin", options.origin);
  if (options.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: options.redirect ?? "manual",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const body = await response.text();
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return {
    status: response.status,
    headers: response.headers,
    setCookies,
    body,
    json<T>(): T {
      return JSON.parse(body) as T;
    },
  };
}

/** Extract the `name=value` pair from a Set-Cookie header for reuse as a Cookie header. */
export function cookiePair(setCookie: string): string {
  const pair = setCookie.split(";")[0] ?? "";
  return pair;
}

export async function login(baseUrl: string, password: string, origin: string): Promise<string> {
  const result = await http(`${baseUrl}/api/auth/login`, { method: "POST", origin, body: { password } });
  if (result.status !== 200) {
    throw new Error(`login failed with ${result.status}: ${result.body}`);
  }
  const setCookie = result.setCookies[0];
  if (setCookie === undefined) throw new Error("login returned no Set-Cookie header");
  return cookiePair(setCookie);
}

/**
 * Read SSE frames until `until` is satisfied or the deadline passes.
 *
 * Reading on a predicate rather than a fixed frame count makes the test robust
 * against interleaved heartbeat comment frames and the stream's rotation.
 */
export async function readSseFrames(
  url: string,
  cookie: string,
  options: { readonly until: (frames: readonly string[]) => boolean; readonly timeoutMs: number; readonly maxFrames?: number },
): Promise<string[]> {
  const maxFrames = options.maxFrames ?? 50;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const frames: string[] = [];
  try {
    const response = await fetch(url, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`SSE request returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        frames.push(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (options.until(frames) || frames.length >= maxFrames) {
          await reader.cancel();
          return frames;
        }
        separator = buffer.indexOf("\n\n");
      }
    }
    return frames;
  } catch (cause) {
    // A timeout is expected when the predicate is never satisfied; the caller
    // asserts on what was collected.
    if (frames.length > 0) return frames;
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export function hasFrame(frames: readonly string[], needle: string): boolean {
  return frames.some((frame) => frame.includes(needle));
}

/** Parse the JSON payload of the first frame whose `event:` matches. */
export function framePayload<T>(frames: readonly string[], eventName: string): T | null {
  for (const frame of frames) {
    if (!frame.includes(`event: ${eventName}`)) continue;
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    return JSON.parse(dataLine.slice("data: ".length)) as T;
  }
  return null;
}

// --- npm script execution (quickstart verification) -------------------------

export interface NpmRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run an npm script from the isolated application with an allowlisted environment.
 *
 * Used to verify the documented quickstart: the scripts must be the entrypoints a
 * user actually runs, so they are spawned by name rather than by re-deriving
 * their command line.
 */
export async function runNpmScript(
  script: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
  options: { readonly cwd?: string } = {},
): Promise<NpmRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script, ...(args.length > 0 ? ["--", ...args] : [])], {
      cwd: appDirectory(options.cwd),
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Read a script's command line from package.json, so tests assert the real one. */
export function readPackageScript(name: string): string {
  const raw = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  const command = parsed.scripts?.[name];
  if (command === undefined) throw new Error(`package.json has no script named ${name}`);
  return command;
}

export function repoPathExists(relative: string): boolean {
  return existsSync(path.join(REPO_ROOT, relative));
}

/**
 * Start the web server through `npm run start`, with no ORCH_* variables in the
 * process environment.
 *
 * Any configuration the process sees must therefore have come from the `.env`
 * file, which is exactly what the quickstart relies on.
 */
export async function startServerViaNpm(
  options: { readonly port: number; readonly cwd?:string },
): Promise<{ baseUrl: string; stop(): Promise<void>; output(): string }> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const child = spawn("npm", ["run", "start", "--", "-p", String(options.port)], {
    cwd: appDirectory(options.cwd),
    env: childEnv({}),
    stdio: ["ignore", "pipe", "pipe"],
    // A new process group lets the teardown signal the whole tree. `npm` does not
    // forward SIGTERM to the `next start` child, so without this the Next server
    // is orphaned and keeps the port, and the next start-up then hangs.
    detached: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killGroup("SIGKILL");
        resolve();
      }, 10_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      killGroup("SIGTERM");
    });
    assertIsolatedDotenvReads();
  };

  const killGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      // Negative pid targets the group created by `detached: true`.
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
      try {
        child.kill(signal);
      } catch {
        // Nothing left to signal.
      }
    }
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`npm run start exited with code ${child.exitCode}:\n${output.slice(-4000)}`);
    }
    let ready=false;
    try {
      const response = await fetch(`${baseUrl}/login`, {
        redirect: "manual",
        // Without a per-attempt timeout, a socket that accepts but never
        // responds would hang this probe indefinitely instead of retrying.
        signal: AbortSignal.timeout(2_000),
      });
      ready=response.status===200;
    } catch {
      // Not listening (or not responding) yet.
    }
    if(ready){assertGuardLoaded(getTestAppDirectory(),child.pid);return { baseUrl, stop, output: () => output };}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error(`npm run start did not become ready:\n${output.slice(-4000)}`);
}
