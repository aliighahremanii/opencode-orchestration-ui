import { execute, fromBool, queryAll, queryOne, toBool, type Db, type SqlValue } from "./driver.ts";
import { redactPersistedField, redactSerializedValue } from "../util/redact.ts";
import type {
  ActivityEvent,
  ActivityKind,
  AgentDefinition,
  CollectionGap,
  Confidence,
  Location,
  ObservationSource,
  RootRun,
  RootRunStatus,
  Session,
  UpstreamOutcome,
} from "../domain/types.ts";

/**
 * Observation persistence.
 *
 * Every writer here is idempotent: rows are keyed by upstream identity and
 * upserted, so replaying a reconcile cycle (after a reconnect, a restart, or an
 * overlapping collector) converges instead of duplicating. Activity events are
 * additionally keyed by a stable `dedupe_key` derived from
 * (location, session, message, part index).
 *
 * Writes that must be attributable to a single collector are wrapped by the
 * lease-fenced helpers in `collection-state.ts`.
 */

// --- locations -------------------------------------------------------------

export interface LocationRow {
  id: string;
  directory: string;
  project_id: string;
  canonical: string;
  subpath: string | null;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
}

/**
 * Upsert a location from a successful location snapshot.
 *
 * `canonical` is display-only free text — the resolved directory the API reports
 * — so it is redacted here, at the persistence boundary, exactly like every other
 * display field. The location's identity is `id`, and `directory` is the input
 * `locationIdFor` derives that id from, so both are preserved verbatim: redacting
 * either would leave the stored id inconsistent with its own directory and break
 * the join from `sessions.location_id`.
 */
export function upsertLocation(db: Db, input: Location & { source: ObservationSource; seenAt: number }): void {
  execute(
    db,
    `INSERT INTO locations (id, directory, project_id, canonical, subpath, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       directory = excluded.directory,
       project_id = excluded.project_id,
       canonical = excluded.canonical,
       subpath = excluded.subpath,
       source = excluded.source,
       last_seen_at = excluded.last_seen_at`,
    [
      input.id,
      input.directory,
      input.projectId,
      redactPersistedField(input.canonical),
      input.subpath,
      input.source,
      input.seenAt,
      input.seenAt,
    ],
  );
}

export function listLocations(db: Db): Location[] {
  return queryAll<LocationRow>(db, "SELECT * FROM locations ORDER BY directory ASC").map((row) => ({
    id: row.id,
    directory: row.directory,
    projectId: row.project_id,
    canonical: row.canonical,
    subpath: row.subpath,
    source: row.source as ObservationSource,
  }));
}

// --- agents ----------------------------------------------------------------

export interface AgentRow {
  location_id: string;
  agent_id: string;
  name: string;
  mode: string;
  hidden: number;
  description: string | null;
  model_provider_id: string | null;
  model_id: string | null;
  active: number;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
}

function toAgent(row: AgentRow): AgentDefinition {
  return {
    locationId: row.location_id,
    agentId: row.agent_id,
    name: row.name,
    mode: row.mode as AgentDefinition["mode"],
    hidden: toBool(row.hidden),
    description: row.description,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    active: toBool(row.active),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    source: row.source as ObservationSource,
  };
}

/**
 * Upsert an agent from a successful location snapshot.
 *
 * Display-only text is redacted here, at the persistence boundary, so a
 * credential pasted into an agent description can never reach the database or
 * the page that renders it. That includes `model_provider_id` and `model_id`:
 * both are arbitrary upstream labels the API reports, both are returned by the
 * agents DTO, and neither is a join key — no query compares or joins on them —
 * so they are redacted exactly like the free text. Identity fields
 * (`location_id`, `agent_id`) are deliberately left intact: those *are* join keys.
 */
export function upsertAgent(db: Db, agent: AgentDefinition): void {
  execute(
    db,
    `INSERT INTO agents (location_id, agent_id, name, mode, hidden, description, model_provider_id, model_id, active, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(location_id, agent_id) DO UPDATE SET
       name = excluded.name,
       mode = excluded.mode,
       hidden = excluded.hidden,
       description = excluded.description,
       model_provider_id = excluded.model_provider_id,
       model_id = excluded.model_id,
       active = 1,
       source = excluded.source,
       last_seen_at = excluded.last_seen_at`,
    [
      agent.locationId,
      agent.agentId,
      redactPersistedField(agent.name),
      agent.mode,
      fromBool(agent.hidden),
      redactPersistedField(agent.description),
      redactPersistedField(agent.modelProviderId),
      redactPersistedField(agent.modelId),
      agent.source,
      agent.firstSeenAt,
      agent.lastSeenAt,
    ],
  );
}

