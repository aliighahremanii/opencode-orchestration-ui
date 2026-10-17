# Domain model

The vocabulary this system uses, and the rules that decide which records may be
created. Evidence types live in `lib/domain/types.ts`; workspace projections live
in `lib/contracts/workspace.ts`. This document explains both.

The whole design turns on one distinction:

> **A declaration is not an execution, and an upstream report is not a verdict.**

Most of the rules below exist to keep that distinction from eroding as the code
grows.

## Core terms

### Connection

A configured OpenCode HTTP server this observer talks to. One connection is
configured at a time (`ORCH_UPSTREAM_BASE_URL`), owned by the collector. The
browser never addresses a connection: it only talks to this application's own
API.

### ProjectContext

The project identity the upstream instance reports for a location:
`{ id, directory, canonical }`. It is the upstream's own view of which project a
piece of work belongs to.

### Location

A **Location** is a project context plus an optional sub-path and a working
directory. It is the scope for two things:

- the **effective agent registry** — `GET /api/agent` is queried per location, so
  the agents available in one checkout are not assumed to be available in
  another;
- **run grouping** — crossing locations is permitted only with an explicit parent
  link and verified matching project, connection and source identities. Unknown or
  conflicting boundaries are not followed.

### AgentDefinition

An agent as currently effective for a location, discovered from the API.

**A definition is never evidence that work ran.** This is why:

- the agents page shows a *separate* observed-invocation count beside each
  definition;
- an agent with zero observed invocations says "none observed" rather than
  appearing active;
- hidden agents are shown, because they are part of the effective registry, not
  because they have run.

Definitions are read from the API rather than from agent files on disk, so the
registry reflects what the instance would actually accept.

An `AgentDefinition` also carries `active`, which records whether the latest
**successful** location snapshot still reports it:

- **Membership is reconciled, not merely accumulated.** An agent the API stops
  reporting is marked `active: false`. It is not deleted, because the invocations
  already attributed to it must keep their attribution.
- **"Currently effective" and "known historically" are different claims**, and
  the UI presents them as different groups. An inactive agent is labelled "no
  longer reported" rather than silently listed as available.
- **An empty snapshot is a real statement.** If the API reports no agents for a
  location, every previously known agent for that location becomes inactive.
  That is the API's answer, and it is recorded as such rather than treated as a
  missing response.
- **An unavailable registry is not an empty snapshot.** A location-scoped
  `UpstreamHttpError` with path `/api/agent` and status 404, caught only around
  that registry request, preserves the last successful membership, agent timestamps
  and checkpoint. The observed Location/Workspace and its sessions/messages may
  still be collected. A deduplicated `agent-registry-unavailable` warning and
  `agents:<locationId>` gap expose the missing coverage; only a committed successful
  snapshot for that location in the same collector scope closes the gap.
  The warning remains historical evidence after recovery, not an open-gap indicator.

### Root Run

A root session (one with no `parentID`) plus every session **observed** to
descend from it within the verified project/connection/source boundary. Legacy
unknown-connection observations remain location-bounded.

Two honesty rules:

- A session whose parent was never observed becomes its own root and is reported
  as an orphan. It is never attached to a guessed parent, and never dropped.
- A cyclic parent chain terminates and is reported; it does not hang collection.

A run also carries **provenance**, and its provenance rules are as strict as its
ancestry rules:

- A run's `source` is the provenance of the session it was **built from**, not
  the collector's current mode. The run forest is rebuilt from everything already
  stored, so deriving the label from "what mode is the collector in now" would
  relabel every fixture run the moment the collector was pointed at a live
  instance. That is why `fromStoredSession` carries the stored `source` through
  and `buildRunTree` reads it from the root observation.
- A parent link that crosses a **provenance boundary** is not followed, exactly as
  an unverified cross-location link is not followed. A fixture session is never attached under
  an upstream parent (or the reverse), so the two provenances can never be blended
  into one run. The link is reported as a warning (`cross-source`) instead.

