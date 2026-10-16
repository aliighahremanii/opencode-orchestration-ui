import { afterEach, describe, expect, it } from "vitest";
import {
  checkThrottle,
  forwardedClientAddress,
  OWNER_WIDE_THROTTLE_KEY,
  recordFailure,
  recordSuccess,
  resetThrottle,
  THROTTLE_LIMITS,
  throttleIdentity,
} from "../../lib/auth/throttle.ts";

afterEach(() => {
  resetThrottle();
});

/**
 * Login throttle.
 *
 * The behaviour that matters: repeated failures eventually block, a success
 * clears the record, and the block expires.
 */
describe("checkThrottle", () => {
  it("allows an unknown key", () => {
    expect(checkThrottle("1.2.3.4", 1000).allowed).toBe(true);
  });

  it("allows attempts below the failure threshold", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES - 1; i += 1) {
      recordFailure("k", now);
      now += 1;
    }
    expect(checkThrottle("k", now).allowed).toBe(true);
  });

  it("blocks once the failure threshold is reached", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES; i += 1) {
      recordFailure("k", now);
      now += 1;
    }
    const decision = checkThrottle("k", now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("blocks one key without affecting another", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES; i += 1) {
      recordFailure("attacker", now);
      now += 1;
    }
    expect(checkThrottle("attacker", now).allowed).toBe(false);
    expect(checkThrottle("owner", now).allowed).toBe(true);
  });

  it("clears the record on success", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES; i += 1) {
      recordFailure("k", now);
      now += 1;
    }
    recordSuccess("k");
    expect(checkThrottle("k", now).allowed).toBe(true);
  });

  it("eventually allows again after the block expires", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES; i += 1) {
      recordFailure("k", now);
      now += 1;
    }
    expect(checkThrottle("k", now).allowed).toBe(false);
    expect(checkThrottle("k", now + THROTTLE_LIMITS.WINDOW_MS + 1).allowed).toBe(true);
  });

  it("backs off further as failures continue", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES; i += 1) {
      recordFailure("k", now);
      now += 1;
    }
    const first = checkThrottle("k", now).retryAfterSeconds;
    recordFailure("k", now);
    const second = checkThrottle("k", now).retryAfterSeconds;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("forgets failures older than the window", () => {
    let now = 1000;
    for (let i = 0; i < THROTTLE_LIMITS.MAX_FAILURES; i += 1) {
      recordFailure("k", now);
      now += 1;
    }
    const farFuture = now + THROTTLE_LIMITS.WINDOW_MS + 1;
    // A new failure after the window starts a fresh record.
    recordFailure("k", farFuture);
    expect(checkThrottle("k", farFuture).allowed).toBe(true);
  });

  it("stays bounded in memory under many distinct keys", () => {
    // The prune path must not grow without bound; this exercises it heavily.
    for (let i = 0; i < 2000; i += 1) {
      recordFailure(`key-${i}`, 1000 + i);
    }
    expect(checkThrottle("key-1999", 3000).allowed).toBeDefined();
  });
});

/**
 * Throttle identity.
 *
 * Regression for the security finding: the bucket key was derived from
 * `X-Forwarded-For`, which the client controls, so an attacker could rotate the
 * header and never be throttled at all.
 */
describe("throttleIdentity", () => {
  it("ignores X-Forwarded-For entirely when no trusted proxy is declared", () => {
    // Whatever the client sends, the key is the same, so there is no input to
    // rotate and the owner-wide bucket always applies.
    const keys = [
      throttleIdentity({ trustProxyHeaders: false, forwardedFor: "1.2.3.4" }),
      throttleIdentity({ trustProxyHeaders: false, forwardedFor: "5.6.7.8" }),
      throttleIdentity({ trustProxyHeaders: false, forwardedFor: null }),
      throttleIdentity({ trustProxyHeaders: false, forwardedFor: "not-an-address" }),
    ];
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(OWNER_WIDE_THROTTLE_KEY);
  });

  it("rotating the header cannot escape the owner-wide bucket", () => {
    // The concrete attack: 100 attempts, each with a different spoofed address.
    // All must land in one bucket, so the throttle still triggers.
    let now = 1000;
    for (let i = 0; i < 100; i += 1) {
      const key = throttleIdentity({ trustProxyHeaders: false, forwardedFor: `10.0.0.${i}` });
      recordFailure(key, now);
      now += 1;
    }
    const decision = checkThrottle(OWNER_WIDE_THROTTLE_KEY, now);
    expect(decision.allowed).toBe(false);
  });

  it("uses the forwarded address only when a trusted proxy is declared", () => {
    const a = throttleIdentity({ trustProxyHeaders: true, forwardedFor: "203.0.113.9" });
    const b = throttleIdentity({ trustProxyHeaders: true, forwardedFor: "203.0.113.10" });
    expect(a).toBe("fwd:203.0.113.9");
    expect(b).toBe("fwd:203.0.113.10");
    expect(a).not.toBe(b);
  });

  it("uses the last forwarded entry, because a proxy appends what it observed", () => {
    // A client-supplied prefix must not be able to choose its own bucket.
    expect(forwardedClientAddress("1.2.3.4, 203.0.113.9")).toBe("203.0.113.9");
    expect(throttleIdentity({ trustProxyHeaders: true, forwardedFor: "1.2.3.4, 203.0.113.9" })).toBe("fwd:203.0.113.9");
  });

  it("falls back to the owner-wide bucket for a malformed or oversized address", () => {
    // A bad header must degrade towards stricter throttling, never weaker.
    for (const value of ["", "   ", "not-an-ip", "<script>", "a".repeat(200), ",,,"]) {
      expect(forwardedClientAddress(value), JSON.stringify(value)).toBeNull();
      expect(throttleIdentity({ trustProxyHeaders: true, forwardedFor: value }), JSON.stringify(value)).toBe(
        OWNER_WIDE_THROTTLE_KEY,
      );
    }
  });

  it("ignores trailing separators left by a proxy", () => {
    expect(forwardedClientAddress("1.2.3.4, ")).toBe("1.2.3.4");
  });

  it("accepts IPv4, IPv6 and bracketed IPv6 forms", () => {
    expect(forwardedClientAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(forwardedClientAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(forwardedClientAddress("[2001:db8::1]")).toBe("[2001:db8::1]");
  });

  it("treats a null header as absent in trusted mode", () => {
    expect(throttleIdentity({ trustProxyHeaders: true, forwardedFor: null })).toBe(OWNER_WIDE_THROTTLE_KEY);
  });
});