/**
 * Mark every agent for a location that the latest snapshot did not report as no
 * longer currently effective.
 *
 * The row is kept, so an agent that disappears upstream stops being presented as
 * currently effective while its historical invocations keep their attribution.
 * Called inside the same fenced transaction as the snapshot upserts, so
 * membership and observations commit together.
 */
export function deactivateAgentsNotInSnapshot(
  db: Db,
  locationId: string,
  activeAgentIds: readonly string[],
): number {
  if (activeAgentIds.length === 0) {
    return execute(db, "UPDATE agents SET active = 0 WHERE location_id = ? AND active = 1", [locationId]).changes;
  }
  const placeholders = activeAgentIds.map(() => "?").join(", ");
  return execute(
    db,
    `UPDATE agents SET active = 0 WHERE location_id = ? AND active = 1 AND agent_id NOT IN (${placeholders})`,
    [locationId, ...activeAgentIds],
  ).changes;
}

export function listAgents(db: Db, locationId?: string): AgentDefinition[] {
  // Currently effective agents first, then retained history, so the UI can
  // present "effective now" and "no longer reported" as distinct groups without
  // a second query.
  const order = "ORDER BY active DESC, location_id ASC, name ASC";
  const rows =
    locationId === undefined
      ? queryAll<AgentRow>(db, `SELECT * FROM agents ${order}`)
      : queryAll<AgentRow>(db, `SELECT * FROM agents WHERE location_id = ? ${order}`, [locationId]);
  return rows.map(toAgent);
}

export function countActiveAgents(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM agents WHERE active = 1")?.n ?? 0;
}

export function countAgents(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM agents")?.n ?? 0;
}

// --- sessions --------------------------------------------------------------

export interface SessionRow {
  id: string;
  location_id: string;
  project_id: string;
  parent_id: string | null;
  agent_id: string | null;
  agent_first_seen: string | null;
  model_provider_id: string | null;
  model_id: string | null;
  title: string | null;
  subpath: string | null;
  upstream_outcome: string | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
  time_archived: number | null;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    locationId: row.location_id,
    projectId: row.project_id,
    parentId: row.parent_id,
    agentId: row.agent_id,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    title: row.title,
    subpath: row.subpath,
    upstreamOutcome: (row.upstream_outcome as UpstreamOutcome | null) ?? null,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    timeIdle: row.time_idle,
    timeArchived: row.time_archived,
    source: row.source as ObservationSource,
  };
}

export function upsertSession(db: Db, session: Session & { seenAt: number }): void {
  execute(
    db,
    `INSERT INTO sessions (
       id, location_id, project_id, parent_id, agent_id, agent_first_seen, model_provider_id, model_id,
       title, subpath, upstream_outcome, time_created, time_updated, time_idle, time_archived,
       source, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       location_id = excluded.location_id,
       project_id = excluded.project_id,
       parent_id = excluded.parent_id,
       agent_id = excluded.agent_id,
       model_provider_id = excluded.model_provider_id,
       model_id = excluded.model_id,
       title = excluded.title,
       subpath = excluded.subpath,
       upstream_outcome = excluded.upstream_outcome,
       time_created = excluded.time_created,
       time_updated = excluded.time_updated,
       time_idle = excluded.time_idle,
       time_archived = excluded.time_archived,
       source = excluded.source,
       last_seen_at = excluded.last_seen_at`,
    [
      session.id,
      session.locationId,
      session.projectId,
      session.parentId,
      session.agentId,
      // Attribution snapshot: the agent observed when the session was first
      // ingested is never overwritten, because a session may be resumed with a
      // different agent. `agent_id` tracks the latest observation.
      session.agentId,
      redactPersistedField(session.modelProviderId),
      redactPersistedField(session.modelId),
      redactPersistedField(session.title),
      redactPersistedField(session.subpath),
      session.upstreamOutcome,
      session.timeCreated,
      session.timeUpdated,
      session.timeIdle,
      session.timeArchived,
      session.source,
      session.seenAt,
      session.seenAt,
    ],
  );
}

export function getSession(db: Db, sessionId: string): Session | null {
  const row = queryOne<SessionRow>(db, "SELECT * FROM sessions WHERE id = ?", [sessionId]);
  return row === undefined ? null : toSession(row);
}

