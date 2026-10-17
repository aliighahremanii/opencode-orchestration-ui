# Tracework — orchestration observation workspace

A full-viewport dark Next.js/TypeScript workspace that observes an existing OpenCode
instance: which runs exist, which sessions belong to them, which agents were
*observed* to run, and how complete the observation actually is.

This build issues only `GET` requests upstream. The narrow **Ask about this task**
capability is explicitly disabled: authenticated installed-API discovery succeeded,
but permission enforcement and collection isolation are not verified. Rejected
question jobs are durable, bounded, redacted and idempotent. No dispatch, execution,
delete, edge editing, source interruption, permission reply or configuration mutation exists.

## What it shows

| Page | Contents |
| --- | --- |
| `/` | Project sidebar, scoped run graph, session-grouping assignment cards, paged Task/Conversation/Activity inspector, coverage and optional technical drawer |
| `/demo` | Owner-authenticated synthetic graph fixture; no telemetry API/SSE or upstream calls; never a fallback for failed observation reads |
| `/overview` | Original observation counts, collector health, recent root runs, recent activity, the retained history window |
| `/runs` | Searchable, filterable root runs |
| `/runs/[rootRunId]` | Observed session hierarchy, evidence-backed invocations (with their evidence), the activity timeline, and any collection gaps overlapping the run |
| `/sessions/[sessionId]` | Observed session metadata, its invocations, and its full activity timeline |
| `/agents` | Effective agent definitions per location, each beside its observed invocation count |
| `/activity` | Searchable, filterable activity across every observed session |
| `/status` | Database state, collector liveness, checkpoints, recorded gaps, collection warnings, and the limits of this build |

Three distinctions are enforced throughout, because they are easy to get wrong:

- **A definition is not an execution.** The agent registry comes from the API,
  and is displayed with a separate count of invocations actually observed.
- **An invocation needs evidence.** It is created only from an assistant message
  carrying an explicit agent field. A child session or a session-level agent is
  not enough.
- **A reported outcome is not a verdict.** Upstream outcomes are labelled
  "Upstream reported …". Idle, silence, and successful tool calls are never
  presented as completion.

See `docs/domain-model.md` for the full vocabulary.

### Workspace interaction and verification

See [workspace interactions](docs/workspace-interactions.md) for scope navigation,
presentation persistence, evidence semantics and responsive behavior. React Flow
12 and Dagre replace the retired Three/Fiber presentation. No remote assets load.

`bun --no-env-file run test:e2e -- tests/e2e/workspace-browser.test.ts` exercises the production
build with disposable fixture data. Install Chromium using `bunx playwright install
chromium` first. Screenshots default to
`/tmp/opencode/orchestration-workspace-reset/browser/`; override with
`WORKSPACE_E2E_ARTIFACTS`. Sizes: 1440×900, 768×1024, 390×844 and a reduced-height
keyboard simulation. These are browser tests, not actual-device or screen-reader certification.

## Architecture

Web and passive collector share SQLite. The optional `questions` Compose profile
adds a separate fail-closed question recovery worker. Observation writes still
belong only to the lease-fenced collector; short local question transactions never
hold a database lock across network operations. No enabled upstream question
mutation adapter is shipped. See [question safety](docs/task-questions.md).

```
                       ┌───────────────────────────┐
   upstream OpenCode ──│ collector (GET only)      │
   127.0.0.1:4096      │  · owns a fenced lease    │
                       │  · reconciles + normalizes │
                       └─────────────┬─────────────┘
                                     │ writes
                              ┌──────▼──────┐
                              │   SQLite    │  WAL, one filesystem
                              └──────┬──────┘
                                     │ reads; local auth/job writes
                       ┌─────────────▼─────────────┐
   browser ──────────▶ │ web (Next.js)             │
   (same origin only)  │  · owner auth (fail closed)│
                       │  · observation read API    │
                       │  · blocked question jobs   │
                       │  · SSE from change log     │
                       └───────────────────────────┘
```

- **`web`** serves pages, observation reads, owner authentication and the narrow
  local question-job endpoint. It is the only thing the browser talks to. It never
  contacts upstream, and it has no code path that can.
- **`collector`** is the only observation writer. It owns a lease in the database so exactly
  one collector can write, and **every** write it makes — observations *and* its
  own metadata (state, checkpoints, gaps) — is fenced by that lease inside the
  same transaction as the write. A stale collector therefore cannot commit
  anything, and cannot overwrite the current collector's state. The lease is
  heartbeated while a cycle runs, so a long reconcile does not expire its own
  lease mid-run.
- **`SQLite`** in WAL mode on a single filesystem, so readers are not blocked by
  the writer.
- **`question-worker`** is optional and performs local job recovery/retention only.
  It shares SQLite through short transactions, never the collector lease. It does
  not create, fork, prompt or interrupt upstream sessions in this build.

### Why reconciliation instead of the event stream

The upstream event stream is documented as experimental and no exact replay
guarantee has been verified. Consuming it as the source of truth would let a
disconnect silently drop activity. Instead the collector re-reads the
authoritative session and message records each cycle; writes are idempotent, so a
disconnect costs freshness rather than data.

Coverage is measured from the last cycle that **succeeded**, never from the last
attempt, so a sustained outage cannot keep resetting the clock. A window that
cannot be proven covered is recorded as a **gap** and shown on `/status`:

