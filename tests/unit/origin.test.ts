import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { checkRequestOrigin } from "../../lib/auth/origin.ts";
import { cleanupTempDirs, configureTestEnv } from "../helpers/harness.ts";

afterEach(() => {
  cleanupTempDirs();
  configureTestEnv();
});

/**
 * CSRF / cross-origin protection.
 *
 * The check must fail closed: a state-changing request with no Origin header is
 * rejected rather than allowed.
 */
function makeRequest(
  url: string,
  options: { method?: string; origin?: string | null; fetchSite?: string | null } = {},
): NextRequest {
  const headers = new Headers();
  if (options.origin !== null && options.origin !== undefined) headers.set("origin", options.origin);
  if (options.fetchSite !== null && options.fetchSite !== undefined) headers.set("sec-fetch-site", options.fetchSite);
  return new NextRequest(new URL(url), { method: options.method ?? "POST", headers });
}

describe("safe methods", () => {
  it("allows GET without an Origin header", () => {
    configureTestEnv();
    expect(checkRequestOrigin(makeRequest("http://localhost:3000/api/overview", { method: "GET" })).ok).toBe(true);
  });

  it("allows HEAD and OPTIONS without an Origin header", () => {
    configureTestEnv();
    expect(checkRequestOrigin(makeRequest("http://localhost:3000/api/x", { method: "HEAD" })).ok).toBe(true);
    expect(checkRequestOrigin(makeRequest("http://localhost:3000/api/x", { method: "OPTIONS" })).ok).toBe(true);
  });
});

describe("state-changing methods", () => {
  it("allows a same-origin POST", () => {
    configureTestEnv();
    const result = checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "http://localhost:3000" }));
    expect(result.ok).toBe(true);
  });

  it("matches the origin against the Host header, not a normalised request URL", () => {
    // A framework or proxy may normalise `request.url` differently from the Host
    // header; the Host header is the origin the browser actually used.
    configureTestEnv();
    const request = makeRequest("http://internal-upstream:8080/api/auth/login", {
      origin: "http://code.example.test:3000",
    });
    request.headers.set("host", "code.example.test:3000");
    expect(checkRequestOrigin(request).ok).toBe(true);
  });

  it("accepts a proxied https request when the proxy reports https", () => {
    configureTestEnv();
    const request = makeRequest("http://internal-upstream:8080/api/auth/login", { origin: "https://code.example.test" });
    request.headers.set("host", "code.example.test");
    request.headers.set("x-forwarded-proto", "https");
    expect(checkRequestOrigin(request).ok).toBe(true);
  });

  it("rejects a POST with no Origin header", () => {
    configureTestEnv();
    const result = checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login"));
    expect(result.ok).toBe(false);
  });

  it("rejects a POST whose Origin is a different scheme on the same host", () => {
    configureTestEnv();
    const result = checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "https://localhost:3000" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a cross-origin POST", () => {
    configureTestEnv();
    const result = checkRequestOrigin(
      makeRequest("http://localhost:3000/api/auth/login", { origin: "https://evil.example" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a POST whose Origin is a different port on the same host", () => {
    configureTestEnv();
    const result = checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "http://localhost:4000" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed Origin header", () => {
    configureTestEnv();
    const result = checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "not a url" }));
    expect(result.ok).toBe(false);
  });

  it("allows a configured public origin", () => {
    configureTestEnv({ ORCH_PUBLIC_ORIGIN: "https://code.sabasystem.app" });
    const result = checkRequestOrigin(
      makeRequest("http://127.0.0.1:3000/api/auth/login", { origin: "https://code.sabasystem.app" }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not allow an origin merely because it is https", () => {
    configureTestEnv();
    const result = checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "https://localhost:3000" }));
    expect(result.ok).toBe(false);
  });
});

describe("sec-fetch-site", () => {
  it("rejects a cross-site state-changing request before reading Origin", () => {
    configureTestEnv();
    const result = checkRequestOrigin(
      makeRequest("http://localhost:3000/api/auth/login", { origin: "http://localhost:3000", fetchSite: "cross-site" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a same-site but different-origin request", () => {
    configureTestEnv();
    const result = checkRequestOrigin(
      makeRequest("http://localhost:3000/api/auth/login", { origin: "http://localhost:3000", fetchSite: "same-site" }),
    );
    expect(result.ok).toBe(false);
  });

  it("allows same-origin and direct navigation", () => {
    configureTestEnv();
    expect(
      checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "http://localhost:3000", fetchSite: "same-origin" })).ok,
    ).toBe(true);
    expect(
      checkRequestOrigin(makeRequest("http://localhost:3000/api/auth/login", { origin: "http://localhost:3000", fetchSite: "none" })).ok,
    ).toBe(true);
  });
});
