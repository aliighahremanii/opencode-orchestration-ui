import type { CollectorConfig } from "../config.ts";
import { persistWorkspaceIdentity, projectScopeMap, reconcileAssignments, bindSessionOrigin, investigationSessionIds } from "../db/workspace.ts";
import type { Db } from "../db/driver.ts";
import {
  acquireLease,
  appendChange,
  COLLECTOR_SCOPE,
  getCheckpoint,
  getCollectorState,
  getLease,
  LeaseLostError,
  listCheckpoints,
  recordWarning,
  releaseLease,
  renewLease,
  setCheckpoint,
  setCollectorState,
  withFence,
  type CollectorState,
  type LeaseHandle,
} from "../db/collection-state.ts";
import {
  closeOpenGapsForStream,
  countActivityForSession,
  deactivateAgentsNotInSnapshot,
  deleteActivityForSession,
  listOpenGaps,
  listStoredSessionsForTree,
  openGap,
  overviewStats,
  reconcileRunReferences,
  recordGap,
  replaceRootRuns,
  replaceRunSessions,
  upsertActivityEvent,
  upsertAgent,
  upsertInvocation,
  upsertLocation,
  upsertSession,
} from "../db/repositories.ts";
import { deterministicId } from "../util/ids.ts";
import type { ObservationSource } from "../domain/types.ts";
import { buildRunTree, fromStoredSession, normalizeSessionActivity } from "./normalize.ts";
import type { AgentList, UpstreamSource } from "../upstream/source.ts";
import { UpstreamError, UpstreamHttpError } from "../upstream/source.ts";
import type { UpstreamMessage, UpstreamSessionInfo } from "../upstream/schema.ts";

/**
 * The collector.
 *
 * Responsibilities:
 *
 * 1. Own the collection lease so exactly one process writes observations.
 * 2. Reconcile the upstream read surface into local, normalized records.
 * 3. Record checkpoints and gaps so the dashboard can be honest about what it
 *    did and did not observe.
 *
 * Why reconcile instead of consuming the event stream: the upstream `/api/event`
 * stream is documented as volatile, and no exact replay guarantee has been
 * verified for this instance. Consuming it would let a disconnect silently drop
 * activity. Reconciliation re-reads the authoritative session and message
 * records on every cycle, so a disconnect costs freshness rather than data — and
 * any window that cannot be proven covered is recorded as a gap.
 */

export { COLLECTOR_SCOPE };

const STREAM_SESSIONS = "sessions";
const STREAM_MESSAGES_PREFIX = "messages:";
const STREAM_AGENTS_PREFIX = "agents:";
const STREAM_LOCATION = "location";

/** How much longer than the poll interval counts as a real pause. */
export const GAP_TOLERANCE_FACTOR = 3;

export interface CollectorLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: CollectorLogger = {
  info: (message, fields) => console.log(formatLine("info", message, fields)),
  warn: (message, fields) => console.warn(formatLine("warn", message, fields)),
  error: (message, fields) => console.error(formatLine("error", message, fields)),
};

function formatLine(level: string, message: string, fields?: Record<string, unknown>): string {
  const stamp = new Date().toISOString();
  const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
  return `${stamp} [collector] ${level}: ${message}${suffix}`;
}

export interface CollectorDeps {
  readonly db: Db;
  readonly source: UpstreamSource;
  readonly config: CollectorConfig;
  readonly now: () => number;
  readonly log: CollectorLogger;
  /**
   * Set by `runCycle` so a long reconcile can stop early once the lease is no
   * longer held, instead of finishing work it is not allowed to commit.
   */
  readonly isLeaseLost?: () => boolean;
}

export interface CycleResult {
  readonly ok: boolean;
  readonly source: ObservationSource;
  readonly locations: number;
  readonly agents: number;
  readonly sessions: number;
  readonly messages: number;
  readonly activityEvents: number;
  readonly invocations: number;
  readonly duplicateMessages: number;
  readonly outOfOrderMessages: number;
  readonly unknownMessageTypes: readonly string[];
  readonly gapsRecorded: number;
  readonly orphans: number;
  readonly cycles: number;
  readonly crossLocationLinks: number;
  /** Parent links that cross a fixture/upstream provenance boundary. */
  readonly crossSourceLinks: number;
  /** Sessions whose transcript paging bound was reached before the end. */
  readonly partialTranscripts: number;
  readonly durationMs: number;
  readonly error: string | null;
}

export function locationIdFor(directory: string, connectionId?:string, source?:ObservationSource): string {
  return deterministicId("loc", connectionId || source==="upstream" ? [connectionId ?? "unknown-connection",source ?? "upstream",directory] : [directory]);
}

export function observedSessionIdFor(upstreamId:string,connectionId?:string,source?:ObservationSource):string {
  return connectionId ? deterministicId("ses",[connectionId,source ?? "upstream",upstreamId]) : upstreamId;
}

/**
 * Map the transport kind onto the observation-source label persisted with each
 * record. `live` observations come from the upstream API, so they are recorded
 * as `upstream`; fixture observations stay labelled as fixtures everywhere they
 * are displayed.
 */