- a gap is **opened** on the first failure (or when a pause exceeds the tolerance,
  or when a lease handover is detected) and stays open across repeated failures;
- cycle/lease gaps are **closed** only once a cycle genuinely succeeds. A
  location registry gap closes only after that location's successful snapshot,
  never because an unrelated location succeeded or it aged out of the fetch window.

A historical session may reference a removed directory. If its `/api/agent` read
returns HTTP 404, collection continues for other registries and all fetched
sessions/messages. Previous agent membership and its checkpoint remain unchanged;
`/status` shows a location-specific warning and open `agents:<locationId>` gap.
Until recovery, cycle health remains failed and `collector:once` exits 1, but its
counts accurately describe committed work, even before a later fatal error. Only
a typed HTTP 404 from that exact registry request is tolerated; other required
read failures remain fatal. An explicit successful empty registry still marks
previous membership inactive. Recovery closes the matching gap; its warning remains
historical, not evidence of a still-open gap.

Two further consequences of a bounded fetch:

- **Older roots survive.** The run forest is rebuilt from every *stored* session,
  not just the sessions inside the current fetch window, so a run whose root has
  aged out of the window keeps its identity and its ancestry.
- **A partial transcript is never destructive.** If the message paging bound is
  reached while upstream still has more to give, existing activity is preserved
  rather than replaced, the checkpoint keeps the cursor to continue from, and the
  stream is flagged `partial`. Activity is only replaced on a complete snapshot.

See `docs/opencode-compatibility.md`.

## Quick start (fixture mode, no upstream needed)

```bash
# 1. Install dependencies (Bun is the pinned package manager).
bun install

# 2. Configure. The owner password is required: the app fails closed without it.
cp .env.example .env
#    Set ORCH_OWNER_PASSWORD in .env for the first run, or generate a hash:
#      npm run auth:hash
#    Set ORCH_UPSTREAM_MODE=fixture to explore without an upstream instance.

# 3. Apply migrations (optional: both processes migrate on startup).
npm run migrate

# 4. Collect once from the fixtures.
npm run collector:once

# 5. Run the app.
npm run dev            # development
# or
npm run build && npm start
```

Then open <http://localhost:3000> and sign in with the owner password.

Fixture mode is labelled in the UI, so fixture data can never be mistaken for
evidence about a live instance.

> **`.env` is loaded by every entrypoint.** Next.js reads `.env` itself, and the
> Node scripts (`migrate`, `collector`, `collector:once`, `auth:hash`) are run
> with `--env-file-if-exists=.env`. This matters: without it the collector and the
> web server would resolve *different* databases and the dashboard would show
> nothing. A missing `.env` is not an error — the scripts fall back to the
> documented defaults — but the file must be present for the quickstart to point
> both processes at the same database. `tests/e2e/quickstart.test.ts` runs this
> exact sequence and asserts both processes agree on one database.

> **The build does not touch the database.** `next build` writes no data
> directory and creates no database file. That is deliberate: the data directory
> may be unwritable at build time, and a build that opened the database would
> fail there.

## Pointing at a real instance

```bash
ORCH_UPSTREAM_MODE=live
ORCH_UPSTREAM_BASE_URL=http://127.0.0.1:4096
ORCH_UPSTREAM_USERNAME=...
ORCH_UPSTREAM_PASSWORD=...
```

- Credentials are read from the **environment only**. This application never
  reads a credential file, so it will not read `/etc/opencode.env`.
- Plain `http` is accepted only for loopback or a private/`.local` host; anything
  else must be `https`.
- The collector reports a missing or rejected credential explicitly (401 from
  upstream) rather than retrying silently.
- The web process needs no upstream configuration at all.
- **Switching modes does not relabel existing data.** Runs and events carry the
  provenance they were *observed* with, so a fixture demo stays marked as a
  fixture when the collector is pointed at a live instance. If you want a clean
  live view, point `ORCH_DB_PATH` at a fresh database rather than reusing the demo
  one; the two provenances are never blended into one run.

> **Verification status.** The initial unauthenticated probes returned `401`.
> Later bounded live-read evidence and its limits are recorded in
> [OpenCode compatibility](docs/opencode-compatibility.md). The stale-location 404
> fix passed focused independent regression tests and a GET-only synthetic HTTP
> E2E through the actual one-shot collector, including failure and recovery exits.
> It has not been rerun against the user's live upstream or existing database.

## Deployment

`Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile`, and `.env.example` are
provided. No production systemd unit, Caddy configuration, or global agent was
modified by this repository.

```bash
cp .env.example .env      # then edit it
docker compose -p opencode-opencode-orchestration-ui up -d --build
```

The compose project is named `opencode-opencode-orchestration-ui` so its
containers, network, and volumes cannot collide with anything else on the host.

### Reaching a loopback upstream (important)

The host OpenCode instance binds `127.0.0.1:4096`. **A container on a Docker
bridge network cannot reach a service that listens only on the host's
`127.0.0.1`.** Inside the container, `127.0.0.1` is the container itself, and
adding a `host.docker.internal:host-gateway` alias does not help, because the
listener is not bound to the bridge interface.

Choose one of these, in order of preference:

1. **Run the collector on the host** and only the web server in Docker, with
   `ORCH_DATA_DIR` on a host directory bind-mounted into the container. This
   needs no change to the upstream bind address and keeps the security posture
   intact.
