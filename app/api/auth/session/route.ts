import type { NextRequest } from "next/server";
import { authenticateOptional, handleError, jsonOk } from "../../../../lib/http/api.ts";
import type { AuthSessionState } from "../../../../lib/contracts/api.ts";

/**
 * Report authentication state to the sign-in page.
 *
 * This is the only endpoint that answers without a session, so it is
 * deliberately minimal: it says whether an owner credential exists and whether
 * the caller is signed in. It never reveals the database path, the credential,
 * or why a session was rejected.
 */


export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db, state, session } = authenticateOptional(request);
    const configured = db !== null && state.ownerConfigured;

    const reason = !state.ready
      ? "The observer database is not usable, so the dashboard cannot serve data. Check the collector and server logs."
      : !configured
        ? "No owner credential is configured. Set ORCH_OWNER_PASSWORD (first run) or ORCH_OWNER_PASSWORD_HASH, then restart the web process."
        : null;

    const body: AuthSessionState = {
      authenticated: session !== null,
      configured,
      reason,
      expiresAt: session?.expiresAt ?? null,
    };
    return jsonOk(body);
  } catch (cause) {
    return handleError(cause);
  }
}
