import type { NextRequest } from "next/server";
import {
  authenticate,
  handleError,
  jsonOk,
  pageMeta,
  parsePagination,
  readEnumParam,
  readStringParam,
} from "../../../lib/http/api.ts";
import {
  countRootRunsMatching,
  invocationCountsByRun,
  listRootRuns,
  locationDirectoryMap,
} from "../../../lib/db/repositories.ts";
import { toRunSummary } from "../../../lib/http/dto.ts";
import type { RootRunStatus } from "../../../lib/contracts/api.ts";

/**
 * Root runs: a root session plus every session observed to descend from it.
 */


const STATUSES = [
  "recently-active",
  "reported-idle",
  "reported-succeeded",
  "reported-failed",
  "reported-interrupted",
  "unknown",
] as const satisfies readonly RootRunStatus[];

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const pagination = parsePagination(request, { defaultLimit: 50, maxLimit: 200 });
    const search = readStringParam(request, "search");
    const status = readEnumParam(request, "status", STATUSES);
    const locationId = readStringParam(request, "locationId", { maxLength: 128 });

    const query = {
      ...(search === null ? {} : { search }),
      ...(status === null ? {} : { status }),
      ...(locationId === null ? {} : { locationId }),
      limit: pagination.limit,
      offset: pagination.offset,
    };

    const directories = locationDirectoryMap(db);
    const invocationCounts = invocationCountsByRun(db);
    const runs = listRootRuns(db, query).map((run) =>
      toRunSummary(run, directories.get(run.locationId) ?? null, invocationCounts.get(run.id) ?? 0),
    );
    const total = countRootRunsMatching(db, query);

    return jsonOk({ data: runs, page: pageMeta(pagination, total) });
  } catch (cause) {
    return handleError(cause);
  }
}