2. **Give the collector host networking** (`network_mode: host` on the
   `collector` service) and leave the web service on the bridge. The collector
   then sees the host's loopback.
3. **Bind the upstream instance to a private interface** (for example
   `--hostname 0.0.0.0` or a specific LAN address) and point
   `ORCH_UPSTREAM_BASE_URL` at it, with `ORCH_UPSTREAM_USERNAME` /
   `ORCH_UPSTREAM_PASSWORD` set. This changes the upstream's exposure, so treat
   it as a deliberate security decision and confirm credentials are required.

Options 2 and 3 change networking or upstream exposure; option 1 changes neither.

### Reverse proxy

The SSE endpoint needs response buffering disabled. The example Caddyfile sets
`flush_interval -1` for exactly that reason; without it the browser receives
nothing until the stream ends. The application also rotates the stream
(`ORCH_SSE_MAX_MS`) and the client resumes from its last sequence number, so a
proxy that closes long connections is not a problem.

Set `ORCH_PUBLIC_ORIGIN=https://<hostname>` so the application's same-origin
check accepts requests arriving on the public hostname.

### Backup, migration, upgrade

- **Backup.** The database is a single file. Use SQLite's online backup rather
  than copying the file while it is in use:
  `sqlite3 /data/orchestration.sqlite ".backup '/backup/orch-$(date +%F).sqlite'"`.
  A plain file copy is safe only while both processes are stopped.
- **Migration.** Both processes apply pending migrations on startup, guarded by a
  row lock, so concurrent starts are safe. Run `npm run migrate` to migrate
  explicitly (for example in an init container). Applied migrations are
  checksummed and immutable: modifying one is a hard error, not a silent
  divergence.
- **A migration that carries a data step is identified by a version, not only by
  its SQL.** Some migrations do their work in JavaScript rather than SQL — a
  repair of rows an earlier build wrote. Such a step has no SQL for a checksum to
  cover, so from version 4 on it must also declare a `dataStepVersion`, which is
  folded into the migration's checksum. The consequence is a rule, not a detail:
  **a data step's behaviour may only change by shipping a new migration version.**
  Editing an applied step in place would leave its recorded identity unchanged and
  an already-migrated database would silently keep the old behaviour; bumping the
  `dataStepVersion` of a step that has not shipped yet moves the checksum instead.
  Migrations 1–3 predate the rule and keep the original statements-only checksum,
  so a database that already applied them still starts.
- **Schema version 2** adds the columns that back the collection-honesty rules:
  `collector_state.last_success_at`, `collector_checkpoints.partial`,
  `agents.active`, and `collection_gaps.open`. The upgrade is additive and is
  covered by `tests/integration/migration-upgrade.test.ts`, which builds a
  version-1 database, populates it, upgrades it, and asserts both the new columns
  and the defaults chosen for pre-existing rows. The defaults are deliberate:
  an old checkpoint counts as complete (it made no partial claim), an old agent
  counts as effective (it was effective when stored), and an old gap counts as
  closed (the previous build had already marked it resumed).
- **Schema version 3** is schema-neutral: it re-runs the redactor over text an
  earlier build persisted before it recognised camelCase secret keys
  (`accessToken`, `refreshToken`, `clientSecret`). Redaction is idempotent, so the
  migration rewrites only rows that still contain a credential-shaped value and
  leaves every other field — and every row — untouched. No history is deleted:
  the repair exists because a credential already written to the database cannot
  be removed by fixing the redactor alone. The upgrade path is covered by the
  same test file, which builds a version-2 database containing camelCase secrets,
  upgrades it, and asserts they are gone while the surrounding history and the
  JSON validity of the evidence blob survive. Its data step is **frozen**: the
  migration has shipped and an installed database skips it, so the field set it
  covered is preserved exactly and later requirements are expressed as new
  migrations.
- **Schema version 4** is the second redaction remediation, and is also
  schema-neutral. It repairs every retained **display** field — the text the
  dashboard renders — rather than only the session and activity columns version 3
  knew about: `activity_events.tool_name` and `actor_agent_id`,
  `root_runs.title`, `invocations.model_provider_id`/`model_id`,
  `locations.canonical`, and the diagnostic text on `/status`. It also recognises
  the credential shapes the redactor now understands — a compound key such as
  `secretAccessKey`/`SecretKey` in camelCase, PascalCase, or snake_case, and a
  whole object or array value under a credential key, including nested and
  double-encoded forms — and it raises `activity_events.redacted` on every event
  whose display text it rewrites, so the badge matches what the row now shows.
  The flag is only ever raised, never cleared. Identity and join keys are never
  touched. The migration runs inside the migration transaction with no collection
  cycle, so a database whose collector is stopped is still sanitised the moment
  either process opens it.
- **Schema version 5** is the third redaction remediation, and is schema-neutral.
  It exists for two reasons. First, the redactor now redacts a parsed JSON fragment
  key-aware *before* the scalar rules can rewrite it, so a payload a previous pass
  left half-redacted — one credential removed, a sibling credential surviving
  because the scalar rules had made the JSON unparseable — is now fully repaired;
  version 5 re-runs the repair over version 4's whole column set so an
  already-migrated database converges on the corrected policy. It can also repair
  a payload a previous build left malformed in exactly that way, by recovering the
  bare placeholder the old ordering wrote. Second, it raises
  `activity_events.redacted` on historical rows that already carry a redaction
  marker — including rows version 3 repaired, which predate the badge entirely and
  so were left unflagged even though their text had been rewritten. The badge is
  **conservative evidence, not proof**: the marker is a literal string, so a
  message in which someone genuinely typed `[redacted]` is flagged as well. It is
  only ever raised, never cleared, and no row or field is deleted. Version 4's data
  step is deliberately left untouched — a behaviour change belongs in a new
  migration — and version 5's own step carries a `dataStepVersion` folded into its
  checksum.
