import path from "node:path";

/**
 * Server-side configuration for the orchestration observer.
 *
 * All configuration is read from the process environment. Nothing here is ever
 * exposed to the browser: the web process only reads its own local SQLite
 * database, and never contacts the upstream OpenCode instance.
 *
 * Failure policy: invalid configuration raises `ConfigError` so the process
 * fails closed instead of silently falling back to a weaker mode.
 */

export type UpstreamMode = "fixture" | "live";
export type CookieSecureMode = "auto" | "always" | "never";

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`Invalid configuration for ${variable}: ${message}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

export interface UpstreamConfig {
  /** `fixture` never contacts the network. `live` uses the configured base URL. */
  readonly mode: UpstreamMode;
  readonly baseUrl: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly requestTimeoutMs: number;
}

export interface AuthConfig {
  readonly ownerPassword: string | null;
  readonly ownerPasswordHash: string | null;
  readonly cookieName: string;
  readonly sessionTtlMs: number;
  readonly cookieSecure: CookieSecureMode;
  readonly publicOrigin: string | null;
  /**
   * Whether `X-Forwarded-For` may be used to identify a client for login
   * throttling.
   *
   * Defaults to `false`, and it must stay `false` unless a reverse proxy in
   * front of this application is known to strip or overwrite the header.
   * `X-Forwarded-For` is supplied by the client, so trusting it by default would
   * let an attacker rotate the value and defeat the throttle entirely.
   */
  readonly trustProxyHeaders: boolean;
}

export interface CollectorConfig {
  readonly pollIntervalMs: number;
  readonly leaseTtlMs: number;
  readonly sessionPageLimit: number;
  readonly messagePageLimit: number;
  readonly maxSessionsPerLocation: number;
  readonly contentMaxChars: number;
}

export interface SseConfig {
  readonly pollMs: number;
  readonly heartbeatMs: number;
  readonly maxMs: number;
}

export interface AppConfig {
  readonly upstream: UpstreamConfig;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly auth: AuthConfig;
  readonly collector: CollectorConfig;
  readonly sse: SseConfig;
  readonly fixtureDir: string;
}

function readString(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readInt(
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = readString(name);
  if (raw === null) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(name, `expected an integer, received ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < bounds.min || value > bounds.max) {
    throw new ConfigError(name, `expected a value between ${bounds.min} and ${bounds.max}, received ${value}`);
  }
  return value;
}

function readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = readString(name);
  if (raw === null) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new ConfigError(name, `expected one of ${allowed.join(", ")}, received ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

/**
 * Only `http://` loopback or a private/`.local` host is accepted without an
 * explicit opt-in. This keeps a misconfigured deployment from pointing the
 * collector at an arbitrary public origin.
 */
function validateUpstreamBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("ORCH_UPSTREAM_BASE_URL", `not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("ORCH_UPSTREAM_BASE_URL", `only http and https are supported, received ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(
      "ORCH_UPSTREAM_BASE_URL",
      "must not embed credentials; use ORCH_UPSTREAM_USERNAME / ORCH_UPSTREAM_PASSWORD",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("ORCH_UPSTREAM_BASE_URL", "must not include a query string or fragment");
  }
  const host = url.hostname;
  const isLoopback =
    host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
  const isPrivate =
    isLoopback ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol === "http:" && !isPrivate) {
    throw new ConfigError(
      "ORCH_UPSTREAM_BASE_URL",
      "plain http is only allowed for loopback/private hosts; use https or an explicit private address",
    );
  }
  // Normalise to an origin-only base so path joins are unambiguous.
  return url.origin;
}

