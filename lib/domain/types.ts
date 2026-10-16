/**
 * Ubiquitous language for the OpenCode orchestration observer.
 *
 * The terms below are the canonical vocabulary used by the collector, the
 * persistence layer, the HTTP API, and the dashboard. See
 * `docs/domain-model.md` for the prose definitions and the
 * evidence rules that decide which of these records may be created.
 *
 * A recurring distinction the whole system depends on:
 *
 * - An `AgentDefinition` is a *declaration*. It is never evidence that work ran.
 * - An `Invocation` requires observed message evidence and may never be derived
 *   from an agent definition or from the mere existence of a child session.
 * - `UpstreamState` (what OpenCode reports) is not `WorkflowOutcome` (whether the
 *   user's work succeeded). Only an explicit upstream report may be shown as an
 *   upstream-reported state, and it is always labelled as such.
 */

/** Where the observed data came from. */
export type ObservationSource = "upstream" | "fixture";

/** Confidence attached to a derived record. */
export type Confidence =
  /** Directly observed fields on a single upstream record. */
  | "verified"
  /** Derived by joining observed records; the join rule is recorded as evidence. */
  | "derived"
  /** The evidence required for a stronger claim is absent. */
  | "unknown";

/** A configured OpenCode HTTP server this observer talks to. */
export interface Connection {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly mode: "fixture" | "live";
  readonly createdAt: number;
}

/** A project context ("location") as reported by the upstream instance. */
export interface ProjectContext {
  readonly id: string;
  readonly directory: string;
  readonly canonical: string;
}

/** A location = project context + optional sub-path + working directory. */
export interface Location {
  readonly id: string;
  readonly directory: string;
  readonly projectId: string;
  readonly canonical: string;
  readonly subpath: string | null;
  readonly source: ObservationSource;
}

/**
 * An agent as currently effective for a location. Discovered from the API, not
 * from files on disk. A definition never implies an execution.
 *
 * `active` reflects the most recent successful location snapshot: an agent that
 * the API no longer reports is retained as history (`active: false`) rather than
 * deleted, so its observed invocations keep their attribution while the UI stops
 * presenting it as currently effective.
 */
export interface AgentDefinition {
  readonly locationId: string;
  readonly agentId: string;
  readonly name: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
  readonly description: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly active: boolean;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly source: ObservationSource;
}

/**
 * A root run: a root session (no `parentID`) plus every session observed to
 * descend from it within the same location.
 */
export interface RootRun {
  readonly id: string;
  readonly locationId: string;
  readonly rootSessionId: string;
  readonly title: string | null;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly status: RootRunStatus;
  readonly agentId: string | null;
  readonly sessionCount: number;
  readonly source: ObservationSource;
}

/**
 * Run status is an observation summary, not a workflow verdict.
 *
 * `reported-*` values come from an explicit upstream field and are always shown
 * as upstream-reported. `recently-active` is a local recency heuristic over
 * observed session timestamps: it means the run was touched recently, and it is
 * never presented as progress or completion.
 */
export type RootRunStatus =
  | "recently-active"
  | "reported-idle"
  | "reported-succeeded"
  | "reported-failed"
  | "reported-interrupted"
  | "unknown";

/** A session as observed upstream, with the parent link used for ancestry. */
export interface Session {
  readonly id: string;
  readonly locationId: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly agentId: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly title: string | null;
  readonly subpath: string | null;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly timeIdle: number | null;
  readonly timeArchived: number | null;
  readonly source: ObservationSource;
}

/** An outcome reported by the upstream instance. Never a workflow verdict. */
export type UpstreamOutcome = "succeeded" | "failed" | "interrupted";

/**
 * An evidence-backed invocation: one agent turn observed inside a session.
 *
 * Created only when the assistant message carries an explicit `agent` field.
 * The `evidence` payload records exactly which upstream fields justified the
 * record so a reviewer can re-check the claim.
 */
export interface Invocation {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly locationId: string;
  readonly agentId: string;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly triggerMessageId: string | null;
  readonly assistantMessageId: string;
  readonly toolCallCount: number;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly confidence: Confidence;
  readonly evidence: InvocationEvidence;
  readonly source: ObservationSource;
}

/** The upstream fields that justified an `Invocation`. */
export interface InvocationEvidence {
  readonly rule: "assistant-message-agent-field";
  readonly assistantMessageId: string;
  readonly assistantMessageType: "assistant";
  readonly agentField: string;
  readonly triggerMessageId: string | null;
  readonly triggerMessageType: string | null;
  readonly toolCallIds: readonly string[];
  readonly observedAt: number;
}

