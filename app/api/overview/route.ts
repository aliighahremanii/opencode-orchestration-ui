import type { NextRequest } from "next/server";
import { authenticate, handleError, jsonOk } from "../../../lib/http/api.ts";
import {
  activityWindow,
  getRootRun,
  invocationCountsByRun,
  listActivity,
  listRootRuns,
  locationDirectoryMap,
  overviewStats,
} from "../../../lib/db/repositories.ts";
import {
  collectorHealth,
  sourceSummary,
  toActivityItem,
  toRunSummary,
} from "../../../lib/http/dto.ts";

/**
 * Dashboard overview.
 *
 * Every count is a count of what was *observed*, and the response says which
 * source it came from so the UI cannot present fixture data as live evidence.
 */


const RECENT_LIMIT = 8;
const RETENTION_NOTE =
  "History is bounded by ORCH_HISTORY_MAX_SESSIONS per collection cycle. Activity older than the window below is not " +
  "retained in this database.";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const now = Date.now();

    const stats = overviewStats(db);
    const directories = locationDirectoryMap(db);
    const invocationCounts = invocationCountsByRun(db);
    const window = activityWindow(db);

    const recentRuns = listRootRuns(db, { limit: RECENT_LIMIT }).map((run) =>
      toRunSummary(run, directories.get(run.locationId) ?? null, invocationCounts.get(run.id) ?? 0),
    );

    const recentActivity = listActivity(db, { limit: 20 }).map(toActivityItem);

    // Touch the run repository for a single run so the overview and the detail
    // endpoint agree on what "a run" is.
    const firstRun = recentRuns[0];
    if (firstRun !== undefined) {
      getRootRun(db, firstRun.id);
    }

    return jsonOk({
      generatedAt: now,
      source: sourceSummary(),
      counts: stats,
      historyWindow: {
        oldestActivityAt: window.oldest,
        newestActivityAt: window.newest,
        retentionNote: RETENTION_NOTE,
      },
      collector: collectorHealth(db, now),
      recentRuns,
      recentActivity,
    });
  } catch (cause) {
    return handleError(cause);
  }
}