When a rebuild **moves a session between runs** — the canonical case being a child
first observed without its parent, which becomes its own orphan root and is later
attached under the parent once the parent is observed — the retained activity
events and invocations are repointed at the run the session now belongs to, in the
same transaction as the rebuild. The old run identity disappears, so without this
its records would be stranded on a run that no longer exists and would vanish from
the run detail page, timeline, and counts. The reconciliation is driven from the
rebuilt membership rather than from the current fetch window, so a session outside
this cycle's bounded fetch, and activity a partial transcript did not re-read, are
repointed too. Nothing is recreated and nothing is deleted; only the run pointer
changes.

### ObservedAssignment

A stable projection above Invocation turns, not the reserved external tracker
`TaskAssignment`. The installed upstream does not expose a verified assignment
lifecycle, so this build uses one explicitly labeled **session grouping** per
session (`grouping: "session-fallback"`). Task boundaries are unavailable, not
inferred. Neither `lastTrigger` changes (user, system or synthetic messages), tool
calls nor repeated agent names establish task boundaries. Separate observed
sessions remain separate groupings, including parallel children; distinct agent
attributions within a grouping are retained rather than collapsed to one role.
Assignment IDs do not depend on the changeable RootRun identity; membership
reconciliation updates their run references transactionally
(`lib/db/workspace.ts`, `reconcileAssignments`).

### Project and Workspace identity

A **Project** is a namespaced observed upstream project identity, not a Root Run
or a task. A **Workspace** is the persisted location within that project used to
scope observation and navigation; it is not proof of a Git worktree or an
allocation by the reserved `WorkspaceAllocator`.

Project and workspace identity are persisted separately. Project keys namespace
upstream identity by connection and source. Live location/session identities also
include that namespace; legacy observations retain unknown connection provenance
rather than being silently adopted. Authoritative root/display metadata and VCS
observations carry provenance/time; missing branch/worktree metadata stays unknown
or unavailable. An alias changes display only. No branch is inferred from paths.

### Session (evidence)

A session as observed upstream, including the `parentID` used for ancestry.

A session may be **resumed**, and the agent may **switch** during it. Therefore:

- session and invocation are **not** 1:1;
- attribution is snapshotted. `agent_first_seen` records the agent observed at
  first ingest and is never overwritten, while `agent_id` tracks the latest
  observation. Both are shown, and a change between them is called out in the UI.

### Invocation (evidence-backed)

One agent turn observed inside a session.

**Creation rule:** an `Invocation` is created only from an assistant message that
carries an explicit `agent` field. Agent definitions, child sessions, and
session-level attribution never produce one.

Each invocation stores the evidence that justified it (`InvocationEvidence`): the
rule name, the assistant message id, the agent field value, the triggering
message, and the tool call ids. The dashboard can display that evidence, so a
claim can be re-checked rather than taken on trust.

Confidence is recorded as `verified` (directly observed fields on a single
record), `derived` (a join across observed records, with the rule recorded), or
`unknown` (the evidence for a stronger claim is absent).

### ActivityEvent

One normalized, deduplicated, redacted unit of observable activity: a message, a
tool call, or a state change.

- **Identity** is `(location, session, message id, part index, kind)`. Replaying
  the same upstream message therefore targets the same row instead of creating a
  second event.
- **Order** comes from upstream creation time with the id as a tiebreak, so the
  stored `sequence` is stable regardless of the order pages arrived in.
- **Content** is redacted and truncated before storage. Redaction and truncation
  are surfaced as badges, so a reader knows the stored text is not the full
  upstream text. A tool call whose input or output was redacted before it was
  serialised still carries that provenance, so the badge is raised even though the
  stored text was already clean by the time the collector saw it. The badge is
  **conservative evidence, not proof**: it reports that the text matches the
  redaction pattern, so a message in which someone genuinely typed `[redacted]` is
  flagged too. It is only ever raised, never cleared.
