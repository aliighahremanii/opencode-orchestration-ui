# Progress contract

How progress is (and is not) represented, and what a future progress producer
would have to satisfy.

## The problem this document exists to prevent

It is tempting to compute a progress percentage from what is observable: elapsed
time, the number of messages, the ratio of completed tool calls, whether the
session went idle. Every one of those is a **proxy**, and each fails in a
different way:

| Proxy | Why it is wrong |
| --- | --- |
| Elapsed time | A run that is thinking is not 40% done; a run that is stuck is not 80% done. |
| Message count | A single message can contain the whole task or none of it. |
| Completed tool calls | Tools succeeding says nothing about whether the *user's* work succeeded. |
| Session idle | A session can be idle because it is waiting on a human, and can be resumed later. |
| Upstream `outcome` | It reports what the upstream recorded, not whether the work was correct. |

This system therefore **does not compute progress at all**. There is no
percentage, no stage, and no completion estimate anywhere in the UI, the API, or
the database writes.

## What is shown instead

Only observable facts, each labelled with what it is:

- **Counts of observations** — sessions, invocations, activity events. These are
  "how much has been observed", not "how much is done".
- **Upstream-reported outcome**, always prefixed "Upstream reported …".
- **`recently-active`** — an explicitly local recency heuristic over observed
  session timestamps, labelled "Recently active (observed)" so it cannot be read
  as completion.
- **Run duration** — the span between first and last *observed* activity. A
  duration is not a progress fraction.
- **Collection health** — whether the collector is `running`, `stale`, or
  `stopped`, when it last *succeeded* (separately from when it last attempted),
  where its open gaps are, and which streams were only partly observed. This is
  the one thing the system *can* state authoritatively: what it has and has not
  observed.

Note what is deliberately absent from that list: there is no percentage, no
stage, and no estimate. "Observed so far" is a statement about the observer, and
it is never presented as a statement about the work. A partial transcript and an
open gap are shown as limits on what is known, not as evidence of progress.

## `ProgressReport` today

`lib/domain/types.ts` declares a `ProgressReport`, and the `progress_reports`
table exists in the schema. **Nothing writes to either.**

The table exists for one reason: if a future upstream record (or a purpose-built
plugin) carries an explicit, structured progress report, there is a defined place
to put it without a migration. Until such a record is observed and verified, the
table stays empty and the UI shows nothing.

This is deliberate. An empty table is a truthful statement; a fabricated
percentage is not.

## What a progress producer would have to satisfy

If a progress source is added later, it must meet all of the following before its
values may be displayed.

1. **Explicit, not inferred.** The value must come from a record that states
   progress. It may not be computed from time, message counts, or tool outcomes.
2. **Attributed.** The report must name the run it describes, and the UI must
   show who reported it (`source`), because a plugin's estimate is not the same
   thing as an upstream-reported state.
3. **Distinct from outcome.** A `ProgressReport` must never be rendered as, or
   used to derive, a `WorkflowOutcome`. The two fields are separate and stay
   separate.
4. **Monotonicity is not assumed.** A later report may be lower than an earlier
   one, or absent. The UI shows the latest report with its timestamp rather than
   a "high water mark".
5. **Staleness is visible.** A report older than the observation window must be
   shown with its age, never as current.
6. **Verified before it is trusted.** Following
   `docs/opencode-compatibility.md`, an unverified source is documented as
   unverified. A report from an unverified source is either not displayed or
   displayed with that status attached.
7. **Read-only.** A progress producer may report. It may not start, cancel,
   retry, or answer anything upstream.

## Why a plugin is documented rather than implemented

A small upstream plugin that emits structured progress is the most plausible
future path. It is not implemented here because:

- it would require modifying the upstream instance's configuration, which the
  approved scope explicitly excludes;
- the plugin's output shape would need to be verified against a running instance
  before any of the rules above could be satisfied;
- implementing it would mean this repository could change upstream behaviour,
  which contradicts the read-only guarantee the rest of the design depends on.

The safe intermediate step is what exists now: a declared type, a reserved table,
and a documented contract. When a verified source becomes available, it plugs
into a shape that already refuses to overclaim.
