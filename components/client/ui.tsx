"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { ApiState } from "./use-api.ts";

/**
 * Shared presentational primitives.
 *
 * Two rules apply throughout:
 *
 * - Upstream-derived text is rendered as a React text child inside an element
 *   that allows wrapping. It is never passed to `dangerouslySetInnerHTML`, so a
 *   payload containing markup is displayed, not executed.
 * - Uncertain or reported values carry a visible label. Nothing here presents an
 *   upstream report as a local verdict.
 */

export type Tone = "neutral" | "positive" | "negative" | "warning" | "info";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border bg-surface text-muted",
  positive: "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  negative: "border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-300",
  warning: "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  info: "border-sky-600/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Panel({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description === undefined ? null : <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint === undefined ? null : <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export function ErrorNotice({ title, message, detail, action }: { title: string; message: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-red-600/40 bg-red-500/5 p-3">
      <p className="text-sm font-medium text-red-700 dark:text-red-300">{title}</p>
      <p className="mt-1 text-sm">{message}</p>
      {detail === undefined ? null : <p className="mt-1 text-xs text-muted">{detail}</p>}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Notices({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-amber-600/40 bg-amber-500/5 p-3 text-xs">
      {notes.map((note) => (
        <li key={note} className="untrusted-text">
          {note}
        </li>
      ))}
    </ul>
  );
}

export function KeyValue({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd className="untrusted-text text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">{children}</div>;
}

/**
 * Render an `ApiState` with consistent loading, empty, error, and 401 handling.
 *
 * A 401 is rendered as a sign-in prompt rather than an error, because the
 * common cause is an expired session.
 */
export function DataState<T>({
  state,
  empty,
  children,
}: {
  state: ApiState<T>;
  empty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    if (state.httpStatus === 401) {
      return (
        <ErrorNotice
          title="Sign-in required"
          message={state.message}
          detail="Your session is missing or has expired."
          action={
            <a className="text-sm underline" href="/login">
              Go to sign-in
            </a>
          }
        />
      );
    }
    if (state.httpStatus === 503) {
      return <ErrorNotice title="Observer not available" message={state.message} detail="The application is failing closed until this is resolved." />;
    }
    return <ErrorNotice title="Request failed" message={state.message} detail={`code: ${state.code}`} />;
  }
  if (empty !== undefined && empty(state.data)) {
    return <Empty>No data has been collected yet.</Empty>;
  }
  return <>{children(state.data)}</>;
}

/**
 * Client-side "now" that starts after mount.
 *
 * Relative labels depend on the current time, so computing them during the
 * server render would produce a hydration mismatch. `useSyncExternalStore`
 * subscribes to the clock as an external store, with a server snapshot of
 * `null`, which keeps the server and first client render identical.
 */
export function useNow(intervalMs = 30_000): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const timer = setInterval(onChange, intervalMs);
      return () => clearInterval(timer);
    },
    [intervalMs],
  );
  const getSnapshot = useCallback(() => Math.floor(Date.now() / 1000) * 1000, []);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