/**
 * Session plus the agent observed at first ingest.
 *
 * A session can be resumed with a different agent, so the current agent and the
 * originally observed agent are both reported rather than one overwriting the
 * other.
 */
export function getSessionWithAttribution(
  db: Db,
  sessionId: string,
): { session: Session; agentFirstSeen: string | null } | null {
  const row = queryOne<SessionRow>(db, "SELECT * FROM sessions WHERE id = ?", [sessionId]);
  if (row === undefined) return null;
  return { session: toSession(row), agentFirstSeen: row.agent_first_seen };
}

export interface SessionListQuery {
  readonly locationId?: string;
  readonly parentId?: string | null;
  readonly search?: string;
  readonly limit: number;
  readonly offset?: number;
}

export function listSessions(db: Db, query: SessionListQuery): Session[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.locationId !== undefined) {
    clauses.push("location_id = ?");
    params.push(query.locationId);
  }
  if (query.parentId === null) {
    clauses.push("parent_id IS NULL");
  } else if (query.parentId !== undefined) {
    clauses.push("parent_id = ?");
    params.push(query.parentId);
  }
  if (query.search !== undefined && query.search.trim() !== "") {
    clauses.push("(title LIKE ? OR id LIKE ?)");
    const needle = `%${query.search.trim()}%`;
    params.push(needle, needle);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(query.limit, query.offset ?? 0);
  const rows = queryAll<SessionRow>(
    db,
    `SELECT * FROM sessions ${where} ORDER BY time_updated DESC, id ASC LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map(toSession);
}

/**
 * Every stored session, for rebuilding the run forest.
 *
 * The forest must be rebuilt from what has been persisted, not from the current
 * bounded fetch window. A bounded window only covers the newest sessions, so
 * rebuilding from it alone would delete the run identity and ancestry of every
 * older root that is still stored and still browsable.
 *
 * `limit` is a safety bound against unbounded memory; it is far above the
 * per-cycle history bound and is not a retention policy.
 */
export function listStoredSessionsForTree(db: Db, limit?:number): Session[] {
  return queryAll<SessionRow>(
    db,
    `SELECT * FROM sessions ORDER BY time_updated DESC${limit===undefined?"":" LIMIT ?"}`,
    limit===undefined?[]:[limit],
  ).map(toSession);
}

export function countSessions(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sessions")?.n ?? 0;
}

export function countRootSessions(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sessions WHERE parent_id IS NULL")?.n ?? 0;
}

export function listAllSessionIds(db: Db, locationId?: string): string[] {
  const rows =
    locationId === undefined
      ? queryAll<{ id: string }>(db, "SELECT id FROM sessions")
      : queryAll<{ id: string }>(db, "SELECT id FROM sessions WHERE location_id = ?", [locationId]);
  return rows.map((row) => row.id);
}

// --- root runs -------------------------------------------------------------

export interface RootRunRow {
  id: string;
  location_id: string;
  root_session_id: string;
  title: string | null;
  started_at: number;
  last_activity_at: number;
  status: string;
  agent_id: string | null;
  session_count: number;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
}

export function toRootRun(row: RootRunRow): RootRun {
  return {
    id: row.id,
    locationId: row.location_id,
    rootSessionId: row.root_session_id,
    title: row.title,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    status: row.status as RootRunStatus,
    agentId: row.agent_id,
    sessionCount: row.session_count,
    source: row.source as ObservationSource,
  };
}

export function replaceRootRuns(db: Db, runs: readonly RootRun[]): void {
  db.exec("DELETE FROM root_runs");
  db.exec("DELETE FROM run_sessions");
  for (const run of runs) {
    execute(
      db,
      `INSERT INTO root_runs (
         id, location_id, root_session_id, title, started_at, last_activity_at, status, agent_id,
         session_count, source, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.locationId,
        run.rootSessionId,
        run.title,
        run.startedAt,
        run.lastActivityAt,
        run.status,
        run.agentId,
        run.sessionCount,
        run.source,
        run.startedAt,
        run.lastActivityAt,
      ],
    );
  }
}

export function replaceRunSessions(db: Db, memberships: readonly { runId: string; sessionId: string; depth: number }[]): void {
  for (const membership of memberships) {
    execute(db, "INSERT OR REPLACE INTO run_sessions (run_id, session_id, depth) VALUES (?, ?, ?)", [
      membership.runId,
      membership.sessionId,
      membership.depth,
    ]);
  }
}

