import type { NextRequest } from "next/server";
import { authenticate, handleError, jsonOk, pageMeta, parsePagination, readStringParam } from "../../../lib/http/api.ts";
import { countSessionsMatching, listSessions, locationDirectoryMap, runIdForSession } from "../../../lib/db/repositories.ts";
import { toSessionSummary } from "../../../lib/http/dto.ts";

/**
 * Sessions, including historical browsing.
 *
 * `parentId=null` filters to root sessions. `search` matches title or id.
 */


export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const pagination = parsePagination(request, { defaultLimit: 50, maxLimit: 200 });
    const search = readStringParam(request, "search");
    const locationId = readStringParam(request, "locationId", { maxLength: 128 });
    const parentParam = readStringParam(request, "parentId", { maxLength: 128 });

    // `parentId=null` is the documented way to ask for roots; a value filters to
    // that parent's children.
    const parentId = parentParam === null ? undefined : parentParam === "null" ? null : parentParam;

    const query = {
      ...(search === null ? {} : { search }),
      ...(locationId === null ? {} : { locationId }),
      ...(parentId === undefined ? {} : { parentId }),
      limit: pagination.limit,
      offset: pagination.offset,
    };

    const directories = locationDirectoryMap(db);
    const runIds = runIdForSession(db);
    const sessions = listSessions(db, query).map((session) =>
      toSessionSummary(session, directories.get(session.locationId) ?? null, runIds.get(session.id) ?? null, null),
    );
    const total = countSessionsMatching(db, query);

    return jsonOk({ data: sessions, page: pageMeta(pagination, total) });
  } catch (cause) {
    return handleError(cause);
  }
}
