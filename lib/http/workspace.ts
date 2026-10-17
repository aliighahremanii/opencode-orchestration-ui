import { createHash } from "node:crypto";
import { prepare, queryAll, queryOne, type Db } from "../db/driver.ts";
import { listActivity, countActivity, listOpenGaps } from "../db/repositories.ts";
import { listCheckpoints } from "../db/collection-state.ts";
import { collectorHealth, toActivityItem, toGapItem } from "./dto.ts";
import { ApiError } from "./api.ts";
import { redactPersistedField } from "../util/redact.ts";
import type { AssignmentDetail, RunGraph, WorkspaceCatalog, ObservedAssignment } from "../contracts/workspace.ts";
import { QUESTION_CAPABILITY } from "../questions/capability.ts";

function basename(value: string) { return value.replace(/\/+$/, "").split("/").pop() || "Unknown location"; }
function snapshot<T>(db: Db, read: () => T): T {
  db.exec("BEGIN");
  try { const result=read(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function readWorkspaceCatalog(db: Db): WorkspaceCatalog {
  return snapshot(db,()=>{
    const projects=queryAll<{id:string; root:string|null; display_name:string|null; alias:string|null; source:string; connection_id:string|null; metadata_state:string; provenance:string; observed_at:number; directory:string; run_count:number}>(db,
      `SELECT p.*, MIN(w.directory) AS directory, COUNT(DISTINCT r.id) AS run_count FROM observed_projects p
       JOIN workspace_identity w ON w.project_key=p.id LEFT JOIN root_runs r ON r.location_id=w.location_id
       GROUP BY p.id ORDER BY p.root,p.id`);
    const names=projects.map(p=>p.alias || p.display_name || basename(p.root ?? p.directory));
    const workspaces=queryAll<{location_id:string;project_key:string;directory:string;branch:string|null;vcs_state:string;worktree_state:string;observed_at:number}>(db,"SELECT * FROM workspace_identity ORDER BY directory,location_id");
    const runs=queryAll<{id:string;project_key:string;title:string|null;source:string;last_activity_at:number;n:number}>(db,
      `SELECT r.*,w.project_key,COUNT(a.id) AS n FROM root_runs r JOIN workspace_identity w ON w.location_id=r.location_id
       LEFT JOIN observed_assignments a ON a.run_id=r.id GROUP BY r.id ORDER BY r.last_activity_at DESC,r.id`);
    return {
      projects:projects.map((p,i)=>({id:p.id,label:redactPersistedField(names.filter(n=>n===names[i]).length>1 ? `${names[i]} · ${p.root ?? p.directory} · ${p.source}${projects.filter(x=>x.root===p.root && x.source===p.source).length>1 ? ` · location ${i+1}` : ""}` : names[i])!,root:p.root,source:p.source,connectionId:p.connection_id,metadataState:p.metadata_state,provenance:p.provenance,observedAt:p.observed_at,
        other:!p.root || /(^\/$|^\/root$|^\/home\/[^/]+$|\/\.config(?:\/|$))/.test(p.root),runCount:p.run_count})),
      workspaces:workspaces.map(w=>({id:w.location_id,projectId:w.project_key,label:basename(w.directory),directory:w.directory,branch:w.branch,vcsState:w.vcs_state,worktreeState:w.worktree_state,observedAt:w.observed_at})),
      runs:runs.map(r=>({id:r.id,projectId:r.project_key,title:r.title || "Untitled run",source:r.source,updatedAt:r.last_activity_at,assignmentCount:r.n})),
    };
  });
}

function assertScope(db: Db, project: string, run: string, workspace: string | null) {
  if (!queryOne(db,`SELECT r.id FROM root_runs r JOIN workspace_identity w ON w.location_id=r.location_id WHERE r.id=? AND w.project_key=?`,[run,project]))
    throw new ApiError(404,"scope-not-found","This project/run scope is no longer available.");
  if (workspace && !queryOne(db,"SELECT location_id FROM workspace_identity WHERE location_id=? AND project_key=?",[workspace,project]))
    throw new ApiError(404,"scope-not-found","Workspace does not belong to this project.");
}
function generation(db: Db, run: string): string {
  // Hash retained presentation/evidence, not collector bookkeeping. A complete
  // transcript replay can delete/reinsert identical rows and advances ingested_at,
  // last_seen_at and Invocation evidence.observedAt without changing any page.
  // Stream rows in stable identity order, under the caller's read transaction.
  const hash=createHash("sha256").update("workspace-content-generation-v2\n");
  const queries=[
    `SELECT s.id,s.location_id,s.project_id,s.parent_id,s.title,s.source,
       s.time_updated,s.time_idle,s.upstream_outcome,rs.depth,
       a.id AS assignment_id,a.run_id,a.grouping,a.boundary_evidence,w.project_key,
       w.connection_id,w.source AS workspace_source,
       EXISTS(SELECT 1 FROM investigation_sessions i WHERE i.session_id=s.id) AS investigation
     FROM run_sessions rs JOIN sessions s ON s.id=rs.session_id
     LEFT JOIN observed_assignments a ON a.session_id=s.id
     LEFT JOIN workspace_identity w ON w.location_id=s.location_id
     WHERE rs.run_id=? ORDER BY s.id`,
    `SELECT id,session_id,agent_id FROM invocations WHERE run_id=? ORDER BY id`,
    `SELECT id,kind,session_id,run_id,message_id,part_index,sequence,occurred_at,
       actor_agent_id,tool_name,tool_status,summary,content,truncated,redacted,
       upstream_outcome,source FROM activity_events
     WHERE session_id IN (SELECT session_id FROM run_sessions WHERE run_id=?) ORDER BY id`,
  ];
  for(const sql of queries){
    hash.update("section\n");
    for(const row of prepare(db,sql).iterate(run)) hash.update(JSON.stringify(row)).update("\n");
  }
  return hash.digest("hex").slice(0,24);
}

export function readRunGraph(db: Db, project: string, run: string, workspace: string | null = null, now=Date.now()): RunGraph {
  return snapshot(db,()=>{
    assertScope(db,project,run,workspace);
    const rows=queryAll<{id:string;session_id:string;location_id:string;title:string|null;time_updated:number;time_idle:number|null;upstream_outcome:string|null;depth:number;parent_id:string|null;boundary_evidence:string;source:string}>(db,
      `SELECT a.id,a.session_id,a.boundary_evidence,s.*,a.id AS id,rs.depth FROM observed_assignments a
       JOIN sessions s ON s.id=a.session_id JOIN run_sessions rs ON rs.session_id=s.id AND rs.run_id=a.run_id
       JOIN workspace_identity w ON w.location_id=s.location_id
       WHERE a.run_id=? AND w.project_key=? AND (? IS NULL OR s.location_id=?)
       AND NOT EXISTS(SELECT 1 FROM investigation_sessions i WHERE i.session_id=s.id)
       ORDER BY rs.depth,s.time_created,s.id`,[run,project,workspace,workspace]);
    const counts=queryAll<{session_id:string;n:number;agents:string}>(db,
      "SELECT session_id,COUNT(*) AS n,json_group_array(DISTINCT agent_id) AS agents FROM invocations WHERE run_id=? GROUP BY session_id",[run]);
    const activity=queryAll<{session_id:string;n:number;unknown:number}>(db,
      "SELECT session_id,COUNT(*) AS n,SUM(kind='message-assistant' AND actor_agent_id IS NULL) AS unknown FROM activity_events WHERE run_id=? GROUP BY session_id",[run]);
    const bySession=new Map(rows.map(r=>[r.session_id,r]));
    const turns=new Map(counts.map(r=>[r.session_id,r])); const events=new Map(activity.map(r=>[r.session_id,r]));
    const assignments:ObservedAssignment[]=rows.map(r=>{const t=turns.get(r.session_id);const e=events.get(r.session_id);return {id:r.id,sessionId:r.session_id,workspaceId:r.location_id,title:r.title || "Untitled session",grouping:"session-fallback",boundaryEvidence:r.boundary_evidence,
      agents:[...(t ? JSON.parse(t.agents) as string[] : []),...(e?.unknown ? ["Unknown attribution"] : [])].map(a=>redactPersistedField(a)!),turnCount:t?.n ?? 0,activityCount:e?.n ?? 0,status:r.upstream_outcome ? `reported-${r.upstream_outcome}` : r.time_idle ? "reported-idle" : "unknown",updatedAt:r.time_updated,depth:r.depth};});
    return {scope:{project,run,workspace},generation:generation(db,run),generatedAt:now,source:rows[0]?.source ?? "unknown",assignments,
      edges:rows.flatMap(r=>{const parent=r.parent_id ? bySession.get(r.parent_id):undefined;return parent && parent.depth<r.depth ? [{id:`parent:${r.id}`,source:parent.id,target:r.id,evidence:"session.parentID" as const}] : [];}),
      collector:collectorHealth(db,now),coverage:{topology:"complete-stored-scope",upstream:"not-proven",partialStreams:listCheckpoints(db).filter(c=>c.partial).length,gaps:listOpenGaps(db).map(toGapItem),limitations:["Session grouping: assignment lifecycle unavailable.","Complete retained scope, not a claim of complete upstream history.",...(workspace ? ["Workspace filter hides other locations and crossing edges."] : [])]},questionCapability:QUESTION_CAPABILITY};
  });
}

export function readAssignmentDetail(db:Db, project:string,run:string,assignmentId:string,cursor:string|null,kind:"conversation"|"activity"="activity"):AssignmentDetail {
  return snapshot(db,()=>{
    assertScope(db,project,run,null);
    const a=queryOne<{session_id:string}>(db,`SELECT a.session_id FROM observed_assignments a JOIN sessions s ON s.id=a.session_id JOIN workspace_identity w ON w.location_id=s.location_id WHERE a.id=? AND a.run_id=? AND w.project_key=?`,[assignmentId,run,project]);
    if (!a) throw new ApiError(404,"assignment-not-found","Assignment is not in the selected scope.");
    const gen=generation(db,run);let offset=0;
    if(cursor){try{const c=JSON.parse(Buffer.from(cursor,"base64url").toString()); if(c.assignment!==assignmentId||c.project!==project||c.run!==run||c.kind!==kind||c.generation!==gen||!Number.isSafeInteger(c.offset)||c.offset<0) throw new Error();offset=c.offset;}catch{throw new ApiError(409,"cursor-expired","Detail changed. Reload from the first page.");}}
    const query={sessionId:a.session_id,limit:100,offset};
    // Both tabs retain exact evidence; conversation filters tools on the client, not the paging cursor.
    const total=countActivity(db,query);const items=listActivity(db,query).map(toActivityItem);
    return {assignmentId,items,total,generation:gen,nextCursor:offset+items.length<total ? Buffer.from(JSON.stringify({assignment:assignmentId,project,run,kind,generation:gen,offset:offset+items.length})).toString("base64url"):null};
  });
}
