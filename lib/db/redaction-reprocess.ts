import { execute, queryAll, type Db, type SqlValue } from "./driver.ts";
import {
  containsRedactionPlaceholder,
  redactSerializedValue,
  redactStructuredLeaves,
  redactText,
} from "../util/redact.ts";

/**
 * Remediation of text persisted by an earlier build.
 *
 * Redaction is idempotent, so re-running it over stored text is safe: a value
 * that is already `[redacted]` is left untouched, and a credential that an
 * earlier redactor missed is replaced in place. This never deletes a row and
 * never removes a field: it only rewrites a field whose stored value still
 * contains something credential-shaped, so user history is preserved rather than
 * silently discarded.
 *
 * It exists because a persisted credential cannot be un-persisted by fixing the
 * redactor alone. The rules that catch camelCase keys (`accessToken`,
 * `refreshToken`, `clientSecret`), compound keys (`secretAccessKey`,
 * `SecretKey`), and a whole object or array value under a credential key are
 * newer than the rows they have to repair, so a database written by an earlier
 * build may still hold a live value in a table the dashboard renders.
 *
 * **Two frozen data steps, two identities.** Migration 3 already shipped and an
 * installed database skips it, so its data step can never be relied on again: it
 * is preserved here as {@link reprocessLegacyRedaction}, over exactly the column
 * set it always touched and through the same free-text entry point. Every later
 * requirement — new fields, new credential shapes, the activity badge — is
 * expressed as a *new* migration with its own data-step version (see
 * {@link reprocessPersistedRedaction}), because a migration is identified by its
 * version and checksum and must never silently change what it does.
 */

/** One stored text column that is display-only and may carry credential-shaped text. */
interface DisplayColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * The columns migration 3 has always reprocessed.
 *
 * Frozen. Migration 3 is identified by a checksum that covers only its
 * statements (it predates data-step versioning), so changing this list would
 * silently change what an applied migration does — and an installed database
 * would never run it again anyway. New columns belong in {@link V4_COLUMNS}.
 */
const V3_COLUMNS: readonly DisplayColumn[] = [
  { table: "activity_events", column: "summary" },
  { table: "activity_events", column: "content" },
  { table: "sessions", column: "title" },
  { table: "sessions", column: "subpath" },
  { table: "sessions", column: "model_provider_id" },
  { table: "sessions", column: "model_id" },
  { table: "agents", column: "name" },
  { table: "agents", column: "description" },
  { table: "agents", column: "model_provider_id" },
  { table: "agents", column: "model_id" },
];

/**
 * Every retained display field that could carry secret text.
 *
 * A superset of {@link V3_COLUMNS}: migration 4 must repair the columns
 * migration 3 covered as well, because a database that already applied
 * migration 3 skips it and would otherwise never have those columns revisited
 * with the newer rules. Migration 5 re-runs the repair over this same set, so it
 * is the canonical "display column" list rather than a v4-only one.
 *
 * The list is every stored column that is *display text* — free text taken from
 * upstream and returned to the browser — and is not an identity or join key.
 * `activity_events` is handled separately, per row, so its `redacted` badge can
 * be raised alongside the text it describes:
 *
 * - `activity_events.tool_name` and `actor_agent_id` are redacted on write;
 * - `root_runs.title` is inherited from the redacted `sessions.title`;
 * - `invocations.model_provider_id` / `model_id` are redacted on write;
 * - `locations.canonical` and the diagnostic text (`collection_gaps.reason`,
 *   `collector_warnings.detail`, `collector_state.last_error`) are DTO-visible
 *   free text.
 *
 * Deliberately excluded, because rewriting them would break a relationship
 * rather than repair a leak:
 *
 * - `locations.directory` is the *input* to `locationIdFor`, so
 *   `locations.id` and every `sessions.location_id` are derived from it;
 *   redacting it would leave the stored id inconsistent with its own directory.
 * - `locations.project_id` and every `*_id` column are compared for equality and
 *   joined across tables.
 * - `collector_checkpoints.stream`/`cursor`, `collector_leases.*`,
 *   `collector_warnings.scope`/`kind` and `collection_gaps.scope`/`stream` are
 *   keys, not text.
 */
