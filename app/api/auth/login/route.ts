import type { NextRequest } from "next/server";
import { checkRequestOrigin } from "../../../../lib/auth/origin.ts";
import { appendAuthAudit, getOwner } from "../../../../lib/db/auth-store.ts";
import { ensureDatabaseReady, getDatabaseState } from "../../../../lib/db/index.ts";
import { verifyOwnerPassword } from "../../../../lib/auth/session.ts";
import { buildSessionCookie, issueSession, serialiseCookie } from "../../../../lib/auth/session.ts";
import { checkThrottle, recordFailure, recordSuccess, throttleIdentity } from "../../../../lib/auth/throttle.ts";
import { getConfig } from "../../../../lib/config.ts";
import { ApiError, handleError, jsonError, jsonOk } from "../../../../lib/http/api.ts";
import type { LoginSuccess } from "../../../../lib/contracts/api.ts";

/**
 * Owner sign-in.
 *
 * Fails closed at every step: a cross-origin request is rejected before the
 * password is read, an unusable database or missing credential yields 503, and a
 * wrong password yields a generic 401 with a throttle delay. The audit table
 * records the attempt without recording the password.
 *
 * The throttle bucket is **not** derived from client-supplied input by default;
 * see `throttleKeyFor` and `throttleIdentity`.
 */


const MAX_PASSWORD_LENGTH = 1024;

/**
 * The throttle bucket for this attempt.
 *
 * Reads no request-supplied value unless the operator has explicitly declared a
 * trusted proxy, so the default deployment cannot be bypassed by rotating a
 * header.
 */
function throttleKeyFor(request: NextRequest): string {
  const config = getConfig();
  const trustProxyHeaders = config.auth.trustProxyHeaders;
  return throttleIdentity({
    trustProxyHeaders,
    forwardedFor: trustProxyHeaders ? request.headers.get("x-forwarded-for") : null,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const origin = checkRequestOrigin(request);
    if (!origin.ok) {
      throw new ApiError(403, "origin-rejected", "Request rejected by the origin policy.", origin.reason);
    }

    const now = Date.now();
    const key = throttleKeyFor(request);
    const throttle = checkThrottle(key, now);
    if (!throttle.allowed) {
      return jsonError(
        { error: "Too many failed attempts. Try again shortly.", code: "throttled" },
        429,
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new ApiError(400, "invalid-body", "Request body must be JSON.");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new ApiError(400, "invalid-body", "Request body must be a JSON object.");
    }
    const password = (payload as Record<string, unknown>).password;
    if (typeof password !== "string" || password === "") {
      throw new ApiError(400, "invalid-body", 'Field "password" must be a non-empty string.');
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new ApiError(400, "invalid-body", 'Field "password" is too long.');
    }

    let db;
    try {
      db = ensureDatabaseReady();
    } catch {
      const state = getDatabaseState();
      throw new ApiError(
        503,
        "database-unavailable",
        "The observer database is not usable, so sign-in is unavailable.",
        state.error ?? undefined,
      );
    }

    const owner = getOwner(db);
    const check = verifyOwnerPassword(password, owner?.password_hash ?? null);
    if (!check.ok) {
      recordFailure(key, now);
      appendAuthAudit(db, check.reason === "not-configured" ? "login-not-configured" : "login-failed", null, now);
      if (check.reason === "not-configured") {
        throw new ApiError(
          503,
          "auth-not-configured",
          "No owner credential is configured. Set ORCH_OWNER_PASSWORD (first run) or ORCH_OWNER_PASSWORD_HASH, then restart.",
        );
      }
      throw new ApiError(401, "invalid-credentials", "Incorrect password.");
    }

    recordSuccess(key);
    const session = issueSession(db, now);
    appendAuthAudit(db, "login-succeeded", null, now);

    const cookie = buildSessionCookie(request, session);
    const body: LoginSuccess = { ok: true, expiresAt: session.expiresAt };
    const response = jsonOk(body);
    response.headers.append("set-cookie", serialiseCookie(cookie));
    return response;
  } catch (cause) {
    return handleError(cause);
  }
}