- **Redaction recognises key *names*, not only key-shaped text.** A credential
  key is matched in separator-delimited (`api_key`), camelCase (`accessToken`,
  `refreshToken`, `clientSecret`), compound (`secretAccessKey`, `SecretKey`) and
  environment-variable style (`OPENAI_KEY`, `GITHUB_TOKEN`) form, in raw, quoted,
  escaped, and double-encoded content. A structured payload
  is redacted by key as well as by value, because an opaque token under a
  credential-named key carries no credential-shaped text for the value rules to
  find; a whole object or array under such a key is replaced outright, nested and
  encoded forms included. A credential assignment owns its **whole** value, so a
  value that merely *looks* like JSON is removed as a unit: `password="correct[42]horse"`,
  `clientSecret='{"value":"…"}'` and `OPENAI_KEY='{"value":"…"}'` are all fully
  removed rather than being split at the `[` or `{` inside them. A **double-encoded**
  document — the escaped form a serialised tool input takes, `{\"OPENAI_KEY\":\"…\"}`
  — is read in its escaped form, so a whole credential-key value is removed without
  ever decoding the text: the escaping level and every ordinary sibling survive
  byte for byte. An ordinary string value is inspected recursively, because a
  serialised tool input commonly nests one encoded document inside another and the
  credential can be in the inner one; a primitive value is accepted only when its
  complete syntax and the boundary that follows it are valid, so
  `{\"password\":123opaque-secret}` fails closed rather than being consumed up to
  `o`. An ordinary string's content goes through the whole **escaped-level
  pipeline**, not just the scalar rules, so a credential *assignment* inside it is
  found and its value consumed whether that value is an escaped string
  (`password=\"…\"`), a container (`password=[17,23,42,91]`) or a bare token. The
  assignment grammar is complete: the label may be **quoted** with either separator
  (`'password': [1,2]`, `"api_key"=[9,9]`), and a **bare value that contains
  brackets** is consumed whole rather than stopping at the first `[`, so
  `password=correct[42]horse` does not leave `[42]horse` behind with no key in front
  of it. A container value must be **well formed and followed by a valid boundary**:
  pairing is validated, so a mismatched closer (`password=[1,2}`) is not a container
  at all, and what follows must be something that may follow a value, so a container
  with a suffix (`password=[1,2]opaque-suffix`) fails closed rather than being
  accepted and leaving the suffix behind.
  A fragment is only reported as handled once **every** span has been checked:
  the structural walk owns only the spans it actually inspected — the credential
  values and the ordinary string contents — and a container is **not** marked
  inspected before its descendants are, so a bare token inside it stays visible. The
  plaintext the walk did not consume — the words around an escaped quoted phrase —
  goes through the scalar rules, so a token sitting beside `\"hello\"` is removed.
  A **value boundary must be complete**: a closing quote or bracket proves only that
  the delimited segment ended, not that the assignment did, so
  `password=""opaque-live-value` and
  `{\"password\":\"abc\"opaque-live-value}` fail closed instead of stranding the
  continuation, while `password="opaque-value"` is preserved. A **key carrying an
  escape the decoder cannot resolve** — a `\uXXXX` escape, where
  `{\"access\u0054oken\":\"…\"}` spells `accessToken` — is classified
  **conservatively sensitive**, so its value is removed whole and the raw key
  spelling is left byte for byte. A nested nonsensitive container is descended in a
  **single forward pass** with a matching stack, so it is visited once rather than
  once per enclosing level, with every operation charged to the shared budget and
  the container depth counted explicitly.
  The label
  classification is defined once and shared by the assignment scanner, the
  env-style scalar rule, and the structured-leaf property test, so a label is
  either sensitive everywhere or nowhere — `OPENAI_KEY="…"` and
  `{"OPENAI_KEY":"…"}` are masked identically, including a whole object or array
  value under such a name. Redaction is idempotent, so re-running it over
  stored text is safe; that is what lets a later build repair text an earlier one
  persisted (see the schema-version notes in the README).
