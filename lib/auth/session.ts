import type { NextRequest } from "next/server";
import { getConfig } from "../config.ts";
import type { Db } from "../db/driver.ts";
import {
  appendAuthAudit,
  createAuthSession,
  findAuthSessionByTokenHash,
  purgeExpiredAuthSessions,
  revokeAuthSession,
  touchAuthSession,
  type AuthSessionRow,
} from "../db/auth-store.ts";
import { randomId, randomToken, sha256Hex } from "../util/ids.ts";
import { dummyVerify, verifyPassword } from "./password.ts";

/**
 * Browser session management.
 *
 * The cookie carries a 256-bit random token. Only its SHA-256 digest is stored,
 * so the database cannot be used to impersonate the owner. Sessions are
 * revocable server-side and expire on a fixed deadline.
 */

const TOUCH_INTERVAL_MS = 60_000;

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: number;
}

export function issueSession(db: Db, now: number): IssuedSession {
  const config = getConfig();
  const token = randomToken(32);
  const expiresAt = now + config.auth.sessionTtlMs;
  createAuthSession(db, {
    id: randomId("sess"),
    tokenHash: sha256Hex(token),
    createdAt: now,
    expiresAt,
  });
  purgeExpiredAuthSessions(db, now);
  return { token, expiresAt };
}

export type SessionLookup =
  | { readonly status: "valid"; readonly session: AuthSessionRow }
  | { readonly status: "missing" }
  | { readonly status: "expired" }
  | { readonly status: "revoked" };

export function lookupSession(db: Db, token: string, now: number): SessionLookup {
  if (token.trim() === "") return { status: "missing" };
  const row = findAuthSessionByTokenHash(db, sha256Hex(token));
  if (row === null) return { status: "missing" };
  if (row.revoked_at !== null) return { status: "revoked" };
  if (row.expires_at <= now) return { status: "expired" };
  return { status: "valid", session: row };
}

export function touchSessionIfStale(db: Db, session: AuthSessionRow, now: number): void {
  if (now - session.last_seen_at >= TOUCH_INTERVAL_MS) {
    touchAuthSession(db, session.id, now);
  }
}

export function endSession(db: Db, token: string, now: number): boolean {
  const row = findAuthSessionByTokenHash(db, sha256Hex(token));
  if (row === null) return false;
  const revoked = revokeAuthSession(db, row.id, now);
  if (revoked) {
    appendAuthAudit(db, "logout", null, now);
  }
  return revoked;
}

// --- credential verification ----------------------------------------------

export type CredentialCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not-configured" | "invalid" };

/**
 * Verify the owner password against the stored hash.
 *
 * `storedHash` is resolved once at database bootstrap (see `lib/db/index.ts`),
 * so this function is pure with respect to the credential store.
 */
export function verifyOwnerPassword(password: string, storedHash: string | null): CredentialCheck {
  if (storedHash === null) {
    dummyVerify();
    return { ok: false, reason: "not-configured" };
  }
  return verifyPassword(password, storedHash) ? { ok: true } : { ok: false, reason: "invalid" };
}

// --- cookie handling -------------------------------------------------------

export interface CookieDescriptor {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: "/";
  readonly maxAgeSeconds: number;
}

export class InsecureCookieConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureCookieConfigurationError";
  }
}

/**
 * Decide whether the session cookie may be sent without `Secure`.
 *
 * `auto` (the default) marks the cookie `Secure` whenever the public origin is
 * https or the request itself arrived over https, so a real deployment never
 * ships a plaintext-capable session cookie. `never` is accepted only for
 * loopback deployments, and is refused outright if a public https origin is
 * configured.
 */
export function shouldUseSecureCookie(request: NextRequest): boolean {
  const config = getConfig();
  const mode = config.auth.cookieSecure;
  const publicIsHttps = config.auth.publicOrigin?.startsWith("https://") ?? false;
  const requestIsHttps =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ||
    (() => {
      try {
        return new URL(request.url).protocol === "https:";
      } catch {
        return false;
      }
    })();

  if (mode === "always") return true;
  if (mode === "never") {
    if (publicIsHttps) {
      throw new InsecureCookieConfigurationError(
        "ORCH_COOKIE_SECURE=never is refused while ORCH_PUBLIC_ORIGIN is https.",
      );
    }
    return false;
  }
  return publicIsHttps || requestIsHttps;
}

export function buildSessionCookie(request: NextRequest, session: IssuedSession): CookieDescriptor {
  return {
    name: getConfig().auth.cookieName,
    value: session.token,
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAgeSeconds: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
  };
}

export function buildClearedCookie(request: NextRequest): CookieDescriptor {
  return {
    name: getConfig().auth.cookieName,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAgeSeconds: 0,
  };
}

export function serialiseCookie(cookie: CookieDescriptor): string {
  const parts = [
    `${cookie.name}=${encodeURIComponent(cookie.value)}`,
    `Path=${cookie.path}`,
    `Max-Age=${cookie.maxAgeSeconds}`,
    `SameSite=Lax`,
  ];
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.secure) parts.push("Secure");
  return parts.join("; ");
}
