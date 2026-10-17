# OpenCode compatibility

What this observer depends on, what was verified, and what remains unverified.

The guiding rule is: **documented is not the same as verified**. Where a
capability was only read from published documentation and could not be exercised
against a running authenticated instance, it is recorded as documented-only. No
write capability is inferred from a published schema alone.

## Workspace-reset verification (2026-10-16)

Authenticated **installed-instance** discovery succeeded using existing process
environment credentials, without reading credential files: `/api/info` reports
2.0.28 and `/openapi.json` contains 118 paths. Runtime adapter reads validated one
location, 27 project records and one bounded session. `/api/session/active` also
returned 200. Current VCS metadata was unavailable and worktree membership unknown;
neither is inferred. These checks are live evidence; browser screenshots are
separately labeled fixtures, not live collection evidence.

A subsequent bounded GET-only collection into a disposable task database succeeded:
2 locations, 3 sessions, 22 observed Invocations and 3 partial transcripts. A local
authenticated browser loaded one selected upstream-backed grouping. No live task
content screenshot was retained. This verifies the read workflow, not complete
history or safe question execution.

No mutating smoke test ran. Fork cannot atomically receive restrictive permissions
in the installed schema; permission enforcement, correlation and publication
isolation were not proven. Questions remain disabled. See `task-questions.md`.
The tables below distinguish current read evidence from historical probes and
schema-only write capabilities.

## Version evidence

| Item | Value | How it was established |
| --- | --- | --- |
| OpenCode server | `2.0.28` | Authenticated installed `GET /api/info`, HTTP 200 |
| Observed endpoint | `http://127.0.0.1:4096` | Successful authenticated read requests; no service restart or bind change |
| Discovery credential source | Existing `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` process environment | Used in memory for HTTP Basic; values were not printed or copied into configuration |
| Installed HTTP API spec | 118 paths | Authenticated installed `GET /openapi.json`, HTTP 200 |
| Current public reference | 142 operations | V2 public documentation consulted as reference only, not installed-instance proof |
| Spec self-description | "Experimental HttpApi surface for selected instance routes." | spec `info.description` |

The spec's own description calls the surface **experimental**. That is the reason
every payload is validated at runtime rather than trusted, and the reason an
unknown message type is recorded as a gap in understanding rather than guessed
at.

## Authentication

| Aspect | Finding | Status |
| --- | --- | --- |
| Documented security schemes | `components.securitySchemes` is **empty** | Documented |
| Historical unauthenticated probes | `GET /api/health`, `/api/info`, `/api/agent`, `/api/session`, `/api/event` returned **HTTP 401** in the baseline | Historical runtime evidence |
| Mechanism | HTTP Basic succeeded for installed-instance discovery and bounded read collection. Pairing was not exercised. | Basic read-verified; pairing documented-only |
| What this application does | Sends HTTP Basic from `ORCH_UPSTREAM_USERNAME` / `ORCH_UPSTREAM_PASSWORD` **environment variables only**. It never reads a credential file. | Implemented |
| Live read validation | Authenticated environment-only discovery and bounded adapter read validation succeeded during workspace reset. No mutating smoke test. | Read-verified |

### Credential handling rules this application follows

- The upstream adapter obtains credentials from the **process environment only**;
  it never opens an upstream credential file. Node entrypoints and Next may load
  the application's configured `.env` through their documented startup mechanisms.
- Only the **collector** uses upstream credentials for requests in this build.
  Web configuration may contain upstream settings, but the web import graph cannot
  reach the upstream adapter and no web route contacts the instance. The disabled
  question recovery worker also makes no upstream requests.
- A rejected credential (`401`) is reported explicitly and not retried silently.
- **Failed sign-ins are throttled against a key that is not client-controlled.**
  The default bucket is owner-wide, so rotating a header cannot escape the limit.
  `X-Forwarded-For` is consulted only when `ORCH_TRUST_PROXY_HEADERS=true` is set
  explicitly, and then only its **last** entry is used, because that is the value a
  trusted proxy itself appended. A malformed forwarded value falls back to the
  owner-wide bucket, so a bad header tightens throttling rather than loosening it.

Schema/fixture tests cover normalization edge cases; the bounded live collection
additionally exercised identity, session, agent and transcript reads. It does not
prove every message variant or complete historical coverage.

### Test-harness safety correction

