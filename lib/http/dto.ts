import type { Db } from "../db/driver.ts";
import { getCollectorState, getLease, listCheckpoints, listWarnings } from "../db/collection-state.ts";
import { listOpenGaps } from "../db/repositories.ts";
import { COLLECTOR_SCOPE } from "../db/collection-state.ts";
import type {
  AgentDefinition,
  ActivityEvent,
  CollectionGap,
  Location,
  RootRun,
  Session,
} from "../domain/types.ts";
import type { InvocationRecord } from "../db/repositories.ts";
import type {
  ActivityItem,
  AgentItem,
  CheckpointItem,
  CollectorHealth,
  Confidence,
  GapItem,
  InvocationItem,
  LocationItem,
  ObservationSource,
  RootRunStatus,
  RootRunSummary,
  SessionSummary,
  UpstreamOutcome,
  WarningItem,
} from "../contracts/api.ts";
import { getConfig } from "../config.ts";

/**
 * Response shaping.
 *
 * Route handlers return these DTOs rather than database rows. Two reasons:
 * column names never leak into the wire contract, and every field that is
 * derived or uncertain is labelled here, in one place, instead of at each call
 * site.
 */

export function toActivityItem(event: ActivityEvent): ActivityItem {
  return {
    id: event.id,
    kind: event.kind,
    sessionId: event.sessionId,
    runId: event.runId,
    messageId: event.messageId,
    partIndex: event.partIndex,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    actorAgentId: event.actorAgentId,
    toolName: event.toolName,
    toolStatus: event.toolStatus,
    summary: event.summary,
    content: event.content,
    truncated: event.truncated,
    redacted: event.redacted,
    upstreamOutcome: event.upstreamOutcome,
    source: event.source,
  };
}

/**
 * A persisted invocation as returned by the repository: the stored evidence blob
 * is replaced with its parsed form.
 */
export type InvocationReadModel = Omit<InvocationRecord, "evidenceJson" | "seenAt"> & { readonly evidence: unknown };

export function toInvocationItem(record: InvocationReadModel): InvocationItem {
  return {
    id: record.id,
    runId: record.runId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    modelProviderId: record.modelProviderId,
    modelId: record.modelId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    toolCallCount: record.toolCallCount,
    upstreamOutcome: record.upstreamOutcome as UpstreamOutcome | null,
    confidence: record.confidence as Confidence,
    evidence: record.evidence,
    source: record.source,
  };
}

export function toRunSummary(run: RootRun, locationDirectory: string | null, invocationCount: number): RootRunSummary {
  return {
    id: run.id,
    locationId: run.locationId,
    locationDirectory,
    rootSessionId: run.rootSessionId,
    title: run.title,
    status: run.status as RootRunStatus,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    agentId: run.agentId,
    sessionCount: run.sessionCount,
    invocationCount,
    source: run.source,
  };
}

export function toSessionSummary(
  session: Session,
  locationDirectory: string | null,
  runId: string | null,
  agentFirstSeen: string | null,
): SessionSummary {
  return {
    id: session.id,
    locationId: session.locationId,
    locationDirectory,
    projectId: session.projectId,
    parentId: session.parentId,
    agentId: session.agentId,
    agentFirstSeen,
    modelProviderId: session.modelProviderId,
    modelId: session.modelId,
    title: session.title,
    upstreamOutcome: session.upstreamOutcome,
    timeCreated: session.timeCreated,
    timeUpdated: session.timeUpdated,
    timeIdle: session.timeIdle,
    runId,
    rootRunId: runId,
    source: session.source,
  };
}

export function toAgentItem(
  agent: AgentDefinition,
  locationDirectory: string | null,
  observedInvocationCount: number,
): AgentItem {
  return {
    locationId: agent.locationId,
    locationDirectory,
    agentId: agent.agentId,
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    active: agent.active,
    description: agent.description,
    modelProviderId: agent.modelProviderId,
    modelId: agent.modelId,
    firstSeenAt: agent.firstSeenAt,
    lastSeenAt: agent.lastSeenAt,
    observedInvocationCount,
    source: agent.source,
  };
}

export function toLocationItem(
  location: Location,
  agentCount: number,
  sessionCount: number,
): LocationItem {
  return {
    id: location.id,
    directory: location.directory,
    projectId: location.projectId,
    canonical: location.canonical,
    agentCount,
    sessionCount,
    source: location.source as ObservationSource,
  };
}

export function toGapItem(gap: CollectionGap): GapItem {
  return {
    id: gap.id,
    scope: gap.scope,
    stream: gap.stream,
    startedAt: gap.startedAt,
    endedAt: gap.endedAt,
    reason: gap.reason,
    detectedAt: gap.detectedAt,
    resumed: gap.resumed,
    open: gap.open,
  };
}

export function toCheckpointItem(checkpoint: {
  scope: string;
  stream: string;
  cursor: string | null;
  lastSeenAt: number | null;
  updatedAt: number;
  partial: boolean;
}): CheckpointItem {
  return {
    scope: checkpoint.scope,
    stream: checkpoint.stream,
    cursor: checkpoint.cursor,
    lastSeenAt: checkpoint.lastSeenAt,
    updatedAt: checkpoint.updatedAt,
    partial: checkpoint.partial,
  };
}

export function toWarningItem(warning: {
  id: string;
  kind: string;
  detail: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
}): WarningItem {
  return {
    id: warning.id,
    kind: warning.kind,
    detail: warning.detail,
    occurrences: warning.occurrences,
    firstSeenAt: warning.firstSeenAt,
    lastSeenAt: warning.lastSeenAt,
  };
}

