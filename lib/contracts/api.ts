/**
 * Wire contracts for this application's own HTTP API.
 *
 * This module is intentionally free of imports: it is the only shared surface
 * between server code and Client Components, so it must never pull in
 * `node:sqlite`, `next/headers`, or the upstream adapter. Types are erased at
 * build time, so a Client Component importing from here cannot accidentally
 * bundle server code.
 *
 * These are the *application's* shapes, not upstream shapes. Upstream records
 * are normalized and narrowed before they reach a response.
 */

export type ObservationSource = "upstream" | "fixture";
export type Confidence = "verified" | "derived" | "unknown";
export type UpstreamOutcome = "succeeded" | "failed" | "interrupted";

export type RootRunStatus =
  | "recently-active"
  | "reported-idle"
  | "reported-succeeded"
  | "reported-failed"
  | "reported-interrupted"
  | "unknown";

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

export interface ApiErrorBody {
  readonly error: string;
  readonly code: string;
  readonly detail?: string;
}

export interface PageMeta {
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

export interface Paginated<T> {
  readonly data: readonly T[];
  readonly page: PageMeta;
}

// --- overview --------------------------------------------------------------

export interface CollectorHealth {
  /**
   * `running` and `stale` come from the lease, which is the only record
   * maintained while a collector is alive. `stopped` means no lease is held
   * even though a previous cycle was recorded, so liveness is not claimed.
   */
  readonly state: "running" | "stale" | "stopped" | "never-started" | "unknown";
  readonly scope: string;
  readonly holderId: string | null;
  readonly epoch: number | null;
  /** The last cycle that ran, whether it succeeded or failed. */
  readonly lastCycleAt: number | null;
  readonly lastCycleOk: boolean | null;
  /** The last cycle that succeeded: the point coverage is measured from. */
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly leaseExpiresAt: number | null;
}

export interface OverviewResponse {
  readonly generatedAt: number;
  readonly source: {
    readonly mode: "fixture" | "live";
    readonly observationSource: ObservationSource;
    /** Never contains credentials. */
    readonly description: string;
  };
  readonly counts: {
    readonly locations: number;
    readonly agents: number;
    /** Agents the latest successful location snapshot still reports. */
    readonly agentsActive: number;
    readonly sessions: number;
    readonly rootSessions: number;
    readonly rootRuns: number;
    readonly invocations: number;
    readonly activity: number;
    readonly openGaps: number;
  };
  readonly historyWindow: {
    readonly oldestActivityAt: number | null;
    readonly newestActivityAt: number | null;
    readonly retentionNote: string;
  };
  readonly collector: CollectorHealth;
  readonly recentRuns: readonly RootRunSummary[];
  readonly recentActivity: readonly ActivityItem[];
}

// --- runs ------------------------------------------------------------------

export interface RootRunSummary {
  readonly id: string;
  readonly locationId: string;
  readonly locationDirectory: string | null;
  readonly rootSessionId: string;
  readonly title: string | null;
  readonly status: RootRunStatus;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly agentId: string | null;
  readonly sessionCount: number;
  readonly invocationCount: number;
  readonly source: ObservationSource;
}

export interface RunSessionNode {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly title: string | null;
  readonly agentId: string | null;
  readonly agentFirstSeen: string | null;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly timeIdle: number | null;
  readonly activityCount: number;
  readonly invocationCount: number;
  readonly isOrphan: boolean;
}

export interface InvocationItem {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly toolCallCount: number;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly confidence: Confidence;
  readonly evidence: unknown;
  readonly source: ObservationSource;
}

export interface RootRunDetailResponse {
  readonly run: RootRunSummary;
  readonly sessions: readonly RunSessionNode[];
  readonly invocations: readonly InvocationItem[];
  readonly activity: readonly ActivityItem[];
  readonly gaps: readonly GapItem[];
  readonly notes: readonly string[];
}

// --- activity --------------------------------------------------------------

export interface ActivityItem {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly sessionId: string;
  readonly runId: string | null;
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

// --- sessions --------------------------------------------------------------

export interface SessionSummary {
  readonly id: string;
  readonly locationId: string;
  readonly locationDirectory: string | null;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly agentId: string | null;
  readonly agentFirstSeen: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly title: string | null;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly timeIdle: number | null;
  readonly runId: string | null;
  readonly rootRunId: string | null;
  readonly source: ObservationSource;
}

export interface SessionDetailResponse {
  readonly session: SessionSummary;
  readonly invocations: readonly InvocationItem[];
  readonly activity: readonly ActivityItem[];
  readonly notes: readonly string[];
}

// --- agents ----------------------------------------------------------------

export interface AgentItem {
  readonly locationId: string;
  readonly locationDirectory: string | null;
  readonly agentId: string;
  readonly name: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
  /** Still reported by the API for this location in the latest snapshot. */
  readonly active: boolean;
  readonly description: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** Observed invocations attributed to this agent. Evidence, not definition. */
  readonly observedInvocationCount: number;
  readonly source: ObservationSource;
}

export interface AgentListResponse {
  readonly agents: readonly AgentItem[];
  readonly locations: readonly LocationItem[];
  readonly note: string;
}

export interface LocationItem {
  readonly id: string;
  readonly directory: string;
  readonly projectId: string;
  readonly canonical: string;
  readonly agentCount: number;
  readonly sessionCount: number;
  readonly source: ObservationSource;
}

// --- status ----------------------------------------------------------------

export interface GapItem {
  readonly id: string;
  readonly scope: string;
  readonly stream: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly reason: string;
  readonly detectedAt: number;
  /** True only once collection has provably resumed after this window. */
  readonly resumed: boolean;
  /** True while the coverage hole is still unresolved. */
  readonly open: boolean;
}

export interface WarningItem {
  readonly id: string;
  readonly kind: string;
  readonly detail: string;
  readonly occurrences: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface CheckpointItem {
  readonly scope: string;
  readonly stream: string;
  /** Where to continue from when the stream is partial. */
  readonly cursor: string | null;
  readonly lastSeenAt: number | null;
  readonly updatedAt: number;
  /** True when the stream was only partly paged. */
  readonly partial: boolean;
}

export interface StatusResponse {
  readonly generatedAt: number;
  readonly database: {
    readonly ready: boolean;
    readonly error: string | null;
    readonly schemaVersion: number;
    readonly expectedSchemaVersion: number;
    readonly ownerConfigured: boolean;
    readonly dbPath: string;
    readonly warnings: readonly string[];
  };
  readonly source: {
    readonly mode: "fixture" | "live";
    readonly observationSource: ObservationSource;
    readonly description: string;
  };
  readonly collector: CollectorHealth;
  readonly checkpoints: readonly CheckpointItem[];
  readonly gaps: readonly GapItem[];
  readonly warnings: readonly WarningItem[];
  readonly limitations: readonly string[];
}

// --- auth ------------------------------------------------------------------

export interface AuthSessionState {
  readonly authenticated: boolean;
  /** Whether an owner credential exists at all. */
  readonly configured: boolean;
  /** Present when the application cannot serve data. Safe for unauthenticated display. */
  readonly reason: string | null;
  readonly expiresAt: number | null;
}

export interface LoginSuccess {
  readonly ok: true;
  readonly expiresAt: number;
}

// --- change stream ---------------------------------------------------------

export interface ChangeEventPayload {
  readonly seq: number;
  readonly kind: string;
  readonly entityId: string;
  readonly scope: string;
  readonly at: number;
}

export interface EventsHelloPayload {
  readonly latestSeq: number;
  readonly resumeFrom: number;
}