The first full E2E run invoked the pre-existing quickstart test, which read/backed
up and temporarily replaced repository `.env`. Its teardown restored the file and
removed the backup; no contents were printed. This behavior violated this task's
credential-file handling constraint. The test was corrected to use a disposable
sandbox with exclusively synthetic configuration. Subsequent focused and full
passes were historical builder-reported results, not final independent E2E
acceptance. The environment-only API discovery above did not use
that file. Subsequent security review also found that E2E Next builds and regular
servers still ran from the real checkout and could implicitly load its dotenv.
The review fix now copies allowlisted application source and dependencies into an
owned temporary application before any build/start, never reuses checkout `.next`
or source/config/dependency symlinks, and supplies an allowlisted child environment.
Preloaded file-access instrumentation denies dotenv reads outside that app and
records allowed synthetic reads without contents. Synthetic canaries and real
build/server audits test the boundary. Vite dotenv loading is disabled and test
commands use Bun's `--no-env-file`. These historical exposures remain disclosed;
the corrected tests do not inspect the actual checkout credential file.

Final independent full-E2E results remain pending a rerun. The independent full
attempt was interrupted by ENOSPC; per-file passes do not establish a clean
complete run. Later focused builder verification passed after the canvas and
Node/Bun guard repairs, using the existing owned application copy to avoid another
dependency copy. That focused result does not replace final independent full-suite
verification or establish release readiness.

## Endpoints used

All upstream access is `GET`. The adapter (`lib/upstream/adapter.ts`) has no code
path that can issue another method, and an architecture test enforces it.

| Endpoint | Parameters used | Purpose |
| --- | --- | --- |
| `GET /api/info` | none | Server identity and reachability |
| `GET /api/location` | none | The default project context for the instance |
| `GET /api/project` | none | Authoritative project root and optional display name |
| `GET /api/vcs` | `location[directory]` | Optional verified branch metadata; unavailable on failure |
| `GET /api/worktree` | `projectID` | Saved inventory only; no discovery, creation or branch inference |
| `GET /api/agent` | `location[directory]` (deepObject) | Location-scoped **effective** agent registry |
| `GET /api/session` | `limit`, `cursor` | Session records with `parentID` for ancestry |
| `GET /api/session/{sessionID}/message` | `limit`, `cursor` | Normalized message transcript per session |

Endpoints the spec documents that this build deliberately does **not** call:
every `POST`/`PUT`/`PATCH`/`DELETE` (prompting, interrupting, permission replies,
configuration, worktree and VCS mutations), `GET /api/event` (see below), and
`GET /api/config` (configuration is not read).

## Location and session shapes

From the spec's schemas:

- `Location.PublicInfo` = `{ directory, project: { id, directory, canonical } }`.
- `Location.PublicRef` = `{ directory }` — the reduced reference carried on
  sessions and messages.
- `Session.ID` is documented as pattern `^ses`.
- `Session.Message.ID` is documented as pattern `^msg_`.
- `Session.Info` requires `id`, `projectID`, `cost`, `tokens`, `time`, `location`.
  Optional and load-bearing for this application: `parentID` (ancestry), `agent`,
  `model`, `outcome` (`succeeded | failed | interrupted`), `title`, `subpath`,
  `time.idle`, `time.archived`.
- `Agent.Info` requires `id`, `name`, `request`, `mode`, `hidden`, `permissions`.
  `mode` is one of `subagent | primary | all`. `hidden` is a boolean, so a hidden
  agent is still part of the effective registry and is shown as such.

Two consequences the implementation encodes:

1. **Identity is validated, not assumed.** `isUsableSessionId` and
   `isUsableMessageId` bound the character set beyond the documented prefix. An
   identifier outside that set is not keyed on, because keying on an unusable id
   would silently duplicate records.
2. **A session is not an invocation.** `parentID` establishes ancestry only.
   Nothing in the session shape records that an agent *ran*, which is why an
   invocation requires message-level evidence.

## Message types

The spec documents eleven message types, all of which this build normalizes:

`agent-switched`, `model-switched`, `location-switched`, `user`, `synthetic`,
`system`, `skill`, `shell`, `assistant`, `compaction`, `idle`.

- Assistant content parts are `text`, `reasoning`, `tool`.
- A tool part's `state.status` is one of `streaming | running | completed | error`.
- `idle` carries an `outcome` of `succeeded | failed | interrupted`.

An unrecognized `type` is **not** coerced. It is counted, surfaced on `/status`
as a `unknown-message-type` warning, and the message is skipped. The fixture set
deliberately injects a `future-event-type` message so this path is covered by
tests.

