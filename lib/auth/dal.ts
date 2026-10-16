import type { NextRequest } from "next/server";
import { io } from "next/cache";
import { getConfig } from "../config.ts";
import type { Db } from "../db/driver.ts";
import { getOwner } from "../db/auth-store.ts";
import { lookupSession, touchSessionIfStale } from "./session.ts";

/**
 * Data Access Layer.
 *
 * Every read path in the application goes through here. Pages and route
 * handlers never read the database directly without an authorization decision,
 * which keeps the single-owner rule in one place instead of scattered across
 * handlers.
 *
 * Failure policy: fail closed. An unconfigured application refuses to serve
 * data (`503`) rather than falling back to anonymous access.
 */

export type AuthFailureCode = "auth-not-configured" | "unauthenticated" | "session-expired" | "session-revoked";

export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthFailureCode;

  constructor(status: number, code: AuthFailureCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export interface OwnerSession {
  readonly sessionId: string;
  readonly expiresAt: number;
}

export function isAuthConfigured(db: Db): boolean {
  return getOwner(db) !== null;
}

export interface CookieAuthState {
  readonly authenticated: boolean;
  readonly configured: boolean;
  readonly reason: string | null;
  readonly expiresAt: number | null;
}

/**
 * Session state for Server Components.
 *
 * Reads the cookie through `next/headers`, so the caller must be inside a
 * `<Suspense>` boundary (Cache Components treats a `cookies()` read as
 * request-time data). Returns a state object instead of throwing, because a
 * page's job here is to render a sign-in prompt rather than an error page.
 *
 * The cookie is read **before** the database is opened. That ordering matters:
 * `cookies()` defers static prerendering; `io()` also defers the runtime shell
 * prerender used by partial prefetching before synchronous database/clock reads.
 * If the database were opened first, `next build` would
 * open (and create) the database file while collecting page data, writing to the
 * data directory during a build.
 */
export async function getCookieAuthState(): Promise<CookieAuthState> {
  const { cookies } = await import("next/headers");

  const cookieName = getConfig().auth.cookieName;
  const token = (await cookies()).get(cookieName)?.value ?? "";
  await io();

  let db: Db;
  try {
    const { ensureDatabaseReady, getDatabaseState } = await import("../db/index.ts");
    db = ensureDatabaseReady();
    const state = getDatabaseState();
    if (!state.ready) {
      return {
        authenticated: false,
        configured: false,
        reason: "The observer database is not usable, so no data can be shown.",
        expiresAt: null,
      };
    }
  } catch {
    return {
      authenticated: false,
      configured: false,
      reason: "The observer database is not usable, so no data can be shown.",
      expiresAt: null,
    };
  }

  const lookup = lookupSession(db, token, Date.now());

  if (lookup.status === "valid") {
    return { authenticated: true, configured: true, reason: null, expiresAt: lookup.session.expires_at };
  }
  if (!isAuthConfigured(db)) {
    return {
      authenticated: false,
      configured: false,
      reason:
        "No owner credential is configured. Set ORCH_OWNER_PASSWORD (first run) or ORCH_OWNER_PASSWORD_HASH, then restart.",
      expiresAt: null,
    };
  }
  return {
    authenticated: false,
    configured: true,
    reason:
      lookup.status === "expired"
        ? "Your session expired."
        : lookup.status === "revoked"
          ? "Your session was revoked."
          : null,
    expiresAt: null,
  };
}

/**
 * Require an authenticated owner session.
 *
 * @throws {AuthError} 503 when no owner credential exists, 401 when the cookie
 * is missing, unknown, expired, or revoked.
 */
export function requireOwner(db: Db, request: NextRequest, now = Date.now()): OwnerSession {
  if (!isAuthConfigured(db)) {
    throw new AuthError(
      503,
      "auth-not-configured",
      "No owner credential is configured. Set ORCH_OWNER_PASSWORD (first run) or " +
        "ORCH_OWNER_PASSWORD_HASH, then restart. The dashboard refuses to serve data until then.",
    );
  }

  const cookieName = getConfig().auth.cookieName;
  const token = request.cookies.get(cookieName)?.value ?? "";
  const lookup = lookupSession(db, token, now);

  switch (lookup.status) {
    case "valid":
      touchSessionIfStale(db, lookup.session, now);
      return { sessionId: lookup.session.id, expiresAt: lookup.session.expires_at };
    case "expired":
      throw new AuthError(401, "session-expired", "Your session has expired. Sign in again.");
    case "revoked":
      throw new AuthError(401, "session-revoked", "Your session was revoked. Sign in again.");
    case "missing":
      throw new AuthError(401, "unauthenticated", "Authentication required.");
  }
}
