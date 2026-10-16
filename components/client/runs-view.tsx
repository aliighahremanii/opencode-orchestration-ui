"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { Paginated, RootRunStatus, RootRunSummary } from "../../lib/contracts/api.ts";
import { formatCount, formatRelative, formatTimestamp, runStatusLabel, runStatusTone } from "../../lib/format.ts";
import { LiveIndicator } from "./live-indicator.tsx";
import { Badge, DataState, Panel, TableWrap, useNow } from "./ui.tsx";
import { buildQuery, useApi, useLiveChanges } from "./use-api.ts";

const PAGE_SIZE = 25;
const POLL_MS = 15_000;

const STATUS_OPTIONS: readonly { value: "" | RootRunStatus; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "recently-active", label: "Recently active (observed)" },
  { value: "reported-idle", label: "Upstream reported idle" },
  { value: "reported-succeeded", label: "Upstream reported succeeded" },
  { value: "reported-failed", label: "Upstream reported failed" },
  { value: "reported-interrupted", label: "Upstream reported interrupted" },
  { value: "unknown", label: "No upstream report" },
];

/**
 * Root runs, searchable and filterable.
 *
 * Rendered as a table on wide screens and as a stacked list on narrow ones: the
 * list is the primary mobile presentation, not a fallback.
 */
export function RunsView() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | RootRunStatus>("");
  const [offset, setOffset] = useState(0);

  const path = useMemo(
    () => `/api/runs${buildQuery({ search, status, limit: PAGE_SIZE, offset })}`,
    [search, status, offset],
  );

  const { state, refresh } = useApi<Paginated<RootRunSummary>>(path, { pollMs: POLL_MS });
  const live = useLiveChanges(refresh);
  const now = useNow(30_000);
  const clock = now ?? 0;

  const onSearch = useCallback((value: string) => {
    setSearch(value);
    setOffset(0);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search title or session id"
          aria-label="Search root runs"
          className="min-w-48 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
        />
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as "" | RootRunStatus);
            setOffset(0);
          }}
          aria-label="Filter by status"
          className="rounded border border-border bg-background px-2 py-1.5 text-sm"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <LiveIndicator live={live} />
      </div>

      <Panel
        title="Root runs"
        description="Ordered by most recent observed activity."
        actions={
          state.status === "ready" ? (
            <span className="text-xs text-muted">
              {formatCount(state.data.page.total)} total
            </span>
          ) : null
        }
      >
        <DataState state={state} empty={(data) => data.data.length === 0}>
          {(data) => (
            <>
              {/* Wide screens: table. */}
              <div className="hidden sm:block">
                <TableWrap>
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-1 pe-3 font-medium">Run</th>
                        <th className="py-1 pe-3 font-medium">Status</th>
                        <th className="py-1 pe-3 font-medium">Agent</th>
                        <th className="py-1 pe-3 font-medium">Sessions</th>
                        <th className="py-1 pe-3 font-medium">Invocations</th>
                        <th className="py-1 font-medium">Last activity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.data.map((run) => (
                        <tr key={run.id}>
                          <td className="max-w-md py-2 pe-3">
                            <Link className="untrusted-text underline-offset-2 hover:underline" href={`/runs/${run.id}`}>
                              {run.title === null || run.title === "" ? run.rootSessionId : run.title}
                            </Link>
                          </td>
                          <td className="py-2 pe-3">
                            <Badge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
                          </td>
                          <td className="py-2 pe-3 text-xs text-muted">{run.agentId ?? "—"}</td>
                          <td className="py-2 pe-3 tabular-nums">{formatCount(run.sessionCount)}</td>
                          <td className="py-2 pe-3 tabular-nums">{formatCount(run.invocationCount)}</td>
                          <td className="py-2 text-xs text-muted" title={formatTimestamp(run.lastActivityAt)}>
                            {clock === 0 ? formatTimestamp(run.lastActivityAt) : formatRelative(run.lastActivityAt, clock)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>

              {/* Narrow screens: the same data as a stacked list. */}
              <ul className="divide-y divide-border sm:hidden">
                {data.data.map((run) => (
                  <li key={run.id} className="py-2">
                    <Link className="untrusted-text text-sm font-medium underline-offset-2 hover:underline" href={`/runs/${run.id}`}>
                      {run.title === null || run.title === "" ? run.rootSessionId : run.title}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
                      <span className="text-xs text-muted">
                        {formatCount(run.sessionCount)} sessions · {formatCount(run.invocationCount)} invocations
                      </span>
                      <span className="text-xs text-muted" title={formatTimestamp(run.lastActivityAt)}>
                        {clock === 0 ? formatTimestamp(run.lastActivityAt) : formatRelative(run.lastActivityAt, clock)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>

              <Pagination
                offset={data.page.offset}
                limit={data.page.limit}
                total={data.page.total}
                onOffset={setOffset}
              />
            </>
          )}
        </DataState>
      </Panel>
    </div>
  );
}

export function Pagination({
  offset,
  limit,
  total,
  onOffset,
}: {
  offset: number;
  limit: number;
  total: number;
  onOffset: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-muted">
      <span className="tabular-nums">
        {formatCount(start)}–{formatCount(end)} of {formatCount(total)}
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
          className="rounded border border-border px-2 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={end >= total}
          onClick={() => onOffset(offset + limit)}
          className="rounded border border-border px-2 py-1 disabled:opacity-40"
        >
          Next
        </button>
      </span>
    </div>
  );
}