### The invocation rule

`Session.Message.Assistant` carries an optional `agent` field. That field is the
only evidence this application accepts for an invocation. Agent definitions,
child sessions, and session-level `agent` attribution never create one. The
evidence payload stored with each invocation records the rule name, the assistant
message id, the agent field value, the triggering message, and the tool call ids,
so a reviewer can re-check the claim.

## Events and gaps

`GET /api/event` is documented as a `text/event-stream` (`x-effect-stream`,
`encoding: sse`) whose data is a `V2EventEncoded` string.

**This build does not consume it as its source of truth.** Reasons:

- The spec documents no `Last-Event-ID` support and no replay guarantee.
- The stream is a live subscription; a disconnect during an unknown window has no
  documented way to prove what was missed.

Instead the collector **reconciles**: each cycle re-reads the authoritative
session and message records, and the write path is idempotent, so a disconnect
costs freshness rather than data.

Any window that cannot be proven covered is recorded in `collection_gaps` with a
reason and a time range, and is shown on `/status` and on the affected run's page.
Gaps are never smoothed over, and their state is explicit:

- a gap is **opened** on the first failed cycle, on a pause longer than the
  configured tolerance, or on a detected lease handover;
- it stays **open** across repeated failed attempts, and re-asserting it is
  idempotent, so one outage is one gap;
- cycle/lease gaps are marked **resumed** only after a full successful cycle;
  location registry gaps close only with a successful snapshot for that location.

OpenCode 2.0.28 can return `LocationNotFoundError` (HTTP 404) from
`GET /api/agent?location[directory]=...` for a historical session directory that
no longer exists. Only a typed `/api/agent` 404 is tolerated at that registry read:
the collector retains last successful AgentDefinition membership and timestamps,
leaves its legacy `agents:<directory>` checkpoint unchanged, and opens a
deduplicated `agents:<locationId>` gap/warning under the lease fence. It persists
the observed location identity and continues other registries, sessions and
messages. Authentication, transport, payload and other endpoint/status failures
remain fatal on these required reads; optional project/VCS metadata retains its
existing unavailable fallback.

An unresolved registry gap, including one outside the next fetch window, keeps
`ok`/`lastCycleOk` false, preserves `lastSuccessAt`, and makes one-shot collection
exit 1. Counts still report committed observations, including progress before a
later fatal error. Retries preserve the original gap start; only a successful
same-location snapshot closes it. A successful empty registry deactivates agents;
404 never does. Fixture mappings follow the same distinction: absent mapping is
typed 404; explicitly mapped empty data is successful-empty. Regression tests use
synthetic sources/databases, not the user's upstream or observation database.

Recovery closes only the matching collector scope and `agents:<locationId>` stream;
the `agent-registry-unavailable` warning is retained as history after closure.
No schema migration or upstream write is introduced.

Independent verification of this fix passed 19 focused collector cases under both
Bun/Vitest and Node/Vitest. A disposable synthetic HTTP server exercised the actual
`scripts/collector.ts --once` entrypoint: the 404 cycle exited 1 while persisting
sessions/messages and accurate committed counts, leaving the registry gap open
without advancing its checkpoint or the last successful cycle time. A subsequent
successful registry response closed the gap and exited 0. Requests remained GET-only;
authentication, 500, transport, payload and unrelated-404 cases remained fatal.
This verifies local failure/recovery behavior, not a rerun against installed OpenCode
or the user's existing database, and does not replace the pending historical full
E2E-suite rerun described above.

Coverage is measured from the last **successful** cycle rather than the last
attempt. This is what makes a sustained outage visible: measuring from the last
attempt would keep resetting the clock, so an outage that never recovered would
never be recorded at all.

The fetch that feeds a cycle is bounded (sessions per cycle, and pages per
transcript). Two rules keep a bound from destroying history:

- **Run identity survives the bound.** The run forest is rebuilt from every
  *stored* session, not only those inside the current window, so a run whose root
  has aged out of the window keeps its identity and ancestry.
- **A partial transcript is non-destructive.** When the paging bound is reached
  with more history available, existing activity is preserved, the checkpoint
  keeps the cursor to continue from, and the stream is flagged `partial` on
  `/status`. Stored activity is replaced only on a complete snapshot, because only
  then is the snapshot known to be whole.

