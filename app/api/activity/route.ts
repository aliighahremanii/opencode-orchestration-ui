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
import { countActivity, listActivity } from "../../../lib/db/repositories.ts";
import { toActivityItem } from "../../../lib/http/dto.ts";
import type { ActivityKind } from "../../../lib/contracts/api.ts";

/**
 * Searchable activity.
 *
 * `search` matches the summary, the stored (already redacted and truncated)
 * content, and the message id.
 */


const KINDS = [
  "message-user",
  "message-assistant",
  "message-system",
  "message-synthetic",
  "message-skill",
  "message-shell",
  "message-idle",
  "message-compaction",
  "agent-switched",
  "model-switched",
  "location-switched",
  "tool",
] as const satisfies readonly ActivityKind[];

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);
    const pagination = parsePagination(request, { defaultLimit: 50, maxLimit: 200 });
    const search = readStringParam(request, "search", { maxLength: 200 });
    const kind = readEnumParam(request, "kind", KINDS);
    const sessionId = readStringParam(request, "sessionId", { maxLength: 128 });
    const runId = readStringParam(request, "runId", { maxLength: 128 });
    const locationId = readStringParam(request, "locationId", { maxLength: 128 });

    const query = {
      ...(search === null ? {} : { search }),
      ...(kind === null ? {} : { kind }),
      ...(sessionId === null ? {} : { sessionId }),
      ...(runId === null ? {} : { runId }),
      ...(locationId === null ? {} : { locationId }),
      limit: pagination.limit,
      offset: pagination.offset,
    };

    const data = listActivity(db, query).map(toActivityItem);
    const total = countActivity(db, query);

    return jsonOk({ data, page: pageMeta(pagination, total) });
  } catch (cause) {
    return handleError(cause);
  }
}
