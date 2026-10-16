"use client";

import Link from "next/link";
import type { SessionDetailResponse } from "../../lib/contracts/api.ts";
import {
  formatCount,
  formatRelative,
  formatTimestamp,
  upstreamOutcomeLabel,
} from "../../lib/format.ts";
import { ActivityRow } from "./activity-row.tsx";
import { LiveIndicator } from "./live-indicator.tsx";
import { InvocationCard } from "./run-detail-view.tsx";
import { Badge, DataState, KeyValue, Notices, Panel, useNow } from "./ui.tsx";
import { useApi, useLiveChanges } from "./use-api.ts";

const POLL_MS = 10_000;

/**
 * Session detail.
 *
 * Shows the observed session metadata, the invocations evidenced inside it, and
 * the full activity timeline. Attribution is explicit: the agent observed first
 * and the most recently observed agent are both shown, because a session can be
 * resumed with a different agent.
 */
export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const { state, refresh } = useApi<SessionDetailResponse>(path, { pollMs: POLL_MS });
  const live = useLiveChanges(refresh);
  const now = useNow(30_000);
  const clock = now ?? 0;

  return (
    <div className="space-y-4">
      <DataState state={state}>
        {(data) => (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={data.session.source === "upstream" ? "info" : "warning"}>
                  {data.session.source === "upstream" ? "observed upstream" : "fixture data"}
                </Badge>
                {data.session.upstreamOutcome === null ? null : (
                  <Badge tone="info">{upstreamOutcomeLabel(data.session.upstreamOutcome)}</Badge>
                )}
                {data.session.rootRunId === null ? null : (
                  <Link className="text-xs underline" href={`/runs/${data.session.rootRunId}`}>
                    view root run
                  </Link>
                )}
                {data.session.parentId === null ? null : (
                  <Link className="text-xs underline" href={`/sessions/${data.session.parentId}`}>
                    parent session
                  </Link>
                )}
              </div>
              <LiveIndicator live={live} />
            </div>

            <Notices notes={data.notes} />

            <Panel title="Session" description="Observed metadata. An upstream outcome is what the instance recorded.">
              <KeyValue
                items={[
                  { label: "Session", value: <span className="font-mono text-xs">{data.session.id}</span> },
                  { label: "Title", value: data.session.title ?? "—" },
                  { label: "Parent", value: data.session.parentId ?? "none observed" },
                  { label: "Location", value: data.session.locationDirectory ?? data.session.locationId },
                  { label: "Project", value: data.session.projectId },
                  { label: "Agent (first observed)", value: data.session.agentFirstSeen ?? "—" },
                  { label: "Agent (latest observation)", value: data.session.agentId ?? "—" },
                  {
                    label: "Model (latest observation)",
                    value: data.session.modelId === null || data.session.modelId === "" ? "—" : `${data.session.modelProviderId ?? "?"}/${data.session.modelId}`,
                  },
                  { label: "Created", value: formatTimestamp(data.session.timeCreated) },
                  { label: "Last updated", value: `${formatTimestamp(data.session.timeUpdated)} (${formatRelative(data.session.timeUpdated, clock)})` },
                  { label: "Idle since", value: data.session.timeIdle === null ? "—" : formatTimestamp(data.session.timeIdle) },
                ]}
              />
            </Panel>

            <Panel
              title="Invocations"
              description="One record per observed assistant turn that carried an explicit agent field."
            >
              {data.invocations.length === 0 ? (
                <p className="text-sm text-muted">No invocations were recorded for this session.</p>
              ) : (
                <ul className="space-y-2">
                  {data.invocations.map((invocation) => (
                    <li key={invocation.id}>
                      <InvocationCard invocation={invocation} clock={clock} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Activity"
              description={`Newest first. ${formatCount(data.activity.length)} event(s) loaded.`}
            >
              {data.activity.length === 0 ? (
                <p className="text-sm text-muted">No activity was observed for this session.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.activity.map((item) => (
                    <li key={item.id} className="py-2">
                      <ActivityRow item={item} clock={clock} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
      </DataState>
    </div>
  );
}
