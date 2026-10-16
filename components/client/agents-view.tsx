"use client";

import Link from "next/link";
import type { AgentListResponse } from "../../lib/contracts/api.ts";
import { formatCount, formatRelative, formatTimestamp } from "../../lib/format.ts";
import { LiveIndicator } from "./live-indicator.tsx";
import { Badge, DataState, Panel, TableWrap, useNow } from "./ui.tsx";
import { useApi, useLiveChanges } from "./use-api.ts";

const POLL_MS = 60_000;

/**
 * Effective agents.
 *
 * Definitions only. The observed invocation count is the evidence-backed number,
 * and the panel repeats that a definition is not an execution so a reader does
 * not mistake this page for a record of what ran.
 */
export function AgentsView() {
  const { state, refresh } = useApi<AgentListResponse>("/api/agents", { pollMs: POLL_MS });
  const live = useLiveChanges(refresh);
  const now = useNow(60_000);
  const clock = now ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          Agents are discovered from the upstream API per location. Hidden agents are shown because they are part of the
          effective registry. An agent the API no longer reports is retained as history and marked
          &ldquo;no longer reported&rdquo; rather than deleted.
        </p>
        <LiveIndicator live={live} />
      </div>

      <DataState state={state} empty={(data) => data.agents.length === 0}>
        {(data) => (
          <>
            <p className="rounded border border-border bg-surface p-2 text-xs">{data.note}</p>

            {data.locations.map((location) => {
              const agents = data.agents.filter((agent) => agent.locationId === location.id);
              const effective = agents.filter((agent) => agent.active).length;
              const historical = agents.length - effective;
              return (
                <Panel
                  key={location.id}
                  title={location.directory}
                  description={
                    `Project ${location.projectId} · ${formatCount(effective)} currently effective · ` +
                    `${formatCount(historical)} no longer reported · ${formatCount(location.sessionCount)} observed sessions`
                  }
                >
                  {agents.length === 0 ? (
                    <p className="text-sm text-muted">No agents were reported for this location.</p>
                  ) : (
                    <>
                      <div className="hidden sm:block">
                        <TableWrap>
                          <table className="w-full text-left text-sm">
                            <thead className="text-xs text-muted">
                              <tr>
                                <th className="py-1 pe-3 font-medium">Agent</th>
                                <th className="py-1 pe-3 font-medium">Mode</th>
                                <th className="py-1 pe-3 font-medium">Model</th>
                                <th className="py-1 pe-3 font-medium">Observed invocations</th>
                                <th className="py-1 font-medium">Last seen</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {agents.map((agent) => (
                                <tr key={agent.agentId}>
                                  <td className="py-2 pe-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="untrusted-text font-medium">{agent.name}</span>
                                      {agent.hidden ? <Badge tone="neutral">hidden</Badge> : null}
                                      {agent.active ? null : (
                                        <Badge tone="warning" title="The latest successful snapshot did not report this agent.">
                                          no longer reported
                                        </Badge>
                                      )}
                                    </div>
                                    {agent.description === null ? null : (
                                      <p className="untrusted-text mt-0.5 text-xs text-muted">{agent.description}</p>
                                    )}
                                  </td>
                                  <td className="py-2 pe-3 text-xs">{agent.mode}</td>
                                  <td className="py-2 pe-3 text-xs text-muted">
                                    {agent.modelId === null || agent.modelId === "" ? "—" : `${agent.modelProviderId ?? "?"}/${agent.modelId}`}
                                  </td>
                                  <td className="py-2 pe-3 tabular-nums">
                                    {agent.observedInvocationCount === 0 ? (
                                      <span className="text-muted">none observed</span>
                                    ) : (
                                      <Link className="underline" href={`/activity?search=${encodeURIComponent(agent.agentId)}`}>
                                        {formatCount(agent.observedInvocationCount)}
                                      </Link>
                                    )}
                                  </td>
                                  <td className="py-2 text-xs text-muted" title={formatTimestamp(agent.lastSeenAt)}>
                                    {clock === 0 ? formatTimestamp(agent.lastSeenAt) : formatRelative(agent.lastSeenAt, clock)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </TableWrap>
                      </div>

                      <ul className="divide-y divide-border sm:hidden">
                        {agents.map((agent) => (
                          <li key={agent.agentId} className="py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="untrusted-text text-sm font-medium">{agent.name}</span>
                              <Badge tone="neutral">{agent.mode}</Badge>
                              {agent.hidden ? <Badge tone="neutral">hidden</Badge> : null}
                              {agent.active ? null : <Badge tone="warning">no longer reported</Badge>}
                            </div>
                            {agent.description === null ? null : (
                              <p className="untrusted-text mt-1 text-xs text-muted">{agent.description}</p>
                            )}
                            <p className="mt-1 text-xs text-muted">
                              observed invocations: {formatCount(agent.observedInvocationCount)}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </Panel>
              );
            })}
          </>
        )}
      </DataState>
    </div>
  );
}
