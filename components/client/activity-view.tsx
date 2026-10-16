"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { ActivityKind, ActivityItem, Paginated } from "../../lib/contracts/api.ts";
import { formatCount } from "../../lib/format.ts";
import { ACTIVITY_KINDS, ActivityRow, activityKindLabel } from "./activity-row.tsx";
import { LiveIndicator } from "./live-indicator.tsx";
import { DataState, Panel, useNow } from "./ui.tsx";
import { Pagination } from "./runs-view.tsx";
import { buildQuery, useApi, useLiveChanges } from "./use-api.ts";

const PAGE_SIZE = 50;
const POLL_MS = 15_000;

/**
 * Searchable activity.
 *
 * The URL is the source of truth for the initial filters, read through
 * `useSearchParams` (which subscribes to the router rather than setting state
 * from an effect). Local edits take precedence once the operator types, which is
 * why the edited values are nullable: `null` means "use the URL value".
 */
export function ActivityView() {
  const searchParams = useSearchParams();
  const urlSearch = searchParams.get("search") ?? "";
  const urlKindRaw = searchParams.get("kind") ?? "";
  const urlKind = (ACTIVITY_KINDS as readonly string[]).includes(urlKindRaw) ? (urlKindRaw as ActivityKind) : "";

  const [editedSearch, setEditedSearch] = useState<string | null>(null);
  const [editedKind, setEditedKind] = useState<ActivityKind | "" | null>(null);
  const [offset, setOffset] = useState(0);

  const search = editedSearch ?? urlSearch;
  const kind = editedKind ?? urlKind;

  const path = useMemo(
    () => `/api/activity${buildQuery({ search, kind, limit: PAGE_SIZE, offset })}`,
    [search, kind, offset],
  );

  const { state, refresh } = useApi<Paginated<ActivityItem>>(path, { pollMs: POLL_MS });
  const live = useLiveChanges(refresh);
  const now = useNow(30_000);
  const clock = now ?? 0;

  const onSearch = useCallback((value: string) => {
    setEditedSearch(value);
    setOffset(0);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search summary, stored content, or message id"
          aria-label="Search activity"
          className="min-w-56 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
        />
        <select
          value={kind}
          onChange={(event) => {
            setEditedKind(event.target.value as ActivityKind | "");
            setOffset(0);
          }}
          aria-label="Filter by activity kind"
          className="rounded border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Any kind</option>
          {ACTIVITY_KINDS.map((value) => (
            <option key={value} value={value}>
              {activityKindLabel(value)}
            </option>
          ))}
        </select>
        <LiveIndicator live={live} />
      </div>

      <Panel
        title="Activity"
        description="Normalized, deduplicated, redacted. Content is stored truncated and secrets are replaced before storage."
        actions={state.status === "ready" ? <span className="text-xs text-muted">{formatCount(state.data.page.total)} matching</span> : null}
      >
        <DataState state={state} empty={(data) => data.data.length === 0}>
          {(data) => (
            <>
              <ul className="divide-y divide-border">
                {data.data.map((item) => (
                  <li key={item.id} className="py-2">
                    <ActivityRow item={item} clock={clock} />
                  </li>
                ))}
              </ul>
              <Pagination offset={data.page.offset} limit={data.page.limit} total={data.page.total} onOffset={setOffset} />
            </>
          )}
        </DataState>
      </Panel>
    </div>
  );
}