- **Schema version 6** is the fourth redaction remediation, and is schema-neutral.
  A serialised tool input is a *double-encoded* document: its quotes are escaped
  (`{\"OPENAI_KEY\":\"…\"}`). The redactor previously knew only the two narrow key
  shapes in escaped content and could not parse an escaped object at all, so a
  credential written that way survived — and version 5, which ran before the fix,
  could not repair it either. The redactor now recognises an escaped document,
  consumes a whole credential-key value (nested containers included) and never
  decodes the text it rewrites, so the escaping level and every ordinary sibling
  survive byte for byte. Version 6 re-runs the same display-column repair with the
  corrected redactor, so a database that already applied version 5 converges.
  Version 5's data step is deliberately left untouched — it shipped under its own
  identity — and version 6's own step carries a `dataStepVersion` folded into its
  checksum. No row and no field is deleted.
- **Schema version 7** is the fifth redaction remediation, and is schema-neutral.
  The escaped-document repair introduced in version 6 had three gaps, each of which
  let a credential survive in stored text: it checked only values under a
  credential *key*, so a provider token or `Authorization` header in an ordinary
  sibling field was never inspected; it read `\"` as a string delimiter
  unconditionally, so a value containing an escaped quote ended early and its tail
  survived; and it required an escaped quote inside a container, so a primitive
  array under a credential key was left whole. The redactor now delimits a value by
  its decoded grammar, checks every ordinary string value as well, and fails closed
  on a value it cannot completely delimit. Version 7 re-runs the same display-column
  repair so a database that already applied version 6 converges. Version 6's data
  step is left untouched — it shipped under its own identity — and version 7's own
  step carries a `dataStepVersion` folded into its checksum.
- **Schema version 8** is the sixth redaction remediation, and is schema-neutral.
  Four further gaps in the escaped-document repair are closed. An ordinary string
  value is now inspected **recursively**, because a serialised tool input commonly
  nests one encoded document inside another and the credential can be in the inner
  one. The URL-userinfo pattern no longer caps the credential — a longer one used
  to match nothing and survive verbatim — while the scheme stays bounded so the
  scan remains linear. A malformed primitive
  (`{\"password\":123opaque-secret}`) now fails closed instead of being consumed up
  to its first non-numeric character and leaving the tail with no key in front of
  it, and a mismatched container (`[1,2}`) is no longer treated as a complete
  value. The credential-label classifier is deterministic: the trailing run is
  `(?:[A-Z][A-Za-z0-9]*)?` rather than the ambiguous `(?:[A-Z][A-Za-z0-9]*)*`,
  which divided a near-miss label exponentially (127 ms at 24 characters). Version
  8 re-runs the same display-column repair so a database that already applied
  version 7 converges. Version 7's data step is left untouched — it shipped under
  its own identity — and version 8's own step carries a `dataStepVersion` folded
  into its checksum.
- **Schema version 9** is the seventh redaction remediation, and is schema-neutral.
  Two further gaps are closed. A content containing an escaped quote used to be
  treated as fully inspected, so the **plaintext** around the quoted phrase —
  `say \"hi\" ghp_…`, `password=… and \"quoted\"` — was never checked and the
  credential survived; a fragment is now only reported as handled once every span
  has been checked, with the plaintext going through the scalar rules. And the
  camelCase credential-label classifier is a **linear parser** rather than a
  regular expression whose leading run and trailing suffix overlapped, so a
  near-miss label such as `"aSecretX".repeat(20_000)` no longer costs seconds and
  grows quadratically; the three camelCase scalar rules are linear passes for the
  same reason. Version 9 re-runs the same display-column repair so a database that
  already applied version 8 converges. Version 8's data step is left untouched — it
  shipped under its own identity — and version 9's own step carries a
  `dataStepVersion` folded into its checksum.
- **Schema version 10** is the eighth redaction remediation, and is schema-neutral.
  Two further gaps are closed. The content of an ordinary escaped string now goes
  through the whole **escaped-level pipeline** rather than the scalar rules alone,
  so a credential *assignment* inside it is found and its value consumed whether
  that value is an escaped string (`password=\"…\"`), a container
  (`password=[17,23,42,91]`) or a bare token — the scalar rules understand none of
  those. And **every** credential-label classifier is now a **linear parser**: the
  separator-delimited and environment-style shapes each had repetitions that
  overlapped around a word alternation, so a repeated label such as
  `"api_key."×n` cost seconds and grew quadratically; the camelCase shape was
  already a parser. The rules built on them — quoted, bare and escaped key/value —
  are linear passes for the same reason. Version 10 re-runs the same display-column
  repair so a database that already applied version 9 converges. Version 9's data
  step is left untouched — it shipped under its own identity — and version 10's own
  step carries a `dataStepVersion` folded into its checksum.