- **The structural scan fails closed at its bounds.** Redaction of a structured
  payload is bounded — a work budget proportional to the input, a cap on the number
  of fragments examined, and a recursion-depth cap — so an adversarial payload
  cannot make it quadratic. No scalar rule may scan unboundedly either: the
  URL-userinfo *scheme* and the base64 run repeat a capped number of times, because
  an unbounded repetition that must be followed by a delimiter costs O(n²) from
  every start position; the private-key block is delimited by an explicit forward
  pass rather than a pattern whose label run would be retried from every
  `-----BEGIN `, and an unterminated block fails closed. The URL *userinfo* itself is
  deliberately unbounded —
  capping it would mean a longer credential matches nothing and is left verbatim,
  so it is consumed whole or not matched at all. The credential-label classifier is
  deterministic. **Every** credential-label classifier is a **linear parser**, not
  a pattern: each shape's repetitions overlapped around a word alternation, so a
  near-miss label such as `"aSecretX".repeat(20_000)` or a repeated
  `"api_key."×n` cost seconds and grew quadratically, and no backtracking engine
  can be bounded from outside. The camelCase, separator-delimited and
  environment-style shapes each have their own single-pass parser, and every rule
  built on them — including the quoted, bare and escaped key/value rules — is a
  linear pass for the same reason. The
  forward walk never scans backwards over
  whitespace: the position of the characters a key lookup needs is carried forward
  in a small fixed-size ring, so a run of 200,000 spaces costs the same as any
  other run of characters. Reaching any bound does **not** silently stop
  inspecting: the uninspected remainder is replaced by a bounded marker,
  `[redacted:uninspected]`, and the redacted flag is raised. A recognised
  assignment whose value cannot be delimited within the remaining budget, or that
  opens a container which never closes, fails the same way — a partial match would
  leave the rest of the value in the text with no key in front of it, which is the
  leak the bound exists to prevent. The marker is distinct
  from `[redacted]`: it says "the scanner gave up before it checked here", not "a
  credential was recognised and removed". Nothing structurally uninspected is ever
  stored, because a structure the scanner never reached may hold a credential.
- **Redaction is enforced at the storage boundary, not only in the collector.**
  The policy is a dependency-free utility that every persistence writer imports,
  so a value is redacted at the moment it is written. Diagnostic text a writer
  persists — a location's `canonical` path, a gap's `reason`, a warning's
  `detail`, the collector's `last_error` — is covered the same way, because a
  writer that bypassed the collector must not be able to reintroduce a credential.
  A writer never falls back to the raw value, and it never rewrites an identity,
  join, or dedup key: `directory`/`id`, `scope`/`stream`, and a warning's
  original-detail hash are all preserved exactly.

### UpstreamState

What the upstream instance reports: `succeeded`, `failed`, `interrupted`, or
`idle`. It is always labelled **"Upstream reported …"**.

### WorkflowOutcome

Whether the user's underlying work actually succeeded. **This system never
computes it.** Idle, silence, and a successful tool call are not completion, and
nothing in the UI presents them as such. Run status values are deliberately named
`reported-succeeded`, `reported-failed`, `reported-interrupted`, `reported-idle`,
`recently-active` (an explicitly local recency observation), and `unknown`.

### ProgressReport (optional, unused)

A progress report that would only ever exist if an upstream record carried one
explicitly. The table exists; nothing writes to it. No progress is fabricated
from elapsed time, message counts, or tool activity. See
`docs/progress-contract.md`.

### TaskReference

A reference to a task tracked outside this observer. The table exists; nothing
writes to it.

### CollectionGap

A window during which the observer cannot prove it observed everything, with a
scope, stream, time range, reason, and whether collection resumed.

Gaps are recorded, never smoothed over. They appear on `/status` and on the run
pages whose window they overlap.

A gap has an explicit lifecycle:

- **Opened** when coverage is lost: a cycle fails, a pause exceeds the tolerance,
  or a lease handover is detected. Opening is idempotent per window, so a run of
  failed attempts re-asserts one gap rather than creating one per attempt.
- **Open** (`open: true`, `resumed: false`) while the window is unresolved. An
  open gap is reported as such, and the overview counts it.
- **Closed** (`open: false`, `resumed: true`) only after successful observation of
  the affected stream: a full successful cycle closes `cycle`/`lease` gaps;
  a committed registry snapshot closes only its `agents:<locationId>` gap.
  An unobserved location's gap survives later bounded fetch windows.

