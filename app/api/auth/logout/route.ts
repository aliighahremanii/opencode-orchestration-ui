import type { NextRequest } from "next/server";
import { checkRequestOrigin } from "../../../../lib/auth/origin.ts";
import { buildClearedCookie, endSession, serialiseCookie } from "../../../../lib/auth/session.ts";
import { getConfig } from "../../../../lib/config.ts";
import { ensureDatabaseReady } from "../../../../lib/db/index.ts";
import { ApiError, handleError, jsonOk } from "../../../../lib/http/api.ts";

/**
 * Owner sign-out.
 *
 * Revokes the session server-side (so a copied cookie stops working) and clears
 * the browser cookie. Always clears the cookie, even when the token was already
 * invalid, so the browser cannot get stuck holding a dead session.
 */


export async function POST(request: NextRequest): Promise<Response> {
  try {
    const origin = checkRequestOrigin(request);
    if (!origin.ok) {
      throw new ApiError(403, "origin-rejected", "Request rejected by the origin policy.", origin.reason);
    }

    const token = request.cookies.get(getConfig().auth.cookieName)?.value ?? "";
    let revoked = false;
    try {
      const db = ensureDatabaseReady();
      revoked = endSession(db, token, Date.now());
    } catch {
      // A database that cannot be reached must not prevent clearing the cookie.
      revoked = false;
    }

    const response = jsonOk({ ok: true, revoked });
    response.headers.append("set-cookie", serialiseCookie(buildClearedCookie(request)));
    return response;
  } catch (cause) {
    return handleError(cause);
  }
}
