"use client";

import Link from "next/link";
import type { OverviewResponse, RootRunSummary } from "../../lib/contracts/api.ts";
import { formatCount, formatRelative, formatTimestamp, runStatusLabel, runStatusTone } from "../../lib/format.ts";
import { ActivityRow } from "./activity-row.tsx";
import { LiveIndicator } from "./live-indicator.tsx";
import { Badge, DataState, KeyValue, Panel, Stat, useNow } from "./ui.tsx";
import { useApi, useLiveChanges } from "./use-api.ts";

const POLL_MS = 15_000;

/**
 * Overview.
 *
 * Counts are counts of observations. Run status is labelled as upstream-reported
 * or as a local recency heuristic, never as a completion verdict.
 */
export function OverviewView() {
  const { state, refresh } = useApi<OverviewResponse>("/api/overview", { pollMs: POLL_MS });
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
                <Badge tone={data.source.mode === "live" ? "info" : "warning"}>
                  {data.source.mode === "live" ? "live upstream" : "fixture mode"}
                </Badge>
                <span className="text-xs text-muted">{data.source.description}</span>
              </div>
              <LiveIndicator live={live} />
            </div>

            {data.source.mode === "fixture" ? (
              <p className="rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs">
                Fixture mode: nothing shown here is evidence about the live OpenCode instance.
              </p>
            ) : null}

            <CollectorBanner collector={data.collector} clock={clock} />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="Root runs" value={formatCount(data.counts.rootRuns)} />
              <Stat label="Sessions" value={formatCount(data.counts.sessions)} hint={`${formatCount(data.counts.rootSessions)} root`} />
              <Stat label="Invocations" value={formatCount(data.counts.invocations)} hint="evidence-backed" />
              <Stat label="Activity" value={formatCount(data.counts.activity)} hint="normalized events" />
              <Stat
                label="Agents"
                value={formatCount(data.counts.agents)}
                hint={`${formatCount(data.counts.agentsActive)} effective`}
              />
              <Stat label="Locations" value={formatCount(data.counts.locations)} />
              <Stat label="Open gaps" value={formatCount(data.counts.openGaps)} hint="coverage holes" />
            </div>

            <Panel
              title="Recent root runs"
              description="A root run is a root session plus every session observed to descend from it."
              actions={
                <Link className="text-xs underline" href="/runs">
                  All runs
                </Link>
              }
            >
              {data.recentRuns.length === 0 ? (
                <p className="text-sm text-muted">No runs have been observed yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentRuns.map((run) => (
                    <li key={run.id} className="py-2">
                      <RunLine run={run} clock={clock} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Recent activity"
              description="Normalized, deduplicated, redacted observations across all sessions."
              actions={
                <Link className="text-xs underline" href="/activity">
                  Search activity
                </Link>
              }
            >
              {data.recentActivity.length === 0 ? (
                <p className="text-sm text-muted">No activity has been observed yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentActivity.map((item) => (
                    <li key={item.id} className="py-2">
                      <ActivityRow item={item} clock={clock} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="History window" description="What this database currently retains.">
              <KeyValue
                items={[
                  { label: "Oldest retained activity", value: formatTimestamp(data.historyWindow.oldestActivityAt) },
                  { label: "Newest retained activity", value: formatTimestamp(data.historyWindow.newestActivityAt) },
                  { label: "Retention", value: data.historyWindow.retentionNote },
                  { label: "Generated", value: formatTimestamp(data.generatedAt) },
                ]}
              />
            </Panel>
          </>
        )}
      </DataState>
    </div>
  );
}

export function RunLine({ run, clock }: { run: RootRunSummary; clock: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <Link className="untrusted-text text-sm font-medium underline-offset-2 hover:underline" href={`/runs/${run.id}`}>
        {run.title === null || run.title === "" ? run.rootSessionId : run.title}
      </Link>
      <Badge tone={runStatusTone(run.status)} title="Status is what the upstream instance reported, not a verdict about the work.">
        {runStatusLabel(run.status)}
      </Badge>
      {run.agentId === null ? null : <span className="text-xs text-muted">agent {run.agentId}</span>}
      <span className="text-xs text-muted">
        {formatCount(run.sessionCount)} session{run.sessionCount === 1 ? "" : "s"} · {formatCount(run.invocationCount)} invocation
        {run.invocationCount === 1 ? "" : "s"}
      </span>
      <span className="text-xs text-muted" title={formatTimestamp(run.lastActivityAt)}>
        {clock === 0 ? formatTimestamp(run.lastActivityAt) : formatRelative(run.lastActivityAt, clock)}
      </span>
    </div>
  );
}

function CollectorBanner({ collector, clock }: { collector: OverviewResponse["collector"]; clock: number }) {
  if (collector.state === "running") {
    return (
      <p className="rounded border border-emerald-600/40 bg-emerald-500/5 p-2 text-xs">
        Collector is running (epoch {collector.epoch ?? "—"}). Last cycle{" "}
        {clock === 0 ? formatTimestamp(collector.lastCycleAt) : formatRelative(collector.lastCycleAt, clock)}
        {collector.lastCycleOk === false ? " and reported a failure" : ""}. Last successful collection{" "}
        {clock === 0 ? formatTimestamp(collector.lastSuccessAt) : formatRelative(collector.lastSuccessAt, clock)}.
      </p>
    );
  }
  if (collector.state === "stale") {
    return (
      <p className="rounded border border-red-600/40 bg-red-500/5 p-2 text-xs">
        The collector lease expired without a heartbeat. Data may be stale; gaps are recorded until it resumes.
      </p>
    );
  }
  if (collector.state === "never-started") {
    return (
      <p className="rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs">
        The collector has never completed a cycle. Start it with <code className="font-mono">npm run collector</code>.
      </p>
    );
  }
  if (collector.state === "stopped") {
    return (
      <p className="rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs">
        No collector holds the lease, so nothing is being collected right now. Data is as fresh as the last successful
        cycle; the window since then is recorded as a gap.
      </p>
    );
  }
  return <p className="rounded border border-border bg-surface p-2 text-xs">Collector state: {collector.state}.</p>;
}
