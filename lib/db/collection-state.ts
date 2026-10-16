import { execute, fromBool, immediateTransaction, queryAll, queryOne, toBool, type Db } from "./driver.ts";
import type { CollectorCheckpoint, CollectorLease } from "../domain/types.ts";
import { deterministicId } from "../util/ids.ts";
import { redactSerializedValue } from "../util/redact.ts";

/**
 * Collector ownership, checkpoints, gaps, and the durable change log.
 *
 * The system has exactly one writer. A second collector may start (a restart, a
 * duplicated unit, an operator mistake), so ownership is enforced in the
 * database rather than by convention:
 *
 * - `acquireLease` runs inside `BEGIN IMMEDIATE`, so two processes racing to
 *   claim the same scope serialise and exactly one wins.
 * - The lease carries a monotonically increasing `epoch`. Every collector write
 *   happens inside `withFence`, which re-reads the lease in the same write
 *   transaction that holds the data write. A collector that lost its lease can
 *   therefore never commit a stale write, because the fence check and the write
 *   are atomic with respect to other writers.
 */

/**
 * The lease scope name for the single collector.
 *
 * Defined here, next to the lease table, rather than in the collector module:
 * the read-only web process needs this constant, and importing it from the
 * collector would drag the upstream adapter graph into the web bundle.
 */
export const COLLECTOR_SCOPE = "collector";

export class LeaseLostError extends Error {
  constructor(scope: string) {
    super(
      `Collector lease for scope ${JSON.stringify(scope)} is no longer held by this process. ` +
        "Refusing to write: another collector has taken ownership.",
    );
    this.name = "LeaseLostError";
  }
}

export interface LeaseHandle {
  readonly scope: string;
  readonly holderId: string;
  readonly epoch: number;
  readonly ttlMs: number;
}

interface LeaseRow {
  scope: string;
  holder_id: string;
  epoch: number;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
}