export function observationSourceFor(kind: UpstreamSource["kind"]): ObservationSource {
  return kind === "live" ? "upstream" : "fixture";
}

// --- gap detection ---------------------------------------------------------

export interface GapCandidate {
  readonly stream: string;
  readonly startedAt: number;
  readonly reason: string;
}

/**
 * Decide which coverage windows cannot be proven.
 *
 * Two independent causes:
 *
 * - **Handover**: the lease was held by a different collector and has already
 *   expired, so between its last heartbeat and now nobody was collecting.
 * - **Pause**: the last *successful* cycle is older than the expected interval
 *   plus tolerance, so collection is not provably continuous.
 *
 * Coverage is measured from the last **successful** cycle, never from the last
 * attempt. Measuring from the last attempt would let a sustained outage keep
 * pushing the clock forward, so a run of failures would never be recorded as a
 * gap at all.
 *
 * A first-ever cycle produces no gap: there is no earlier coverage claim to
 * contradict.
 */
export function detectGaps(input: {
  readonly previousState: CollectorState | null;
  readonly previousLease: { readonly holderId: string; readonly epoch: number; readonly heartbeatAt: number; readonly expiresAt: number } | null;
  readonly holderId: string;
  readonly now: number;
  readonly expectedIntervalMs: number;
}): GapCandidate[] {
  const candidates: GapCandidate[] = [];
  const tolerance = input.expectedIntervalMs * GAP_TOLERANCE_FACTOR;

  if (input.previousLease !== null && input.previousLease.holderId !== input.holderId) {
    if (input.previousLease.expiresAt <= input.now) {
      candidates.push({
        stream: "lease",
        startedAt: input.previousLease.heartbeatAt,
        reason:
          `collector handover: lease epoch ${input.previousLease.epoch} held by ${input.previousLease.holderId} ` +
          "expired before this process acquired it",
      });
    }
  }

  // The last proven coverage point. Falls back to the last attempt only when no
  // successful cycle has ever been recorded, so the very first pause after a
  // start-up failure is still measured from something meaningful.
  const lastProvenAt = input.previousState?.lastSuccessAt ?? null;

  if (lastProvenAt !== null) {
    const uncoveredMs = input.now - lastProvenAt;
    if (uncoveredMs > tolerance) {
      candidates.push({
        stream: "cycle",
        startedAt: lastProvenAt,
        reason:
          `no successful collection for ${Math.round(uncoveredMs / 1000)}s, ` +
          `longer than the ${Math.round(tolerance / 1000)}s tolerance for a ${Math.round(input.expectedIntervalMs / 1000)}s interval`,
      });
    }
  }

  return candidates;
}

/**
 * Gap identity is derived from the window start alone.
 *
 * An outage spans many failed attempts, and each attempt re-asserts the same
 * window. Keying on the start makes that idempotent, so one outage is one gap
 * rather than one gap per attempt.
 */
export function gapIdFor(scope: string, stream: string, startedAt: number): string {
  return deterministicId("gap", [scope, stream, startedAt]);
}

/**
 * Open a coverage gap.
 *
 * The gap is left unresolved (`open`, not `resumed`). Cycle/lease gaps close
 * after a successful cycle; registry gaps close with their successful snapshot.
 */
export function openGapCandidate(
  db: Db,
  handle: LeaseHandle,
  candidate: GapCandidate,
  now: number,
): void {
  withFence(db, handle, now, () => {
    openGap(db, {
      id: gapIdFor(handle.scope, candidate.stream, candidate.startedAt),
      scope: handle.scope,
      stream: candidate.stream,
      startedAt: candidate.startedAt,
      reason: candidate.reason,
      detectedAt: now,
    });
    appendChange(db, { kind: "gap", entityId: candidate.stream, scope: handle.scope }, now);
  });
}

/** A successful cycle proves cycle/lease recovery, not unobserved registry coverage. */
export function closeGapsAfterSuccess(db: Db, handle: LeaseHandle, now: number): number {
  return withFence(db, handle, now, () => {
    const closed = closeOpenGapsForStream(db, handle.scope, "cycle", now)
      + closeOpenGapsForStream(db, handle.scope, "lease", now);
    if (closed > 0) {
      appendChange(db, { kind: "gap-closed", entityId: "cycle/lease", scope: handle.scope }, now);
    }
    return closed;
  });
}

// --- reconcile -------------------------------------------------------------

interface ReconcileAccumulator {
  locations: number;
  agents: number;
  sessions: number;
  messages: number;
  activityEvents: number;
  invocations: number;
  duplicateMessages: number;
  outOfOrderMessages: number;
  orphans: number;
  cycles: number;
  crossLocationLinks: number;
  crossSourceLinks: number;
  partialTranscripts: number;
  unknownMessageTypes: string[];
  gapsRecorded: number;
}

/**
 * One full reconcile pass. Idempotent: running it twice with the same upstream
 * state converges on the same rows.
 */
export async function reconcile(deps: CollectorDeps, handle: LeaseHandle): Promise<CycleResult> {
  return reconcileWithProgress(deps, handle, emptyProgress());
}