/**
 * Summarise collector health.
 *
 * The lease is the authority on whether a collector is running, because it is
 * the only record that is actually maintained while the process is alive:
 *
 * - **running** — a lease exists and its deadline has not passed.
 * - **stale** — a lease exists but its deadline passed without a heartbeat: the
 *   collector died or is wedged.
 * - **stopped** — no lease is held, but a previous cycle was recorded. This is
 *   the honest answer after a clean shutdown; reporting `running` here would
 *   claim liveness from a state row that no longer has a live owner.
 * - **never-started** — no lease and no recorded cycle.
 */
export function collectorHealth(db: Db, now: number): CollectorHealth {
  const state = getCollectorState(db, COLLECTOR_SCOPE);
  const lease = getLease(db, COLLECTOR_SCOPE);

  if (lease === null) {
    return {
      state: state === null ? "never-started" : "stopped",
      scope: COLLECTOR_SCOPE,
      holderId: state?.holderId ?? null,
      epoch: state?.epoch ?? null,
      lastCycleAt: state?.lastCycleAt ?? null,
      lastCycleOk: state?.lastCycleOk ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastError: state?.lastError ?? null,
      leaseExpiresAt: null,
    };
  }

  return {
    state: lease.expiresAt <= now ? "stale" : "running",
    scope: COLLECTOR_SCOPE,
    holderId: lease.holderId,
    epoch: lease.epoch,
    lastCycleAt: state?.lastCycleAt ?? null,
    lastCycleOk: state?.lastCycleOk ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastError: state?.lastError ?? null,
    leaseExpiresAt: lease.expiresAt,
  };
}

export function sourceSummary(): {
  readonly mode: "fixture" | "live";
  readonly observationSource: ObservationSource;
  readonly description: string;
} {
  const config = getConfig();
  const mode = config.upstream.mode;
  return {
    mode,
    observationSource: mode === "live" ? "upstream" : "fixture",
    description:
      mode === "live"
        ? `${config.upstream.baseUrl} (credentials ${config.upstream.username === null ? "not configured" : "configured"})`
        : `fixtures in ${config.fixtureDir}`,
  };
}

export function checkpointItems(db: Db): CheckpointItem[] {
  return listCheckpoints(db).map(toCheckpointItem);
}

export function warningItems(db: Db, limit = 100): WarningItem[] {
  return listWarnings(db, limit).map(toWarningItem);
}

/**
 * Limitations this build discloses on `/status`.
 *
 * These are statements about what has and has not been verified, not
 * disclaimers. They are derived from configuration so a fixture deployment
 * cannot imply a live integration.
 */
export function limitations(db: Db, now: number): string[] {
  const config = getConfig();
  const notes: string[] = [];

  notes.push(
    "Read-only observer: this application issues only GET requests upstream. It cannot execute, cancel, or " +
      "retry work, reply to permission requests, or change upstream configuration.",
  );

  if (config.upstream.mode === "fixture") {
    notes.push(
      "Running in fixture mode. All observed data comes from local fixtures in " +
        `${config.fixtureDir}; nothing here is evidence about the live OpenCode instance.`,
    );
  } else {
    notes.push(
      `Configured for the live upstream at ${config.upstream.baseUrl}. ` +
        (config.upstream.username === null
          ? "No upstream credentials are configured, so every request will fail with 401 until they are supplied through the environment."
          : "Credentials are read from the process environment only; this application never reads credential files."),
    );
  }

  notes.push(
    "Collection reconciles the authoritative session and message records on each cycle. The upstream event stream " +
      "is documented as volatile and no exact replay guarantee has been verified, so it is not used as the source of " +
      "truth and disconnects are recorded as gaps instead of being smoothed over.",
  );

  notes.push(
    "Upstream-reported outcomes are shown as reported. They describe what the upstream recorded, not whether the " +
      "user's underlying work succeeded. Silence, an idle session, or a successful tool call is not treated as completion.",
  );

  notes.push(
    "An invocation is recorded only when an assistant message carries an explicit agent field. Agent definitions, " +
      "child sessions, and session-level attribution never produce an invocation on their own.",
  );

  const health = collectorHealth(db, now);
  if (health.state === "never-started") {
    notes.push("The collector has never completed a cycle, so no data has been collected yet.");
  } else if (health.state === "stale") {
    notes.push(
      "The collector lease has expired without a heartbeat. Data shown is as fresh as the last completed cycle and " +
        "may be missing later activity until the collector resumes.",
    );
  } else if (health.state === "stopped") {
    notes.push(
      "No collector currently holds the lease. Data shown is as fresh as the last completed cycle, and the window " +
        "since then is recorded as a gap rather than being presented as complete.",
    );
  }

  const openGaps = listOpenGaps(db, COLLECTOR_SCOPE);
  if (openGaps.length > 0) {
    notes.push(
      `${openGaps.length} collection gap(s) are still open. Coverage inside those windows is not proven and is ` +
        "recorded as such; a gap is marked resumed only after a cycle genuinely succeeds.",
    );
  }

  const partial = listCheckpoints(db).filter((checkpoint) => checkpoint.partial);
  if (partial.length > 0) {
    notes.push(
      `${partial.length} stream(s) are only partly observed because the paging bound was reached. Their existing ` +
        "history was preserved rather than replaced, and their checkpoints are marked partial.",
    );
  }

  return notes;
}