function toLease(row: LeaseRow): CollectorLease {
  return {
    scope: row.scope,
    holderId: row.holder_id,
    epoch: row.epoch,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

export function getLease(db: Db, scope: string): CollectorLease | null {
  const row = queryOne<LeaseRow>(db, "SELECT * FROM collector_leases WHERE scope = ?", [scope]);
  return row === undefined ? null : toLease(row);
}

/**
 * Claim or renew the lease.
 *
 * Returns `null` when another live holder owns the scope. An expired lease is
 * taken over with an incremented epoch, which fences the previous holder out.
 * Re-acquiring as the current holder keeps the same epoch (it is the same
 * writer resuming).
 */
export function acquireLease(db: Db, scope: string, holderId: string, ttlMs: number, now: number): LeaseHandle | null {
  return immediateTransaction(db, () => {
    const row = queryOne<LeaseRow>(db, "SELECT * FROM collector_leases WHERE scope = ?", [scope]);
    if (row === undefined) {
      execute(
        db,
        "INSERT INTO collector_leases (scope, holder_id, epoch, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [scope, holderId, 1, now, now, now + ttlMs],
      );
      return { scope, holderId, epoch: 1, ttlMs };
    }
    if (row.holder_id === holderId) {
      execute(
        db,
        "UPDATE collector_leases SET heartbeat_at = ?, expires_at = ? WHERE scope = ? AND holder_id = ? AND epoch = ?",
        [now, now + ttlMs, scope, holderId, row.epoch],
      );
      return { scope, holderId, epoch: row.epoch, ttlMs };
    }
    if (row.expires_at <= now) {
      const nextEpoch = row.epoch + 1;
      execute(
        db,
        "UPDATE collector_leases SET holder_id = ?, epoch = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE scope = ?",
        [holderId, nextEpoch, now, now, now + ttlMs, scope],
      );
      return { scope, holderId, epoch: nextEpoch, ttlMs };
    }
    return null;
  });
}

export function renewLease(db: Db, handle: LeaseHandle, now: number): boolean {
  const result = execute(
    db,
    "UPDATE collector_leases SET heartbeat_at = ?, expires_at = ? WHERE scope = ? AND holder_id = ? AND epoch = ?",
    [now, now + handle.ttlMs, handle.scope, handle.holderId, handle.epoch],
  );
  return result.changes === 1;
}

export function releaseLease(db: Db, handle: LeaseHandle): boolean {
  const result = execute(db, "DELETE FROM collector_leases WHERE scope = ? AND holder_id = ? AND epoch = ?", [
    handle.scope,
    handle.holderId,
    handle.epoch,
  ]);
  return result.changes === 1;
}

/**
 * Run `fn` inside a write transaction that is fenced by the lease.
 *
 * The lease is re-read after the transaction takes the write lock, so a
 * collector whose lease expired while it was preparing a write cannot commit.
 */
export function withFence<T>(db: Db, handle: LeaseHandle, now: number, fn: () => T): T {
  return immediateTransaction(db, () => {
    const row = queryOne<LeaseRow>(db, "SELECT * FROM collector_leases WHERE scope = ?", [handle.scope]);
    if (
      row === undefined ||
      row.holder_id !== handle.holderId ||
      row.epoch !== handle.epoch ||
      row.expires_at <= now
    ) {
      throw new LeaseLostError(handle.scope);
    }
    return fn();
  });
}

// --- checkpoints -----------------------------------------------------------

interface CheckpointRow {
  scope: string;
  stream: string;
  cursor: string | null;
  last_seen_at: number | null;
  updated_at: number;
  partial: number;
}

function toCheckpoint(row: CheckpointRow): CollectorCheckpoint {
  return {
    scope: row.scope,
    stream: row.stream,
    cursor: row.cursor,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    partial: toBool(row.partial),
  };
}

export function getCheckpoint(db: Db, scope: string, stream: string): CollectorCheckpoint | null {
  const row = queryOne<CheckpointRow>(
    db,
    "SELECT * FROM collector_checkpoints WHERE scope = ? AND stream = ?",
    [scope, stream],
  );
  return row === undefined ? null : toCheckpoint(row);
}

export function listCheckpoints(db: Db): CollectorCheckpoint[] {
  return queryAll<CheckpointRow>(
    db,
    "SELECT * FROM collector_checkpoints ORDER BY partial DESC, scope ASC, stream ASC",
  ).map(toCheckpoint);
}

/**
 * Record a resume position for a stream.
 *
 * `partial` marks a stream that was only partly paged. A partial checkpoint keeps
 * the cursor it still has to continue from, and must never be read as proof that
 * the stream was fully observed.
 */
export function setCheckpoint(
  db: Db,
  input: {
    scope: string;
    stream: string;
    cursor: string | null;
    lastSeenAt: number | null;
    updatedAt: number;
    partial?: boolean;
  },
): void {
  execute(
    db,
    `INSERT INTO collector_checkpoints (scope, stream, cursor, last_seen_at, updated_at, partial)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, stream) DO UPDATE SET
       cursor = excluded.cursor,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at,
       partial = excluded.partial`,
    [input.scope, input.stream, input.cursor, input.lastSeenAt, input.updatedAt, fromBool(input.partial === true)],
  );
}

// --- collector state -------------------------------------------------------

interface CollectorStateRow {
  scope: string;
  holder_id: string | null;
  epoch: number;
  last_cycle_at: number | null;
  last_cycle_ok: number | null;
  last_error: string | null;
  updated_at: number;
  last_success_at: number | null;
}

export interface CollectorState {
  readonly scope: string;
  readonly holderId: string | null;
  readonly epoch: number;
  /** The last cycle that ran, whether it succeeded or failed. */
  readonly lastCycleAt: number | null;
  readonly lastCycleOk: boolean | null;
  /**
   * The last cycle that actually succeeded. Coverage must be measured from here:
   * measuring from the last *attempt* would let a sustained outage keep resetting
   * the clock, so the outage would never be recorded as a gap.
   */
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

/**
 * Record the collector's durable state for a scope.
 *
 * `lastError` is the last failure's message, rendered at `/status`, so it is
 * redacted at the write boundary: an upstream error can quote a request URL, a
 * serialised body, or a config value. `null` stays `null` — an absent error is
 * not text — and every key (`scope`, `holder_id`, `epoch`) is untouched. Both the
 * insert and the `ON CONFLICT` update carry the redacted value.
 */
export function setCollectorState(
  db: Db,
  input: {
    scope: string;
    holderId: string | null;
    epoch: number;
    lastCycleAt: number | null;
    lastCycleOk: boolean | null;
    lastError: string | null;
    updatedAt: number;
    /**
     * Only set this on a successful cycle. Passing `undefined` preserves the
     * existing value, so a failure cannot erase the record of the last time
     * coverage was actually proven.
     */
    lastSuccessAt?: number | null;
  },
): void {
  execute(
    db,
    `INSERT INTO collector_state (scope, holder_id, epoch, last_cycle_at, last_cycle_ok, last_error, updated_at, last_success_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       holder_id = excluded.holder_id,
       epoch = excluded.epoch,
       last_cycle_at = excluded.last_cycle_at,
       last_cycle_ok = excluded.last_cycle_ok,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at,
       last_success_at = COALESCE(excluded.last_success_at, collector_state.last_success_at)`,
    [
      input.scope,
      input.holderId,
      input.epoch,
      input.lastCycleAt,
      input.lastCycleOk === null ? null : (input.lastCycleOk ? 1 : 0),
      input.lastError === null ? null : redactSerializedValue(input.lastError),
      input.updatedAt,
      input.lastSuccessAt ?? null,
    ],
  );
}

export function listCollectorStates(db: Db): CollectorState[] {
  return queryAll<CollectorStateRow>(db, "SELECT * FROM collector_state ORDER BY scope ASC").map((row) => ({
    scope: row.scope,
    holderId: row.holder_id,
    epoch: row.epoch,
    lastCycleAt: row.last_cycle_at,
    lastCycleOk: row.last_cycle_ok === null ? null : toBool(row.last_cycle_ok),
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }));
}

export function getCollectorState(db: Db, scope: string): CollectorState | null {
  return listCollectorStates(db).find((state) => state.scope === scope) ?? null;
}

// --- warnings --------------------------------------------------------------

export interface CollectorWarning {
  readonly id: string;
  readonly scope: string;
  readonly kind: string;
  readonly detail: string;
  readonly occurrences: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

interface WarningRow {
  id: string;
  scope: string;
  kind: string;
  detail: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
}

/**
 * Record a non-fatal collection problem (an unknown upstream message type, a
 * payload that failed validation). These are surfaced at `/status` instead of
 * being logged and forgotten, so a silent capability gap is visible.
 *
 * `detail` is stored redacted — it is diagnostic text from upstream and may quote
 * a credential. The row's **identity is still derived from the original detail**:
 * the warning is deduplicated by `(scope, kind, detail)`, so hashing the redacted
 * form would change which row an occurrence joins (and, worse, would make two
 * distinct problems that share a redacted body collide). Only the stored text is
 * sanitised; the id and the dedup semantics are untouched.
 */
export function recordWarning(db: Db, input: { scope: string; kind: string; detail: string }, now: number): void {
  const id = deterministicId("warn", [input.scope, input.kind, input.detail]);
  execute(
    db,
    `INSERT INTO collector_warnings (id, scope, kind, detail, occurrences, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       occurrences = collector_warnings.occurrences + 1,
       last_seen_at = excluded.last_seen_at`,
    [id, input.scope, input.kind, redactSerializedValue(input.detail), now, now],
  );
}

export function listWarnings(db: Db, limit: number): CollectorWarning[] {
  return queryAll<WarningRow>(
    db,
    "SELECT * FROM collector_warnings ORDER BY last_seen_at DESC, id ASC LIMIT ?",
    [limit],
  ).map((row) => ({
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    detail: row.detail,
    occurrences: row.occurrences,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export function countWarnings(db: Db): number {
  return queryOne<{ n: number }>(db, "SELECT COUNT(*) AS n FROM collector_warnings")?.n ?? 0;
}

// --- change log ------------------------------------------------------------

export interface ChangeRow {
  seq: number;
  kind: string;
  entity_id: string;
  scope: string;
  at: number;
}

export interface ChangeRecord {
  readonly seq: number;
  readonly kind: string;
  readonly entityId: string;
  readonly scope: string;
  readonly at: number;
}

function toChange(row: ChangeRow): ChangeRecord {
  return { seq: row.seq, kind: row.kind, entityId: row.entity_id, scope: row.scope, at: row.at };
}

/**
 * Append a durable change marker.
 *
 * The dashboard's live updates are driven by this table, not by the upstream
 * event stream: the browser only ever talks to this application, and a client
 * that disconnects and reconnects can resume from the last sequence number it
 * saw without replaying upstream traffic.
 */
export function appendChange(db: Db, input: { kind: string; entityId: string; scope: string }, now: number): number {
  const result = execute(db, "INSERT INTO change_log (kind, entity_id, scope, at) VALUES (?, ?, ?, ?)", [
    input.kind,
    input.entityId,
    input.scope,
    now,
  ]);
  return result.lastInsertRowid;
}

export function changesSince(db: Db, sinceSeq: number, limit: number): ChangeRecord[] {
  return queryAll<ChangeRow>(
    db,
    "SELECT * FROM change_log WHERE seq > ? ORDER BY seq ASC LIMIT ?",
    [sinceSeq, limit],
  ).map(toChange);
}

export function latestChangeSeq(db: Db): number {
  return queryOne<{ seq: number | null }>(db, "SELECT MAX(seq) AS seq FROM change_log")?.seq ?? 0;
}

export function pruneChangeLog(db: Db, keepAfter: number): number {
  return execute(db, "DELETE FROM change_log WHERE at < ?", [keepAfter]).changes;
}
