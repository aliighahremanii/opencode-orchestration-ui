import type { NextRequest } from "next/server";
import { ApiError, authenticate, handleError, jsonOk, parsePagination, requirePathId } from "../../../../lib/http/api.ts";
import {
  getSessionWithAttribution,
  listActivity,
  listInvocations,
  locationDirectoryMap,
  runIdForSession,
  unobservedParentSessionIds,
} from "../../../../lib/db/repositories.ts";
import { toActivityItem, toInvocationItem, toSessionSummary } from "../../../../lib/http/dto.ts";

/**
 * Session detail: observed metadata, evidence-backed invocations, and the full
 * activity timeline for one session.
 */


export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const { sessionId: rawSessionId } = await context.params;
    const sessionId = requirePathId(rawSessionId, "sessionId");
    const pagination = parsePagination(request, { defaultLimit: 200, maxLimit: 500 });

    const found = getSessionWithAttribution(db, sessionId);
    if (found === null) {
      throw new ApiError(404, "session-not-found", "No session with that identifier has been observed.");
    }

    const directories = locationDirectoryMap(db);
    const runIds = runIdForSession(db);
    const session = toSessionSummary(
      found.session,
      directories.get(found.session.locationId) ?? null,
      runIds.get(found.session.id) ?? null,
      found.agentFirstSeen,
    );

    const invocations = listInvocations(db, {
      sessionId,
      limit: pagination.limit,
      offset: pagination.offset,
    }).map(toInvocationItem);

    const activity = listActivity(db, {
      sessionId,
      limit: pagination.limit,
      offset: pagination.offset,
    }).map(toActivityItem);

    const notes: string[] = [];
    if (session.parentId !== null && unobservedParentSessionIds(db).has(session.id)) {
      notes.push(
        `This session's parent (${session.parentId}) has not been observed, so its position in a run hierarchy is unknown.`,
      );
    }
    if (session.agentFirstSeen !== null && session.agentId !== null && session.agentFirstSeen !== session.agentId) {
      notes.push(
        `The agent changed during this session: ${session.agentFirstSeen} was observed first and ${session.agentId} is ` +
          "the most recent observation. Invocations record the agent per assistant turn.",
      );
    }
    if (invocations.length === 0) {
      notes.push(
        "No invocation was recorded for this session. Invocations require an assistant message with an explicit agent field.",
      );
    }

    return jsonOk({ session, invocations, activity, notes });
  } catch (cause) {
    return handleError(cause);
  }
}