/**
 * Repoint every retained activity event and invocation at the run its session
 * currently belongs to.
 *
 * Rebuilding the run forest can move a session between runs. The concrete case
 * this exists for: a bounded collection first observes a child `C` whose parent
 * `P` has not been seen, so `C` becomes its own orphan root. A later cycle
 * observes `P`, `C` is attached under `P`, and `C`'s old orphan run disappears
 * from `root_runs`. `C`'s already-stored `activity_events` and `invocations`
 * still carry the deleted run's id, so they vanish from the run detail page,
 * timeline, and counts even though the session is still listed as a member.
 *
 * Reconciling from `run_sessions` (rather than from the current fetch window)
 * fixes that for every retained row: a session outside this cycle's bounded fetch
 * and activity that a partial transcript did not re-read are repointed too. No
 * row is deleted and no evidence is regenerated — only the `run_id` pointer
 * changes. The statements are idempotent: a reference that is already correct is
 * not rewritten, so a replay converges and reports zero changes.
 *
 * A session with no membership (only possible beyond the tree's safety bound) is
 * left untouched, so nothing is silently detached.
 *
 * Must run inside the same transaction as {@link replaceRootRuns} and
 * {@link replaceRunSessions}: it reads `run_sessions`, so it sees the rebuilt
 * hierarchy, and the pointer update commits atomically with the runs it points
 * at.
 */
export function reconcileRunReferences(db: Db): void {
  // `run_id` is nullable on activity events and NOT NULL on invocations; the
  // `IS NOT` comparison handles the nullable case correctly, and the `EXISTS`
  // guard leaves rows for unmapped sessions alone.
  execute(
    db,
    `UPDATE activity_events
        SET run_id = (SELECT rs.run_id FROM run_sessions rs WHERE rs.session_id = activity_events.session_id)
      WHERE EXISTS (SELECT 1 FROM run_sessions rs WHERE rs.session_id = activity_events.session_id)
        AND run_id IS NOT (SELECT rs.run_id FROM run_sessions rs WHERE rs.session_id = activity_events.session_id)`,
  );
  execute(
    db,
    `UPDATE invocations
        SET run_id = (SELECT rs.run_id FROM run_sessions rs WHERE rs.session_id = invocations.session_id)
      WHERE EXISTS (SELECT 1 FROM run_sessions rs WHERE rs.session_id = invocations.session_id)
        AND run_id IS NOT (SELECT rs.run_id FROM run_sessions rs WHERE rs.session_id = invocations.session_id)`,
  );
}

export interface RootRunListQuery {
  readonly search?: string;
  readonly status?: RootRunStatus;
  readonly locationId?: string;
  readonly limit: number;
  readonly offset?: number;
}

export function listRootRuns(db: Db, query: RootRunListQuery): RootRun[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.locationId !== undefined) {
    clauses.push("location_id = ?");
    params.push(query.locationId);
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.search !== undefined && query.search.trim() !== "") {
    clauses.push("(title LIKE ? OR root_session_id LIKE ?)");
    const needle = `%${query.search.trim()}%`;
    params.push(needle, needle);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(query.limit, query.offset ?? 0);
  return queryAll<RootRunRow>(
    db,
    `SELECT * FROM root_runs ${where} ORDER BY last_activity_at DESC, id ASC LIMIT ? OFFSET ?`,
    params,
  ).map(toRootRun);
}

export function getRootRun(db: Db, runId: string): RootRun | null {
  const row = queryOne<RootRunRow>(db, "SELECT * FROM root_runs WHERE id = ?", [runId]);
  return row === undefined ? null : toRootRun(row);
}

export function getRootRunForSession(db: Db, sessionId: string): RootRun | null {
  const row = queryOne<RootRunRow>(
    db,
    `SELECT r.* FROM root_runs r
       JOIN run_sessions rs ON rs.run_id = r.id
      WHERE rs.session_id = ?
      ORDER BY rs.depth ASC
      LIMIT 1`,
    [sessionId],
  );
  return row === undefined ? null : toRootRun(row);
}

export function listRunSessions(db: Db, runId: string): { session: Session; depth: number }[] {
  const rows = queryAll<SessionRow & { depth: number }>(
    db,
    `SELECT s.*, rs.depth AS depth FROM run_sessions rs
       JOIN sessions s ON s.id = rs.session_id
      WHERE rs.run_id = ?
      ORDER BY rs.depth ASC, s.time_created ASC`,
    [runId],
  );
  return rows.map((row) => ({ session: toSession(row), depth: row.depth }));
}

export function countRootRuns(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM root_runs")?.n ?? 0;
}

// --- invocations -----------------------------------------------------------

