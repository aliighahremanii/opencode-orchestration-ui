import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  InsecureCookieConfigurationError,
  buildClearedCookie,
  buildSessionCookie,
  serialiseCookie,
  shouldUseSecureCookie,
} from "../../lib/auth/session.ts";
import { cleanupTempDirs, configureTestEnv } from "../helpers/harness.ts";

afterEach(() => {
  cleanupTempDirs();
  configureTestEnv();
});

/**
 * Session cookie policy.
 *
 * The cookie carries the owner's session, so it must be HttpOnly, SameSite=Lax,
 * path-scoped, and marked Secure whenever the deployment is reachable over https.
 * The `auto` default must not be able to ship a plaintext-capable cookie in
 * production.
 */
function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url), { headers: new Headers(headers) });
}

describe("shouldUseSecureCookie", () => {
  it("marks the cookie Secure for an https public origin", () => {
    configureTestEnv({ ORCH_PUBLIC_ORIGIN: "https://code.example.com" });
    expect(shouldUseSecureCookie(request("http://127.0.0.1:3000/login"))).toBe(true);
  });

  it("marks the cookie Secure when the request arrived over https", () => {
    configureTestEnv();
    expect(shouldUseSecureCookie(request("http://127.0.0.1:3000/login", { "x-forwarded-proto": "https" }))).toBe(true);
  });

  it("reads the first value of a forwarded proto chain", () => {
    configureTestEnv();
    expect(shouldUseSecureCookie(request("http://127.0.0.1:3000/login", { "x-forwarded-proto": "https, http" }))).toBe(true);
  });

  it("omits Secure for a plain http loopback deployment with no public origin", () => {
    configureTestEnv();
    expect(shouldUseSecureCookie(request("http://127.0.0.1:3000/login"))).toBe(false);
  });

  it("forces Secure under the always policy", () => {
    configureTestEnv({ ORCH_COOKIE_SECURE: "always" });
    expect(shouldUseSecureCookie(request("http://127.0.0.1:3000/login"))).toBe(true);
  });

  it("refuses the never policy while a public https origin is configured", () => {
    configureTestEnv({ ORCH_COOKIE_SECURE: "never", ORCH_PUBLIC_ORIGIN: "https://code.example.com" });
    expect(() => shouldUseSecureCookie(request("http://127.0.0.1:3000/login"))).toThrow(InsecureCookieConfigurationError);
  });

  it("allows the never policy for a loopback-only deployment", () => {
    configureTestEnv({ ORCH_COOKIE_SECURE: "never" });
    expect(shouldUseSecureCookie(request("http://127.0.0.1:3000/login"))).toBe(false);
  });
});

describe("buildSessionCookie", () => {
  it("sets the hardening attributes", () => {
    configureTestEnv();
    const cookie = buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "tok", expiresAt: Date.now() + 60_000 });
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/");
    expect(cookie.maxAgeSeconds).toBeGreaterThan(0);
  });

  it("uses the configured cookie name", () => {
    configureTestEnv({ ORCH_COOKIE_NAME: "custom_session" });
    const cookie = buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "tok", expiresAt: Date.now() + 1000 });
    expect(cookie.name).toBe("custom_session");
  });

  it("never reports a zero or negative max age", () => {
    configureTestEnv();
    const cookie = buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "tok", expiresAt: Date.now() - 10_000 });
    expect(cookie.maxAgeSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("buildClearedCookie", () => {
  it("expires the cookie immediately and keeps the hardening", () => {
    configureTestEnv();
    const cookie = buildClearedCookie(request("http://127.0.0.1:3000/login"));
    expect(cookie.maxAgeSeconds).toBe(0);
    expect(cookie.value).toBe("");
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
  });
});

describe("serialiseCookie", () => {
  it("emits the hardening directives", () => {
    configureTestEnv();
    const header = serialiseCookie(buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "abc", expiresAt: Date.now() + 60_000 }));
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=");
  });

  it("includes Secure when the policy requires it", () => {
    configureTestEnv({ ORCH_COOKIE_SECURE: "always" });
    const header = serialiseCookie(buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "abc", expiresAt: Date.now() + 60_000 }));
    expect(header).toContain("Secure");
  });

  it("omits Secure over plain http with the auto policy", () => {
    configureTestEnv();
    const header = serialiseCookie(buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "abc", expiresAt: Date.now() + 60_000 }));
    expect(header).not.toContain("Secure");
  });

  it("encodes a token that contains reserved characters", () => {
    configureTestEnv();
    const header = serialiseCookie(buildSessionCookie(request("http://127.0.0.1:3000/login"), { token: "a b;c=d", expiresAt: Date.now() + 60_000 }));
    expect(header).not.toContain(";c=d");
    expect(header).toContain(encodeURIComponent("a b;c=d"));
  });
});
