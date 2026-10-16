# OpenCode compatibility

What this observer depends on, what was verified, and what remains unverified.

The guiding rule is: **documented is not the same as verified**. Where a
capability was only read from published documentation and could not be exercised
against a running authenticated instance, it is recorded as documented-only. No
part of this application claims a live integration.

## Version evidence

| Item | Value | How it was established |
| --- | --- | --- |
| OpenCode server | `v2.0.28` | `opencode --version` on the host |
| Server bind address | `127.0.0.1:4096` | systemd unit `/etc/systemd/system/opencode.service` (`ExecStart=... opencode serve --hostname 127.0.0.1 --port 4096`) |
| Credential source | `EnvironmentFile=/etc/opencode.env` | systemd unit. **This file was never read** by this work: global policy forbids reading credential files. |
| HTTP API spec | `opencode HttpApi`, spec version `0.0.1` | `https://opencode.ai/v2/openapi.json`, fetched over the network (HTTP 200, 578,272 bytes, 118 documented paths) |
| Spec self-description | "Experimental HttpApi surface for selected instance routes." | spec `info.description` |

The spec's own description calls the surface **experimental**. That is the reason
every payload is validated at runtime rather than trusted, and the reason an
unknown message type is recorded as a gap in understanding rather than guessed
at.

## Authentication

| Aspect | Finding | Status |
| --- | --- | --- |
| Documented security schemes | `components.securitySchemes` is **empty** | Documented |
| Actual behaviour | `GET /api/health`, `/api/info`, `/api/agent`, `/api/session`, `/api/event` all returned **HTTP 401** unauthenticated | **Runtime-verified** |
| Mechanism | The spec does not describe the scheme. Official documentation describes HTTP Basic / a static password or a pairing flow. | Documented-only |
| What this application does | Sends HTTP Basic from `ORCH_UPSTREAM_USERNAME` / `ORCH_UPSTREAM_PASSWORD` **environment variables only**. It never reads a credential file. | Implemented |
| Live smoke test | **Not performed.** Exercising the authenticated surface would require a credential from `/etc/opencode.env`, which must not be read. | Not done |

### Credential handling rules this application follows

- Credentials are read from the **process environment only**. No code path reads a
  credential file, so `/etc/opencode.env` is never read even when it exists.
- The upstream credential is used by the **collector only**. The web process has no
  upstream configuration and no code path that contacts the instance.
- A rejected credential (`401`) is reported explicitly and not retried silently.
- **Failed sign-ins are throttled against a key that is not client-controlled.**
  The default bucket is owner-wide, so rotating a header cannot escape the limit.
  `X-Forwarded-For` is consulted only when `ORCH_TRUST_PROXY_HEADERS=true` is set
  explicitly, and then only its **last** entry is used, because that is the value a
  trusted proxy itself appended. A malformed forwarded value falls back to the
  owner-wide bucket, so a bad header tightens throttling rather than loosening it.

Consequence: no payload from the live instance has ever been observed by this
codebase. Every assertion about upstream shapes below rests on the published spec
plus local fixtures shaped to match it.

## Endpoints used

All upstream access is `GET`. The adapter (`lib/upstream/adapter.ts`) has no code
path that can issue another method, and an architecture test enforces it.

| Endpoint | Parameters used | Purpose |
| --- | --- | --- |
| `GET /api/info` | none | Server identity and reachability |
| `GET /api/location` | none | The default project context for the instance |
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
- it is marked **resumed** only after a cycle genuinely succeeds.

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

`lib/upstream/schema.ts` validates every payload field by field. It is forward
compatible in one direction only: unknown *extra properties* are ignored, but
every required field must be present with the documented type. A payload that
fails validation is rejected and reported (`UpstreamPayloadError`), never
coerced into a plausible-looking record.

The fixture source pushes its JSON through the **same** validators, so the
fixture path exercises validation rather than bypassing it.

## Summary of verification status

| Capability | Documented | Runtime-verified | Notes |
| --- | --- | --- | --- |
| Server reachable at `127.0.0.1:4096` | yes | yes (401 responses received) | Reachability only; no authenticated payload observed |
| Requires authentication | not described in spec | yes (401) | Scheme itself is documented-only |
| `GET /api/info` shape | yes | **no** | Validated against spec + fixtures |
| `GET /api/location` shape | yes | **no** | Same |
| `GET /api/agent` location scoping | yes | **no** | Same |
| Session hierarchy via `parentID` | yes | **no** | Same |
| Session pagination via `cursor` | yes | **no** | Same |
| Message transcript shapes | yes | **no** | Same |
| Event stream replay | **no** | no | Not relied upon |
| Exact semantics of `outcome` / `time.idle` | partial | **no** | Treated as *reported*, never as a verdict |
| Agent membership changes over time | not described | **no** | Reconciled per successful snapshot; removals retained as history |
| Transcript paging bound behaviour | not described | **no** | Bounded fetch is treated as partial, never as a complete snapshot |

## What this application is not

It is read-only. It has no capability to execute, cancel, retry, or queue work,
answer a permission request, or modify upstream configuration. There is no
scheduler, no dispatcher, and no task launcher. Those boundaries exist only as
type declarations and documentation (see `docs/domain-model.md` and
`docs/progress-contract.md`).

## Living office compatibility check (2026-10-16)

Both explicit manual dispatch operations are approved in product scope:
**create a session then submit its initial prompt**, and **submit a continuation
prompt to an existing session**. They are not implemented in this build because
the required target verification is blocked, not because the UI silently excludes
them from scope.

- The current public V2 reference still documents `POST /api/session` and
  `POST /api/session/{sessionID}/prompt` as experimental. Published documentation
  is not proof of the installed target's request/result or ambiguity semantics.
- This implementation process has no `ORCH_UPSTREAM_BASE_URL`,
  `ORCH_UPSTREAM_USERNAME` or `ORCH_UPSTREAM_PASSWORD` in its inherited environment
  (only presence was checked). No credential file was inspected or printed.
- Read-only probes to the previously documented local target
  `http://127.0.0.1:4096/openapi.json` and `/api/info` both returned **401**.
  Consequently the actual authenticated spec, accepted payloads, prompt delivery,
  duplicate-request behavior and create-then-prompt recovery could not be verified.
- **No production writes were attempted.** No mutation adapter, mutation route,
  or receipt table was added based on assumptions. The authenticated office DTO
  explicitly reports both operations unavailable, and the UI shows the reason.
  Supplying credentials alone will not enable commands in this build.

To unblock: provide an approved authenticated **process environment** and verify
the actual target spec plus an isolated disposable write-test target with the
same contract. Then implement/review the narrow owner-only adapter, origin/CSRF
checks, ambiguity reporting and any contract-justified operation identity. Do not
use a production prompt as a connectivity test or automatically retry a request.

The office itself is read-only and independently usable: `/api/office` reads local
SQLite DTOs; updates invalidate via the existing durable change log. `/demo` is
deterministic and separate from the live/fixture read path, with browser-tested
zero `/api/*` traffic from the demo view. It is owner-authenticated through the
normal proxy and database-backed server page gate; anonymous, forged and revoked
sessions cannot open it. Authentication does not connect the demo to telemetry.
It never substitutes synthetic records when live reads fail. Transient office
read failures retain an explicitly stale snapshot and presentation state;
authorization denial or an `auth-expired` stream event clears protected content.
