import type { ActivityItem, CollectorHealth, GapItem } from "./api.ts";

export interface ProjectItem {
  id: string; label: string; root: string | null; source: string; connectionId: string | null;
  metadataState: string; provenance: string; observedAt: number; other: boolean; runCount: number;
}
export interface WorkspaceItem {
  id: string; projectId: string; label: string; directory: string; branch: string | null;
  vcsState: string; worktreeState: string; observedAt: number;
}
export interface RunItem { id: string; projectId: string; title: string; source: string; updatedAt: number; assignmentCount: number }
export interface WorkspaceCatalog { projects: ProjectItem[]; workspaces: WorkspaceItem[]; runs: RunItem[] }
/** This is a presentation projection, never an Invocation or external TaskAssignment. */
export interface ObservedAssignment {
  id: string; sessionId: string; workspaceId: string; title: string;
  grouping: "session-fallback"; boundaryEvidence: string; agents: string[];
  turnCount: number; activityCount: number; status: string; updatedAt: number; depth: number;
}
export interface AssignmentEdge { id: string; source: string; target: string; evidence: "session.parentID" }
export interface RunGraph {
  scope: { project: string; run: string; workspace: string | null }; generation: string; generatedAt: number;
  source: string; assignments: ObservedAssignment[]; edges: AssignmentEdge[];
  collector: CollectorHealth;
  coverage: { topology: "complete-stored-scope"; upstream: "not-proven"; partialStreams: number; gaps: GapItem[]; limitations: string[] };
  questionCapability: { enabled: false; reason: string };
}
export interface AssignmentDetail { assignmentId: string; items: ActivityItem[]; total: number; nextCursor: string | null; generation: string }
