/**
 * In-process login throttle.
 *
 * There is a single owner and no distributed state, so a small in-memory
 * failure counter is enough to make online password guessing impractical. It is
 * intentionally conservative about memory: only the most recent keys are kept,
 * and entries expire.
 *
 * This is defence in depth, not the primary control: the password is verified
 * with scrypt, and a successful guess still only yields a read-only observer
 * session.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_TRACKED_KEYS = 512;

/**
 * The throttle bucket used when no trusted client identity is available.
 *
 * This application has exactly one owner, so a single shared bucket is both the
 * safest choice and the most effective one: it cannot be bypassed, because there
 * is no client-supplied input in the key at all.
 */
export const OWNER_WIDE_THROTTLE_KEY = "owner";

/** Cap on an accepted forwarded address, so a header cannot force unbounded keys. */
const MAX_FORWARDED_ADDRESS_LENGTH = 64;

/**
 * Parse a client address from `X-Forwarded-For`.
 *
 * Only called when the operator has explicitly declared a trusted proxy.
 *
 * The **last** entry is used, not the first. A proxy appends the address it
 * observed, so with one trusted proxy the final element is the value that proxy
 * wrote; earlier elements are whatever the client sent and are therefore
 * attacker-controlled.
 */
export function forwardedClientAddress(value: string | null): string | null {
  if (value === null) return null;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const last = entries[entries.length - 1];
  if (last === undefined) return null;
  if (last.length === 0 || last.length > MAX_FORWARDED_ADDRESS_LENGTH) return null;
  // Bound the character set so a header cannot inject arbitrary key material.
  if (!/^[0-9a-fA-F.:\[\]]+$/.test(last)) return null;
  return last;
}

export interface ThrottleIdentityInput {
  /** The explicitly configured trust decision. Never inferred from the request. */
  readonly trustProxyHeaders: boolean;
  /** The `X-Forwarded-For` header value, if any. */
  readonly forwardedFor: string | null;
}

/**
 * Derive the throttle bucket key for a login attempt.
 *
 * The key must not be attacker-controlled, or the throttle is decorative: an
 * attacker would simply vary the input on each attempt. Two modes:
 *
 * - **Untrusted (default):** one owner-wide bucket. The request contributes
 *   nothing to the key, so there is no input to rotate. This is the correct
 *   default for a single-owner application.
 * - **Trusted proxy:** one bucket per forwarded client address. Only reachable
 *   when `ORCH_TRUST_PROXY_HEADERS=true`, which asserts that a reverse proxy
 *   overwrites the header.
 *
 * A malformed or absent forwarded address in trusted mode falls back to the
 * owner-wide bucket rather than to a per-request unique value, so a bad header
 * degrades towards stricter throttling, never weaker.
 */
export function throttleIdentity(input: ThrottleIdentityInput): string {
  if (!input.trustProxyHeaders) return OWNER_WIDE_THROTTLE_KEY;
  const address = forwardedClientAddress(input.forwardedFor);
  return address === null ? OWNER_WIDE_THROTTLE_KEY : `fwd:${address}`;
}

interface Attempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

const attempts = new Map<string, Attempt>();

export interface ThrottleDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export function checkThrottle(key: string, now: number): ThrottleDecision {
  const entry = attempts.get(key);
  if (entry === undefined) return { allowed: true, retryAfterSeconds: 0 };
  if (entry.blockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailure(key: string, now: number): void {
  const entry = attempts.get(key);
  if (entry === undefined || now - entry.firstFailureAt > WINDOW_MS) {
    attempts.set(key, { failures: 1, firstFailureAt: now, blockedUntil: 0 });
  } else {
    entry.failures += 1;
    if (entry.failures >= MAX_FAILURES) {
      // Exponential backoff, capped, so a sustained attack is slowed without
      // permanently locking the owner out.
      const backoffMs = Math.min(2 ** (entry.failures - MAX_FAILURES) * 30_000, WINDOW_MS);
      entry.blockedUntil = now + backoffMs;
    }
  }
  prune(now);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}

function prune(now: number): void {
  if (attempts.size <= MAX_TRACKED_KEYS) {
    for (const [key, entry] of attempts) {
      if (now - entry.firstFailureAt > WINDOW_MS && entry.blockedUntil <= now) {
        attempts.delete(key);
      }
    }
    return;
  }
  // Under pressure, drop the oldest entries rather than growing without bound.
  const ordered = [...attempts.entries()].sort((a, b) => a[1].firstFailureAt - b[1].firstFailureAt);
  for (const [key] of ordered.slice(0, ordered.length - MAX_TRACKED_KEYS)) {
    attempts.delete(key);
  }
}

/** Test helper. */
export function resetThrottle(): void {
  attempts.clear();
}

export const THROTTLE_LIMITS = { WINDOW_MS, MAX_FAILURES } as const;