export interface InvocationRow {
  id: string;
  run_id: string;
  session_id: string;
  location_id: string;
  agent_id: string;
  model_provider_id: string | null;
  model_id: string | null;
  started_at: number;
  ended_at: number | null;
  trigger_message_id: string | null;
  assistant_message_id: string;
  tool_call_count: number;
  upstream_outcome: string | null;
  confidence: string;
  evidence_json: string;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface InvocationRecord {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly locationId: string;
  readonly agentId: string;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly triggerMessageId: string | null;
  readonly assistantMessageId: string;
  readonly toolCallCount: number;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly confidence: Confidence;
  readonly evidenceJson: string;
  readonly source: ObservationSource;
  readonly seenAt: number;
}

export function upsertInvocation(db: Db, invocation: InvocationRecord): void {
  execute(
    db,
    `INSERT INTO invocations (
       id, run_id, session_id, location_id, agent_id, model_provider_id, model_id, started_at, ended_at,
       trigger_message_id, assistant_message_id, tool_call_count, upstream_outcome, confidence,
       evidence_json, source, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       run_id = excluded.run_id,
       ended_at = excluded.ended_at,
       tool_call_count = excluded.tool_call_count,
       upstream_outcome = excluded.upstream_outcome,
       evidence_json = excluded.evidence_json,
       last_seen_at = excluded.last_seen_at`,
    [
      invocation.id,
      invocation.runId,
      invocation.sessionId,
      invocation.locationId,
      invocation.agentId,
      redactPersistedField(invocation.modelProviderId),
      redactPersistedField(invocation.modelId),
      invocation.startedAt,
      invocation.endedAt,
      invocation.triggerMessageId,
      invocation.assistantMessageId,
      invocation.toolCallCount,
      invocation.upstreamOutcome,
      invocation.confidence,
      invocation.evidenceJson,
      invocation.source,
      invocation.seenAt,
      invocation.seenAt,
    ],
  );
}

export interface InvocationListQuery {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly limit: number;
  readonly offset?: number;
}

export function listInvocations(db: Db, query: InvocationListQuery): (Omit<InvocationRecord, "evidenceJson" | "seenAt"> & { evidence: unknown })[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.runId !== undefined) {
    clauses.push("run_id = ?");
    params.push(query.runId);
  }
  if (query.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(query.sessionId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(query.limit, query.offset ?? 0);
  const rows = queryAll<InvocationRow>(
    db,
    `SELECT * FROM invocations ${where} ORDER BY started_at DESC, id ASC LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    locationId: row.location_id,
    agentId: row.agent_id,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    triggerMessageId: row.trigger_message_id,
    assistantMessageId: row.assistant_message_id,
    toolCallCount: row.tool_call_count,
    upstreamOutcome: (row.upstream_outcome as UpstreamOutcome | null) ?? null,
    confidence: row.confidence as Confidence,
    source: row.source as ObservationSource,
    evidence: safeParseJson(row.evidence_json),
  }));
}

export function countInvocations(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM invocations")?.n ?? 0;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { parseError: true, raw };
  }
}

// --- activity --------------------------------------------------------------

export interface ActivityRow {
  id: string;
  dedupe_key: string;
  location_id: string;
  session_id: string;
  run_id: string | null;
  kind: string;
  message_id: string;
  part_index: number;
  sequence: number;
  occurred_at: number;
  actor_agent_id: string | null;
  tool_name: string | null;
  tool_status: string | null;
  summary: string;
  content: string | null;
  truncated: number;
  redacted: number;
  upstream_outcome: string | null;
  source: string;
  ingested_at: number;
}

export function toActivityEvent(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    locationId: row.location_id,
    sessionId: row.session_id,
    runId: row.run_id,
    kind: row.kind as ActivityKind,
    messageId: row.message_id,
    partIndex: row.part_index,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    actorAgentId: row.actor_agent_id,
    toolName: row.tool_name,
    toolStatus: (row.tool_status as ActivityEvent["toolStatus"]) ?? null,
    summary: row.summary,
    content: row.content,
    truncated: toBool(row.truncated),
    redacted: toBool(row.redacted),
    upstreamOutcome: (row.upstream_outcome as UpstreamOutcome | null) ?? null,
    source: row.source as ObservationSource,
  };
}

/**
 * Idempotent write. The `dedupe_key` unique index is the guard: replaying the
 * same upstream message part updates the existing row instead of creating a
 * second activity event.
 */
export function upsertActivityEvent(db: Db, event: ActivityEvent, ingestedAt: number): void {
  execute(
    db,
    `INSERT INTO activity_events (
       id, dedupe_key, location_id, session_id, run_id, kind, message_id, part_index, sequence,
       occurred_at, actor_agent_id, tool_name, tool_status, summary, content, truncated, redacted,
       upstream_outcome, source, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       run_id = excluded.run_id,
       summary = excluded.summary,
       content = excluded.content,
       truncated = excluded.truncated,
       redacted = excluded.redacted,
       tool_status = excluded.tool_status,
       upstream_outcome = excluded.upstream_outcome,
       ingested_at = excluded.ingested_at`,
    [
      event.id,
      event.dedupeKey,
      event.locationId,
      event.sessionId,
      event.runId,
      event.kind,
      event.messageId,
      event.partIndex,
      event.sequence,
      event.occurredAt,
      event.actorAgentId,
      event.toolName,
      event.toolStatus,
      event.summary,
      event.content,
      fromBool(event.truncated),
      fromBool(event.redacted),
      event.upstreamOutcome,
      event.source,
      ingestedAt,
    ],
  );
}

export function deleteActivityForSession(db: Db, sessionId: string): number {
  return execute(db, "DELETE FROM activity_events WHERE session_id = ?", [sessionId]).changes;
}

export interface ActivityListQuery {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly kind?: ActivityKind;
  readonly search?: string;
  readonly locationId?: string;
  readonly limit: number;
  readonly offset?: number;
}

function activityWhere(query: ActivityListQuery): { where: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(query.sessionId);
  }
  if (query.runId !== undefined) {
    clauses.push("run_id = ?");
    params.push(query.runId);
  }
  if (query.locationId !== undefined) {
    clauses.push("location_id = ?");
    params.push(query.locationId);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(query.kind);
  }
  if (query.search !== undefined && query.search.trim() !== "") {
    clauses.push("(summary LIKE ? OR content LIKE ? OR message_id LIKE ?)");
    const needle = `%${query.search.trim()}%`;
    params.push(needle, needle, needle);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listActivity(db: Db, query: ActivityListQuery): ActivityEvent[] {
  const { where, params } = activityWhere(query);
  params.push(query.limit, query.offset ?? 0);
  return queryAll<ActivityRow>(
    db,
    `SELECT * FROM activity_events ${where} ORDER BY occurred_at DESC, sequence DESC, id ASC LIMIT ? OFFSET ?`,
    params,
  ).map(toActivityEvent);
}

export function countActivity(db: Db, query: ActivityListQuery): number {
  const { where, params } = activityWhere(query);
  return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM activity_events ${where}`, params)?.n ?? 0;
}

export function countActivityForSession(db: Db, sessionId: string): number {
  return countActivity(db, { sessionId, limit: 0 });
}

/** Oldest retained activity timestamp, used to disclose history bounds. */
export function activityWindow(db: Db): { oldest: number | null; newest: number | null } {
  const row = queryOne<{ oldest: number | null; newest: number | null }>(
    db,
    "SELECT MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest FROM activity_events",
  );
  return { oldest: row?.oldest ?? null, newest: row?.newest ?? null };
}

// --- gaps ------------------------------------------------------------------

export interface GapRow {
  id: string;
  scope: string;
  stream: string;
  started_at: number;
  ended_at: number | null;
  reason: string;
  detected_at: number;
  resumed: number;
  open: number;
}

export function toGap(row: GapRow): CollectionGap {
  return {
    id: row.id,
    scope: row.scope,
    stream: row.stream,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    reason: row.reason,
    detectedAt: row.detected_at,
    resumed: toBool(row.resumed),
    open: toBool(row.open),
  };
}

/**
 * Persist a coverage gap, open or resumed.
 *
 * `reason` is diagnostic free text taken from an upstream failure, so it is
 * redacted at the write boundary — it may be a message, a serialised error body,
 * or prose that quotes a credential. The gap's identity (`id`) and its join keys
 * (`scope`, `stream`) are preserved exactly; only the stored text changes. Both
 * the insert and the `ON CONFLICT` update carry the redacted value, so a re-assert
 * cannot reintroduce a raw one.
 */
export function recordGap(db: Db, gap: CollectionGap): void {
  execute(
    db,
    `INSERT INTO collection_gaps (id, scope, stream, started_at, ended_at, reason, detected_at, resumed, open)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ended_at = excluded.ended_at,
       reason = excluded.reason,
       resumed = excluded.resumed,
       open = excluded.open`,
    [
      gap.id,
      gap.scope,
      gap.stream,
      gap.startedAt,
      gap.endedAt,
      redactSerializedValue(gap.reason),
      gap.detectedAt,
      fromBool(gap.resumed),
      fromBool(gap.open),
    ],
  );
}

/**
 * Open (or re-assert) a coverage gap that has not yet been resolved.
 *
 * The identity is derived from the window start only, so repeated failed
 * attempts at the same outage re-assert one row rather than creating a new gap
 * every cycle. `resumed` stays false and `open` stays true until a cycle
 * genuinely succeeds.
 *
 * `reason` is redacted at the write boundary, on both the insert and the
 * re-assert update, for the same reason as {@link recordGap}: it is diagnostic
 * text from an upstream failure and may carry a credential.
 */
export function openGap(
  db: Db,
  input: {
    readonly id: string;
    readonly scope: string;
    readonly stream: string;
    readonly startedAt: number;
    readonly reason: string;
    readonly detectedAt: number;
  },
): void {
  execute(
    db,
    `INSERT INTO collection_gaps (id, scope, stream, started_at, ended_at, reason, detected_at, resumed, open)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 1)
     ON CONFLICT(id) DO UPDATE SET
       reason = excluded.reason,
       open = 1,
       resumed = 0,
       ended_at = NULL`,
    [input.id, input.scope, input.stream, input.startedAt, redactSerializedValue(input.reason), input.detectedAt],
  );
}

/**
 * Close every open gap for a scope, now that a cycle has succeeded.
 *
 * Callers needing stream-specific proof must use closeOpenGapsForStream instead;
 * a successful cycle cannot prove recovery of a registry outside its fetch window.
 */
export function closeOpenGaps(db: Db, scope: string, endedAt: number): number {
  return execute(
    db,
    "UPDATE collection_gaps SET ended_at = ?, resumed = 1, open = 0 WHERE scope = ? AND open = 1",
    [endedAt, scope],
  ).changes;
}

/** Resolve only the coverage stream whose observations successfully committed. */
export function closeOpenGapsForStream(db: Db, scope: string, stream: string, endedAt: number): number {
  return execute(
    db,
    "UPDATE collection_gaps SET ended_at = ?, resumed = 1, open = 0 WHERE scope = ? AND stream = ? AND open = 1",
    [endedAt, scope, stream],
  ).changes;
}

export function listOpenGaps(db: Db, scope?: string): CollectionGap[] {
  const rows =
    scope === undefined
      ? queryAll<GapRow>(db, "SELECT * FROM collection_gaps WHERE open = 1 ORDER BY started_at ASC")
      : queryAll<GapRow>(db, "SELECT * FROM collection_gaps WHERE open = 1 AND scope = ? ORDER BY started_at ASC", [scope]);
  return rows.map(toGap);
}

export function listGaps(db: Db, limit: number, offset = 0): CollectionGap[] {
  // Open gaps first: an unresolved coverage hole is the most important thing on
  // this list.
  return queryAll<GapRow>(
    db,
    "SELECT * FROM collection_gaps ORDER BY open DESC, detected_at DESC, id ASC LIMIT ? OFFSET ?",
    [limit, offset],
  ).map(toGap);
}

export function countOpenGaps(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM collection_gaps WHERE open = 1")?.n ?? 0;
}

export function countGaps(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM collection_gaps")?.n ?? 0;
}

// --- overview --------------------------------------------------------------

export interface OverviewStats {
  readonly locations: number;
  readonly agents: number;
  /** Agents the latest successful location snapshot still reports. */
  readonly agentsActive: number;
  readonly sessions: number;
  readonly rootSessions: number;
  readonly rootRuns: number;
  readonly invocations: number;
  readonly activity: number;
  readonly openGaps: number;
}

export function overviewStats(db: Db): OverviewStats {
  return {
    locations: queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM locations")?.n ?? 0,
    agents: countAgents(db),
    agentsActive: countActiveAgents(db),
    sessions: countSessions(db),
    rootSessions: countRootSessions(db),
    rootRuns: countRootRuns(db),
    invocations: countInvocations(db),
    activity: queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM activity_events")?.n ?? 0,
    openGaps: countOpenGaps(db),
  };
}

// --- aggregate lookups used by the read API --------------------------------

/** Map of location id -> directory, so list responses can show a directory. */
export function locationDirectoryMap(db: Db): Map<string, string> {
  const rows = queryAll<{ id: string; directory: string }>(db, "SELECT id, directory FROM locations");
  return new Map(rows.map((row) => [row.id, row.directory]));
}

/** Invocation counts keyed by run id. */
export function invocationCountsByRun(db: Db): Map<string, number> {
  const rows = queryAll<{ run_id: string; n: number }>(
    db,
    "SELECT run_id, COUNT(*) AS n FROM invocations GROUP BY run_id",
  );
  return new Map(rows.map((row) => [row.run_id, row.n]));
}

/** Invocation counts keyed by session id. */
export function invocationCountsBySession(db: Db): Map<string, number> {
  const rows = queryAll<{ session_id: string; n: number }>(
    db,
    "SELECT session_id, COUNT(*) AS n FROM invocations GROUP BY session_id",
  );
  return new Map(rows.map((row) => [row.session_id, row.n]));
}

/** Activity counts keyed by session id. */
export function activityCountsBySession(db: Db): Map<string, number> {
  const rows = queryAll<{ session_id: string; n: number }>(
    db,
    "SELECT session_id, COUNT(*) AS n FROM activity_events GROUP BY session_id",
  );
  return new Map(rows.map((row) => [row.session_id, row.n]));
}

/**
 * Observed invocations per (location, agent).
 *
 * This is the evidence-backed counterpart to an agent definition: it counts
 * agent turns actually observed in assistant messages.
 */
export function observedInvocationsByAgent(db: Db): Map<string, number> {
  const rows = queryAll<{ location_id: string; agent_id: string; n: number }>(
    db,
    "SELECT location_id, agent_id, COUNT(*) AS n FROM invocations GROUP BY location_id, agent_id",
  );
  return new Map(rows.map((row) => [`${row.location_id}\u0000${row.agent_id}`, row.n]));
}

export function agentCountsByLocation(db: Db): Map<string, number> {
  const rows = queryAll<{ location_id: string; n: number }>(
    db,
    "SELECT location_id, COUNT(*) AS n FROM agents GROUP BY location_id",
  );
  return new Map(rows.map((row) => [row.location_id, row.n]));
}

export function sessionCountsByLocation(db: Db): Map<string, number> {
  const rows = queryAll<{ location_id: string; n: number }>(
    db,
    "SELECT location_id, COUNT(*) AS n FROM sessions GROUP BY location_id",
  );
  return new Map(rows.map((row) => [row.location_id, row.n]));
}

/** Root run id for a session, or null when the session is not in any run. */
export function runIdForSession(db: Db): Map<string, string> {
  const rows = queryAll<{ session_id: string; run_id: string }>(
    db,
    "SELECT session_id, run_id FROM run_sessions",
  );
  return new Map(rows.map((row) => [row.session_id, row.run_id]));
}

export function countInvocationsForSession(db: Db, sessionId: string): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM invocations WHERE session_id = ?", [sessionId])?.n ?? 0;
}

export function countInvocationsForRun(db: Db, runId: string): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM invocations WHERE run_id = ?", [runId])?.n ?? 0;
}

/** Sessions whose parent link was not observed (used to flag orphans in the UI). */
export function unobservedParentSessionIds(db: Db): Set<string> {
  const rows = queryAll<{ id: string }>(
    db,
    `SELECT s.id AS id FROM sessions s
      WHERE s.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_id)`,
  );
  return new Set(rows.map((row) => row.id));
}

export interface RunSearchQuery {
  readonly search?: string;
  readonly status?: RootRunStatus;
  readonly locationId?: string;
  readonly limit: number;
  readonly offset?: number;
}

export function countRootRunsMatching(db: Db, query: RunSearchQuery): number {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.locationId !== undefined) {
    clauses.push("location_id = ?");
    params.push(query.locationId);
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.search !== undefined && query.search.trim() !== "") {
    clauses.push("(title LIKE ? OR root_session_id LIKE ?)");
    const needle = `%${query.search.trim()}%`;
    params.push(needle, needle);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM root_runs ${where}`, params)?.n ?? 0;
}

export function countSessionsMatching(db: Db, query: SessionListQuery): number {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.locationId !== undefined) {
    clauses.push("location_id = ?");
    params.push(query.locationId);
  }
  if (query.parentId === null) {
    clauses.push("parent_id IS NULL");
  } else if (query.parentId !== undefined) {
    clauses.push("parent_id = ?");
    params.push(query.parentId);
  }
  if (query.search !== undefined && query.search.trim() !== "") {
    clauses.push("(title LIKE ? OR id LIKE ?)");
    const needle = `%${query.search.trim()}%`;
    params.push(needle, needle);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM sessions ${where}`, params)?.n ?? 0;
}