function buildConfig(): AppConfig {
  const cwd = process.cwd();

  // Path resolution is split deliberately. A default path is statically scoped
  // under the project directory, which keeps Turbopack from tracing the whole
  // project into the build output. An operator-supplied override is genuinely
  // dynamic, so it is resolved with an explicit opt-out of build-time tracing.
  const dataDirEnv = readString("ORCH_DATA_DIR");
  const dataDir = dataDirEnv === null ? path.join(cwd, ".orch-data") : path.resolve(/* turbopackIgnore: true */ dataDirEnv);

  const dbPathEnv = readString("ORCH_DB_PATH");
  const dbPath =
    dbPathEnv === null ? path.join(dataDir, "orchestration.sqlite") : path.resolve(/* turbopackIgnore: true */ dbPathEnv);

  const fixtureDirEnv = readString("ORCH_FIXTURE_DIR");
  const fixtureDir =
    fixtureDirEnv === null ? path.join(cwd, "fixtures") : path.resolve(/* turbopackIgnore: true */ fixtureDirEnv);

  const mode = readEnum<UpstreamMode>("ORCH_UPSTREAM_MODE", ["fixture", "live"], "fixture");
  const baseUrlRaw = readString("ORCH_UPSTREAM_BASE_URL") ?? "http://127.0.0.1:4096";

  const publicOriginRaw = readString("ORCH_PUBLIC_ORIGIN");
  let publicOrigin: string | null = null;
  if (publicOriginRaw !== null) {
    try {
      publicOrigin = new URL(publicOriginRaw).origin;
    } catch {
      throw new ConfigError("ORCH_PUBLIC_ORIGIN", `not a valid absolute URL: ${JSON.stringify(publicOriginRaw)}`);
    }
  }

  const password = readString("ORCH_OWNER_PASSWORD");
  const passwordHash = readString("ORCH_OWNER_PASSWORD_HASH");
  if (password !== null && passwordHash !== null) {
    throw new ConfigError(
      "ORCH_OWNER_PASSWORD",
      "set either ORCH_OWNER_PASSWORD or ORCH_OWNER_PASSWORD_HASH, not both",
    );
  }

  return {
    upstream: {
      mode,
      baseUrl: validateUpstreamBaseUrl(baseUrlRaw),
      username: readString("ORCH_UPSTREAM_USERNAME"),
      password: readString("ORCH_UPSTREAM_PASSWORD"),
      requestTimeoutMs: readInt("ORCH_UPSTREAM_TIMEOUT_MS", 10_000, { min: 500, max: 120_000 }),
    },
    dataDir,
    dbPath,
    auth: {
      ownerPassword: password,
      ownerPasswordHash: passwordHash,
      cookieName: readString("ORCH_COOKIE_NAME") ?? "orch_session",
      sessionTtlMs: readInt("ORCH_SESSION_TTL_HOURS", 168, { min: 1, max: 24 * 365 }) * 3_600_000,
      cookieSecure: readEnum<CookieSecureMode>("ORCH_COOKIE_SECURE", ["auto", "always", "never"], "auto"),
      trustProxyHeaders: readEnum<"true" | "false">(
        "ORCH_TRUST_PROXY_HEADERS",
        ["true", "false"],
        "false",
      ) === "true",
      publicOrigin,
    },
    collector: {
      pollIntervalMs: readInt("ORCH_POLL_INTERVAL_MS", 5_000, { min: 250, max: 3_600_000 }),
      leaseTtlMs: readInt("ORCH_LEASE_TTL_MS", 30_000, { min: 2_000, max: 3_600_000 }),
      sessionPageLimit: readInt("ORCH_SESSION_PAGE_LIMIT", 100, { min: 1, max: 1_000 }),
      messagePageLimit: readInt("ORCH_MESSAGE_PAGE_LIMIT", 100, { min: 1, max: 1_000 }),
      maxSessionsPerLocation: readInt("ORCH_HISTORY_MAX_SESSIONS", 500, { min: 1, max: 100_000 }),
      contentMaxChars: readInt("ORCH_CONTENT_MAX_CHARS", 2_000, { min: 0, max: 200_000 }),
    },
    sse: {
      pollMs: readInt("ORCH_SSE_POLL_MS", 1_000, { min: 100, max: 60_000 }),
      heartbeatMs: readInt("ORCH_SSE_HEARTBEAT_MS", 15_000, { min: 1_000, max: 300_000 }),
      maxMs: readInt("ORCH_SSE_MAX_MS", 300_000, { min: 5_000, max: 3_600_000 }),
    },
    fixtureDir,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached === null) {
    cached = buildConfig();
  }
  return cached;
}

/** Test helper: drop the memoised configuration. */
export function resetConfigForTests(): void {
  cached = null;
}