/** What kind of thing an activity event describes. */
export type ActivityKind =
  | "message-user"
  | "message-assistant"
  | "message-system"
  | "message-synthetic"
  | "message-skill"
  | "message-shell"
  | "message-idle"
  | "message-compaction"
  | "agent-switched"
  | "model-switched"
  | "location-switched"
  | "tool";

/** One normalized, deduplicated, redacted unit of observable activity. */
export interface ActivityEvent {
  readonly id: string;
  readonly dedupeKey: string;
  readonly locationId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly kind: ActivityKind;
  readonly messageId: string;
  readonly partIndex: number;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly actorAgentId: string | null;
  readonly toolName: string | null;
  readonly toolStatus: "streaming" | "running" | "completed" | "error" | null;
  readonly summary: string;
  readonly content: string | null;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly source: ObservationSource;
}

/**
 * An optional progress report. Nothing in this system fabricates one: reports
 * only exist if an upstream record carries them explicitly. The future progress
 * plugin described in the docs is not implemented here.
 */
export interface ProgressReport {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly reportedAt: number;
  readonly reportedPercent: number | null;
  readonly reportedStage: string | null;
  readonly text: string;
  readonly source: ObservationSource;
}

/** A reference to a task tracked outside this observer. */
export interface TaskReference {
  readonly id: string;
  readonly runId: string;
  readonly externalSystem: string;
  readonly externalId: string;
  readonly url: string | null;
}

/**
 * A window during which the observer cannot prove it observed everything.
 *
 * Lifecycle: a gap is **opened** when coverage is lost (a pause longer than the
 * tolerance, a collector handover, or a failed cycle) and stays open across
 * repeated failed attempts. It is **closed** only once a cycle genuinely
 * succeeds, at which point `resumed` becomes true and `endedAt` is set. A gap is
 * therefore never marked resumed before success.
 */
export interface CollectionGap {
  readonly id: string;
  readonly scope: string;
  readonly stream: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly reason: string;
  readonly detectedAt: number;
  /** True only once collection has provably resumed. */
  readonly resumed: boolean;
  /** True while the window is still unresolved. */
  readonly open: boolean;
}

/**
 * A resume position for one observed stream.
 *
 * `partial` is true when the stream was only partly paged: the cursor holds the
 * position to continue from, and the stream must not be treated as fully
 * observed.
 */
export interface CollectorCheckpoint {
  readonly scope: string;
  readonly stream: string;
  readonly cursor: string | null;
  readonly lastSeenAt: number | null;
  readonly updatedAt: number;
  readonly partial: boolean;
}

/** Ownership record proving which collector process may write. */
export interface CollectorLease {
  readonly scope: string;
  readonly holderId: string;
  readonly epoch: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// Future interfaces: documented boundaries only.
//
// These types describe the seams a future tracker/dispatcher would use. They
// are intentionally unimplemented: this application is read-only and must never
// execute, cancel, or reply to upstream work.
// ---------------------------------------------------------------------------

/** Future: a source of tasks to dispatch. No implementation exists. */
export interface TaskSource {
  readonly id: string;
  readonly kind: string;
  listOpenTasks(): Promise<readonly ExternalTaskReference[]>;
}

/** Future: a task that lives in an external tracker. */
export interface ExternalTaskReference {
  readonly system: string;
  readonly externalId: string;
  readonly title: string;
  readonly url: string | null;
}

/** Future: binding of an external task to a root run. */
export interface TaskAssignment {
  readonly taskId: string;
  readonly runId: string;
  readonly assignedAt: number;
  readonly assignedBy: string;
}

/** Future: launches a run. Read-only observer must not implement this. */
export interface RunLauncher {
  launch(request: { readonly locationId: string; readonly agentId: string; readonly prompt: string }): Promise<{ readonly runId: string }>;
}

/** Future: decides which agent/model receives a task. */
export interface DispatchPolicy {
  readonly id: string;
  selectAgent(input: { readonly locationId: string; readonly task: ExternalTaskReference }): Promise<string | null>;
}

/** Future: reserves an isolated workspace for a dispatched run. */
export interface WorkspaceAllocator {
  allocate(input: { readonly locationId: string }): Promise<{ readonly directory: string }>;
  release(input: { readonly directory: string }): Promise<void>;
}
