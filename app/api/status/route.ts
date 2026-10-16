import type { NextRequest } from "next/server";
import { authenticate, handleError, jsonOk } from "../../../lib/http/api.ts";
import { getDatabaseState } from "../../../lib/db/index.ts";
import { listGaps } from "../../../lib/db/repositories.ts";
import {
  checkpointItems,
  collectorHealth,
  limitations,
  sourceSummary,
  toGapItem,
  warningItems,
} from "../../../lib/http/dto.ts";
import type { StatusResponse } from "../../../lib/contracts/api.ts";

/**
 * Collection status.
 *
 * This is where the application is honest about itself: what the database looks
 * like, whether the collector is alive, which streams have checkpoints, every
 * recorded gap, every non-fatal collection problem, and the capability limits of
 * this build.
 */


export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const now = Date.now();
    const state = getDatabaseState();

    const body: StatusResponse = {
      generatedAt: now,
      database: {
        ready: state.ready,
        error: state.error,
        schemaVersion: state.schemaVersion,
        expectedSchemaVersion: state.expectedSchemaVersion,
        ownerConfigured: state.ownerConfigured,
        dbPath: state.dbPath,
        warnings: state.warnings,
      },
      source: sourceSummary(),
      collector: collectorHealth(db, now),
      checkpoints: checkpointItems(db),
      gaps: listGaps(db, 100).map(toGapItem),
      warnings: warningItems(db, 100),
      limitations: limitations(db, now),
    };

    return jsonOk(body);
  } catch (cause) {
    return handleError(cause);
  }
}
