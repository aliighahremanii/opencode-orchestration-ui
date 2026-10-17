import { execute, queryAll, queryOne, type Db } from "./driver.ts";
import { deterministicId } from "../util/ids.ts";
import { redactPersistedField } from "../util/redact.ts";

export interface ProjectMetadata { id: string; root: string; name: string | null }
export interface WorkspaceMetadata { branch: string | null; vcsState: "verified" | "unavailable" | "unknown"; worktreeState: "verified" | "unavailable" | "unknown" }

export function persistWorkspaceIdentity(db: Db, input: {
  locationId: string; connectionId: string | null; source: string; projectId: string;
  directory: string; project: ProjectMetadata | null; metadata: WorkspaceMetadata; now: number;
}): void {
  const existing=queryOne<{connection_id:string|null;source:string;upstream_id:string}>(db,"SELECT w.connection_id,w.source,p.upstream_id FROM workspace_identity w JOIN observed_projects p ON p.id=w.project_key WHERE location_id=?",[input.locationId]);
  if(existing && (existing.source!==input.source || existing.upstream_id!==input.projectId || (existing.connection_id && existing.connection_id!==input.connectionId)))
    throw new Error("Location identity conflicts with retained connection/source; observation rejected.");
  // Unknown connections cannot establish a cross-location project boundary.
  const key = deterministicId("project", [input.connectionId ?? input.locationId, input.source, input.projectId]);
  execute(db, `INSERT INTO observed_projects(id,connection_id,source,upstream_id,root,display_name,metadata_state,provenance,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    root=COALESCE(excluded.root,root),display_name=COALESCE(excluded.display_name,display_name),
    metadata_state=CASE WHEN excluded.root IS NOT NULL THEN excluded.metadata_state ELSE metadata_state END,
    provenance=CASE WHEN excluded.root IS NOT NULL THEN excluded.provenance ELSE provenance END,
    observed_at=CASE WHEN excluded.root IS NOT NULL THEN excluded.observed_at ELSE observed_at END`, [key,input.connectionId,input.source,input.projectId,
    redactPersistedField(input.project?.root ?? null),redactPersistedField(input.project?.name ?? null),input.project ? "verified" : "unknown",
    input.project ? "upstream-project" : "session-projectID",input.now]);
  execute(db, `INSERT INTO workspace_identity(location_id,project_key,connection_id,source,directory,branch,vcs_state,worktree_state,provenance,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(location_id) DO UPDATE SET project_key=excluded.project_key,
    connection_id=excluded.connection_id,source=excluded.source,directory=excluded.directory,branch=excluded.branch,
    vcs_state=excluded.vcs_state,worktree_state=excluded.worktree_state,provenance=excluded.provenance,observed_at=excluded.observed_at`,
    [input.locationId,key,input.connectionId,input.source,redactPersistedField(input.directory),redactPersistedField(input.metadata.branch),
      input.metadata.vcsState,input.metadata.worktreeState,"upstream-location",input.now]);
}

/** Never overwrite a retained upstream identity belonging to another connection/source. */
export function bindSessionOrigin(db: Db, sessionId: string, connectionId: string, source: string, upstreamId=sessionId): void {
  const existing = queryOne<{ connection_id: string; source: string }>(db,"SELECT * FROM session_origins WHERE session_id=?",[sessionId]);
  const legacy = queryOne<{ source: string }>(db,"SELECT source FROM sessions WHERE id=?",[sessionId]);
  if ((existing && (existing.connection_id !== connectionId || existing.source !== source)) || (legacy && legacy.source !== source)) {
    throw new Error("Session identity conflicts with retained connection/source; observation rejected.");
  }
  execute(db,"INSERT OR IGNORE INTO session_origins VALUES(?,?,?,?)",[sessionId,connectionId,source,upstreamId]);
}

export function projectScopeMap(db: Db): Map<string, { projectKey: string; connectionId: string | null; upstreamProjectId:string }> {
  return new Map(queryAll<{ location_id: string; project_key: string; connection_id: string | null; upstream_id:string }>(db,
    "SELECT w.location_id,w.project_key,w.connection_id,p.upstream_id FROM workspace_identity w JOIN observed_projects p ON p.id=w.project_key").map(r=>[r.location_id,{projectKey:r.project_key,connectionId:r.connection_id,upstreamProjectId:r.upstream_id}]));
}

/** Run membership and stable assignment references commit in the same fenced transaction. */
export function reconcileAssignments(db: Db): void {
  execute(db, `INSERT INTO observed_assignments(id,session_id,run_id,grouping,boundary_evidence)
    SELECT 'assignment:' || s.source || ':' || s.id,s.id,rs.run_id,'session-fallback',
    'No verified assignment lifecycle; grouped by session, not by agent or trigger.'
    FROM sessions s JOIN run_sessions rs ON rs.session_id=s.id
    WHERE NOT EXISTS(SELECT 1 FROM investigation_sessions i WHERE i.session_id=s.id)
    ON CONFLICT(session_id) DO UPDATE SET run_id=excluded.run_id`);
}

export function investigationSessionIds(db: Db): Set<string> {
  return new Set(queryAll<{session_id:string}>(db,"SELECT session_id FROM investigation_sessions").map(r=>r.session_id));
}
