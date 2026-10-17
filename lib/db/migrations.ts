import { createHash } from "node:crypto";
import { WORKSPACE_SCHEMA } from "./workspace-schema.ts";
import { execute, immediateTransaction, queryAll, queryOne, type Db } from "./driver.ts";
import {
  reprocessLegacyRedaction,
  reprocessPersistedRedaction,
  reprocessPersistedRedactionV5,
  reprocessPersistedRedactionV6,
  reprocessPersistedRedactionV7,
  reprocessPersistedRedactionV8,
  reprocessPersistedRedactionV9,
  reprocessPersistedRedactionV10,
  reprocessPersistedRedactionV11,
  reprocessPersistedRedactionV12,
  reprocessPersistedRedactionV13,
  reprocessPersistedRedactionV14,
  reprocessPersistedRedactionV15,
  reprocessPersistedRedactionV16,
  reprocessPersistedRedactionV17,
  reprocessPersistedRedactionV18,
} from "./redaction-reprocess.ts";

/**
 * Ordered, checksum-verified migrations.
 *
 * Ownership rules:
 *
 * - Exactly one process applies a given migration. `runMigrations` takes a row
 *   lock (`BEGIN IMMEDIATE`) on `migration_lock` before reading the applied
 *   version, so a collector and a web server starting at the same time cannot
 *   both apply the same migration.
 * - Applied migrations are immutable. Each is checksummed; changing an applied
 *   migration's SQL is a hard error rather than a silent divergence.
 * - The web process calls `runMigrations` too, so a fresh deployment cannot
 *   serve reads against an empty schema. It is safe because of the lock.
 *
 * A migration that carries a JavaScript data step is identified by *both* its
 * statements and its {@link Migration.dataStepVersion}; see {@link checksumOf}.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
  /**
   * An optional JavaScript data step for a migration that SQL cannot express —
   * for example, re-running the redactor over text written by an earlier build.
   *
   * It runs inside the same `BEGIN IMMEDIATE` transaction as `statements`, after
   * them and before the migration row is recorded, so a failure rolls the whole
   * migration back and leaves the database on the previous version.
   */
  readonly reprocess?: (db: Db) => void;
  /**
   * Identifies the *behaviour* of {@link Migration.reprocess}, and is part of the
   * migration's checksum when present.
   *
   * A data step is code, not schema: its SQL is empty, so a checksum over
   * `statements` alone cannot tell two different behaviours apart. Without this
   * identifier, editing a data step would leave the checksum unchanged, an
   * already-applied database would silently keep running the *old* behaviour,
   * and the same recorded migration identity would mean two different things.
   *
   * The rule that follows from that: **a data step's behaviour may only change
   * by shipping a new migration version**. If the behaviour of an applied data
   * step has to change, add a new migration; do not edit the existing one. If a
   * *pending* data step must change, bump its `dataStepVersion` — the checksum
   * moves with it, so a database that somehow applied the previous behaviour is
   * rejected instead of silently diverging.
   *
   * Migrations 1–3 predate this field and are checksummed by the original,
   * statements-only formula, which is frozen: adding a version to them would
   * invalidate every database that has already applied them.
   */
  readonly dataStepVersion?: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS connections (
     id            TEXT PRIMARY KEY,
     label         TEXT NOT NULL,
     base_url      TEXT NOT NULL,
     mode          TEXT NOT NULL,
     created_at    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS locations (
     id            TEXT PRIMARY KEY,
     directory     TEXT NOT NULL,
     project_id    TEXT NOT NULL,
     canonical     TEXT NOT NULL,
     subpath       TEXT,
     source        TEXT NOT NULL,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS agents (
     location_id       TEXT NOT NULL,
     agent_id          TEXT NOT NULL,
     name              TEXT NOT NULL,
     mode              TEXT NOT NULL,
     hidden            INTEGER NOT NULL,
     description       TEXT,
     model_provider_id TEXT,
     model_id          TEXT,
     source            TEXT NOT NULL,
     first_seen_at     INTEGER NOT NULL,
     last_seen_at      INTEGER NOT NULL,
     PRIMARY KEY (location_id, agent_id)
   )`,

  `CREATE TABLE IF NOT EXISTS sessions (
     id                TEXT PRIMARY KEY,
     location_id       TEXT NOT NULL,
     project_id        TEXT NOT NULL,
     parent_id         TEXT,
     agent_id          TEXT,
     agent_first_seen  TEXT,
     model_provider_id TEXT,
     model_id          TEXT,
     title             TEXT,
     subpath           TEXT,
     upstream_outcome  TEXT,
     time_created      INTEGER NOT NULL,
     time_updated      INTEGER NOT NULL,
     time_idle         INTEGER,
     time_archived     INTEGER,
     source            TEXT NOT NULL,
     first_seen_at     INTEGER NOT NULL,
     last_seen_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions (parent_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_location_idx ON sessions (location_id, time_updated DESC)`,

  `CREATE TABLE IF NOT EXISTS root_runs (
     id               TEXT PRIMARY KEY,
     location_id      TEXT NOT NULL,
     root_session_id  TEXT NOT NULL,
     title            TEXT,
     started_at       INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL,
     status           TEXT NOT NULL,
     agent_id         TEXT,
     session_count    INTEGER NOT NULL,
     source           TEXT NOT NULL,
     first_seen_at    INTEGER NOT NULL,
     last_seen_at     INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS root_runs_recent_idx ON root_runs (last_activity_at DESC)`,

  `CREATE TABLE IF NOT EXISTS run_sessions (
     run_id     TEXT NOT NULL,
     session_id TEXT NOT NULL,
     depth      INTEGER NOT NULL,
     PRIMARY KEY (run_id, session_id)
   )`,
  `CREATE INDEX IF NOT EXISTS run_sessions_session_idx ON run_sessions (session_id)`,

  `CREATE TABLE IF NOT EXISTS invocations (
     id                  TEXT PRIMARY KEY,
     run_id              TEXT NOT NULL,
     session_id          TEXT NOT NULL,
     location_id         TEXT NOT NULL,
     agent_id            TEXT NOT NULL,
     model_provider_id   TEXT,
     model_id            TEXT,
     started_at          INTEGER NOT NULL,
     ended_at            INTEGER,
     trigger_message_id  TEXT,
     assistant_message_id TEXT NOT NULL,
     tool_call_count     INTEGER NOT NULL,
     upstream_outcome    TEXT,
     confidence          TEXT NOT NULL,
     evidence_json       TEXT NOT NULL,
     source              TEXT NOT NULL,
     first_seen_at       INTEGER NOT NULL,
     last_seen_at        INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS invocations_run_idx ON invocations (run_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS invocations_session_idx ON invocations (session_id, started_at)`,

  `CREATE TABLE IF NOT EXISTS activity_events (
     id                TEXT PRIMARY KEY,
     dedupe_key        TEXT NOT NULL UNIQUE,
     location_id       TEXT NOT NULL,
     session_id        TEXT NOT NULL,
     run_id            TEXT,
     kind              TEXT NOT NULL,
     message_id        TEXT NOT NULL,
     part_index        INTEGER NOT NULL,
     sequence          INTEGER NOT NULL,
     occurred_at       INTEGER NOT NULL,
     actor_agent_id    TEXT,
     tool_name         TEXT,
     tool_status       TEXT,
     summary           TEXT NOT NULL,
     content           TEXT,
     truncated         INTEGER NOT NULL,
     redacted          INTEGER NOT NULL,
     upstream_outcome  TEXT,
     source            TEXT NOT NULL,
     ingested_at       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS activity_recent_idx ON activity_events (occurred_at DESC, sequence DESC)`,
  `CREATE INDEX IF NOT EXISTS activity_session_idx ON activity_events (session_id, occurred_at, sequence)`,
  `CREATE INDEX IF NOT EXISTS activity_run_idx ON activity_events (run_id, occurred_at, sequence)`,

  // Reserved for the documented future tracker/progress boundary. Nothing in
  // this read-only observer writes to these tables.
  `CREATE TABLE IF NOT EXISTS progress_reports (
     id                TEXT PRIMARY KEY,
     run_id            TEXT NOT NULL,
     session_id        TEXT,
     reported_at       INTEGER NOT NULL,
     reported_percent  REAL,
     reported_stage    TEXT,
     text              TEXT NOT NULL,
     source            TEXT NOT NULL,
     ingested_at       INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS task_references (
     id              TEXT PRIMARY KEY,
     run_id          TEXT NOT NULL,
     external_system TEXT NOT NULL,
     external_id     TEXT NOT NULL,
     url             TEXT,
     ingested_at     INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS collection_gaps (
     id          TEXT PRIMARY KEY,
     scope       TEXT NOT NULL,
     stream      TEXT NOT NULL,
     started_at  INTEGER NOT NULL,
     ended_at    INTEGER,
     reason      TEXT NOT NULL,
     detected_at INTEGER NOT NULL,
     resumed     INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS collection_gaps_recent_idx ON collection_gaps (detected_at DESC)`,

  `CREATE TABLE IF NOT EXISTS collector_checkpoints (
     scope        TEXT NOT NULL,
     stream       TEXT NOT NULL,
     cursor       TEXT,
     last_seen_at INTEGER,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (scope, stream)
   )`,

  `CREATE TABLE IF NOT EXISTS collector_leases (
     scope        TEXT PRIMARY KEY,
     holder_id    TEXT NOT NULL,
     epoch        INTEGER NOT NULL,
     acquired_at  INTEGER NOT NULL,
     heartbeat_at INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS collector_state (
     scope         TEXT PRIMARY KEY,
     holder_id     TEXT,
     epoch         INTEGER NOT NULL,
     last_cycle_at INTEGER,
     last_cycle_ok INTEGER,
     last_error    TEXT,
     updated_at    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS collector_warnings (
     id            TEXT PRIMARY KEY,
     scope         TEXT NOT NULL,
     kind          TEXT NOT NULL,
     detail        TEXT NOT NULL,
     occurrences   INTEGER NOT NULL,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS collector_warnings_recent_idx ON collector_warnings (last_seen_at DESC)`,

  `CREATE TABLE IF NOT EXISTS change_log (
     seq       INTEGER PRIMARY KEY AUTOINCREMENT,
     kind      TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     scope     TEXT NOT NULL,
     at        INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS change_log_at_idx ON change_log (at DESC)`,

  `CREATE TABLE IF NOT EXISTS app_owner (
     id            INTEGER PRIMARY KEY CHECK (id = 1),
     password_hash TEXT NOT NULL,
     algo          TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS auth_sessions (
     id           TEXT PRIMARY KEY,
     token_hash   TEXT NOT NULL UNIQUE,
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     revoked_at   INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS auth_audit (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     INTEGER NOT NULL,
     kind   TEXT NOT NULL,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS auth_audit_at_idx ON auth_audit (at DESC)`,
] as const;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    statements: SCHEMA,
  },
  {
    version: 2,
    name: "collection-honesty-columns",
    statements: [
      // Tracks the last cycle that actually *succeeded*, separately from the last
      // attempt. Gap detection must measure coverage from the last success, or a
      // sustained outage would keep resetting the clock and never be recorded.
      `ALTER TABLE collector_state ADD COLUMN last_success_at INTEGER`,

      // A checkpoint is `partial` while a transcript was only partly paged. A
      // partial checkpoint must be visible, and must not be treated as proof that
      // the whole transcript was observed.
      `ALTER TABLE collector_checkpoints ADD COLUMN partial INTEGER NOT NULL DEFAULT 0`,

      // Whether an agent is currently reported by the API for its location.
      // Inactive agents are retained as history rather than deleted, so an agent
      // that disappears upstream stops being shown as currently effective without
      // its observed invocations losing their attribution.
      `ALTER TABLE agents ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,

      // The window start of an open (unresolved) coverage gap. Gaps used to be
      // written already-resumed; an open gap lets a gap stay open across failed
      // attempts and close only once a cycle genuinely succeeds.
      `ALTER TABLE collection_gaps ADD COLUMN open INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 3,
    name: "reprocess-camelcase-redaction",
    statements: [],
    // Schema-neutral: this migration only re-runs the redactor over text that an
    // earlier build persisted before it understood camelCase secret keys
    // (`accessToken`, `refreshToken`, `clientSecret`). Redaction is idempotent, so
    // it rewrites only rows that still contain a credential-shaped value and
    // leaves every other field untouched. No row or field is deleted.
    //
    // Frozen. This migration has shipped and an installed database skips it, so
    // its data step may never be extended: the field set it covered and the
    // redactor it used are preserved exactly in `reprocessLegacyRedaction`. Later
    // requirements are expressed as migration 4.
    reprocess: (db) => {
      reprocessLegacyRedaction(db);
    },
  },
  {
    version: 4,
    name: "reprocess-display-redaction",
    statements: [],
    // Schema-neutral: the second redaction remediation, for the fields migration
    // 3 did not cover and for the credential shapes the redactor now understands
    // (a compound key such as `secretAccessKey`, and a whole object or array
    // value under a credential key, nested and encoded forms included). It also
    // raises `activity_events.redacted` on every event whose stored display text
    // it rewrites, so the timeline badge matches what the row now shows.
    //
    // It needs no collection cycle: opening the database from either process
    // applies it, so a stopped collector still leaves the API-visible data clean.
    // No row and no field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedaction(db);
    },
  },
  {
    version: 5,
    name: "converge-redaction-and-flag-history",
    statements: [],
    // Schema-neutral: the third redaction remediation. It re-runs the display
    // repair over migration 4's column set with the corrected redactor — which
    // now redacts a parsed JSON fragment key-aware before the scalar rules can
    // corrupt it, so a mixed payload a previous pass left half-redacted is fully
    // repaired — and raises `activity_events.redacted` on historical rows that
    // already carry a placeholder, including rows migration 3 repaired before the
    // badge existed.
    //
    // Migration 4's step is deliberately left untouched: it shipped under its own
    // identity, and a behaviour change belongs in a new migration. This step is a
    // pure function of what is stored, so opening the database from either process
    // applies it and no collection cycle is needed. No row and no field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV5(db);
    },
  },
  {
    version: 6,
    name: "repair-escaped-redaction",
    statements: [],
    // Schema-neutral: the fourth redaction remediation. The redactor now reads a
    // double-encoded JSON document — the escaped form a serialised tool input takes
    // — and consumes a whole credential-key value, nested containers included, so
    // `{\"OPENAI_KEY\":\"…\"}` no longer survives. A database that applied
    // migration 5 before that fix still holds such a value, and migration 5 cannot
    // be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV6(db);
    },
  },
  {
    version: 7,
    name: "repair-escaped-siblings",
    statements: [],
    // Schema-neutral: the fifth redaction remediation. The escaped-document repair
    // now checks every ordinary string value as well as every credential-key value,
    // delimits a value whose content holds an escaped quote, and consumes a
    // primitive array under a credential key. A database that applied migration 6
    // before that was fixed still holds those values, and migration 6 cannot be
    // edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV7(db);
    },
  },
  {
    version: 8,
    name: "repair-nested-and-delimitation",
    statements: [],
    // Schema-neutral: the sixth redaction remediation. The escaped walker now
    // recurses into an encoded document nested inside an ordinary string value,
    // consumes a URL userinfo of any length, and validates a primitive's complete
    // syntax and boundary (and a container's bracket pairing) before accepting it.
    // A database that applied migration 7 before that was fixed still holds those
    // values, and migration 7 cannot be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV8(db);
    },
  },
  {
    version: 9,
    name: "repair-escaped-plaintext",
    statements: [],
    // Schema-neutral: the seventh redaction remediation. The escaped walker now
    // checks the plaintext around an escaped quoted phrase as well as the quoted
    // content itself, so a credential sitting beside a quoted phrase is removed, and
    // the credential-label classifier is a linear parser rather than a regular
    // expression with overlapping repetitions. A database that applied migration 8
    // before that was fixed still holds the first kind of value, and migration 8
    // cannot be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV9(db);
    },
  },
  {
    version: 10,
    name: "repair-escaped-assignments",
    statements: [],
    // Schema-neutral: the eighth redaction remediation. The escaped walker now runs
    // the whole escaped-level pipeline over an ordinary string's content — a
    // credential assignment is found and its value consumed whether it is an
    // escaped string, a container or a bare token — and the separator-delimited and
    // environment-style label classifiers are linear parsers rather than patterns
    // with overlapping repetitions. A database that applied migration 9 before that
    // was fixed still holds the first kind of value, and migration 9 cannot be
    // edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV10(db);
    },
  },
  {
    version: 11,
    name: "repair-assignment-grammar",
    statements: [],
    // Schema-neutral: the ninth redaction remediation. The escaped-level assignment
    // pass now recognises a quoted label with either separator, consumes a bare
    // value that contains brackets, requires a container value to be well formed
    // (pairing validated) and followed by a valid boundary, and advances past a
    // whole separator run instead of rescanning it. A database that applied
    // migration 10 before that was fixed still holds the first three kinds of value,
    // and migration 10 cannot be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV11(db);
    },
  },
  {
    version: 12,
    name: "repair-assignment-boundaries-and-escaped-keys",
    statements: [],
    // Schema-neutral: the tenth redaction remediation. The escaped walker now
    // requires a complete, reliable value boundary in every plain and escaped
    // string/container branch (a closing quote or bracket alone does not prove the
    // assignment ended, so `password=""opaque-live-value` and
    // `{\"password\":\"abc\"opaque-live-value}` fail closed instead of leaving the
    // continuation behind), classifies a key carrying an escape the decoder does
    // not handle (such as `\uXXXX`) as sensitive so
    // `{\"access\u0054oken\":\"…\"}` is removed, and descends into nested
    // nonsensitive containers in a single forward pass with a shared work budget and
    // an explicit depth, so a nested container is visited once rather than once per
    // enclosing level. A database that applied migration 11 before that was fixed
    // still holds the first two kinds of value, and migration 11 cannot be edited:
    // it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV12(db);
    },
  },
  {
    version: 13,
    name: "repair-container-strings-and-key-escapes",
    statements: [],
    // Schema-neutral: the eleventh redaction remediation. Five gaps are closed. A
    // container value's **ordinary quoted string** is now skipped like the escaped
    // form, so a brace inside it no longer closes the container early
    // (`password={"value":"},opaque-live-value"}`). The key before a structured
    // value is found by a **bounded backward walk** instead of an unanchored pattern
    // over the whole preceding text, so a long non-matching prefix before a valid
    // fragment is linear rather than quadratic. A key carrying an escape hidden one
    // layer deeper (`{"access\\u0054oken":"…"}`) is classified **conservatively
    // sensitive** at every decoding layer. A **bare assignment with a quoted
    // continuation** (`password=prefix"opaque-demo-suffix"`) fails closed instead of
    // stranding the quoted part. And the **private-key block** rule is a bounded
    // linear delimiter pass that fails closed on an incomplete block, rather than a
    // pattern whose label run was retried from every position. A database that
    // applied migration 12 before that was fixed still holds the first four kinds of
    // value, and migration 12 cannot be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV13(db);
    },
  },
  {
    version: 14,
    name: "repair-bounded-lookup-and-partial-redaction",
    statements: [],
    // Schema-neutral: the twelfth redaction remediation. Two gaps are closed. The
    // bounded preceding-key lookup is now **three-valued** — it reports
    // `unresolved` when the bound was reached before the absence of a key could be
    // proved — and the caller fails closed on that answer, so a long key or a long
    // whitespace run before a valid fragment no longer hides the credential key
    // (the lookup used to report "no key" and the value survived). And the
    // **partial redaction an older build left behind** is recognised and failed
    // closed: `password={"value":"},opaque-live-value"}` was stored as
    // `password=[redacted],opaque-live-value"}`, which the current redactor accepted
    // as a complete value followed by a valid `,`. A database that applied migration
    // 13 before that was fixed still holds both kinds of value, and migration 13
    // cannot be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV14(db);
    },
  },
  {
    version: 15,
    name: "repair-whitespace-artifact-and-json-siblings",
    statements: [],
    // Schema-neutral: the thirteenth redaction remediation. Two gaps in migration
    // 14's legacy-partial-artifact recovery are closed. Recovery now consumes the
    // **entire** leaked remainder — whitespace is not a reliable boundary, and the
    // leaked suffix may begin with or contain one, so
    // `password=[redacted],first opaque-secret-suffix` and
    // `password=[redacted], multi word suffix` no longer leave their tails behind.
    // And recovery only runs when the text is **not recoverable structured JSON**, so
    // a valid document that merely carries a bare placeholder value —
    // `{"password":[redacted],"region":"us-east-1"}` — keeps its siblings and
    // structure instead of having them deleted; the structural pass repairs the
    // placeholder. A database that applied migration 14 before that was fixed still
    // holds the whitespace-containing values and may have lost JSON siblings, and
    // migration 14 cannot be edited: it shipped under its own identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV15(db);
    },
  },
  {
    version: 16,
    name: "linear-artifact-recovery",
    statements: [],
    // Schema-neutral: the fourteenth redaction remediation. Migration 15's legacy
    // artifact recovery found the next marker with two `indexOf` calls per iteration,
    // so a text holding many markers — `"[redacted] ".repeat(N)` — re-scanned the
    // remaining suffix every time a marker turned out not to be an artifact: 352 000
    // characters took most of a second, and a 16 MiB field could stall a collector.
    // Its work was also omitted from the shared scan budget. Recovery is now a single
    // forward pass with a monotonic cursor whose work is charged to the shared
    // allowance, which fails closed when exhausted. The stored shapes are recovered
    // identically — the same artifacts are failed closed and the same JSON siblings
    // preserved — so this step exists to bring a version-15 database onto the current
    // code and to repair any row a version-15 build left unconverted.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV16(db);
    },
  },
  {
    version: 17,
    name: "protect-embedded-json-and-charge-recovery",
    statements: [],
    // Schema-neutral: the fifteenth redaction remediation. Version 16 ran the
    // legacy-tail recovery whenever the whole stored value failed to parse, so
    // recoverable JSON embedded in prose was consumed:
    // `config {"password":[redacted],"region":"us-east-1"}` lost `region` and
    // everything after it. Recovery now skips a recoverable JSON container — the
    // structural pass repairs its bare markers and preserves its siblings and the
    // surrounding text — while a genuine malformed artifact is still failed closed.
    // Version 16 also charged the recovery's scan only when it changed the text, so an
    // unchanged marker-heavy value got a fresh structural budget; the work is now
    // always charged and the combined total fails closed when it exceeds the
    // allowance. A database that applied version 16 before that was fixed still holds
    // the truncated values, and version 16 cannot be edited: it shipped under its own
    // identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV17(db);
    },
  },
  {
    version: 18,
    name: "examine-the-whole-credential-key",
    statements: [],
    // Schema-neutral: the sixteenth redaction remediation. The assignment lookup kept
    // only the **last** 64 characters of a key run, so a long credential key whose
    // sensitive prefix was earlier was read as a non-credential suffix:
    // `password.` + `z`.repeat(64) + `="prefix[42]suffix"` was never consumed as an
    // assignment, and its quoted value was split around the `[42]` inside it, so the
    // credential survived. The lookup now examines the key whole — the bound is
    // generous enough for a realistic compound label — and a run that reaches the
    // bound and may continue fails closed rather than being classified from a
    // truncated suffix. A database that applied version 17 before that was fixed still
    // holds those values, and version 17 cannot be edited: it shipped under its own
    // identity.
    //
    // This step re-runs the same display-column repair with the corrected redactor,
    // so an already-migrated database converges. No collection cycle is needed and
    // no row or field is deleted.
    dataStepVersion: 1,
    reprocess: (db) => {
      reprocessPersistedRedactionV18(db);
    },
  },
  { version: 19, name: "observation-workspace-and-question-boundary", statements: WORKSPACE_SCHEMA },
];

/**
 * Checksum a migration's recorded identity.
 *
 * Migrations 1–3 predate data-step versioning and are checksummed by the
 * original statements-only formula. That formula is frozen: it is what every
 * already-applied database recorded, so changing it would invalidate all of them.
 *
 * From migration 4 on, a migration that declares {@link Migration.dataStepVersion}
 * has that identifier folded into its checksum. A data step's SQL is empty, so
 * without this the checksum would be blind to behaviour: editing the step would
 * leave the identity unchanged and an applied database would silently keep the
 * old behaviour. With it, any change to the declared data-step behaviour must
 * move the checksum, and a mismatch is a hard error rather than a silent
 * divergence.
 */
export function checksumOf(migration: Migration): string {
  const statements = migration.statements.join(";\n");
  if (migration.dataStepVersion === undefined) {
    return createHash("sha256").update(statements).digest("hex");
  }
  return createHash("sha256")
    .update(`${statements}\ndata-step-version:${migration.dataStepVersion}`)
    .digest("hex");
}

/** The first migration version that identifies its data step by version. */
const FIRST_DATA_STEP_VERSION = 4;

/**
 * Refuse to run a build whose versioned data step has no identity.
 *
 * A data step added from {@link FIRST_DATA_STEP_VERSION} on must declare a
 * `dataStepVersion`, because that identifier is the only thing tying the step's
 * behaviour to the migration's checksum. A step without one would be an
 * unidentifiable behaviour: editing it would leave the recorded identity
 * unchanged and an applied database would silently keep running the old code.
 *
 * Migrations 1–3 predate the rule and are exempt; their behaviour is frozen and
 * their checksums are the legacy statements-only formula.
 */
export function assertDataStepsIdentified(migrations: readonly Migration[] = MIGRATIONS): void {
  for (const migration of migrations) {
    if (migration.version < FIRST_DATA_STEP_VERSION) continue;
    if (migration.reprocess !== undefined && migration.dataStepVersion === undefined) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) declares a data step without a dataStepVersion. ` +
          "A data step's behaviour is part of the migration's identity; declare a dataStepVersion so a change to it moves the checksum.",
      );
    }
  }
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function ensureMigrationTables(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT NOT NULL,
             checksum   TEXT NOT NULL,
             applied_at INTEGER NOT NULL
           )`);
  db.exec(`CREATE TABLE IF NOT EXISTS migration_lock (
             id        INTEGER PRIMARY KEY CHECK (id = 1),
             locked_at INTEGER NOT NULL,
             locked_by TEXT NOT NULL
           )`);
}

export interface MigrationResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
}

/**
 * Apply every pending migration. Idempotent and safe to call from either
 * process: the whole check-and-apply runs inside one `BEGIN IMMEDIATE`
 * transaction, so concurrent callers serialise.
 */
export function runMigrations(db: Db, appliedBy = "unknown"): MigrationResult {
  assertDataStepsIdentified();
  ensureMigrationTables(db);
  return immediateTransaction(db, () => {
    const appliedRows = queryAll<AppliedRow>(db, "SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));

    for (const row of appliedRows) {
      const known = MIGRATIONS.find((m) => m.version === row.version);
      if (known === undefined) {
        throw new Error(
          `Database has migration ${row.version} (${row.name}) which this build does not know about. ` +
            "Refusing to run against a newer schema.",
        );
      }
      if (checksumOf(known) !== row.checksum) {
        throw new Error(
          `Migration ${row.version} (${row.name}) has been modified after being applied ` +
            `(stored checksum ${row.checksum}, computed ${checksumOf(known)}). Migrations are immutable.`,
        );
      }
    }

    const applied: number[] = [];
    const alreadyApplied: number[] = [];
    const now = Date.now();

    for (const migration of MIGRATIONS) {
      if (appliedByVersion.has(migration.version)) {
        alreadyApplied.push(migration.version);
        continue;
      }
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      // A data step runs inside the same transaction as the statements, so a
      // failure leaves the migration unrecorded and the database unchanged.
      migration.reprocess?.(db);
      execute(
        db,
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        [migration.version, migration.name, checksumOf(migration), now],
      );
      applied.push(migration.version);
    }

    if (applied.length > 0) {
      execute(db, "INSERT INTO migration_lock (id, locked_at, locked_by) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET locked_at = excluded.locked_at, locked_by = excluded.locked_by", [
        now,
        appliedBy,
      ]);
    }
    return { applied, alreadyApplied };
  });
}

export function currentSchemaVersion(db: Db): number {
  ensureMigrationTables(db);
  const row = queryOne<{ version: number | null }>(db, "SELECT MAX(version) AS version FROM schema_migrations");
  return row?.version ?? 0;
}

export function expectedSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Test/debug helper: describe the applied migration set. */
export function appliedMigrations(db: Db): AppliedRow[] {
  ensureMigrationTables(db);
  return queryAll<AppliedRow>(db, "SELECT version, name, checksum FROM schema_migrations ORDER BY version");
}
