import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, getConfig } from "../../lib/config.ts";
import { cleanupTempDirs, configureTestEnv, fixtureDir } from "../helpers/harness.ts";

afterEach(() => {
  cleanupTempDirs();
  configureTestEnv();
});

/**
 * Configuration is fail-closed: an invalid value raises rather than silently
 * falling back to a weaker mode.
 */
describe("config defaults", () => {
  it("defaults to fixture mode and a loopback upstream", () => {
    configureTestEnv();
    const config = getConfig();
    expect(config.upstream.mode).toBe("fixture");
    expect(config.upstream.baseUrl).toBe("http://127.0.0.1:4096");
    expect(config.upstream.username).toBeNull();
  });

  it("defaults the fixture directory to the repository fixtures", () => {
    configureTestEnv();
    expect(getConfig().fixtureDir).toBe(fixtureDir());
  });

  it("applies documented defaults for collector bounds", () => {
    configureTestEnv();
    const config = getConfig();
    expect(config.collector.pollIntervalMs).toBe(5_000);
    expect(config.collector.leaseTtlMs).toBe(30_000);
    expect(config.collector.contentMaxChars).toBe(2_000);
    expect(config.sse.pollMs).toBe(1_000);
  });
});

describe("upstream base URL validation", () => {
  it("accepts loopback over plain http", () => {
    configureTestEnv({ ORCH_UPSTREAM_MODE: "live", ORCH_UPSTREAM_BASE_URL: "http://127.0.0.1:4096" });
    expect(getConfig().upstream.baseUrl).toBe("http://127.0.0.1:4096");
  });

  it("accepts localhost and private ranges over plain http", () => {
    for (const url of ["http://localhost:4096", "http://10.1.2.3:4096", "http://192.168.1.5:4096", "http://172.16.0.9:4096", "http://box.internal:4096"]) {
      configureTestEnv({ ORCH_UPSTREAM_BASE_URL: url });
      expect(getConfig().upstream.baseUrl, url).toBe(new URL(url).origin);
    }
  });

  it("refuses plain http to a public host", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "http://example.com" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("accepts https to a public host", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "https://code.example.com" });
    expect(getConfig().upstream.baseUrl).toBe("https://code.example.com");
  });

  it("refuses a non-http protocol", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "ftp://127.0.0.1" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("refuses credentials embedded in the URL", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "http://user:pass@127.0.0.1:4096" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("refuses a query string or fragment", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "http://127.0.0.1:4096?x=1" });
    expect(() => getConfig()).toThrow(ConfigError);
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "http://127.0.0.1:4096#frag" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("refuses a relative or malformed URL", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "not-a-url" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("normalises the base URL to an origin", () => {
    configureTestEnv({ ORCH_UPSTREAM_BASE_URL: "http://127.0.0.1:4096/" });
    expect(getConfig().upstream.baseUrl).toBe("http://127.0.0.1:4096");
  });
});

describe("enum and integer validation", () => {
  it("refuses an unknown upstream mode", () => {
    configureTestEnv({ ORCH_UPSTREAM_MODE: "hybrid" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("refuses a non-integer interval", () => {
    configureTestEnv({ ORCH_POLL_INTERVAL_MS: "soon" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("refuses an interval below the documented minimum", () => {
    configureTestEnv({ ORCH_POLL_INTERVAL_MS: "10" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("refuses an interval above the documented maximum", () => {
    configureTestEnv({ ORCH_POLL_INTERVAL_MS: String(10_000_000) });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("accepts a value on the boundary", () => {
    configureTestEnv({ ORCH_POLL_INTERVAL_MS: "250" });
    expect(getConfig().collector.pollIntervalMs).toBe(250);
  });

  it("names the offending variable in the error", () => {
    configureTestEnv({ ORCH_LEASE_TTL_MS: "-5" });
    try {
      getConfig();
      throw new Error("expected a ConfigError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).variable).toBe("ORCH_LEASE_TTL_MS");
      expect((cause as ConfigError).message).toContain("ORCH_LEASE_TTL_MS");
    }
  });
});

describe("owner credential validation", () => {
  it("accepts a plaintext password alone", () => {
    configureTestEnv({ ORCH_OWNER_PASSWORD: "hunter2" });
    expect(getConfig().auth.ownerPassword).toBe("hunter2");
    expect(getConfig().auth.ownerPasswordHash).toBeNull();
  });

  it("accepts a hash alone", () => {
    const hash = "scrypt$16384$8$1$c2FsdA:a2V5";
    configureTestEnv({ ORCH_OWNER_PASSWORD_HASH: hash });
    expect(getConfig().auth.ownerPasswordHash).toBe(hash);
  });

  it("refuses both at once rather than picking one", () => {
    configureTestEnv({ ORCH_OWNER_PASSWORD: "a", ORCH_OWNER_PASSWORD_HASH: "scrypt$1$1$1$a:b" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("treats a blank value as unset", () => {
    configureTestEnv({ ORCH_OWNER_PASSWORD: "   " });
    expect(getConfig().auth.ownerPassword).toBeNull();
  });
});

describe("cookie and origin configuration", () => {
  it("defaults to the auto secure policy", () => {
    configureTestEnv();
    expect(getConfig().auth.cookieSecure).toBe("auto");
  });

  it("normalises a public origin", () => {
    configureTestEnv({ ORCH_PUBLIC_ORIGIN: "https://code.sabasystem.app/some/path" });
    expect(getConfig().auth.publicOrigin).toBe("https://code.sabasystem.app");
  });

  it("refuses a malformed public origin", () => {
    configureTestEnv({ ORCH_PUBLIC_ORIGIN: "not a url" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("derives the session TTL from hours", () => {
    configureTestEnv({ ORCH_SESSION_TTL_HOURS: "1" });
    expect(getConfig().auth.sessionTtlMs).toBe(3_600_000);
  });
});

describe("config memoisation", () => {
  it("returns the same object until it is reset", () => {
    configureTestEnv();
    expect(getConfig()).toBe(getConfig());
  });

  it("re-reads the environment after a reset", () => {
    configureTestEnv({ ORCH_COOKIE_NAME: "one" });
    expect(getConfig().auth.cookieName).toBe("one");
    configureTestEnv({ ORCH_COOKIE_NAME: "two" });
    expect(getConfig().auth.cookieName).toBe("two");
  });
});
