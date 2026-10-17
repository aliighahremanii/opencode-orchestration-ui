# Tracework workspace

Original branding and implementation; n8n's current node/canvas documentation was
used as interaction reference, not copied UI or execution semantics.

The 240px project rail and 56px context bar frame a dotted React Flow v12 canvas
and 380px inspector. Projects use persisted aliases, upstream display names or
directory basenames, with duplicate disambiguation. Home/configuration and unknown
project roots are under **Other locations**. IDs belong in technical details.

`project`, `run`, `workspace`, `assignment` URL parameters determine selection.
Changing scope clears the previous graph/inspector before new data arrives.
Cards are **ObservedAssignment** projections, currently explicitly labeled
session-grouping fallback because the installed schema supplies no verified task
lifecycle. Nine assistant turns stay nine Invocations inside one grouping.
Reviewer and unknown attribution are not relabeled as implementers.

Edges represent explicit observed `session.parentID` links, not execution order.
Same-project cross-location ancestry requires matching connection, source and
upstream project identity. Unknown, conflicting or cyclic ancestry is protected.
Workspace filtering hides crossing edges and discloses this limitation.

Pan, zoom, fit, find and tidy affect presentation only. Versioned local storage
contains only node positions and viewport, partitioned by scope. Existing node
positions remain stable during updates. Tidy is the explicit layout reset.
React Flow connecting, reconnecting and deletion are disabled at the component API.
There is no Delete control or menu. Delete/Backspace are suppressed when the canvas
or a node has focus (not while editing Find text). Diagram change events can only
move existing observation positions; node additions/replacements/removals and all
edge changes are ignored. Only a new scoped observation response changes topology.

The list mirrors selection for mobile and non-drag navigation. On narrow screens
the inspector replaces the list; close/Escape returns to it. Composer input uses
native multiline behavior (Enter never submits) and bounded text. Asking is
disabled with the actual reason, not a simulated successful conversation.

Graph reads cover the entire retained scope, not a global latest-100 window.
Conversation/activity detail pages contain 100 records with scope/generation-bound
cursors. Relevant retained content or membership changes invalidate old cursors
instead of silently skipping records. Identical collector replay does not: the
generation excludes ingestion/last-seen/evidence-observation timestamps and hashes
retained values in deterministic identity order inside the read transaction.
Upstream history completeness is never claimed. Gaps and partial streams remain
visible. A stopped collector remains stopped; last-success age advances each second.
Local SSE only invalidates the SQLite snapshot; 5-second polling remains active.
Transient errors retain an explicitly stale snapshot in the same scope; auth denial
discards it. `/demo` is explicit fixture-only and never replaces failed live data.
