"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEventPayload, EventsHelloPayload } from "../../lib/contracts/api.ts";

/**
 * Client data access.
 *
 * All dashboard data is fetched from this application's own same-origin API.
 * The browser never contacts the upstream OpenCode instance, and it never
 * supplies an upstream URL: the paths below are fixed relative paths.
 */

export type ApiState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly message: string; readonly code: string; readonly httpStatus: number };

export interface ApiError {
  readonly message: string;
  readonly code: string;
  readonly httpStatus: number;
}

async function readError(response: Response): Promise<ApiError> {
  let message = `Request failed with HTTP ${response.status}.`;
  let code = "http-error";
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error !== "") message = body.error;
    if (typeof body.code === "string" && body.code !== "") code = body.code;
  } catch {
    // A non-JSON error body keeps the generic message.
  }
  return { message, code, httpStatus: response.status };
}

export interface UseApiOptions {
  /** Poll interval in milliseconds. Omit to fetch once. */
  readonly pollMs?: number;
}

export interface UseApiResult<T> {
  readonly state: ApiState<T>;
  readonly refresh: () => void;
}

/**
 * Fetch a JSON endpoint, optionally polling.
 *
 * Pass `null` as the path to skip fetching entirely; the returned state stays
 * `loading`, and no effect body sets state synchronously.
 *
 * A 401 is surfaced as its own state so the UI can prompt for sign-in instead of
 * showing a generic failure. The in-flight request is aborted on unmount or when
 * the path changes, so a fast filter change cannot land a stale response.
 */
export function useApi<T>(path: string | null, options: UseApiOptions = {}): UseApiResult<T> {
  const { pollMs } = options;
  const [state, setState] = useState<ApiState<T>>({ status: "loading" });
  const abortRef = useRef<AbortController | null>(null);
  const requestRefreshRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(() => {
    requestRefreshRef.current?.();
  }, []);

  useEffect(() => {
    if (path === null) return;

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    let inFlight = false;
    let invalidated = false;

    const load = async (): Promise<void> => {
      // A slow poll must not race another response back into older state.
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const response = await fetch(path, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (cancelled) return;
        if (!response.ok) {
          const error = await readError(response);
          if (!cancelled) {
            setState({ status: "error", message: error.message, code: error.code, httpStatus: error.httpStatus });
          }
          return;
        }
        const data = (await response.json()) as T;
        if (!cancelled) setState({ status: "ready", data });
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setState({
          status: "error",
          message: "Could not reach the observer API. Check that the web process is running.",
          code: "network-error",
          httpStatus: 0,
        });
      } finally {
        inFlight = false;
        if (invalidated && !cancelled) {
          invalidated = false;
          void load();
        }
      }
    };

    // Do not repeatedly abort a slow read when a busy change stream invalidates
    // it: that would starve the view forever. Finish it, then reconcile once.
    requestRefreshRef.current = () => {
      if (inFlight) invalidated = true;
      else void load();
    };

    void load();

    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollMs !== undefined && pollMs > 0) {
      timer = setInterval(() => {
        void load();
      }, pollMs);
    }

    return () => {
      cancelled = true;
      requestRefreshRef.current = null;
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [path, pollMs]);

  return { state, refresh };
}

/** POST JSON and return either the parsed body or a structured error. */
export async function postJson<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response) };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return {
      ok: false,
      error: {
        message: "Could not reach the observer API.",
        code: "network-error",
        httpStatus: 0,
      },
    };
  }
}

export interface LiveChangesState {
  readonly connected: boolean;
  /** Terminal for this subscription owner; protected views must discard data. */
  readonly authExpired: boolean;
  /** Sequence number the stream has delivered up to. */
  readonly lastSeq: number;
  readonly latestSeq: number;
}

/**
 * Subscribe to this application's change stream.
 *
 * Reconnects with `since=<lastSeq>` so a dropped connection replays the durable
 * change log rather than losing the window. `onChange` is called with a
 * monotonically increasing counter, which callers use to trigger a refetch.
 */
export function useLiveChanges(onChange: () => void, options: { readonly enabled?: boolean } = {}): LiveChangesState {
  const { enabled = true } = options;
  const [connected, setConnected] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);
  const [latestSeq, setLatestSeq] = useState(0);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled || authExpired) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let closed = false;
    let pending = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const open = (): void => {
      if (closed) return;
      const url = lastSeqRef.current > 0 ? `/api/events?since=${lastSeqRef.current}` : "/api/events";
      source = new EventSource(url, { withCredentials: true });

      source.addEventListener("open", () => {
        setConnected(true);
      });

      source.addEventListener("hello", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as EventsHelloPayload;
          setLatestSeq(payload.latestSeq);
          if (payload.resumeFrom !== lastSeqRef.current) {
            lastSeqRef.current = payload.resumeFrom;
          }
          onChangeRef.current();
        } catch {
          // A malformed frame is ignored; the next change still triggers a refresh.
        }
      });

      source.addEventListener("change", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as ChangeEventPayload;
          if (payload.seq > lastSeqRef.current) {
            lastSeqRef.current = payload.seq;
            setLastSeq(payload.seq);
          }
          setLatestSeq((current) => Math.max(current, payload.seq));
          // Coalesce a burst of changes into a single refetch.
          if (!pending) {
            pending = true;
            refreshTimer = setTimeout(() => {
              pending = false;
              if (!closed) onChangeRef.current();
            }, 250);
          }
        } catch {
          // Ignore malformed frames.
        }
      });

      source.addEventListener("auth-expired", () => {
        closed = true;
        setAuthExpired(true);
        setConnected(false);
        source?.close();
        source = null;
        clearTimeout(refreshTimer);
        clearTimeout(reconnectTimer);
        onChangeRef.current();
      });

      source.addEventListener("error", () => {
        setConnected(false);
        source?.close();
        source = null;
        // EventSource retries on its own for some errors; because the stream
        // rotates deliberately, reconnect explicitly with the resume cursor.
        if (!closed) {
          reconnectTimer = setTimeout(open, 2000);
        }
      });
    };

    open();

    return () => {
      closed = true;
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      setConnected(false);
      source?.close();
      source = null;
    };
  }, [enabled, authExpired]);

  return { connected, authExpired, lastSeq, latestSeq };
}

/** Build a query string from defined, non-empty values. */
export function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
}
