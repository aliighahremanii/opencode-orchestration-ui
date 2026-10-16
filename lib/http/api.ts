import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { AuthError, requireOwner, type OwnerSession } from "../auth/dal.ts";
import { checkRequestOrigin } from "../auth/origin.ts";
import { ConfigError } from "../config.ts";
import { ensureDatabaseReady, getDatabaseState, type DatabaseState } from "../db/index.ts";
import type { Db } from "../db/driver.ts";
import { DatabaseUnavailableError, describeError } from "../db/driver.ts";
import type { ApiErrorBody, PageMeta } from "../contracts/api.ts";

/**
 * Shared HTTP plumbing for Route Handlers.
 *
 * Two rules every handler follows:
 *
 * 1. **Request-time first.** `authenticate()` reads `request.headers` and
 *    `request.cookies` before anything else. Those are request-object
 *    properties, so Next.js cannot prerender the handler at build time. Without
 *    that, a `GET` handler that touches only the synchronous database would be
 *    treated as a predictable value and baked into a static response.
 * 2. **Fail closed.** An unusable database, a missing owner credential, or a
 *    missing/expired session all produce an error response. No handler falls
 *    back to serving data.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface RequestContext {
  readonly db: Db;
  readonly session: OwnerSession;
}

/**
 * Force the handler to be request-time before any other work.
 *
 * Reading a request-object property is what tells Next.js a `GET` handler cannot
 * be prerendered. It matters here for a concrete reason: the origin check below
 * returns early for safe methods without reading any header, so a `GET` handler
 * whose only other work is a synchronous database read looked prerenderable.
 * The build then opened — and created — the database file while collecting page
 * data, which writes to the data directory during a build and fails outright if
 * that directory is not writable.
 *
 * Reading the cookie is the natural choice: it is needed by every authenticated
 * handler anyway.
 */
function markRequestTime(request: NextRequest): string {
  const cookieHeader = request.headers.get("cookie");
  return cookieHeader ?? "";
}

/**
 * Verify the request and return the database handle.
 *
 * @throws {ApiError} for every failure mode, including a database that is not
 * ready and a cross-origin state-changing request.
 */
export function authenticate(request: NextRequest): RequestContext {
  markRequestTime(request);

  // Origin/CSRF first: it is pure header inspection, and it must run before any
  // side effect.
  const origin = checkRequestOrigin(request);
  if (!origin.ok) {
    throw new ApiError(403, "origin-rejected", "Request rejected by the origin policy.", origin.reason);
  }

  let db: Db;
  try {
    db = ensureDatabaseReady();
  } catch (cause) {
    const state = getDatabaseState();
    throw new ApiError(
      503,
      "database-unavailable",
      "The observer database is not usable, so no data can be served.",
      state.error ?? describeError(cause),
    );
  }

  try {
    const session = requireOwner(db, request);
    return { db, session };
  } catch (cause) {
    if (cause instanceof AuthError) {
      throw new ApiError(cause.status, cause.code, cause.message);
    }
    throw cause;
  }
}

/**
 * Authenticate without requiring a session.
 *
 * Used only by `/api/auth/session`, which the sign-in page calls to learn
 * whether the application is configured. It deliberately exposes no database
 * path or credential detail.
 */
export function authenticateOptional(request: NextRequest): {
  readonly db: Db | null;
  readonly state: DatabaseState;
  readonly session: OwnerSession | null;
} {
  markRequestTime(request);

  const origin = checkRequestOrigin(request);
  if (!origin.ok) {
    throw new ApiError(403, "origin-rejected", "Request rejected by the origin policy.", origin.reason);
  }
  let db: Db | null = null;
  try {
    db = ensureDatabaseReady();
  } catch {
    return { db: null, state: getDatabaseState(), session: null };
  }
  try {
    return { db, state: getDatabaseState(), session: requireOwner(db, request) };
  } catch {
    return { db, state: getDatabaseState(), session: null };
  }
}

export function jsonOk<T>(body: T, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(init?.headers ?? {}),
    },
  });
}

export function jsonError(error: ApiErrorBody, status: number): Response {
  return Response.json(error, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Convert any thrown value into a safe error response.
 *
 * Next.js signals "this route cannot be prerendered" by throwing a
 * framework-controlled error from a request-time API. That error is
 * control flow, not an application failure: it must be rethrown so the
 * framework can mark the route dynamic, otherwise the route is turned into a
 * 500 response and the build logs a misleading "unhandled error".
 *
 * `unstable_rethrow` returns normally for anything that is not a
 * framework-controlled exception, so application errors fall through to the
 * handling below.
 */
export function handleError(cause: unknown): Response {
  unstable_rethrow(cause);

  if (cause instanceof ApiError) {
    return jsonError({ error: cause.message, code: cause.code, ...(cause.detail === undefined ? {} : { detail: cause.detail }) }, cause.status);
  }
  if (cause instanceof ConfigError) {
    // Configuration problems are the operator's to fix and contain no secrets.
    return jsonError({ error: cause.message, code: "invalid-configuration" }, 500);
  }
  if (cause instanceof DatabaseUnavailableError) {
    return jsonError({ error: cause.message, code: "database-unavailable" }, 503);
  }
  // Unknown failures are not echoed to the client.
  console.error("[api] unhandled error", cause);
  return jsonError({ error: "Internal server error.", code: "internal-error" }, 500);
}

export interface ParsedPagination {
  readonly limit: number;
  readonly offset: number;
}

export function parsePagination(request: NextRequest, options?: { readonly defaultLimit?: number; readonly maxLimit?: number }): ParsedPagination {
  const defaultLimit = options?.defaultLimit ?? 50;
  const maxLimit = options?.maxLimit ?? 200;
  const params = request.nextUrl.searchParams;
  const rawLimit = params.get("limit");
  const rawOffset = params.get("offset");

  let limit = defaultLimit;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ApiError(400, "invalid-limit", `Query parameter "limit" must be a positive integer.`);
    }
    limit = Math.min(parsed, maxLimit);
  }

  let offset = 0;
  if (rawOffset !== null) {
    const parsed = Number.parseInt(rawOffset, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ApiError(400, "invalid-offset", `Query parameter "offset" must be a non-negative integer.`);
    }
    offset = parsed;
  }

  return { limit, offset };
}

export function pageMeta(pagination: ParsedPagination, total: number): PageMeta {
  return { limit: pagination.limit, offset: pagination.offset, total };
}

export function readStringParam(request: NextRequest, name: string, options?: { readonly maxLength?: number }): string | null {
  const raw = request.nextUrl.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const maxLength = options?.maxLength ?? 200;
  if (trimmed.length > maxLength) {
    throw new ApiError(400, "invalid-parameter", `Query parameter "${name}" is too long.`);
  }
  return trimmed;
}

export function readEnumParam<T extends string>(
  request: NextRequest,
  name: string,
  allowed: readonly T[],
): T | null {
  const raw = readStringParam(request, name, { maxLength: 64 });
  if (raw === null) return null;
  if (!allowed.includes(raw as T)) {
    throw new ApiError(400, "invalid-parameter", `Query parameter "${name}" must be one of ${allowed.join(", ")}.`);
  }
  return raw as T;
}

/**
 * Reject a path parameter that could not be one of our identifiers.
 *
 * The identifiers are opaque, but bounding the character set keeps arbitrary
 * upstream-controlled strings out of log lines and error messages.
 */
export function requirePathId(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ApiError(400, "invalid-path-parameter", `Path parameter "${name}" is not a valid identifier.`);
  }
  return value;
}