const V4_COLUMNS: readonly DisplayColumn[] = [
  // `activity_events` is handled per row instead, so the `redacted` badge can be
  // raised in the same statement as the text it describes.
  { table: "sessions", column: "title" },
  { table: "sessions", column: "subpath" },
  { table: "sessions", column: "model_provider_id" },
  { table: "sessions", column: "model_id" },
  { table: "agents", column: "name" },
  { table: "agents", column: "description" },
  { table: "agents", column: "model_provider_id" },
  { table: "agents", column: "model_id" },
  { table: "root_runs", column: "title" },
  { table: "invocations", column: "model_provider_id" },
  { table: "invocations", column: "model_id" },
  { table: "locations", column: "canonical" },
  { table: "collection_gaps", column: "reason" },
  { table: "collector_warnings", column: "detail" },
  { table: "collector_state", column: "last_error" },
];

/**
 * Re-redact one text column of one table, keyed by `rowid`.
 *
 * `rowid` rather than a logical key, because the tables touched here have
 * different primary keys (and `agents` has a composite one).
 */
function reprocessColumn(db: Db, table: string, column: string, redact: (value: string) => string): number {
  const rows = queryAll<{ rid: number; value: string | null }>(
    db,
    `SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`,
  );
  let changed = 0;
  for (const row of rows) {
    if (typeof row.value !== "string") continue;
    const next = redact(row.value);
    if (next !== row.value) {
      execute(db, `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [next, row.rid]);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Re-redact the stored evidence blob.
 *
 * The evidence is a serialised object, so it is parsed and re-serialised rather
 * than run through the free-text redactor: redacting the serialised form would
 * leave a bare `[redacted]` where a JSON value belonged. A row that does not
 * parse is left exactly as it is — it cannot be repaired, and rewriting it would
 * risk destroying evidence.
 */
function reprocessEvidence(db: Db): number {
  const rows = queryAll<{ rid: number; evidence_json: string }>(
    db,
    "SELECT rowid AS rid, evidence_json FROM invocations",
  );
  let changed = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.evidence_json);
    } catch {
      continue;
    }
    const next = JSON.stringify(redactStructuredLeaves(parsed));
    if (next !== row.evidence_json) {
      execute(db, "UPDATE invocations SET evidence_json = ? WHERE rowid = ?", [next, row.rid]);
      changed += 1;
    }
  }
  return changed;
}

/** The activity columns whose redaction is reflected by the `redacted` badge. */
const ACTIVITY_DISPLAY_COLUMNS = ["summary", "content", "tool_name", "actor_agent_id"] as const;

interface ActivityDisplayRow {
  rid: number;
  summary: string;
  content: string | null;
  tool_name: string | null;
  actor_agent_id: string | null;
  redacted: number;
}

/**
 * Re-redact the display text of every activity event, and flag the row.
 *
 * The `redacted` column is the badge the timeline shows next to an event whose
 * displayed text was altered. Redacting a stored field in a migration changes
 * what the event displays, so the badge has to follow — otherwise the UI would
 * present a redacted summary as if it were the verbatim upstream text.
 *
 * The flag is only ever raised, never cleared: a `1` stays `1` because the
 * redaction that justified it has already happened and cannot be undone by a
 * later pass. An event whose display text changed in *any* of the tracked
 * columns is flagged, so `tool_name` and `actor_agent_id` count as well as
 * `summary` and `content`.
 */
function reprocessActivityEvents(db: Db): number {
  const rows = queryAll<ActivityDisplayRow>(
    db,
    "SELECT rowid AS rid, summary, content, tool_name, actor_agent_id, redacted FROM activity_events",
  );
  let changed = 0;
  for (const row of rows) {
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const column of ACTIVITY_DISPLAY_COLUMNS) {
      const value = row[column];
      if (typeof value !== "string") continue;
      const next = redactSerializedValue(value);
      if (next !== value) {
        assignments.push(`${column} = ?`);
        params.push(next);
      }
    }
    if (assignments.length === 0) continue;
    if (row.redacted === 0) assignments.push("redacted = 1");
    execute(db, `UPDATE activity_events SET ${assignments.join(", ")} WHERE rowid = ?`, [...params, row.rid]);
    changed += 1;
  }
  return changed;
}

/**
 * Migration 3's data step: the camelCase-era remediation, unchanged.
 *
 * Kept as a separate, frozen function so that extending the redactor never
 * changes what migration 3 does. Only the column set it always covered is
 * touched, and only with the free-text redactor it always used.
 */
export function reprocessLegacyRedaction(db: Db): number {
  let changed = 0;
  for (const { table, column } of V3_COLUMNS) {
    changed += reprocessColumn(db, table, column, (value) => redactText(value).text);
  }
  changed += reprocessEvidence(db);
  return changed;
}

/**
 * Migration 4's data step: every retained display field, plus the activity flag.
 *
 * Unlike the legacy step this one treats each stored value as possibly
 * serialised JSON — a value that parses is redacted key-aware (a whole object or
 * array under a credential key is replaced, nested wrappers and encoded payloads
 * included), and anything that does not parse falls back to the text rules.
 *
 * It runs inside the migration transaction and needs no collection cycle, so a
 * database whose collector is stopped is still sanitised the moment the web
 * process (or the collector) opens it. Identity and join keys are never touched.
 */
export function reprocessPersistedRedaction(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  // Activity is handled per row rather than per column so the `redacted` badge is
  // raised in the same statement as the text it describes.
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  return changed;
}

/**
 * Raise the `redacted` badge on activity rows that already carry a placeholder.
 *
 * Migration 3 rewrote `activity_events` display text with the older redactor, but
 * it predates the badge entirely: a row it repaired kept `redacted = 0`. Migration
 * 4 raises the badge only when *its own* pass changes text, and by the time it ran
 * the text was already redacted, so those historical rows stayed unflagged and the
 * timeline presented sanitised text as if it were verbatim.
 *
 * This closes that gap directly: any row whose tracked display text already
 * contains the marker is flagged, whether the redaction happened in migration 3,
 * migration 4, or this pass. It is a repair of the *record*, not of the text — no
 * text is rewritten here.
 *
 * The flag is only ever raised, never cleared: rows already at `1` are not even
 * read, because the redaction that justified the flag cannot be undone.
 *
 * **Conservative by design.** The marker is a literal string, so a message in
 * which a user genuinely typed `[redacted]` is flagged even though nothing was
 * removed. That false positive is the safe direction: the badge says "this text
 * may not be the verbatim upstream record", and over-reporting that is honest,
 * while under-reporting would present altered text as complete.
 */
function flagHistoricallyRedactedActivity(db: Db): number {
  const rows = queryAll<ActivityDisplayRow>(
    db,
    "SELECT rowid AS rid, summary, content, tool_name, actor_agent_id, redacted FROM activity_events WHERE redacted = 0",
  );
  let changed = 0;
  for (const row of rows) {
    const carriesPlaceholder = ACTIVITY_DISPLAY_COLUMNS.some((column) => {
      const value = row[column];
      return typeof value === "string" && containsRedactionPlaceholder(value);
    });
    if (!carriesPlaceholder) continue;
    execute(db, "UPDATE activity_events SET redacted = 1 WHERE rowid = ?", [row.rid]);
    changed += 1;
  }
  return changed;
}

/**
 * Migration 5's data step: converge stored data on the corrected redaction
 * policy, and make the historical badge honest.
 *
 * Two things, in order:
 *
 * 1. Re-run the display-column repair over exactly the column set migration 4
 *    covered, with the current redactor. The redactor now redacts a parsed JSON
 *    fragment key-aware *before* the scalar rules can rewrite it into invalid
 *    JSON, so a mixed payload a previous pass left half-redacted (one key removed,
 *    a sibling key surviving because the JSON no longer parsed) is now fully
 *    repaired. Re-running the pass is what converges an already-migrated database
 *    onto the corrected policy — the earlier migrations are immutable and are not
 *    edited, and this step is a pure function of what is stored, so it needs no
 *    collection cycle.
 * 2. Raise the `redacted` badge on historical activity rows that already carry a
 *    placeholder (see {@link flagHistoricallyRedactedActivity}), which is what
 *    flags the rows migration 3 repaired before the badge existed.
 *
 * No row and no field is deleted.
 */
export function reprocessPersistedRedactionV5(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 6's data step: repair text the escaped-content gap left behind.
 *
 * Migration 5 converged stored data on the redactor as it stood then. That
 * redactor could not read a *double-encoded* JSON document — the form a tool
 * input takes after it has been `JSON.stringify`ed — so a credential written as
 * `{\"OPENAI_KEY\":\"…\"}` survived, both because the escaped scalar rules knew
 * only the two narrow key shapes and because the scanner could not parse an
 * escaped object at all. The redactor now recognises those documents and consumes
 * a whole credential-key value, nested containers included.
 *
 * A database that applied migration 5 *before* that fix therefore still holds the
 * secret, and migration 5 cannot be edited: it shipped under its own identity, and
 * changing what an applied migration does is exactly what the versioned data-step
 * rule forbids. This migration is the repair, in the same shape as 5 — the display
 * columns, the activity badge, the evidence blob — re-run with the corrected
 * redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database that was written by a
 * fixed build is a no-op: redaction is idempotent, and the badge flag is only ever
 * raised.
 */
export function reprocessPersistedRedactionV6(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 7's data step: repair text the incomplete escaped walker left behind.
 *
 * Migration 6 introduced the escaped-document repair, but that first pass had
 * three gaps, all of which let a credential survive in stored text:
 *
 * - it redacted only values under a credential *key*, so a provider token or
 *   `Authorization` header sitting in an ordinary sibling field was never checked;
 * - it read `\"` as a string delimiter unconditionally, so a value containing an
 *   escaped quote (`\"first\\\"opaque-suffix\"`) terminated early and its tail
 *   survived;
 * - it required an escaped quote inside a container, so a primitive array such as
 *   `[17,23,42,91]` under a credential key was left whole.
 *
 * A database that applied migration 6 before that was fixed therefore still holds
 * those values, and migration 6 cannot be edited: it shipped under its own
 * identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5 and
 * 6 — the display columns, the activity badge, the evidence blob — re-run with the
 * corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build
 * is a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV7(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 8's data step: repair text the escaped walker still left behind.
 *
 * Migration 7 completed the escaped-document repair for values under a credential
 * key, escaped-quote content and primitive arrays. Four gaps remained, each of
 * which let a credential survive in stored text:
 *
 * - a nested encoded document inside an *ordinary* string value was checked only
 *   by the scalar rules, which cannot see the nested `\\\"` delimiters, so a
 *   credential inside it survived;
 * - the userinfo pattern capped the credential at 256 characters, so a longer one
 *   matched nothing and was left verbatim;
 * - a malformed primitive (`{\\"password\\":123opaque-secret}`) was consumed only up
 *   to its first non-numeric character, leaving the tail with no key in front of it;
 * - a mismatched container (`[1,2}`) was treated as a complete value.
 *
 * A database that applied migration 7 before that was fixed therefore still holds
 * those values, and migration 7 cannot be edited: it shipped under its own
 * identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5, 6
 * and 7 — the display columns, the activity badge, the evidence blob — re-run with
 * the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV8(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 9's data step: repair text the escaped walker still left behind.
 *
 * Migration 8 completed the escaped-document repair for nested documents,
 * over-long userinfo and malformed primitives. Two gaps remained:
 *
 * - a content that contained an escaped quote was taken to be fully inspected, so
 *   the **plaintext** around the quoted phrase — `say \"hi\" ghp_…`,
 *   `password=… and \"quoted\"` — was never checked by the scalar rules and the
 *   credential survived;
 * - the camelCase credential-key classifier was a regular expression whose
 *   repetitions overlapped, so a near-miss label could make it quadratic. That is a
 *   availability defect rather than a leak, but it is the same classifier the
 *   repair runs, so a stored value shaped like one could stall the migration.
 *
 * A database that applied migration 8 before that was fixed therefore still holds
 * the first kind of value, and migration 8 cannot be edited: it shipped under its
 * own identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5
 * through 8 — the display columns, the activity badge, the evidence blob — re-run
 * with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV9(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 10's data step: repair text the escaped walker still left behind.
 *
 * Migration 9 completed the escaped walker for documents, containers and the
 * plaintext beside an escaped quoted phrase. Two gaps remained:
 *
 * - the content of an ordinary escaped string was checked only by the scalar
 *   rules, so a credential *assignment* inside it with a container value
 *   (`password=[17,23,42,91]`) or an escaped-string value
 *   (`password=\"opaque\"`) survived — the scalar rules understand neither; and
 * - the separator-delimited and environment-style credential-label classifiers
 *   were regular expressions whose repetitions overlapped, so a repeated label
 *   could make them quadratic. That is an availability defect rather than a leak,
 *   but it is the same classifier the repair runs.
 *
 * A database that applied migration 9 before that was fixed therefore still holds
 * the first kind of value, and migration 9 cannot be edited: it shipped under its
 * own identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5
 * through 9 — the display columns, the activity badge, the evidence blob — re-run
 * with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV10(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 11's data step: repair text the escaped walker still left behind.
 *
 * Migration 10 completed the escaped-level assignment pass. Four gaps remained:
 *
 * - the assignment grammar at a decoded depth was incomplete: a quoted label
 *   (`'password': [1,2]`) was not recognised at all, and a bare value stopped at a
 *   bracket (`password=correct[42]horse` kept `[42]horse`), so both survived;
 * - a container value was consumed without checking what followed it, so
 *   `password=[1,2]opaque-suffix` left the suffix with no key in front of it;
 * - a mismatched closer (`password=[1,2}`) was accepted as a complete value;
 * - a separator-only run was rescanned one character at a time, which is
 *   quadratic — twenty seconds for 40 000 characters — and a nested container was
 *   marked inspected before its descendants were, hiding an uninspected bare token
 *   from the scalar complement pass.
 *
 * A database that applied migration 10 before that was fixed therefore still holds
 * the first three kinds of value, and migration 10 cannot be edited: it shipped
 * under its own identity, and changing what an applied migration does is what the
 * versioned data-step rule forbids. This migration is the repair, in the same shape
 * as 5 through 10 — the display columns, the activity badge, the evidence blob —
 * re-run with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV11(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 12's data step: repair text the escaped walker still left behind.
 *
 * Migration 11 completed the escaped-level assignment grammar. Three gaps
 * remained, each of which let a credential survive in stored text:
 *
 * - **an incomplete value boundary.** A closing quote or bracket was accepted as
 *   proof that the assignment had ended, so `password=""opaque-live-value` and
 *   `{\"password\":\"abc\"opaque-live-value}` redacted the delimited part and left
 *   the continuation behind with no key in front of it. A value is now accepted
 *   only when a real follower (whitespace, a comma, a closing bracket or brace, or
 *   the end of the text) terminates it; an ambiguous continuation fails closed.
 * - **an unhandled escape in a credential key.** `{\"access\u0054oken\":\"…\"}` is
 *   the escaped spelling of `accessToken`, but the key decoder handles only `\"`
 *   and `\\`, so the key was not recognised and its value survived. A key carrying
 *   an escape the decoder does not handle is now classified sensitive — the value
 *   is removed whole and the raw key spelling is left untouched.
 * - **a repeated scan of nested nonsensitive containers.** A nonsensitive container
 *   value was fully scanned up front and then rescanned on the way down, once per
 *   enclosing level, and that lookahead was charged to neither the work budget nor
 *   the depth. The descent is now a single forward pass with a matching stack, so
 *   each container is visited once, every operation is charged, and the depth is
 *   bounded.
 *
 * A database that applied migration 11 before those were fixed therefore still
 * holds the first two kinds of value, and migration 11 cannot be edited: it
 * shipped under its own identity, and changing what an applied migration does is
 * what the versioned data-step rule forbids. This migration is the repair, in the
 * same shape as 5 through 11 — the display columns, the activity badge, the
 * evidence blob — re-run with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build
 * is a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV12(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 13's data step: repair text the escaped walker still left behind.
 *
 * Migration 12 closed the assignment-boundary and escaped-key gaps. Five more
 * remained, each of which let a credential survive in stored text:
 *
 * - **a container value's quoted string.** The container scanner skipped an
 *   escaped string (`\"…\"`) but not an ordinary quoted one, so a brace *inside* a
 *   plain JSON string closed the container early:
 *   `password={"value":"},opaque-live-value"}` ended the value at the brace and
 *   stranded `,opaque-live-value"`.
 * - **an unbudgeted, quadratic preceding-key lookup.** The key before a structured
 *   value was found with an unanchored pattern over the whole preceding text, so a
 *   long non-matching prefix before a valid fragment cost O(n²) — a
 *   100 000-character prefix took hundreds of milliseconds.
 * - **an escape hidden one layer deeper in a key.** `{"access\\u0054oken":"…"}` is
 *   the escaped spelling of `accessToken`; the decoder handled the outer `\\` and
 *   exposed an unresolved `\u0054` one layer later, so the key was not recognised.
 * - **a bare assignment with a quoted continuation.**
 *   `password=prefix"opaque-demo-suffix"` redacted `prefix` and left the quoted
 *   part with no key in front of it.
 * - **a quadratic private-key block rule.** The `-----BEGIN …-----END …` pattern
 *   retried its label run from every start position, so a repeated near-miss with
 *   no `END` cost O(n²) — 880 000 characters took over three seconds.
 *
 * A database that applied migration 12 before those were fixed therefore still
 * holds those values, and migration 12 cannot be edited: it shipped under its own
 * identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5
 * through 12 — the display columns, the activity badge, the evidence blob — re-run
 * with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build
 * is a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV13(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 14's data step: repair text the bounded lookup and the partial
 * redaction left behind.
 *
 * Two gaps remained after migration 13:
 *
 * - **the bounded preceding-key lookup failed open.** When the backward walk
 *   reached its bound while a key or whitespace run may still have continued, it
 *   reported "no key" instead of "cannot tell", so a long key or a long whitespace
 *   run before a valid fragment hid the credential key and the value survived —
 *   `"password." + "a".repeat(64) + "=" + " ".repeat(257) + '{"value":"…"}'`. The
 *   lookup is now three-valued and the caller fails closed on "cannot tell".
 * - **the partial redaction an older build wrote was not repaired.** That build
 *   redacted a credential container by stopping at a brace inside its quoted
 *   string, so `password={"value":"},opaque-live-value"}` was stored as
 *   `password=[redacted],opaque-live-value"}`. Re-running the current redactor over
 *   that text did **not** repair it: `[redacted]` looked like a complete value
 *   followed by a valid `,`, so the tail stayed. The artifact is now recognised and
 *   failed closed.
 *
 * A database that applied migration 13 before those were fixed therefore still
 * holds those values, and migration 13 cannot be edited: it shipped under its own
 * identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5
 * through 13 — the display columns, the activity badge, the evidence blob — re-run
 * with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build
 * is a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV14(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 15's data step: repair what migration 14's artifact recovery missed.
 *
 * Migration 14 recognised the legacy partial redaction
 * (`password=[redacted],<leaked tail>`) but recovered it two ways that were both
 * wrong:
 *
 * - **it stopped at the first whitespace**, and skipped entirely when the comma was
 *   followed by a space. The leaked text is the remainder of a container the old
 *   build stopped short of, so it can contain spaces — `password=[redacted],first
 *   opaque-secret-suffix` kept `opaque-secret-suffix`, and
 *   `password=[redacted], multi word suffix` was not recovered at all.
 * - **it ran before the structured parse**, so a *valid* JSON document that merely
 *   carried a bare placeholder as a redacted value —
 *   `{"password":[redacted],"region":"us-east-1"}` — was mistaken for a damaged
 *   assignment and had its siblings and structure deleted.
 *
 * Recovery now consumes the **entire** leaked remainder (there is no trustworthy
 * delimiter inside it) and only runs when the text is **not** recoverable
 * structured JSON, so a legitimate sibling is preserved by the structural pass
 * instead.
 *
 * A database that applied migration 14 before those were fixed therefore still
 * holds the whitespace-containing values, and migration 14 cannot be edited: it
 * shipped under its own identity, and changing what an applied migration does is
 * what the versioned data-step rule forbids. This migration is the repair, in the
 * same shape as 5 through 14 — the display columns, the activity badge, the
 * evidence blob — re-run with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build
 * is a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV15(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 16's data step: re-run the repair with the linear artifact recovery.
 *
 * Migration 15's recovery found the next marker with two `indexOf` calls per
 * iteration, so a text holding many markers — `"[redacted] ".repeat(N)` — re-scanned
 * the whole remaining suffix every time a marker turned out not to be an artifact.
 * That is quadratic: 352 000 characters took most of a second, and a 16 MiB field
 * could stall a collector cycle. The recovery's work was also omitted from the
 * shared scan budget, so it was not bounded by the same allowance as the structural
 * pass.
 *
 * Recovery is now **one forward pass** with a monotonic cursor, and all its work is
 * charged against the shared budget, which fails closed when exhausted. The
 * *results* for the stored shapes are unchanged — the same artifacts are recovered,
 * the same JSON siblings are preserved — so this step exists to bring a database
 * that applied migration 15 up to the current code, and to repair any row that a
 * version-15 build left unconverted when it hit the quadratic path or a bound. It is
 * in the same shape as 5 through 15: the display columns, the activity badge, the
 * evidence blob, re-run with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV16(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 17's data step: repair what version 16's recovery destroyed.
 *
 * Version 16 ran the legacy-tail recovery whenever the *whole* stored value failed to
 * parse, so recoverable JSON **embedded in prose** was consumed: a stored
 * `config {"password":[redacted],"region":"us-east-1"}` became
 * `config {"password":[redacted:uninspected]` — the `region` sibling and everything
 * after it were deleted. Recovery now skips a recoverable JSON container, so the
 * structural pass repairs its bare markers and preserves its siblings and the text
 * around it, while a genuine malformed artifact is still failed closed.
 *
 * Version 16 also under-reported its work: the recovery's scan was charged to the
 * shared budget only when it changed the text, so an unchanged marker-heavy value got
 * a fresh structural budget. The work is now always charged, and the combined total
 * fails closed when it exceeds the allowance. That is an accounting correction, not a
 * stored-value change, but it is part of the same behaviour change.
 *
 * A database that applied version 16 before those were fixed therefore still holds
 * the truncated values, and version 16 cannot be edited: it shipped under its own
 * identity, and changing what an applied migration does is what the versioned
 * data-step rule forbids. This migration is the repair, in the same shape as 5
 * through 16 — the display columns, the activity badge, the evidence blob — re-run
 * with the corrected redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV17(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}

/**
 * Migration 18's data step: repair a long credential key the lookup could not see.
 *
 * The assignment lookup kept only the **last** 64 characters of a key run, so a long
 * credential key whose sensitive prefix was earlier was read as a non-credential
 * suffix. `password.` + `z`.repeat(64) + `="prefix[42]suffix"` was therefore never
 * consumed as an assignment, and its quoted value was split around the `[42]` inside
 * it — the credential survived verbatim in the stored text. The lookup now examines
 * the key **whole** (up to {@link MAX_ASSIGNMENT_KEY_CHARS}) and fails closed when a
 * run reaches the bound and may continue, so the label is never classified from a
 * truncated suffix.
 *
 * A database that applied migration 17 before that was fixed therefore still holds
 * those values, and migration 17 cannot be edited: it shipped under its own identity,
 * and changing what an applied migration does is what the versioned data-step rule
 * forbids. This migration is the repair, in the same shape as 5 through 17 — the
 * display columns, the activity badge, the evidence blob — re-run with the corrected
 * redactor.
 *
 * It is a pure function of what is stored, so it needs no collection cycle, and it
 * deletes no row and no field. Running it on a database written by a fixed build is
 * a no-op: redaction is idempotent, and the badge flag is only ever raised.
 */
export function reprocessPersistedRedactionV18(db: Db): number {
  let changed = 0;
  for (const { table, column } of V4_COLUMNS) {
    changed += reprocessColumn(db, table, column, redactSerializedValue);
  }
  changed += reprocessActivityEvents(db);
  changed += reprocessEvidence(db);
  changed += flagHistoricallyRedactedActivity(db);
  return changed;
}
