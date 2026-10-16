import type { NextRequest } from "next/server";
import { ApiError, authenticate, handleError, jsonOk, requirePathId } from "../../../../lib/http/api.ts";
import {
  activityCountsBySession,
  countInvocationsForRun,
  getRootRun,
  invocationCountsByRun,
  invocationCountsBySession,
  listActivity,
  listGaps,
  listInvocations,
  listRunSessions,
  locationDirectoryMap,
  unobservedParentSessionIds,
} from "../../../../lib/db/repositories.ts";
import {
  toActivityItem,
  toGapItem,
  toInvocationItem,
  toRunSummary,
} from "../../../../lib/http/dto.ts";
import type { RunSessionNode } from "../../../../lib/contracts/api.ts";

/**
 * Root run detail: the observed session hierarchy, evidence-backed invocations,
 * and the activity timeline for the run.
 */


const RUN_ACTIVITY_LIMIT = 200;
const RUN_INVOCATION_LIMIT = 200;

export async function GET(request: NextRequest, context: { params: Promise<{ rootRunId: string }> }): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const { rootRunId: rawRunId } = await context.params;
    const runId = requirePathId(rawRunId, "rootRunId");

    const run = getRootRun(db, runId);
    if (run === null) {
      throw new ApiError(404, "run-not-found", "No root run with that identifier has been observed.");
    }

    const directories = locationDirectoryMap(db);
    const orphanIds = unobservedParentSessionIds(db);
    const activityCounts = activityCountsBySession(db);
    const sessionInvocationCounts = invocationCountsBySession(db);
    const invocationCounts = invocationCountsByRun(db);

    const sessions: RunSessionNode[] = listRunSessions(db, runId).map(({ session, depth }) => ({
      sessionId: session.id,
      parentId: session.parentId,
      depth,
      title: session.title,
      agentId: session.agentId,
      agentFirstSeen: null,
      upstreamOutcome: session.upstreamOutcome,
      timeCreated: session.timeCreated,
      timeUpdated: session.timeUpdated,
      timeIdle: session.timeIdle,
      activityCount: activityCounts.get(session.id) ?? 0,
      invocationCount: sessionInvocationCounts.get(session.id) ?? 0,
      isOrphan: orphanIds.has(session.id),
    }));

    const invocations = listInvocations(db, { runId, limit: RUN_INVOCATION_LIMIT }).map(toInvocationItem);
    const activity = listActivity(db, { runId, limit: RUN_ACTIVITY_LIMIT }).map(toActivityItem);

    // Only gaps that overlap the run's observed window are shown, so an
    // unrelated outage elsewhere is not attached to this run.
    const gaps = listGaps(db, 200)
      .filter((gap) => gap.endedAt === null || (gap.endedAt >= run.startedAt && gap.startedAt <= run.lastActivityAt))
      .map(toGapItem);

    const notes: string[] = [];
    if (sessions.some((session) => session.isOrphan)) {
      notes.push(
        "At least one session in this run references a parent session that has not been observed. It is shown at the " +
          "depth where collection found it rather than being attached to a guessed parent.",
      );
    }
    if (gaps.length > 0) {
      notes.push(
        "Collection gaps overlap this run's window, so activity inside those windows may be missing. The gaps are " +
          "listed rather than being smoothed over.",
      );
    }
    if (invocations.length === 0 && sessions.length > 0) {
      notes.push(
        "No invocations were recorded for this run. An invocation requires an assistant message carrying an explicit " +
          "agent field; a session existing, or a child session existing, is not evidence that an agent ran.",
      );
    }

    return jsonOk({
      run: toRunSummary(run, directories.get(run.locationId) ?? null, invocationCounts.get(run.id) ?? countInvocationsForRun(db, runId)),
      sessions,
      invocations,
      activity,
      gaps,
      notes,
    });
  } catch (cause) {
    return handleError(cause);
  }
}