- **Schema version 11** is the ninth redaction remediation, and is schema-neutral.
  It completes the escaped-level **assignment grammar**. A credential assignment
  inside a decoded string is recognised with a **quoted label** and either separator
  (`'password': [1,2]`, `"api_key"=[9,9]`), not only a bare label; a **bare value
  that contains brackets** is consumed whole rather than stopping at the first `[`,
  so `password=correct[42]horse` no longer leaves `[42]horse` behind with no key in
  front of it; a **container value must be well formed and followed by a valid
  boundary**, so a mismatched closer (`password=[1,2}`) and a container followed by
  a suffix (`password=[1,2]opaque-suffix`) both fail closed instead of being
  accepted as a complete value; and a **separator-only run** is advanced as a unit
  rather than rescanned one character at a time, which was quadratic (twenty seconds
  for 40 000 characters). A container is no longer marked inspected before its
  descendants are, so a bare token inside it stays visible to the scalar complement
  pass — the walk owns only the spans it actually inspected. Version 11 re-runs the
  same display-column repair so a database that already applied version 10
  converges. Version 10's data step is left untouched — it shipped under its own
  identity — and version 11's own step carries a `dataStepVersion` folded into its
  checksum.
- **Schema version 12** is the tenth redaction remediation, and is schema-neutral.
  It closes three gaps in the escaped-level walker. First, **a value boundary must
  be complete**: a closing quote or bracket proves only that the delimited segment
  ended, not that the assignment did, so `password=""opaque-live-value` and
  `{\"password\":\"abc\"opaque-live-value}` now fail closed instead of redacting the
  delimited part and stranding the continuation with no key in front of it, while a
  clearly terminated assignment (`password="opaque-value"`) is preserved. Second, a
  **credential key carrying an escape the decoder cannot resolve** — such as
  `\uXXXX`, where `{\"access\u0054oken\":\"…\"}` is the escaped spelling of
  `accessToken` — is classified **conservatively sensitive**, so the value is
  removed whole and the raw key spelling is left byte for byte; the key decoder
  itself is unchanged. Third, the walk descends into **nested nonsensitive
  containers in a single forward pass** with a matching stack, so each container is
  visited once rather than once per enclosing level; every operation is charged to
  the shared work budget, the container depth is counted explicitly, and a
  malformed or over-budget scan fails closed. Version 12 re-runs the same
  display-column repair so a database that already applied version 11 converges.
  Version 11's data step is left untouched — it shipped under its own identity — and
  version 12's own step carries a `dataStepVersion` folded into its checksum.
- **Schema version 13** is the eleventh redaction remediation, and is schema-neutral.
  It closes five further gaps. A container value's **ordinary quoted string** is now
  skipped like the escaped form, so a brace inside it no longer closes the container
  early — `password={"value":"},opaque-live-value"}` used to end the value at the
  brace and strand the tail. The key before a structured value is found by a
  **bounded backward walk** rather than an unanchored pattern over the whole
  preceding text, so a long non-matching prefix before a valid fragment is linear
  instead of quadratic (100 000 characters took hundreds of milliseconds) and its
  work is charged to the pass budget. A key carrying an escape hidden **one layer
  deeper** — `{"access\\u0054oken":"…"}`, which is `accessToken` written with an
  escaped unicode escape — is classified **conservatively sensitive** at every
  decoding layer, so its value is removed whole and the raw key spelling is
  preserved. A **bare assignment with a quoted continuation**
  (`password=prefix"opaque-demo-suffix"`) fails closed instead of redacting the
  prefix and stranding the quoted part. And the **private-key block** rule is a
  bounded linear delimiter pass that fails closed on an incomplete block, rather
  than a pattern whose label run was retried from every position (880 000 characters
  of repeated `-----BEGIN PRIVATE KEY` took over three seconds). Version 13 re-runs
  the same display-column repair so a database that already applied version 12
  converges. Version 12's data step is left untouched — it shipped under its own
  identity — and version 13's own step carries a `dataStepVersion` folded into its
  checksum.
- **Schema version 14** is the twelfth redaction remediation, and is schema-neutral.
  It closes two gaps. The bounded preceding-key lookup is now **three-valued**: it
  reports `unresolved` when its bound was reached before the absence of a key could
  be proved, and the caller fails closed on that answer, so a long key or a long
  whitespace run before a valid fragment no longer hides the credential key and
  leaves the value in the text (the lookup used to answer "no key" and the value
  survived). And the **partial redaction an older build wrote** is recognised and
  failed closed: that build redacted a credential container by stopping at a brace
  inside its quoted string, so `password={"value":"},opaque-live-value"}` was stored
  as `password=[redacted],opaque-live-value"}`, which the current redactor accepted
  as a complete value followed by a valid `,`. Version 14 re-runs the same
  display-column repair so a database that already applied version 13 converges.
  Version 13's data step is left untouched — it shipped under its own identity — and
  version 14's own step carries a `dataStepVersion` folded into its checksum.
