"use client";

import type { StatusResponse } from "../../lib/contracts/api.ts";
import { collectorStateLabel, formatRelative, formatTimestamp } from "../../lib/format.ts";
import { LiveIndicator } from "./live-indicator.tsx";
import { Badge, DataState, KeyValue, Panel, TableWrap, useNow } from "./ui.tsx";
import { useApi, useLiveChanges } from "./use-api.ts";

const POLL_MS = 15_000;

/**
 * Collection status.
 *
 * This page exists so the application can be honest about itself: schema state,
 * collector liveness, per-stream checkpoints, every recorded gap, every
 * non-fatal collection problem, and the capability limits of this build.
 */
export function StatusView() {
  const { state, refresh } = useApi<StatusResponse>("/api/status", { pollMs: POLL_MS });
  const live = useLiveChanges(refresh);
  const now = useNow(15_000);
  const clock = now ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <LiveIndicator live={live} />
      </div>

      <DataState state={state}>
        {(data) => (
          <>
            <Panel title="Collector" description="Ownership is enforced in the database with a fenced lease.">
              <KeyValue
                items={[
                  {
                    label: "State",
                    value: (
                      <Badge tone={data.collector.state === "running" ? "positive" : data.collector.state === "stale" ? "negative" : "warning"}>
                        {collectorStateLabel(data.collector.state)}
                      </Badge>
                    ),
                  },
                  { label: "Scope", value: <span className="font-mono text-xs">{data.collector.scope}</span> },
                  { label: "Holder", value: data.collector.holderId ?? "—" },
                  { label: "Lease epoch", value: data.collector.epoch === null ? "—" : String(data.collector.epoch) },
                  {
                    label: "Last cycle attempt",
                    value:
                      data.collector.lastCycleAt === null
                        ? "never"
                        : `${formatTimestamp(data.collector.lastCycleAt)} (${formatRelative(data.collector.lastCycleAt, clock)})`,
                  },
                  {
                    label: "Last cycle result",
                    value: data.collector.lastCycleOk === null ? "unknown" : data.collector.lastCycleOk ? "succeeded" : "failed",
                  },
                  {
                    label: "Last successful collection",
                    value:
                      data.collector.lastSuccessAt === null
                        ? "never"
                        : `${formatTimestamp(data.collector.lastSuccessAt)} (${formatRelative(data.collector.lastSuccessAt, clock)})`,
                  },
                  { label: "Lease expires", value: formatTimestamp(data.collector.leaseExpiresAt) },
                  { label: "Last error", value: data.collector.lastError ?? "none" },
                ]}
              />
            </Panel>

            <Panel title="Database" description="Schema version and credential state.">
              <KeyValue
                items={[
                  { label: "Ready", value: data.database.ready ? "yes" : "no" },
                  { label: "Schema version", value: `${data.database.schemaVersion} of ${data.database.expectedSchemaVersion}` },
                  { label: "Owner configured", value: data.database.ownerConfigured ? "yes" : "no" },
                  { label: "Database file", value: <span className="font-mono text-xs">{data.database.dbPath}</span> },
                  { label: "Error", value: data.database.error ?? "none" },
                ]}
              />
              {data.database.warnings.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs">
                  {data.database.warnings.map((warning) => (
                    <li key={warning} className="untrusted-text rounded border border-amber-600/40 bg-amber-500/5 p-2">
                      {warning}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <Panel title="Upstream source" description="How observations reach this database.">
              <KeyValue
                items={[
                  { label: "Mode", value: <Badge tone={data.source.mode === "live" ? "info" : "warning"}>{data.source.mode}</Badge> },
                  { label: "Observation source", value: data.source.observationSource },
                  { label: "Description", value: data.source.description },
                ]}
              />
            </Panel>

            <Panel
              title="Gaps"
              description="Windows where coverage cannot be proven. These are recorded, never smoothed over."
            >
              {data.gaps.length === 0 ? (
                <p className="text-sm text-muted">No gaps recorded.</p>
              ) : (
                <TableWrap>
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-1 pe-3 font-medium">Stream</th>
                        <th className="py-1 pe-3 font-medium">Window</th>
                        <th className="py-1 pe-3 font-medium">State</th>
                        <th className="py-1 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.gaps.map((gap) => (
                        <tr key={gap.id}>
                          <td className="py-2 pe-3 text-xs">{gap.stream}</td>
                          <td className="py-2 pe-3 text-xs">
                            {formatTimestamp(gap.startedAt)} → {formatTimestamp(gap.endedAt)}
                          </td>
                          <td className="py-2 pe-3 text-xs">
                            {gap.open ? (
                              <Badge tone="negative" title="Coverage inside this window is not proven.">
                                open
                              </Badge>
                            ) : gap.resumed ? (
                              <Badge tone="positive">resumed</Badge>
                            ) : (
                              <Badge tone="neutral">closed, not resumed</Badge>
                            )}
                          </td>
                          <td className="untrusted-text py-2 text-xs">{gap.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Panel>

            <Panel title="Collection warnings" description="Non-fatal problems, such as an upstream message type this build does not understand.">
              {data.warnings.length === 0 ? (
                <p className="text-sm text-muted">No collection warnings.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.warnings.map((warning) => (
                    <li key={warning.id} className="untrusted-text rounded border border-border p-2">
                      <span className="font-medium">{warning.kind}</span> ×{warning.occurrences} — {warning.detail}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Checkpoints" description="The last position recorded for each observed stream.">
              {data.checkpoints.length === 0 ? (
                <p className="text-sm text-muted">No checkpoints recorded yet.</p>
              ) : (
                <TableWrap>
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-1 pe-3 font-medium">Stream</th>
                        <th className="py-1 pe-3 font-medium">Coverage</th>
                        <th className="py-1 pe-3 font-medium">Resume cursor</th>
                        <th className="py-1 pe-3 font-medium">Last seen</th>
                        <th className="py-1 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.checkpoints.map((checkpoint) => (
                        <tr key={`${checkpoint.scope}/${checkpoint.stream}`}>
                          <td className="py-2 pe-3 font-mono text-xs">{checkpoint.stream}</td>
                          <td className="py-2 pe-3 text-xs">
                            {checkpoint.partial ? (
                              <Badge tone="warning" title="The paging bound was reached before the end of this stream.">
                                partial
                              </Badge>
                            ) : (
                              <Badge tone="positive">complete</Badge>
                            )}
                          </td>
                          <td className="untrusted-text py-2 pe-3 font-mono text-xs">{checkpoint.cursor ?? "—"}</td>
                          <td className="py-2 pe-3 text-xs">{formatTimestamp(checkpoint.lastSeenAt)}</td>
                          <td className="py-2 text-xs">{formatTimestamp(checkpoint.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Panel>

            <Panel title="Capabilities and limits" description="What this build does and does not do.">
              <ul className="space-y-1 text-xs">
                {data.limitations.map((note) => (
                  <li key={note} className="untrusted-text rounded border border-border p-2">
                    {note}
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        )}
      </DataState>
    </div>
  );
}