The dashboard's own live updates use a different mechanism: a durable local
change log (`change_log`) that the browser resumes from with `?since=<seq>`. The
`since` value accepts the full safe-integer range of that sequence column. The
session is re-validated while the stream is open, so a revoked or expired session
ends the stream with an `auth-expired` event instead of continuing to receive
data.

If a future version of the upstream API documents and demonstrates exact replay
(an event id that can be replayed), consuming the stream becomes viable. Until
that is verified, reconciliation is the safe choice.

## Runtime validation, not type assertion

`lib/upstream/schema.ts` validates the core observation payloads field by field. It is forward
compatible in one direction only: unknown *extra properties* are ignored, but
every required field must be present with the documented type. A payload that
fails validation is rejected and reported (`UpstreamPayloadError`), never
coerced into a plausible-looking record.

The fixture source pushes its JSON through the **same** validators, so the
fixture path exercises validation rather than bypassing it.

The workspace adapter validates project identity/root fields and checks optional
VCS/inventory fields before accepting metadata. A failed or unrecognized optional
response leaves metadata unavailable/unknown rather than inferring a branch or
worktree from a directory name.

## Summary of verification status

| Capability | Documented | Runtime-verified | Notes |
| --- | --- | --- | --- |
| Server reachable at `127.0.0.1:4096` | yes | yes (authenticated 200) | Installed version 2.0.28 |
| Requires authentication | not described in spec | historical 401; current Basic success | No credential file needed for API discovery |
| `GET /api/info` shape | yes | yes | Core adapter validation succeeded |
| `GET /api/location` shape | yes | yes | One default location validated |
| Project root/display metadata | yes | yes, bounded discovery | 27 project records validated; no claim that all optional names exist |
| VCS branch / saved worktree inventory | yes | request path exercised | Branch unavailable and membership unknown in the read check; no inferred metadata |
| `GET /api/agent` location scoping | yes | bounded collection exercised | Effective-agent reads for collected locations; broader semantics remain fixture-tested |
| Session hierarchy via `parentID` | yes | session reads exercised | Cross-boundary and cyclic cases regression-tested with fixtures, not induced live |
| Session pagination via `cursor` | yes | bounded first page | Complete multi-page live history not verified |
| Message transcript shapes | yes | bounded collection exercised | 22 Invocations observed; not every variant or complete history |
| Event stream replay | **no** | no | Not relied upon |
| Exact semantics of `outcome` / `time.idle` | partial | **no** | Treated as *reported*, never as a verdict |
| Agent membership changes over time | not described | **no** | Reconciled per successful snapshot; removals retained as history |
| Transcript paging bound behaviour | not described | three partial transcripts observed | Retention/recovery guarantees regression-tested locally |
| Read-only task investigation | create/fork/prompt/permissions schemas present | **no** | Permission enforcement, busy safety, correlation and isolation not proven; disabled |

## What this application is not

Upstream access remains read-only. This build cannot execute, cancel, retry or
dispatch source work, answer permissions, edit edges or modify upstream
configuration. Local auth/job writes are not upstream mutations. Future tracker
and dispatcher interfaces remain declarations, not implemented controls.

## Narrow task-question capability

The installed schema exposes creation with identity/metadata/permissions and
prompt admission with message identity/metadata. Fork accepts only `before`, so
it cannot atomically receive restrictive permissions or caller-selected identity.
Schema availability alone does not establish effective deny precedence, plugin
and tool enforcement, source-session busy safety, correlation or exclusion from
collection. No mutation smoke test was safe to justify from this evidence.

Consequently **Ask about this task remains disabled**, with an explicit UI/API
reason. The authenticated same-origin web route only records bounded, redacted,
idempotent terminal blocked jobs. The separate worker performs local recovery and
retention; it has no upstream mutation adapter. The investigation registry is a
prerequisite seam, not proof of a working publication barrier. Supplying
credentials or an environment flag cannot enable question execution. See
`task-questions.md` for guarantees and the verification required before enablement.

The observation workspace is independently usable through the authenticated local
`/api/workspace`, `/api/workspace/graph` and `/api/workspace/detail` endpoints.
Complete retained scope is distinct from complete upstream history. Local SSE
invalidates snapshots and polling continues. `/demo` is explicitly synthetic,
owner-gated and isolated from telemetry; failed observation reads never fall back
to it. Transient same-scope errors retain visibly stale data; scope changes and
authorization denial clear protected prior-scope content.