- **Schema version 15** is the thirteenth redaction remediation, and is
  schema-neutral. It corrects two things in version 14's legacy-partial-artifact
  recovery. Recovery now consumes the **entire** leaked remainder: whitespace is not
  a reliable boundary, and the leaked suffix may begin with or contain one, so
  `password=[redacted],first opaque-secret-suffix` and
  `password=[redacted], multi word suffix` no longer leave their tails behind (14
  stopped at the first space, or skipped entirely when the comma was followed by
  one). And recovery only runs when the text is **not** recoverable structured
  JSON, so a valid document that merely carries a bare placeholder value —
  `{"password":[redacted],"region":"us-east-1"}` — keeps its siblings and structure
  instead of having them deleted; the structural pass repairs the placeholder, and
  the bare-marker repair now covers `[redacted:uninspected]` as well. The
  `[redacted:uninspected]` marker left by version 14's partial consumption is
  recognised the same way. Version 15 re-runs the same display-column repair so a
  database that already applied version 14 converges. Version 14's data step is left
  untouched — it shipped under its own identity — and version 15's own step carries
  a `dataStepVersion` folded into its checksum.
- **Schema version 16** is the fourteenth redaction remediation, and is
  schema-neutral. It makes the legacy-partial-artifact recovery a **single bounded
  forward pass**. Version 15's recovery located the next marker with two `indexOf`
  calls per iteration, so marker-heavy text — `"[redacted] ".repeat(N)` — re-scanned
  the whole remaining suffix every time a marker turned out not to be an artifact:
  352 000 characters took most of a second and a 16 MiB field could stall a
  collector cycle. Its work was also omitted from the shared scan budget. Recovery
  now walks the text once with a monotonic cursor, charges every character it
  examines to the same allowance the structural pass uses, and **fails closed** when
  that allowance is exhausted. The stored shapes are recovered identically — the
  same artifacts are failed closed and the same JSON siblings preserved — so this
  step exists to bring a database that applied version 15 onto the current code and
  to repair any row a version-15 build left unconverted. Version 15's data step is
  left untouched — it shipped under its own identity — and version 16's own step
  carries a `dataStepVersion` folded into its checksum.
- **Schema version 17** is the fifteenth redaction remediation, and is schema-neutral.
  It closes two gaps in version 16. Recovery ran whenever the **whole** stored value
  failed to parse, so recoverable JSON **embedded in prose** was consumed:
  `config {"password":[redacted],"region":"us-east-1"}` lost `region` and everything
  after it. Recovery now **skips a recoverable JSON container**, so the structural
  pass repairs its bare markers and preserves its siblings and the surrounding text,
  while a genuine malformed artifact is still failed closed. And the recovery's scan
  is now charged to the shared budget **whether or not it changed the text** — passing
  it only on a change gave an unchanged marker-heavy value a fresh structural budget
  and under-reported the total — so the combined work fails closed when it exceeds the
  allowance. Version 17 re-runs the same display-column repair so a database that
  already applied version 16 converges. Version 16's data step is left untouched — it
  shipped under its own identity — and version 17's own step carries a
  `dataStepVersion` folded into its checksum.
- **Schema version 18** is the sixteenth redaction remediation, and is schema-neutral.
  It makes the assignment key lookup examine the key **whole**. The lookup kept only
  the **last** 64 characters of a key run, so a long credential key whose sensitive
  prefix was earlier was read as a non-credential suffix:
  `password.` + `z`.repeat(64) + `="prefix[42]suffix"` was never consumed as an
  assignment, and its quoted value was split around the `[42]` inside it, so the whole
  credential survived in the stored text. The bound is now generous enough for a
  realistic compound label, and a run that reaches it and **may continue fails
  closed** rather than being classified from a truncated suffix — a truncated suffix
  is never classified. Version 18 re-runs the same display-column repair so a database
  that already applied version 17 converges. Version 17's data step is left untouched
  — it shipped under its own identity — and version 18's own step carries a
  `dataStepVersion` folded into its checksum.
- **Redaction fails closed at its bounds.** Redacting a structured payload is
  bounded so an adversarial value cannot make the pass quadratic: a work budget
  proportional to the input, a cap on the number of JSON fragments examined, and a
  recursion-depth cap. The forward walk never rescans whitespace, so a long run of
  spaces costs the same as any other run of characters. Reaching any bound does
  **not** silently stop inspecting — the uninspected remainder is replaced by a
  bounded marker, `[redacted:uninspected]`, and the redacted flag is raised. A
  recognised assignment whose value cannot be delimited within the remaining
  budget fails closed the same way, never by consuming a partial token. The scalar
  rules are bounded too: an unbounded repetition that must be followed by a
  delimiter makes a rule quadratic, so the URL-userinfo and base64 patterns repeat
  a capped number of times. The marker
  is distinct
  from `[redacted]`: it means "the scan stopped before checking here", not "a
  credential was recognised and removed". No structurally uninspected text is
  stored, because a structure the scanner never reached may hold a credential. A
  credential assignment also owns its whole value, so a value that merely looks
  like JSON — `password="correct[42]horse"`, `clientSecret='{"value":"…"}'`,
  `OPENAI_KEY='{"value":"…"}'` — is removed as a unit rather than split at the
  brace or bracket inside it. The same label classification decides whether a
  JSON *property name* is a credential, so `{"OPENAI_KEY":"…"}` is masked exactly
  like `OPENAI_KEY="…"`, including a whole object or array value under the name.
- **Upgrade.** Rebuild the image, then restart the collector first and the web
  server second. A collector that dies without a clean shutdown is replaced after
  `ORCH_LEASE_TTL_MS`, and the handover window is recorded as a gap rather than
  being hidden.
- **Rollback.** The schema is additive; a previous image can read a newer
  database only if no migration has been applied that it does not know about.
  Otherwise it refuses to start, which is the intended behaviour. Restore from
  backup to roll back a migration.

