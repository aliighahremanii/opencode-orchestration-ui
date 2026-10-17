# Ask about this task: fail-closed capability

The installed OpenCode 2.0.28 instance was authenticated using process environment
credentials on 2026-10-16. `/api/info`, `/openapi.json`, `/api/location`,
`/api/project`, `/api/session/active` and a bounded session read succeeded. No
credential file was read for this API discovery and no source session was modified.

The installed schema has 118 paths. Session creation accepts caller identity,
metadata and permissions; prompt accepts message identity/metadata and returns an
inbox record. Fork accepts only `before`, not permissions or a caller-selected
identity. Update exposes permissions but the schema alone does not establish
effective deny precedence, plugin/tool enforcement, busy safety, or isolation from
collection. No safe end-to-end read-only mode was established. **No mutating smoke
test ran; no prompt, fork, session creation or permission change was sent.**

The UI accurately disables submission. `/api/questions` still authenticates the
owner and origin, accepts only assignmentId/question/requestKey, resolves the
source server-side, and stores a terminal `blocked` job. It never queues unsafe
work. JSON bodies are capped at 18KB; questions at 4000 characters; five distinct
requests per owner per minute. A duplicate key replays the same result; a changed
request under that key is a conflict. Text is redacted before persistence.

The optional dedicated worker (`bun run question-worker`, Compose profile
`questions`) performs local recovery/retention only. Interrupted `creating` or
`sending` states become `ambiguous`, never blind mutation retries. Terminal
blocked/completed jobs without investigation associations expire after 30 days.
The passive collector remains GET-only. Browser and web have no upstream adapter.

Compose passes the same explicit `ORCH_DB_PATH` to web, collector and worker,
including a nondefault filename. The worker does not receive their credential
`env_file`; only its local database path/data directory and role are supplied.

The additive source-purpose registry reserves investigation session identity and
assignment association before collection. Registered identities are excluded from
the new graph. It is a prerequisite seam, **not proof of an enabled publication
barrier**. Before enabling any mutation, independently verify actual tool deny
enforcement, metadata/correlation and pre-registration identity, quarantine every
create/prompt ambiguity, exclude investigations from all observation counts, and
test crash/timeout recovery against that installed version. An environment flag
cannot enable this build's capability gate.
