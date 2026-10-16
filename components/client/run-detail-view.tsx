"use client";

import Link from "next/link";
import { useState } from "react";
import type { InvocationItem, RootRunDetailResponse, RunSessionNode } from "../../lib/contracts/api.ts";
import {
  confidenceLabel,
  formatCount,
  formatDuration,
  formatRelative,
  formatTimestamp,
  runStatusLabel,
  runStatusTone,
  upstreamOutcomeLabel,
} from "../../lib/format.ts";
import { ActivityRow } from "./activity-row.tsx";
import { LiveIndicator } from "./live-indicator.tsx";
import { Badge, DataState, KeyValue, Notices, Panel, useNow } from "./ui.tsx";
import { useApi, useLiveChanges } from "./use-api.ts";

const POLL_MS = 10_000;

/**
 * Run detail.
 *
 * The session hierarchy is rendered as an indented list rather than a canvas
 * graph. That keeps it readable and usable on a phone, and it makes the
 * parent/child relationship explicit in the DOM so it is navigable by keyboard
 * and screen readers.
 */
export function RunDetailView({ runId }: { runId: string }) {
  const path = `/api/runs/${encodeURIComponent(runId)}`;
  const { state, refresh } = useApi<RootRunDetailResponse>(path, { pollMs: POLL_MS });
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
                <Badge tone={runStatusTone(data.run.status)}>{runStatusLabel(data.run.status)}</Badge>
                <Badge tone={data.run.source === "upstream" ? "info" : "warning"}>
                  {data.run.source === "upstream" ? "observed upstream" : "fixture data"}
                </Badge>
                <span className="text-xs text-muted">
                  {formatCount(data.sessions.length)} sessions · {formatCount(data.invocations.length)} invocations
                </span>
              </div>
              <LiveIndicator live={live} />
            </div>

            <Notices notes={data.notes} />

            <Panel title="Run" description="Observed timing and attribution.">
              <KeyValue
                items={[
                  { label: "Root session", value: <span className="font-mono text-xs">{data.run.rootSessionId}</span> },
                  { label: "Run id", value: <span className="font-mono text-xs">{data.run.id}</span> },
                  { label: "Location", value: data.run.locationDirectory ?? data.run.locationId },
                  { label: "Root agent (latest observation)", value: data.run.agentId ?? "—" },
                  { label: "First observed activity", value: formatTimestamp(data.run.startedAt) },
                  { label: "Last observed activity", value: `${formatTimestamp(data.run.lastActivityAt)} (${formatRelative(data.run.lastActivityAt, clock)})` },
                ]}
              />
            </Panel>

            <Panel
              title="Session hierarchy"
              description="Indentation is the observed parent/child depth. Sessions whose parent was not observed are marked."
            >
              <SessionTree sessions={data.sessions} clock={clock} />
            </Panel>

            <Panel
              title="Invocations"
              description="Each record requires an assistant message that carried an explicit agent field. The evidence is shown."
            >
              {data.invocations.length === 0 ? (
                <p className="text-sm text-muted">No invocations were recorded for this run.</p>
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

            {data.gaps.length > 0 ? (
              <Panel title="Collection gaps overlapping this run" description="Activity inside these windows may be missing.">
                <ul className="space-y-2 text-xs">
                  {data.gaps.map((gap) => (
                    <li key={gap.id} className="untrusted-text rounded border border-amber-600/40 bg-amber-500/5 p-2">
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        <span>
                          {formatTimestamp(gap.startedAt)} → {formatTimestamp(gap.endedAt)} ({gap.stream})
                        </span>
                        {gap.open ? (
                          <Badge tone="negative" title="Collection has not yet succeeded since this window began.">
                            still open
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-muted">{gap.reason}</div>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <Panel title="Timeline" description="Newest first. Redaction and truncation are labelled per event.">
              {data.activity.length === 0 ? (
                <p className="text-sm text-muted">No activity was observed for this run.</p>
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

export function SessionTree({ sessions, clock }: { sessions: readonly RunSessionNode[]; clock: number }) {
  if (sessions.length === 0) {
    return <p className="text-sm text-muted">No sessions were observed for this run.</p>;
  }
  return (
    <ul className="space-y-1">
      {sessions.map((session) => (
        <li key={session.sessionId}>
          {/* Indentation communicates depth without relying on a drawn graph. */}
          <div
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-s-2 border-border ps-2"
            style={{ marginInlineStart: `${Math.min(session.depth, 6) * 16}px` }}
          >
            <Link className="untrusted-text text-sm underline-offset-2 hover:underline" href={`/sessions/${session.sessionId}`}>
              {session.title === null || session.title === "" ? session.sessionId : session.title}
            </Link>
            <span className="text-xs text-muted">depth {session.depth}</span>
            {session.agentId === null ? null : <span className="text-xs text-muted">agent {session.agentId}</span>}
            {session.upstreamOutcome === null ? null : <Badge tone="info">{upstreamOutcomeLabel(session.upstreamOutcome)}</Badge>}
            {session.isOrphan ? (
              <Badge tone="warning" title="The parent session referenced by this session has not been observed.">
                parent not observed
              </Badge>
            ) : null}
            <span className="text-xs text-muted">
              {formatCount(session.activityCount)} events · {formatCount(session.invocationCount)} invocations
            </span>
            <span className="text-xs text-muted" title={formatTimestamp(session.timeUpdated)}>
              {clock === 0 ? formatTimestamp(session.timeUpdated) : formatRelative(session.timeUpdated, clock)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function InvocationCard({ invocation, clock }: { invocation: InvocationItem; clock: number }) {
  const [showEvidence, setShowEvidence] = useState(false);
  return (
    <div className="rounded border border-border p-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{invocation.agentId}</span>
        {invocation.modelProviderId === null && invocation.modelId === null ? null : (
          <span className="text-xs text-muted">
            {invocation.modelProviderId ?? "?"}
            {invocation.modelId === null || invocation.modelId === "" ? "" : `/${invocation.modelId}`}
          </span>
        )}
        <Badge tone={invocation.confidence === "verified" ? "positive" : "warning"} title={confidenceLabel(invocation.confidence)}>
          {invocation.confidence}
        </Badge>
        <span className="text-xs text-muted">
          {formatCount(invocation.toolCallCount)} tool call{invocation.toolCallCount === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted">ran {formatDuration(invocation.startedAt, invocation.endedAt)}</span>
        {invocation.upstreamOutcome === null ? null : <Badge tone="info">{upstreamOutcomeLabel(invocation.upstreamOutcome)}</Badge>}
        <span className="text-xs text-muted" title={formatTimestamp(invocation.startedAt)}>
          {clock === 0 ? formatTimestamp(invocation.startedAt) : formatRelative(invocation.startedAt, clock)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
        <Link className="underline" href={`/sessions/${invocation.sessionId}`}>
          session {invocation.sessionId}
        </Link>
        <button type="button" className="underline" onClick={() => setShowEvidence((value) => !value)} aria-expanded={showEvidence}>
          {showEvidence ? "Hide evidence" : "Show evidence"}
        </button>
      </div>
      {showEvidence ? (
        <pre className="untrusted-text mt-1 max-h-60 overflow-auto rounded border border-border bg-background p-2 text-xs">
          {JSON.stringify(invocation.evidence, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