## Development

```bash
npm run typecheck   # next typegen && tsc --noEmit
npm run lint        # eslint over application and test code (see note)
npm run lint:all    # eslint over the whole repository, including vendored files
npm run build
npm test            # unit + integration tests
npm run test:e2e    # builds, starts a real server, drives it over HTTP
npm run verify      # all of the above, in order
```

### A note on `npm run lint`

`npm run lint` is scoped to the code this project owns: `app`, `components`,
`lib`, `scripts`, `proxy.ts`, `tests`, and the Vitest configs. That scope passes
cleanly.

`npm run lint:all` lints the entire repository, and reports pre-existing errors
in `.opencode/skills/**/*.cjs` — vendored skill scripts that ship with the
repository and are not part of this application. Those files were not modified
and their errors are a pre-existing baseline, not a regression. The scoped script
exists so a green lint result means something about this project's own code;
`lint:all` remains available to see the full picture.

### Tests

| Suite | What it covers |
| --- | --- |
| `tests/unit` | Redaction and truncation (including **camelCase and compound secret keys** — `accessToken`, `secretAccessKey`, `SecretKey` — in raw/quoted/escaped forms, **whole object and array values under a credential key**, key-aware structured redaction, quoted/escaped JSON keys, quoted env values, idempotency, bounded scan), normalization (identity, dedupe, ordering, the invocation rule, outcome attribution, **per-run provenance derivation and the fixture/upstream partition**), **same-origin `?next=` validation**, payload validation (**including a structured tool input redacted before it is serialised**), config validation, password hashing, CSRF/origin, cookie policy, throttle identity, display formatting |
| `tests/integration` | Lease fencing and epoch takeover across two connections, **lease heartbeating through a cycle longer than the TTL**, **fenced collector metadata (a stale collector cannot overwrite state or checkpoints)**, migration safety, **the v1 → v2, v2 → v3, v3 → v4, v4 → v5 and v5 → v6, v6 → v7, v7 → v8, v8 → v9 and v9 → v10 upgrade paths (including camelCase-redaction reprocessing, the frozen v3 data step, the versioned data-step checksum, v4 repairing every display field and raising the activity `redacted` badge without a collection cycle, v5 converging stored data on the corrected redaction policy and flagging historical rows v3 repaired, v6 repairing a stored escaped (double-encoded) credential a pre-fix v5 left behind, v7 repairing an escaped sibling token, an escaped-quote value tail and a primitive array a pre-fix v6 left behind, v8 repairing a nested encoded document, an over-long URL userinfo and a malformed escaped primitive a pre-fix v7 left behind, v9 repairing a credential in the plaintext beside an escaped quoted phrase a pre-fix v8 left behind, and v10 repairing a credential assignment inside an escaped string a pre-fix v9 left behind)**, restart persistence, write idempotency, the change log, the collector against fixtures (orphans, cross-location links, duplicate pages, unknown message types, secrets, gap open/resume lifecycle, **partial transcripts**, **agent deactivation**, **run-reference reconciliation across a rebuilt hierarchy**, **provenance across a source switch**), auth session lifecycle |
| `tests/architecture` | No client module can reach the upstream adapter or database; web cannot reach upstream; mutating handlers are restricted to sign-in/sign-out and local question jobs; the passive adapter is GET-only; question capability is fail-closed; application code does not read credential files; no `NEXT_PUBLIC_` variable exists |
| `tests/e2e` | A real production build served by `next start`: the auth boundary, the read API, SSE resume, **SSE termination on session revocation**, **the accepted `since` cursor range**, redaction, restart persistence, fail-closed behaviour without a credential, and **the documented quickstart sequence run through the npm scripts** |

Regression coverage for each review finding lives in
`tests/integration/review-findings.test.ts`, which names the defect each block
pins down.

The HTTP E2E suite drives the server with Node's built-in `fetch`. Use
`bun --no-env-file run test` and `bun --no-env-file run test:e2e` to prevent Bun
itself from loading checkout dotenv; both Vitest configurations disable Vite dotenv
loading as well. Every E2E Next build/dev/start runs in a fresh allowlisted source
and dependency copy under the task temporary directory, with no reused checkout
build, source/config/dependency symlink back to the checkout, or inherited upstream
credentials. Child-process instrumentation rejects dotenv reads outside that
owned app directory. Synthetic canary tests and build/server audit assertions
verify this isolation. Application copies and audit files remain for review/cleaner.
Run Bun package scripts with the Node binary directory first on `PATH`: E2E Next
and SQLite processes require Node. The guard is delivered using both
`NODE_OPTIONS=--require` and `BUN_OPTIONS=--preload`; runtime markers verify loading
for each child. A missing marker reports an actionable guard/runtime error rather
than a missing audit-file ENOENT. Synthetic tests exercise native Node, native Bun,
and a Bun script wrapper launching Node without inherited credentials.
`tests/e2e/workspace-browser.test.ts` additionally uses dev-only Playwright Chromium
for rendered graph/list interaction, URL scopes, responsive screenshots, viewport
stability, stale/auth transitions and the disabled question boundary. The quickstart
suite now writes synthetic configuration only in a disposable sandbox; it does not
read, back up or replace the repository `.env`. Workspace integration regressions
cover nine turns in one grouping, attribution, identity boundaries, more than 200
assignments, more than 200 detail records, unrelated runs and question-job recovery.