Any unresolved registry gap keeps cycle health failed (`ok: false`,
`lastCycleOk: false`) and preserves `lastSuccessAt`, even when independent
observations commit. Cycle counters describe committed observations, not net new
rows; later failures retain those counts and exclude rolled-back batches.

Coverage is measured from the last **successful** cycle, not the last attempt.
Measuring from the last attempt would let a sustained outage keep pushing the
clock forward, so the outage would never be recorded at all.

### CollectorCheckpoint

The last observed position for one stream (sessions, a session's messages, a
location's agents). Checkpoints are shown on `/status` so "what has been looked
at" is inspectable.

A checkpoint carries `partial`, which says whether the stream was fully observed
or the paging bound cut it short:

- **Complete** (`partial: false`) — upstream offered no further page. This is the
  only case in which a session's stored activity may be replaced, because only
  then is the snapshot known to be whole.
- **Partial** (`partial: true`) — the bound was reached with more history
  available. The existing activity is preserved rather than deleted, the cursor
  to continue from is retained, and the stream is flagged so "observed so far" is
  never read as "observed completely".

A checkpoint is committed inside the same transaction as the observations it
describes, so it can never claim coverage that was not written.

### CollectorLease

The ownership record proving which collector process may write, with a holder id
and a monotonic **epoch**.

The lease is what makes "exactly one writer" true rather than conventional. A
second collector may start (a restart, a duplicated unit, an operator mistake),
so ownership is enforced in the database:

- claiming a lease runs inside an immediate transaction, so two processes racing
  serialise and exactly one wins;
- every collector write runs inside a fenced transaction that re-reads the lease
  in the same transaction as the write. A collector that lost its lease therefore
  cannot commit a stale write, because the check and the write are atomic with
  respect to other writers;
- **the fence covers metadata, not only observations.** Collector state,
  checkpoints, and gaps are written under the same fence, so a stale collector
  cannot overwrite the current collector's health record — for example by
  stamping an old error over a healthy state;
- **the lease is heartbeated while a cycle runs.** A reconcile can take longer
  than the TTL; without a heartbeat a long cycle would expire its own lease
  mid-run, letting another collector take over while the first was still writing.

Liveness is read from the lease rather than from a state row, so a collector that
has stopped is reported as **stopped** (a state row exists, no lease is held)
rather than as running. `last_success_at` is tracked separately from
`last_cycle_at`, so a failure cannot erase the record of when coverage was last
actually proven.

## Workspace presentation

The authenticated `/` workspace presents observations, not a scheduler, execution
engine or verdict. See `workspace-interactions.md` for navigation and controls.

- A node or list entry selects an **ObservedAssignment**, currently an explicitly
  labeled session grouping. Its **Invocations** remain distinct assistant turns;
  nine turns do not become nine assignments. Agent names, tools and trigger
  messages do not establish assignment boundaries. Reviewer and unknown
  attribution remain explicit.
- A **Root Run** is not a project or workspace. Project identities namespace
  upstream identity by connection and source. Cross-location ancestry requires an
  explicit parent link and matching verified project/connection/source boundaries.
  An edge reports `session.parentID`, not execution order or a handoff.
- Node positions and viewport are presentation-only, stored locally by version
  and scope. Refreshes preserve existing positions; tidy explicitly rearranges
  them. URL project/run/workspace/assignment selection is separate from layout.
  Changing scope clears old evidence before replacement data arrives.
- Task context discloses the grouping limitation. Conversation and Activity show
  retained, redacted evidence with pagination; no progress, busy state, completion
  percentage or workflow success is inferred.
- Authenticated `GET /api/workspace/graph` returns the complete retained selected
  scope in a coherent read transaction, not a latest-100 global window or a claim
  of complete upstream history. Detail cursors bind scope and generation; changed
  evidence expires a cursor instead of silently skipping records. Identical
  collector replay does not expire it: generation tracks retained content and
  membership, not ingestion or last-seen bookkeeping timestamps
  (`lib/http/workspace.ts`, `generation`). Workspace filtering hides other
  locations and crossing edges, and discloses that limitation.
- Collection gaps, partial streams and freshness remain visible. Local SSE
  invalidates stored snapshots; polling continues. Transient failures retain an
  explicitly stale same-scope snapshot; authorization denial clears it.
- The responsive list and graph share selection. The owner-authenticated `/demo`
  is deterministic synthetic data with no telemetry or command calls; it never
  substitutes for failed observation reads.

### Task question boundary

**Ask about this task is unavailable in this build.** Installed-API read discovery
succeeded, but safe read-only permission enforcement, busy safety, correlation and
publication isolation have not been demonstrated. The capability gate is
hard-disabled; credentials or an environment flag cannot enable it
(`lib/questions/capability.ts`). No prompt is sent to the source session or
an investigation session. No fork or permission change is performed.

The narrowly allowed local `POST /api/questions` authenticates the owner and
origin, resolves an assignment, bounds and redacts input, and durably records a
terminal `blocked` job. Duplicate keys replay the result; conflicting reuse is
rejected. The separate worker performs local recovery/retention only; interrupted
mutation states are marked ambiguous rather than retried. The investigation
registry is a prerequisite seam, not an operational publication barrier. See
`task-questions.md` for exact limits and enablement prerequisites.

## Reserved interfaces (documented boundaries, not implemented)

These are declared in `lib/domain/types.ts` and intentionally have no
implementation. They mark the seams a future tracker or dispatcher would use, so
the current read-only boundary is explicit rather than accidental.

General dispatch, creation/continuation controls, execution, cancellation and edge
editing are outside the workspace scope. The narrow task-question capability is
not a dispatcher and remains disabled for the reasons above. The passive collector
issues only `GET` requests upstream; supplying credentials does not enable writes.
Even a future verified admission would not itself establish an `Invocation`: the
explicit assistant-message evidence rule still applies.

| Interface | Would do | Why it is not implemented |
| --- | --- | --- |
| `TaskSource` | List open tasks from an external tracker | Requires write-capable integration and a credential channel; out of scope |
| `ExternalTaskReference` | Identify a task in an external system | Data shape only |
| `TaskAssignment` | Bind an external task to a root run | Requires a dispatcher |
| `RunLauncher` | Start a run | Reserved boundary only; general dispatch is outside workspace scope |
| `DispatchPolicy` | Choose an agent/model for a task | Requires a scheduler |
| `WorkspaceAllocator` | Reserve an isolated workspace | Requires filesystem and VCS mutation |

Architecture tests allow mutating web methods only on owner sign-in/sign-out and
the narrow local question-job route. They preserve browser isolation from the
database and upstream adapter, web isolation from upstream access, and the passive
collector's GET-only adapter. Local job persistence is not an upstream write.

## Rules in one place

1. Definitions are not executions.
2. A child session is not evidence that an agent ran.
3. An invocation requires an assistant message carrying an explicit agent.
4. An upstream-reported outcome is shown as reported, never as a verdict.
5. An outcome observed *before* an invocation is not evidence about that
   invocation. Only a report that follows it is attached to it.
6. Idle, silence, and tool success do not prove completion.
7. Attribution is snapshotted; a resumed session does not rewrite its history.
8. Unknowns are preserved. An unrecognized message type is reported, not guessed
   at; an unobserved parent yields an orphan, not an invented parent.
9. Coverage holes are recorded as gaps, never smoothed over.
10. A gap is resumed only after its stream is successfully observed, and coverage is
    measured from the last success, not the last attempt.
11. A partial snapshot never destroys what an earlier complete one stored.
12. A bounded fetch never deletes the identity or ancestry of a session that is
    still stored.
13. Membership is reconciled: an agent the API stops reporting stops being
    currently effective, but is retained as history.
14. A stale collector cannot write anything, including its own metadata.
15. A run's provenance comes from the observation it was built from, never from
    the collector's current mode; a parent link that crosses a provenance boundary
    is not followed, so fixtures and live data are never blended or relabelled.
16. When a rebuild moves a session between runs, its retained activity and
    invocations are repointed at the run it now belongs to, in the same
    transaction — including records for sessions outside the current fetch and
    rows a partial transcript did not re-read.
17. A credential key is recognised by name, not only by its value: camelCase keys
    (`accessToken`), compound keys (`secretAccessKey`, `SecretKey`) and
    environment-variable-style keys (`OPENAI_KEY`, `GITHUB_TOKEN`) are
    redacted exactly as separator-delimited ones (`api_key`) are, in raw, quoted,
    escaped, and double-encoded content, and a structured payload is redacted by
    key as well as by value — a whole object or array under a credential key is
    replaced, not left behind. A credential assignment owns its whole value, so a
    value that merely looks like JSON is removed as one unit rather than split at
    the brace or bracket inside it — the label may be quoted with either separator
    (`'password': [1,2]`, `"api_key"=[9,9]`), and a bare value that contains
    brackets is consumed whole, so `password=correct[42]horse` leaves no
    `[42]horse` behind. A container value must be well formed — pairing is
    validated, so a mismatched closer (`password=[1,2}`) is not a container — and
    followed by a valid boundary, so `password=[1,2]opaque-suffix` fails closed
    rather than being accepted and leaving the suffix behind. The label
    classification is shared by the
    assignment scanner, the env-style rule and the structured-leaf property test,
    so a name is sensitive everywhere or nowhere — `OPENAI_KEY="…"` and
    `{"OPENAI_KEY":"…"}` are masked alike. A double-encoded (escaped) document is
    redacted in its escaped form, so a whole credential-key value is removed —
    nested containers included — without decoding the surrounding text. A **value
    boundary must be complete**: a closing quote or bracket proves only that the
    delimited segment ended, not that the assignment did, so an ambiguous
    continuation (`password=""opaque-live-value`,
    `{\"password\":\"abc\"opaque-live-value}`) fails closed rather than being
    accepted and stranding the tail, while a clearly terminated assignment
    (`password="opaque-value"`) is preserved. A **key carrying an escape the decoder
    cannot resolve** — a `\uXXXX` escape, where
    `{\"access\u0054oken\":\"…\"}` spells `accessToken` — is classified
    conservatively sensitive: the value is removed whole and the raw key spelling is
    left byte for byte, because the decoder is byte-faithful and cannot resolve the
    escape without rewriting the text. The escape is checked at **every decoding
    layer**, so an escape hidden one layer deeper (`{"access\\u0054oken":"…"}`, which
    is `accessToken` written with an escaped unicode escape) is treated the same way.
    A container value's **ordinary quoted string** is skipped like the escaped form,
    so a brace inside it is content rather than the container's close
    (`password={"value":"},opaque-live-value"}` no longer ends early). A **bare
    assignment with a quoted continuation**
    (`password=prefix"opaque-demo-suffix"`) fails closed rather than redacting the
    prefix and stranding the quoted part, and a clearly terminated bare assignment
    (`password=opaque-value`) is preserved. A **private-key block** is delimited by a
    bounded linear pass and **fails closed** on an incomplete block, so an
    unterminated `-----BEGIN … PRIVATE KEY-----` removes the remainder rather than
    keeping a body that may be key material.
18. The structural scan fails closed. It is bounded by a work budget, a fragment
    cap, and a depth cap; reaching any bound replaces the uninspected remainder
    with `[redacted:uninspected]` and raises the redacted flag. The walk is
    forward-only, so whitespace is never rescanned. A recognised assignment whose
    value cannot be delimited within budget, whose container never closes, or whose
    container is malformed, also fails closed — it is never partially consumed. An
    assignment's **key is examined whole or not at all**: the key run is read in full
    up to the lookup's bound, and a run that reaches the bound and may continue fails
    closed rather than being classified from a **truncated suffix**. Classifying a
    suffix is what let a long credential key whose sensitive prefix was earlier
    (`password.` + `z`.repeat(64)) be read as a non-credential label, so the
    assignment was never consumed and its quoted value was split around the `[42]`
    inside it. The
    walk owns only the spans it actually inspected, so a bare token inside a
    container it did not descend into is still reached by the scalar rules rather
    than being hidden. A nested nonsensitive container is descended in a **single
    forward pass** with a matching stack, so it is visited once rather than once per
    enclosing level; every operation — including a failed scan, whitespace, decoding
    and key matching — is charged to the shared budget, the container depth is
    counted explicitly, and a malformed or over-budget scan fails closed. The key
    before a structured value is found by a **bounded backward walk**, not by a
    pattern over the whole preceding text, so a long non-matching prefix is linear
    and its work is charged like any other. That walk is **three-valued**: when its
    bound is reached before the absence of a key can be proved it reports
    *unresolved*, and the caller **fails closed over the whole remainder** — a parsed
    fragment is replaced by `[redacted:uninspected]` and nothing after it is kept —
    because treating "could not tell" as "no key" let a long key or a long whitespace
    run hide the credential key, and the value may continue past the fragment. A
    **partial redaction** an older build wrote — our marker as the value of a
    sensitive key, followed by the residue of a container whose quoted string held a
    brace, `password=[redacted],opaque-live-value"}` — is likewise recognised and
    failed closed. The **whole** leaked remainder is consumed, because whitespace is
    not a reliable boundary: the suffix may begin with or contain one
    (`password=[redacted], multi word suffix`), and there is no trustworthy delimiter
    inside it. The `[redacted:uninspected]` marker is recognised the same way, so the
    residue a partial repair left behind a space is removed too. Recovery runs only
    when the text is **not** recoverable structured JSON, so a valid document that
    merely carries a bare marker value — `{"password":[redacted],"region":"us-east-1"}`
    — keeps its siblings and structure; the structural pass repairs the marker
    instead. A recoverable JSON container **embedded in prose** is protected the same
    way: `config {"password":[redacted],"region":"us-east-1"}` does not parse as a
    whole, but its container does, so recovery skips that container and the structural
    pass repairs it while the sibling and the surrounding text survive. Recovery is a
    **single bounded forward pass**: it walks the text once
    with a monotonic cursor and charges every character it examines to the same work
    allowance the structural pass uses, failing closed when that allowance is
    exhausted. That charge applies **whether or not the recovery changed the text** —
    an unchanged marker-heavy value must not receive a fresh structural budget — and
    the two passes together fail closed when their combined work exceeds the
    allowance. Locating the next marker with a repeated search instead re-scanned the
    remaining suffix per marker, which is quadratic on marker-heavy text — a 16 MiB
    field could stall a cycle. That
    marker is not
    `[redacted]`: it reports that the scanner stopped before checking, not that a
    credential was recognised. No structurally uninspected text is ever stored,
    because a structure the scanner never reached may hold a credential — the
    bound protects the process, never the secret.
19. Every retained display field is repairable, and a repair that rewrites an
    event's display text raises that event's `redacted` badge. The badge is only
    ever raised, never cleared. Identity and join keys are never rewritten, so a
    repair cannot break a join. A repair also raises the badge on a historical
    row that already carries a redaction marker, because an earlier build could
    rewrite the text without recording that it had — otherwise the timeline would
    present sanitised text as if it were verbatim. **The badge is therefore
    conservative evidence, not proof:** the marker is a literal string, so a
    message in which a user genuinely typed `[redacted]` is flagged even though
    nothing was removed. It reports "this text matches the redaction pattern and
    may not be the verbatim upstream record", which is the honest direction to
    err — over-reporting is safe, under-reporting would claim altered text is
    complete.
20. A migration's data step is part of its identity: a step's behaviour may only
    change by shipping a new migration version, and a versioned step declares the
    `dataStepVersion` its checksum covers.
21. Redaction is enforced at the storage boundary, not only in the collector. The
    policy is a dependency-free utility that every persistence writer imports, so
    a field is redacted when it is written — including diagnostic text no display
    path produced (`locations.canonical`, a gap's `reason`, a warning's `detail`,
    the collector's `last_error`). A writer never falls back to the raw value, and
    redaction never alters an identity, join, or dedup key: a location's
    `directory`/`id`, a gap's `scope`/`stream`, and a warning's original-detail
    hash are preserved exactly.
