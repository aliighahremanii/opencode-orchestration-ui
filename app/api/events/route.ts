import type { NextRequest } from "next/server";
import { ApiError, authenticate, handleError, jsonError } from "../../../lib/http/api.ts";
import { getConfig } from "../../../lib/config.ts";
import { changesSince, latestChangeSeq } from "../../../lib/db/collection-state.ts";
import { lookupSession } from "../../../lib/auth/session.ts";
import type { ChangeEventPayload, EventsHelloPayload } from "../../../lib/contracts/api.ts";

/**
 * Server-Sent Events for live dashboard updates.
 *
 * The stream is fed by this application's own durable change log, never by the
 * upstream event stream. That matters for two reasons:
 *
 * - The browser never talks to the upstream instance, so no upstream credential
 *   or origin ever reaches the client.
 * - A client that disconnects and reconnects resumes from the last sequence
 *   number it saw (`?since=`), so a missed window is replayed from durable
 *   storage instead of being lost.
 *
 * The connection is closed after `ORCH_SSE_MAX_MS` and the client reconnects
 * with its last sequence number. That keeps a proxy or platform from holding a
 * connection open indefinitely.
 */


/** How often the open stream re-validates the session. */
const AUTH_CHECK_INTERVAL_MS = 5_000;

/**
 * The largest `since` value that can be represented exactly.
 *
 * `change_log.seq` is a SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`, so its range
 * is far wider than JavaScript can represent. The bound here is therefore
 * JavaScript's safe integer limit rather than an arbitrary small cap: capping it
 * at a round number would reject a legitimate cursor once the log grew past it.
 */
const MAX_SINCE = Number.MAX_SAFE_INTEGER;

/** Accept only a plain non-negative decimal integer. */
function parseSince(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  let db;
  let session;
  try {
    ({ db, session } = authenticate(request));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      return jsonError({ error: cause.message, code: cause.code }, 401);
    }
    return handleError(cause);
  }

  const cookieName = getConfig().auth.cookieName;
  const token = request.cookies.get(cookieName)?.value ?? "";
  if (token === "") {
    return jsonError({ error: "Authentication required.", code: "unauthenticated" }, 401);
  }

  const config = getConfig().sse;
  const sinceParam = request.nextUrl.searchParams.get("since");
  let resumeFrom = 0;
  if (sinceParam !== null) {
    const parsed = parseSince(sinceParam);
    if (parsed === null || parsed > MAX_SINCE) {
      return jsonError(
        { error: `Query parameter "since" must be a non-negative integer no greater than ${MAX_SINCE}.`, code: "invalid-since" },
        400,
      );
    }
    resumeFrom = parsed;
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let cursor = resumeFrom;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between the check and the enqueue.
          closed = true;
        }
      };

      const sendEvent = (name: string, payload: unknown): void => {
        send(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const onAbort = (): void => {
        closed = true;
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        const hello: EventsHelloPayload = { latestSeq: latestChangeSeq(db), resumeFrom };
        // `retry` is a field of the same event block rather than a separate
        // frame, so a client that reads frames one at a time does not see an
        // extra, meaningless frame before the first change.
        send(`retry: 3000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);

        let lastHeartbeat = Date.now();
        let lastAuthCheck = Date.now();

        while (!closed) {
          if (request.signal.aborted) break;
          const now = Date.now();

          // The session is re-validated on a fixed cadence so a revoked or
          // expired session cannot keep receiving data on an already-open
          // stream. Signing out in another tab therefore ends this one too.
          if (now - lastAuthCheck >= AUTH_CHECK_INTERVAL_MS) {
            lastAuthCheck = now;
            const lookup = lookupSession(db, token, now);
            if (lookup.status !== "valid") {
              sendEvent("auth-expired", { reason: lookup.status });
              break;
            }
          }

          const changes = changesSince(db, cursor, 200);
          for (const change of changes) {
            const payload: ChangeEventPayload = {
              seq: change.seq,
              kind: change.kind,
              entityId: change.entityId,
              scope: change.scope,
              at: change.at,
            };
            sendEvent("change", payload);
            cursor = change.seq;
          }

          if (now - lastHeartbeat >= config.heartbeatMs) {
            send(": heartbeat\n\n");
            lastHeartbeat = now;
          }

          if (now - startedAt >= config.maxMs) {
            sendEvent("reconnect", { resumeFrom: cursor, reason: "stream rotation" });
            break;
          }

          await sleep(config.pollMs);
        }
      } catch (cause) {
        // A failure mid-stream must not leave the client hanging: close so the
        // browser reconnects and resumes from `cursor`.
        console.error("[sse] stream failed", cause);
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        finish();
      }
    },
    cancel() {
      closed = true;
    },
  });

  void session;

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Tells nginx (and therefore Caddy's reverse_proxy) not to buffer the
      // stream, which would otherwise delay every event.
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