function emptyProgress(): ReconcileAccumulator {
  return {
    locations: 0,
    agents: 0,
    sessions: 0,
    messages: 0,
    activityEvents: 0,
    invocations: 0,
    duplicateMessages: 0,
    outOfOrderMessages: 0,
    orphans: 0,
    cycles: 0,
    crossLocationLinks: 0,
    crossSourceLinks: 0,
    partialTranscripts: 0,
    unknownMessageTypes: [],
    gapsRecorded: 0,
  };
}

/** Progress is published only after fenced transactions commit, including on failure. */
async function reconcileWithProgress(deps: CollectorDeps, handle: LeaseHandle, acc: ReconcileAccumulator): Promise<CycleResult> {
  const startedAt = deps.now();
  const source: ObservationSource = observationSourceFor(deps.source.kind);

  // 1. Confirm the upstream is reachable and record its identity.
  const serverInfo = await deps.source.getServerInfo();
  const declaredLocations = await deps.source.listLocations();
  const projects = await deps.source.listProjects?.().catch(() => []) ?? [];
  const investigationIds = investigationSessionIds(deps.db);
  deps.log.info("upstream reachable", { version: serverInfo.version, locations: declaredLocations.length });

  // 2. Page through sessions. Bounded so a large instance cannot stall a cycle.
  const collected: UpstreamSessionInfo[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const maxPages = Math.max(1, Math.ceil(deps.config.maxSessionsPerLocation / deps.config.sessionPageLimit));
  while (pages < maxPages && collected.length < deps.config.maxSessionsPerLocation) {
    const page = await deps.source.listSessions({ cursor, limit: deps.config.sessionPageLimit });
    collected.push(...page.sessions);
    pages += 1;
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  const bounded = collected.slice(0, deps.config.maxSessionsPerLocation);
  // Paging can legitimately repeat a session (an overlapping page while
  // messages are appended). Deduplicate before doing any per-session work so a
  // repeat cannot double-count observations or cause a redundant transcript
  // fetch.
  const unique = [...new Map(bounded.filter(s=>!investigationIds.has(observedSessionIdFor(s.id,deps.source.connectionId,source))).map((session) => [session.id, session])).values()];

  // 3. Locations come from the declared location plus every location a session
  //    reports, so a session in another checkout is still scoped correctly.
  const directories = new Map<string, { directory: string; projectId: string; canonical: string }>();
  for (const declared of declaredLocations) {
    directories.set(declared.directory, {
      directory: declared.directory,
      projectId: declared.projectId,
      canonical: declared.canonical,
    });
  }
  for (const session of unique) {
    if (session.locationDirectory === "") continue;
    if (!directories.has(session.locationDirectory)) {
      directories.set(session.locationDirectory, {
        directory: session.locationDirectory,
        projectId: session.projectId,
        canonical: session.locationDirectory,
      });
    }
  }

  // 4. Effective agents per location. The registry is read from the API, never
  //    from agent files on disk.
  //
  //    Membership is reconciled on a *successful* snapshot: an agent the API no
  //    longer reports is marked inactive rather than left looking currently
  //    effective. The row is retained so historical invocations keep their
  //    attribution.
  for (const location of directories.values()) {
    const locationId = locationIdFor(location.directory,deps.source.connectionId,source);
    let list: AgentList | null;
    try {
      list = await deps.source.listAgents(location.directory);
    } catch (cause) {
      // Only this endpoint's typed 404 means an unavailable location registry.
      // Authentication, validation, transport and all other HTTP errors stay fatal.
      if (!(cause instanceof UpstreamHttpError) || cause.path !== "/api/agent" || cause.status !== 404) throw cause;
      list = null;
    }
    const gapStream = `${STREAM_AGENTS_PREFIX}${locationId}`;
    const metadata = await deps.source.workspaceMetadata?.(location.directory,location.projectId) ?? {branch:null,vcsState:"unknown" as const,worktreeState:"unknown" as const};
    const openedGap = withFence(deps.db, handle, deps.now(), () => {
      upsertLocation(deps.db, {
        id: locationId,
        directory: location.directory,
        projectId: location.projectId,
        canonical: location.canonical,
        subpath: null,
        source,
        seenAt: deps.now(),
      });
      const declared = declaredLocations.find(d=>d.projectId===location.projectId);
      persistWorkspaceIdentity(deps.db,{locationId,connectionId:deps.source.connectionId ?? null,source,projectId:location.projectId,
        directory:location.directory,project:projects.find(p=>p.id===location.projectId) ?? (declared ? {id:declared.projectId,root:declared.projectDirectory,name:null}:null), metadata,now:deps.now()});
      if (list === null) {
        // Keep the last successful membership, timestamps and checkpoint intact.
        // Deduplicate under the same fence and preserve the outage's original start.
        const existing = listOpenGaps(deps.db, handle.scope).some(gap => gap.stream === gapStream);
        if (!existing) {
          const checkpoint = getCheckpoint(deps.db, handle.scope, `${STREAM_AGENTS_PREFIX}${location.directory}`);
          const startedAt = checkpoint?.updatedAt ?? deps.now();
          const detail = `Agent registry unavailable for location ${locationId}: /api/agent returned HTTP 404; last successful membership retained`;
          openGap(deps.db, { id: gapIdFor(handle.scope, gapStream, startedAt), scope: handle.scope,
            stream: gapStream, startedAt, reason: detail, detectedAt: deps.now() });
          recordWarning(deps.db, { scope: handle.scope, kind: "agent-registry-unavailable", detail }, deps.now());
          appendChange(deps.db, { kind: "gap", entityId: gapStream, scope: handle.scope }, deps.now());
        }
        appendChange(deps.db, { kind: "location", entityId: locationId, scope: handle.scope }, deps.now());
        return !existing;
      }
      for (const agent of list.agents) {
        upsertAgent(deps.db, {
          locationId,
          agentId: agent.id,
          name: agent.name,
          mode: agent.mode,
          hidden: agent.hidden,
          description: agent.description,
          modelProviderId: agent.modelProviderId,
          modelId: agent.modelId,
          active: true,
          firstSeenAt: deps.now(),
          lastSeenAt: deps.now(),
          source,
        });
      }
      // Membership and observations commit together, so there is no window in
      // which the snapshot is applied but its membership is not.
      const deactivated = deactivateAgentsNotInSnapshot(deps.db, locationId, list.agents.map(agent => agent.id));
      if (deactivated > 0) {
        deps.log.info("agents no longer reported by the API were marked inactive", {
          location: location.directory,
          count: deactivated,
        });
      }
      appendChange(deps.db, { kind: "agents", entityId: locationId, scope: handle.scope }, deps.now());
      setCheckpoint(deps.db, { scope: handle.scope, stream: `${STREAM_AGENTS_PREFIX}${location.directory}`,
        cursor: null, lastSeenAt: deps.now(), updatedAt: deps.now(), partial: false });
      if (closeOpenGapsForStream(deps.db, handle.scope, gapStream, deps.now()) > 0) {
        appendChange(deps.db, { kind: "gap-closed", entityId: gapStream, scope: handle.scope }, deps.now());
      }
      return false;
    });
    acc.locations += 1;
    acc.agents += list?.agents.length ?? 0;
    if (openedGap) acc.gapsRecorded += 1;
    if (list === null) deps.log.warn("agent registry unavailable; continuing independent observations", { locationId, status: 404 });
  }

  // 5. Persist the sessions from this window, then rebuild the run forest from
  //    everything *stored*, not just this window. Rebuilding from the window
  //    alone would delete the run identity and ancestry of older roots that the
  //    window no longer covers, even though those sessions remain stored and
  //    browsable.
  withFence(deps.db, handle, deps.now(), () => {
    for (const session of unique) {
      if(directories.get(session.locationDirectory)?.projectId!==session.projectId)
        throw new Error("Session project conflicts with observed location identity; collection cannot safely publish this scope.");
      const locationId = locationIdFor(session.locationDirectory,deps.source.connectionId,source);
      const sessionId=observedSessionIdFor(session.id,deps.source.connectionId,source);
      bindSessionOrigin(deps.db,sessionId,deps.source.connectionId ?? "legacy",source,session.id);
      upsertSession(deps.db, {
        id: sessionId,
        locationId,
        projectId: session.projectId,
        parentId: session.parentId ? observedSessionIdFor(session.parentId,deps.source.connectionId,source) : null,
        agentId: session.agentId,
        modelProviderId: session.modelProviderId,
        modelId: session.modelId,
        title: session.title,
        subpath: session.subpath,
        upstreamOutcome: session.outcome,
        timeCreated: session.timeCreated,
        timeUpdated: session.timeUpdated,
        timeIdle: session.timeIdle,
        timeArchived: session.timeArchived,
        source,
        seenAt: deps.now(),
      });
    }
    appendChange(deps.db, { kind: "sessions", entityId: "all", scope: handle.scope }, deps.now());
  });
  acc.sessions += unique.length;

  const storedSessions = listStoredSessionsForTree(deps.db);
  const scopes = projectScopeMap(deps.db);
  const tree = buildRunTree(storedSessions.filter(s=>!investigationIds.has(s.id)).map(s=>{const scope=scopes.get(s.locationId);return {...fromStoredSession(s),...(scope?.upstreamProjectId===s.projectId?scope:{})};}), { now: deps.now() });

  const runIdBySession = new Map<string, string>();
  for (const membership of tree.memberships) {
    runIdBySession.set(membership.sessionId, membership.runId);
  }

  withFence(deps.db, handle, deps.now(), () => {
    replaceRootRuns(deps.db, tree.runs);
    replaceRunSessions(deps.db, tree.memberships);
    // Repoint retained activity and invocations at the rebuilt runs in the same
    // transaction, so a session that moved between runs (an orphan that was later
    // linked to its parent) never has its stored records stranded on the run that
    // just disappeared.
    reconcileRunReferences(deps.db);
    reconcileAssignments(deps.db);
    appendChange(deps.db, { kind: "runs", entityId: "all", scope: handle.scope }, deps.now());
  });
  acc.orphans = tree.orphans.length;
  acc.cycles = tree.cycles.length;
  acc.crossLocationLinks = tree.crossLocation.length;
  acc.crossSourceLinks = tree.crossSource.length;

  if (tree.orphans.length > 0) {
    deps.log.warn("sessions whose parent was not observed were treated as their own root", {
      count: tree.orphans.length,
      sample: tree.orphans.slice(0, 3).map((orphan) => orphan.sessionId),
    });
  }
  if (tree.cycles.length > 0) {
    deps.log.warn("cyclic parent links detected and truncated", { count: tree.cycles.length });
    recordWarningSafe(deps, handle, "cycle", `${tree.cycles.length} cyclic parent link(s) detected`);
  }
  if (tree.crossLocation.length > 0) {
    deps.log.warn("parent links crossing locations were not followed", { count: tree.crossLocation.length });
    recordWarningSafe(
      deps,
      handle,
      "cross-location",
      `${tree.crossLocation.length} parent link(s) cross a location boundary and were not followed`,
    );
  }
  if (tree.crossSource.length > 0) {
    deps.log.warn("parent links crossing a provenance boundary were not followed", { count: tree.crossSource.length });
    recordWarningSafe(
      deps,
      handle,
      "cross-source",
      `${tree.crossSource.length} parent link(s) cross a fixture/upstream provenance boundary and were not followed`,
    );
  }

  if (deps.isLeaseLost?.() === true) {
    throw new LeaseLostError(handle.scope);
  }

  // 6. Messages -> activity + invocations, per session in this window.
  //
  //    Transcripts are paged with a bound. If the bound is reached while the
  //    upstream still has more to give, the snapshot is **partial**: the existing
  //    activity must be preserved rather than replaced, and the checkpoint must
  //    record that the stream is incomplete.
  for (const session of unique) {
    const sessionId=observedSessionIdFor(session.id,deps.source.connectionId,source);
    const runId = runIdBySession.get(sessionId) ?? null;
    const locationId = locationIdFor(session.locationDirectory,deps.source.connectionId,source);
    const collectedMessages: UpstreamMessage[] = [];
    const unknownMessageTypes = new Set<string>();
    let messageCursor: string | null = null;
    let messagePages = 0;
    const maxMessagePages = Math.max(1, Math.ceil(deps.config.maxSessionsPerLocation / deps.config.messagePageLimit));
    while (messagePages < maxMessagePages) {
      const page = await deps.source.listMessages({
        sessionId: session.id,
        cursor: messageCursor,
        limit: deps.config.messagePageLimit,
      });
      collectedMessages.push(...page.messages);
      for (const unknown of page.unknownTypes) unknownMessageTypes.add(unknown);
      messagePages += 1;
      messageCursor = page.nextCursor;
      if (messageCursor === null) break;
    }
    // Complete means upstream offered no further page. Running out of pages with
    // a cursor still in hand means there is unseen history.
    const transcriptComplete = messageCursor === null;

    const normalized = normalizeSessionActivity({
      locationId,
      sessionId,
      runId,
      source,
      messages: collectedMessages,
      contentMaxChars: deps.config.contentMaxChars,
      ingestedAt: deps.now(),
    });

    withFence(deps.db, handle, deps.now(), () => {
      // Only a complete snapshot may replace a session's activity. Deleting on a
      // partial snapshot would destroy events that were observed earlier and that
      // this bounded fetch simply did not reach.
      if (transcriptComplete) {
        const existing = countActivityForSession(deps.db, sessionId);
        if (existing > 0) {
          deleteActivityForSession(deps.db, sessionId);
        }
      }
      for (const event of normalized.events) {
        upsertActivityEvent(deps.db, event, deps.now());
      }
      for (const invocation of normalized.invocations) {
        upsertInvocation(deps.db, invocation);
      }

      // The checkpoint commits in the same transaction as the observations it
      // describes, so a checkpoint can never claim coverage that was not written.
      setCheckpoint(deps.db, {
        scope: handle.scope,
        stream: `${STREAM_MESSAGES_PREFIX}${sessionId}`,
        cursor: transcriptComplete ? null : messageCursor,
        lastSeenAt: collectedMessages.reduce((max, message) => Math.max(max, message.created), 0) || null,
        updatedAt: deps.now(),
        partial: !transcriptComplete,
      });

      appendChange(deps.db, { kind: "session-activity", entityId: sessionId, scope: handle.scope }, deps.now());
    });
    acc.messages += collectedMessages.length;
    acc.duplicateMessages += normalized.duplicateMessageCount;
    acc.outOfOrderMessages += normalized.outOfOrderCount;
    if (!transcriptComplete) acc.partialTranscripts += 1;
    acc.activityEvents += normalized.events.length;
    acc.invocations += normalized.invocations.length;
    acc.unknownMessageTypes = [...new Set([...acc.unknownMessageTypes, ...unknownMessageTypes])];

    if (!transcriptComplete) {
      deps.log.warn("transcript paging bound reached; stored activity was preserved and the checkpoint is partial", {
        session: session.id,
        pages: messagePages,
        remainingCursor: messageCursor,
      });
      recordWarningSafe(
        deps,
        handle,
        "partial-transcript",
        `${session.id}: reached the ${maxMessagePages}-page bound with more history available`,
      );
    }
  }

  withFence(deps.db, handle, deps.now(), () => {
    setCheckpoint(deps.db, {
      scope: handle.scope,
      stream: STREAM_SESSIONS,
      cursor: null,
      lastSeenAt: unique.reduce((max, session) => Math.max(max, session.timeUpdated), 0) || null,
      updatedAt: deps.now(),
      partial: false,
    });
    setCheckpoint(deps.db, {
      scope: handle.scope,
      stream: STREAM_LOCATION,
      cursor: null,
      lastSeenAt: deps.now(),
      updatedAt: deps.now(),
      partial: false,
    });
  });

  for (const unknown of acc.unknownMessageTypes) {
    deps.log.warn("upstream returned a message type this build does not understand", { type: unknown });
    recordWarningSafe(deps, handle, "unknown-message-type", unknown);
  }

  const stats = overviewStats(deps.db);
  deps.log.info("reconcile complete", { ...stats, durationMs: deps.now() - startedAt });
  const unresolved = listOpenGaps(deps.db, handle.scope).filter(gap => gap.stream.startsWith(STREAM_AGENTS_PREFIX));

  return {
    ok: unresolved.length === 0,
    source,
    locations: acc.locations,
    agents: acc.agents,
    sessions: acc.sessions,
    messages: acc.messages,
    activityEvents: acc.activityEvents,
    invocations: acc.invocations,
    duplicateMessages: acc.duplicateMessages,
    outOfOrderMessages: acc.outOfOrderMessages,
    unknownMessageTypes: acc.unknownMessageTypes,
    gapsRecorded: acc.gapsRecorded,
    orphans: acc.orphans,
    cycles: acc.cycles,
    crossLocationLinks: acc.crossLocationLinks,
    crossSourceLinks: acc.crossSourceLinks,
    partialTranscripts: acc.partialTranscripts,
    durationMs: deps.now() - startedAt,
    error: unresolved.length === 0 ? null : `Agent registry coverage unavailable for ${unresolved.length} location(s); see open agents:<locationId> gaps`,
  };
}

function recordWarningSafe(deps: CollectorDeps, handle: LeaseHandle, kind: string, detail: string): void {
  try {
    withFence(deps.db, handle, deps.now(), () => {
      recordWarning(deps.db, { scope: handle.scope, kind, detail }, deps.now());
    });
  } catch (cause) {
    deps.log.warn("failed to persist a collection warning", { kind, error: cause instanceof Error ? cause.message : String(cause) });
  }
}

// --- cycle orchestration ---------------------------------------------------

export interface CycleOptions {
  readonly once?: boolean;
  readonly signal?: AbortSignal;
  /** Test hook: overrides how long to sleep between cycles. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunCycleOptions {
  /**
   * Release the lease when the cycle finishes.
   *
   * A long-running loop holds the lease across cycles so a redundant collector
   * stays in standby. A one-shot collection has no next cycle, so leaving the
   * lease held would block the next collection for the whole lease TTL.
   */
  readonly releaseWhenDone?: boolean;
}

/**
 * The shortest heartbeat interval. A TTL below this cannot be heartbeated in
 * time, so such a TTL is treated as already-too-short rather than silently
 * leaving the lease to expire mid-cycle.
 */
export const MIN_HEARTBEAT_MS = 250;

export interface LeaseHeartbeat {
  /** True once a renewal has failed: the lease is no longer held. */
  readonly lost: () => boolean;
  stop(): void;
}

/**
 * Keep the lease alive while a long cycle runs.
 *
 * A reconcile can take arbitrarily long (many sessions, a slow upstream). The
 * lease TTL is a fixed deadline, so without a heartbeat a cycle longer than the
 * TTL would expire its own lease mid-run: another collector could take over, and
 * every subsequent fenced write in this cycle would fail.
 *
 * The heartbeat renews at a third of the TTL, which tolerates two consecutive
 * missed renewals before the deadline passes.
 */
export function startLeaseHeartbeat(
  db: Db,
  handle: LeaseHandle,
  ttlMs: number,
  log: CollectorLogger,
): LeaseHeartbeat {
  let lost = false;
  const intervalMs = Math.max(MIN_HEARTBEAT_MS, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    if (lost) return;
    try {
      if (!renewLease(db, handle, Date.now())) {
        lost = true;
        log.warn("lease renewal failed mid-cycle; the lease is no longer held", { epoch: handle.epoch });
      }
    } catch (cause) {
      lost = true;
      log.warn("lease renewal threw mid-cycle; treating the lease as lost", {
        epoch: handle.epoch,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, intervalMs);
  // A heartbeat must never be the reason the process stays alive.
  if (typeof timer.unref === "function") timer.unref();
  return {
    lost: () => lost,
    stop: () => clearInterval(timer),
  };
}

/**
 * Run one cycle: acquire the lease, open gaps for lost coverage, reconcile, then
 * close the gaps and record state — all fenced by the lease.
 *
 * Returns the cycle result, or `null` when another collector owns the lease
 * (which is not an error: it is the expected outcome for a redundant process).
 */
export async function runCycle(
  deps: CollectorDeps,
  holderId: string,
  options: RunCycleOptions = {},
): Promise<CycleResult | null> {
  const cycleStartedAt = deps.now();
  const now = deps.now();
  const previousLease = getLease(deps.db, COLLECTOR_SCOPE);
  const previousState = getCollectorState(deps.db, COLLECTOR_SCOPE);

  const handle = acquireLease(deps.db, COLLECTOR_SCOPE, holderId, deps.config.leaseTtlMs, now);
  if (handle === null) {
    deps.log.warn("another collector owns the lease; standing by", {
      holder: previousLease?.holderId ?? "unknown",
      epoch: previousLease?.epoch ?? 0,
    });
    return null;
  }

  if (previousLease === null || previousLease.holderId !== holderId || previousLease.epoch !== handle.epoch) {
    deps.log.info("lease acquired", { epoch: handle.epoch, holder: holderId });
  }

  // The lease is definitely held from here on. Capturing it in a `const` after
  // the null check above keeps the narrowed type available to the closures below.
  const heldLease: LeaseHandle = handle;
  const heartbeat = startLeaseHeartbeat(deps.db, heldLease, deps.config.leaseTtlMs, deps.log);

  const finish = (result: CycleResult): CycleResult => {
    heartbeat.stop();
    if (options.releaseWhenDone === true) {
      releaseLease(deps.db, heldLease);
    }
    return result;
  };

  /**
   * Run a metadata write under the fence.
   *
   * Collector state, checkpoints, and gaps are as much a part of the write
   * surface as observations are: without the fence a collector that lost its
   * lease could overwrite the *current* collector's state, for example by
   * stamping a stale error message over a healthy one.
   *
   * A lost lease is reported and skipped rather than thrown, because the caller
   * is usually already handling a failure and must not be masked by a second
   * one.
   */
  const fenceMeta = (what: string, fn: () => void): boolean => {
    try {
      withFence(deps.db, heldLease, deps.now(), fn);
      return true;
    } catch (cause) {
      if (cause instanceof LeaseLostError) {
        deps.log.warn(`not writing ${what}: the lease is no longer held`, { epoch: heldLease.epoch });
        return false;
      }
      throw cause;
    }
  };

  // Gaps are opened *before* the reconcile, so a long or failing cycle cannot
  // hide the window it failed to cover. They are left open and are closed only
  // after a cycle genuinely succeeds.
  const gapCandidates = detectGaps({
    previousState,
    previousLease,
    holderId,
    now,
    expectedIntervalMs: deps.config.pollIntervalMs,
  });
  let gapsRecorded = 0;
  for (const candidate of gapCandidates) {
    try {
      openGapCandidate(deps.db, heldLease, candidate, deps.now());
      deps.log.warn("opened a collection gap", {
        stream: candidate.stream,
        from: new Date(candidate.startedAt).toISOString(),
        reason: candidate.reason,
      });
      gapsRecorded += 1;
    } catch (cause) {
      if (cause instanceof LeaseLostError) {
        deps.log.warn("lost the lease before a gap could be recorded", { stream: candidate.stream });
      } else {
        throw cause;
      }
    }
  }

  fenceMeta("collector state", () => {
    setCollectorState(deps.db, {
      scope: COLLECTOR_SCOPE,
      holderId,
      epoch: heldLease.epoch,
      lastCycleAt: now,
      lastCycleOk: null,
      lastError: null,
      updatedAt: now,
    });
  });

  const reconcileDeps: CollectorDeps = { ...deps, isLeaseLost: heartbeat.lost };
  const progress = emptyProgress();

  try {
    const result = await reconcileWithProgress(reconcileDeps, heldLease, progress);
    if (!result.ok) {
      // Independent observations committed, but coverage has not recovered.
      fenceMeta("collector state", () => {
        setCollectorState(deps.db, { scope: COLLECTOR_SCOPE, holderId, epoch: heldLease.epoch,
          lastCycleAt: deps.now(), lastCycleOk: false, lastError: result.error, updatedAt: deps.now() });
      });
      return finish({ ...result, gapsRecorded: gapsRecorded + progress.gapsRecorded });
    }

    // Success. Only now may an open gap be marked resumed.
    const closed = closeGapsAfterSuccess(deps.db, heldLease, deps.now());
    if (closed > 0) {
      deps.log.info("collection resumed; closed open gaps", { count: closed });
    }

    // The fixture-simulated gap describes a *past* window. It is recorded closed
    // here, in the success path, so nothing is marked resumed before success.
    const simulated = simulatedGapFromSource(deps.source);
    if (simulated !== null) {
      const startedAt = deps.now() + simulated.startedAtOffsetMs;
      const endedAt = deps.now() + simulated.endedAtOffsetMs;
      const wrote = fenceMeta("fixture gap", () => {
        recordGap(deps.db, {
          id: gapIdFor(heldLease.scope, simulated.stream, startedAt),
          scope: heldLease.scope,
          stream: simulated.stream,
          startedAt,
          endedAt,
          reason: simulated.reason,
          detectedAt: deps.now(),
          resumed: true,
          open: false,
        });
        appendChange(deps.db, { kind: "gap", entityId: simulated.stream, scope: heldLease.scope }, deps.now());
      });
      if (wrote) gapsRecorded += 1;
    }

    fenceMeta("collector state", () => {
      setCollectorState(deps.db, {
        scope: COLLECTOR_SCOPE,
        holderId,
        epoch: heldLease.epoch,
        lastCycleAt: deps.now(),
        lastCycleOk: true,
        lastError: null,
        updatedAt: deps.now(),
        lastSuccessAt: deps.now(),
      });
    });

    return finish({ ...result, gapsRecorded: gapsRecorded + progress.gapsRecorded });
  } catch (cause) {
    const message = cause instanceof UpstreamError ? `${cause.name}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause);
    deps.log.error("reconcile failed", { error: message });

    if (!(cause instanceof LeaseLostError)) {
      // A failed cycle leaves a coverage window. Open a gap for it immediately so
      // the outage is visible on the first failure, not only once it grows past
      // the tolerance.
      //
      // Only one gap is opened per outage: if a gap is already open, the window
      // is already represented and re-asserting it would create a second row per
      // failed attempt.
      const alreadyOpen = listOpenGaps(deps.db, heldLease.scope).some(gap => gap.stream === "cycle");
      if (!alreadyOpen) {
        const startedAt = previousState?.lastSuccessAt ?? cycleStartedAt;
        const wrote = fenceMeta("failure gap", () => {
          openGap(deps.db, {
            id: gapIdFor(heldLease.scope, "cycle", startedAt),
            scope: heldLease.scope,
            stream: "cycle",
            startedAt,
            reason: `collection failed: ${message}`,
            detectedAt: deps.now(),
          });
          appendChange(deps.db, { kind: "gap", entityId: "cycle", scope: heldLease.scope }, deps.now());
        });
        if (wrote) gapsRecorded += 1;
      }
    }

    fenceMeta("collector state", () => {
      setCollectorState(deps.db, {
        scope: COLLECTOR_SCOPE,
        holderId,
        epoch: heldLease.epoch,
        lastCycleAt: deps.now(),
        lastCycleOk: false,
        lastError: message,
        updatedAt: deps.now(),
        // `lastSuccessAt` is intentionally omitted, so a failure cannot erase the
        // record of when coverage was last actually proven.
      });
    });

    return finish({
      ok: false,
      source: observationSourceFor(deps.source.kind),
      ...progress,
      gapsRecorded: gapsRecorded + progress.gapsRecorded,
      durationMs: deps.now() - cycleStartedAt,
      error: message,
    });
  }
}

interface SimulatedGap {
  readonly stream: string;
  readonly startedAtOffsetMs: number;
  readonly endedAtOffsetMs: number;
  readonly reason: string;
}

function simulatedGapFromSource(source: UpstreamSource): SimulatedGap | null {
  const candidate = source as { simulatedGap?: unknown };
  if (candidate.simulatedGap === undefined || candidate.simulatedGap === null) return null;
  const gap = candidate.simulatedGap as { startedAtOffsetMs: number; endedAtOffsetMs: number; reason: string };
  return { stream: "fixture", startedAtOffsetMs: gap.startedAtOffsetMs, endedAtOffsetMs: gap.endedAtOffsetMs, reason: gap.reason };
}

export async function runCollectorLoop(
  deps: CollectorDeps,
  holderId: string,
  options: CycleOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) return;
    options.signal.addEventListener("abort", stop, { once: true });
  }

  let consecutiveFailures = 0;

  for (;;) {
    const result = await runCycle(deps, holderId);
    if (result === null || result.ok) {
      consecutiveFailures = 0;
    } else if (result.error?.includes(LeaseLostError.name) === true) {
      // Losing the lease is not an upstream failure: another collector owns the
      // scope now. Stand by and try again on the normal interval rather than
      // backing off as if the source were broken.
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
    }
    if (options.once === true) break;
    if (stopping) break;

    const backoff = Math.min(
      deps.config.pollIntervalMs * 2 ** Math.min(consecutiveFailures, 4),
      Math.max(deps.config.pollIntervalMs, Math.floor(deps.config.leaseTtlMs / 2)),
    );
    await sleep(consecutiveFailures > 0 ? backoff : deps.config.pollIntervalMs);
    if (stopping) break;
  }

  if (options.signal !== undefined) {
    options.signal.removeEventListener("abort", stop);
  }

  // Release only a lease this process still holds, so a clean shutdown cannot
  // take the lease away from a collector that took over.
  const lease = getLease(deps.db, COLLECTOR_SCOPE);
  if (lease !== null && lease.holderId === holderId) {
    releaseLease(deps.db, {
      scope: COLLECTOR_SCOPE,
      holderId: lease.holderId,
      epoch: lease.epoch,
      ttlMs: deps.config.leaseTtlMs,
    });
  }
  deps.log.info("collector stopped");
}

export function collectorIdentity(now: number): string {
  const explicit = process.env.ORCH_COLLECTOR_ID;
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const host = process.env.HOSTNAME ?? "host";
  return `collector:${host}:${process.pid}:${now}`;
}

export function listCheckpointStreams(db: Db): string[] {
  return listCheckpoints(db).map((checkpoint) => `${checkpoint.scope}/${checkpoint.stream}`);
}

export function readCheckpoint(db: Db, stream: string) {
  return getCheckpoint(db, COLLECTOR_SCOPE, stream);
}