## Operational notes

- **Fail closed.** With no owner credential configured, protected data access
  fails closed and the API reports `503`. There is no anonymous live-data
  fallback. `/demo` also requires an owner session, even though its records are synthetic.
- **One owner.** Sign-in is a single password. Sessions are opaque 256-bit
  tokens, stored only as a SHA-256 digest, revocable server-side, and carried in
  an HttpOnly, SameSite=Lax cookie that is marked `Secure` whenever the
  deployment is reachable over https.
- **Login throttle.** Failed sign-ins are throttled. The bucket key is **not**
  derived from client-supplied input: by default every attempt shares one
  owner-wide bucket, so an attacker cannot rotate a header to escape the limit.
  `ORCH_TRUST_PROXY_HEADERS=true` opts into per-client buckets from
  `X-Forwarded-For`, and must only be set behind a reverse proxy that overwrites
  the header. When it is set, the **last** forwarded entry is used, because that
  is the value the proxy itself appended.
- **CSRF.** State-changing requests are rejected without a same-origin `Origin`
  header, and cross-site `Sec-Fetch-Site` values are refused before the origin is
  even read. The permitted endpoints are sign-in, sign-out and the narrowly
  authenticated local question-job route. None proxies an upstream mutation.
- **Live updates.** The dashboard's change stream is served from this
  application's own durable change log, and the session is re-validated while the
  stream is open. Revoking or expiring the session ends the stream with an
  `auth-expired` event, so an already-open connection cannot keep receiving data.
  The `since` cursor accepts the full safe-integer range of the log's sequence
  column rather than an arbitrary cap.
- **Bounded, redacted history.** Stored content is capped
  (`ORCH_CONTENT_MAX_CHARS`) and credential-shaped strings are replaced before
  storage. The redactor recognises separator-delimited (`api_key`), camelCase
  (`accessToken`, `refreshToken`, `clientSecret`) and compound (`secretAccessKey`,
  `SecretKey`) key forms, in raw, quoted, escaped, and double-encoded content, and
  redacts a structured payload by key as well as by value — an opaque token under
  a credential-named key has nothing else to match on, and a whole object or
  array under such a key is replaced rather than left behind. Redaction and
  truncation are shown as badges, so a reader knows the text is incomplete.
- **Untrusted text.** All upstream-derived text is rendered as escaped React text
  children, never as HTML.
- **Provenance is per observation.** Every run carries the provenance of the
  session it was built from, never the collector's current mode, so a fixture
  demo cannot be relabelled `observed upstream` when the collector is later
  pointed at a live instance. A parent link that crosses a fixture/upstream
  boundary is not followed, so the two are never blended into one run; the link is
  reported as a warning instead.
- **Run references follow the hierarchy.** When a rebuild moves a session between
  runs — most visibly when a child first observed without its parent is later
  attached to it — the retained activity events and invocations are repointed at
  the run the session now belongs to, in the same transaction as the rebuild.
  Records for sessions outside the current fetch window, and rows a partial
  transcript did not re-read, are repointed too; no evidence is recreated or
  deleted.
- **Bounded history.** At most `ORCH_HISTORY_MAX_SESSIONS` sessions are
  reconciled per cycle, and the retained activity window is shown on the
  overview. A stream that the paging bound cut short is flagged `partial` on
  `/status`, with the cursor it will continue from.
- **Agent history.** The agent registry reflects the latest **successful** API
  snapshot per location. An agent the API stops reporting is marked inactive and
  shown as "no longer reported" rather than deleted, so the invocations already
  attributed to it keep their attribution.
- **Collector liveness.** `/status` and the overview report `running`, `stale`,
  `stopped`, or `never-started`. Liveness comes from the lease, not from a state
  row, so a cleanly stopped collector is reported as stopped rather than running.
  The last successful collection time is shown separately from the last attempt.

## Scope

Implemented: dynamic effective-agent discovery, root runs, an evidence-backed
invocation and session graph, details and timelines, historical browsing,
reliable collection with reconnect and gap state, SQLite persistence with a
dedicated GET-only collector, secure single-owner auth, namespaced project and
workspace metadata, stable session-fallback assignment projections, a complete
retained-scope React Flow graph, responsive synchronized list, paged evidence
inspector, isolated synthetic preview and Docker/Compose deployment scaffolding.
The narrow question boundary stores blocked jobs and supplies a separate local
recovery worker. Read-only investigation execution remains disabled: actual
permission enforcement and publication isolation are not verified. General
dispatch/execution/delete/edge editing are not part of this workspace.

Documented only, with no runtime implementation: the future tracker and
dispatcher interfaces (`TaskSource`, `TaskAssignment`, `RunLauncher`,
`DispatchPolicy`, `WorkspaceAllocator`) and the progress contract. See
`docs/domain-model.md` and `docs/progress-contract.md`.

## Documentation

- `docs/opencode-compatibility.md` — version evidence, what is documented versus
  verified, authentication, location/session shapes, and the events/gaps decision
- `docs/domain-model.md` — the vocabulary and the rules that decide which records
  may be created
- `docs/progress-contract.md` — how progress is (and is not) represented
- `docs/workspace-interactions.md` — scope navigation, evidence semantics and responsive presentation
- `docs/task-questions.md` — disabled capability, local job guarantees and prerequisites for safe investigations
