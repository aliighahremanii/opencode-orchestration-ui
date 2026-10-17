import { afterEach, describe, expect, it } from "vitest";
import { createTestDb,cleanupTempDirs,fixtureDir } from "../helpers/harness.ts";
import { bindSessionOrigin,persistWorkspaceIdentity,projectScopeMap,reconcileAssignments } from "../../lib/db/workspace.ts";
import { upsertLocation,upsertSession,replaceRootRuns,replaceRunSessions,upsertInvocation,upsertActivityEvent } from "../../lib/db/repositories.ts";
import { buildRunTree,fromStoredSession } from "../../lib/collector/normalize.ts";
import { readAssignmentDetail,readRunGraph,readWorkspaceCatalog } from "../../lib/http/workspace.ts";
import { execute,queryOne,type Db } from "../../lib/db/driver.ts";
import type { Session } from "../../lib/domain/types.ts";
import { recordQuestion,recoverQuestionJobs } from "../../lib/db/questions.ts";
import { locationIdFor,observedSessionIdFor,runCycle } from "../../lib/collector/collector.ts";
import { FixtureUpstreamSource } from "../../lib/upstream/fixture-source.ts";
import type { UpstreamSource } from "../../lib/upstream/source.ts";
import type { UpstreamUserMessage } from "../../lib/upstream/schema.ts";

afterEach(cleanupTempDirs);
function location(db:Db,id="loc",project="upstream-project",root="/projects/atlas",connectionId="connection") {
  upsertLocation(db,{id,directory:`${root}/${id}`,projectId:project,canonical:root,subpath:null,source:"fixture",seenAt:10});
  persistWorkspaceIdentity(db,{locationId:id,connectionId,source:"fixture",projectId:project,directory:`${root}/${id}`,project:{id:project,root,name:null},metadata:{branch:null,vcsState:"unknown",worktreeState:"unknown"},now:10});
}
function session(db:Db,id:string,parentId:string|null=null,locationId="loc",projectId="upstream-project"):Session {
  const s:Session={id,parentId,locationId,projectId,agentId:"implementer",modelProviderId:null,modelId:null,title:`Task ${id}`,subpath:null,upstreamOutcome:null,timeCreated:10,timeUpdated:20,timeIdle:null,timeArchived:null,source:"fixture"};
  upsertSession(db,{...s,seenAt:10});return s;
}
function forest(db:Db,sessions:Session[]) {const scopes=projectScopeMap(db);const tree=buildRunTree(sessions.map(s=>({...fromStoredSession(s),...scopes.get(s.locationId)})),{now:20});replaceRootRuns(db,tree.runs);replaceRunSessions(db,tree.memberships);reconcileAssignments(db);return tree;}
function turn(db:Db,s:Session,runId:string,n:number,agent="implementer") {
  upsertInvocation(db,{id:`inv-${s.id}-${n}`,runId,sessionId:s.id,locationId:s.locationId,agentId:agent,modelProviderId:null,modelId:null,startedAt:n,endedAt:null,triggerMessageId:`trigger-${n}`,assistantMessageId:`msg_${n}`,toolCallCount:1,upstreamOutcome:null,confidence:"verified",evidenceJson:'{"rule":"assistant-message-agent-field"}',source:"fixture",seenAt:30});
}
function event(db:Db,s:Session,runId:string,n:number,actorAgentId:string|null="implementer") {upsertActivityEvent(db,{id:`event-${s.id}-${n}`,dedupeKey:`key-${s.id}-${n}`,locationId:s.locationId,sessionId:s.id,runId,kind:"message-assistant",messageId:`msg_${n}`,partIndex:0,sequence:n,occurredAt:n,actorAgentId,toolName:null,toolStatus:null,summary:`Evidence ${n}`,content:`Evidence ${n}`,truncated:false,redacted:false,upstreamOutcome:null,source:"fixture"},30);}

describe("observed workspace projections",()=>{
  it("preserves detail cursors through identical collector replay but expires on same-count content edits",async()=>{
    const t=createTestDb();try{
      const fixture=new FixtureUpstreamSource({fixtureDir:fixtureDir(),shiftToNow:false});
      const sample=(await fixture.listSessions({cursor:null,limit:1})).sessions[0];
      let messages:UpstreamUserMessage[]=Array.from({length:251},(_,i)=>({id:`msg_replay_${i}`,type:"user",created:1000+i,text:`Evidence ${i}`}));
      const source:UpstreamSource={kind:"fixture",description:"Replay regression",getServerInfo:()=>fixture.getServerInfo(),listLocations:()=>fixture.listLocations(),listAgents:d=>fixture.listAgents(d),listSessions:async()=>({sessions:[sample],nextCursor:null}),listMessages:async()=>({messages,nextCursor:null,unknownTypes:[]})};
      let now=2_000_000;
      const deps={db:t.db,source,now:()=>now,config:{pollIntervalMs:5000,leaseTtlMs:60000,sessionPageLimit:1000,messagePageLimit:1000,maxSessionsPerLocation:1000,contentMaxChars:4000},log:{info(){},warn(){},error(){}}};
      expect((await runCycle(deps,"cursor-test"))?.ok).toBe(true);
      const run=readWorkspaceCatalog(t.db).runs[0];const assignment=readRunGraph(t.db,run.projectId,run.id).assignments[0];
      const first=readAssignmentDetail(t.db,run.projectId,run.id,assignment.id,null);
      expect(first.nextCursor).not.toBeNull();
      const before=queryOne<{n:number}>(t.db,"SELECT MAX(ingested_at) AS n FROM activity_events")!.n;
      now+=5000;expect((await runCycle(deps,"cursor-test"))?.ok).toBe(true);
      expect(queryOne<{n:number}>(t.db,"SELECT MAX(ingested_at) AS n FROM activity_events")!.n).toBeGreaterThan(before);
      const second=readAssignmentDetail(t.db,run.projectId,run.id,assignment.id,first.nextCursor);
      expect(second.generation).toBe(first.generation);expect(second.items).toHaveLength(100);
      messages=messages.map((m,i)=>i===0?{...m,text:"Changed retained content, same identity/count/time"}:m);
      now+=5000;expect((await runCycle(deps,"cursor-test"))?.ok).toBe(true);
      expect(()=>readAssignmentDetail(t.db,run.projectId,run.id,assignment.id,second.nextCursor)).toThrow("Detail changed");
      const updated=readAssignmentDetail(t.db,run.projectId,run.id,assignment.id,null);
      expect(updated.generation).not.toBe(first.generation);
      // Membership edits invalidate the scope even when all evidence is unchanged.
      execute(t.db,"UPDATE run_sessions SET depth=depth+1 WHERE session_id=?",[assignment.sessionId]);
      expect(()=>readAssignmentDetail(t.db,run.projectId,run.id,assignment.id,updated.nextCursor)).toThrow("Detail changed");
    }finally{t.close();}
  });
  it("namespaces upstream location/session identities by connection and source",()=>{
    expect(locationIdFor("/same","connection-a","upstream")).not.toBe(locationIdFor("/same","connection-b","upstream"));
    expect(locationIdFor("/same","connection-a","upstream")).not.toBe(locationIdFor("/same","connection-a","fixture"));
    expect(observedSessionIdFor("ses_same","connection-a","upstream")).not.toBe(observedSessionIdFor("ses_same","connection-b","upstream"));
    expect(observedSessionIdFor("ses_same","connection-a","upstream")).toBe(observedSessionIdFor("ses_same","connection-a","upstream"));
  });
  it("does not truncate a scope containing more than 200 assignments",()=>{const t=createTestDb();try{
    location(t.db);const root=session(t.db,"ses_root");const children=Array.from({length:205},(_,i)=>session(t.db,`ses_child_${i}`,root.id));const tree=forest(t.db,[root,...children]);const p=readWorkspaceCatalog(t.db).projects[0].id;const graph=readRunGraph(t.db,p,tree.runs[0].id);
    expect(graph.assignments).toHaveLength(206);expect(graph.edges).toHaveLength(205);expect(graph.coverage.topology).toBe("complete-stored-scope");
  }finally{t.close();}});
  it("keeps nine distinct turns in one stable session grouping; never merges parallel agents",()=>{const t=createTestDb();try{
    location(t.db);const s=session(t.db,"ses_root");const parallel=session(t.db,"ses_parallel","ses_root");const reviewer=session(t.db,"ses_review","ses_root");const unknown=session(t.db,"ses_unknown","ses_root");const tree=forest(t.db,[s,parallel,reviewer,unknown]);const run=tree.runs[0].id;
    for(let i=0;i<9;i++)turn(t.db,s,run,i);turn(t.db,parallel,run,1);turn(t.db,reviewer,run,1,"Reviewer");event(t.db,unknown,run,1,null);
    const p=readWorkspaceCatalog(t.db).projects[0].id;const graph=readRunGraph(t.db,p,run);
    expect(graph.assignments).toHaveLength(4);expect(graph.assignments.find(a=>a.sessionId===s.id)?.turnCount).toBe(9);expect(graph.assignments.find(a=>a.sessionId===reviewer.id)?.agents).toEqual(["Reviewer"]);expect(graph.assignments.find(a=>a.sessionId===unknown.id)?.agents).toEqual(["Unknown attribution"]);expect(graph.edges).toHaveLength(3);
    const before=graph.assignments.map(a=>a.id);forest(t.db,[s,parallel,reviewer,unknown]);expect(readRunGraph(t.db,p,run).assignments.map(a=>a.id)).toEqual(before);
  }finally{t.close();}});
  it("returns an old scoped graph despite >100 unrelated runs and pages >200 detail records",()=>{const t=createTestDb();try{
    location(t.db);const sessions=Array.from({length:122},(_,i)=>session(t.db,`ses_${i}`));const tree=forest(t.db,sessions);const run=tree.runs.find(r=>r.rootSessionId===sessions[0].id)!.id;const p=readWorkspaceCatalog(t.db).projects[0].id;
    for(let i=0;i<251;i++)event(t.db,sessions[0],run,i);
    const graph=readRunGraph(t.db,p,run);expect(graph.assignments).toHaveLength(1);expect(graph.assignments[0].activityCount).toBe(251);
    let cursor:string|null=null;const ids:string[]=[];do{const page=readAssignmentDetail(t.db,p,run,graph.assignments[0].id,cursor);ids.push(...page.items.map(e=>e.id));cursor=page.nextCursor;}while(cursor);
    expect(new Set(ids).size).toBe(251);const first=readAssignmentDetail(t.db,p,run,graph.assignments[0].id,null);event(t.db,sessions[0],run,252);expect(()=>readAssignmentDetail(t.db,p,run,graph.assignments[0].id,first.nextCursor)).toThrow("Detail changed");
    expect(()=>readRunGraph(t.db,"unrelated-project",run)).toThrow();expect(()=>readRunGraph(t.db,p,run,"unrelated-workspace")).toThrow();
  }finally{t.close();}});
  it("accepts verified same-project ancestry across locations, protects unknown/conflicting/cyclic boundaries",()=>{const t=createTestDb();try{
    location(t.db);location(t.db,"worktree");location(t.db,"unrelated","different");const root=session(t.db,"ses_root");const child=session(t.db,"ses_child",root.id,"worktree");const unrelated=session(t.db,"ses_other",root.id,"unrelated","different");
    const tree=forest(t.db,[root,child,unrelated]);expect(tree.runs).toHaveLength(2);expect(tree.runs.find(r=>r.rootSessionId===root.id)?.sessionCount).toBe(2);expect(tree.crossLocation).toHaveLength(1);
    const unknown=buildRunTree([fromStoredSession(root),fromStoredSession(child)],{now:20});expect(unknown.runs).toHaveLength(2);
    const cycle=buildRunTree([fromStoredSession({...root,parentId:child.id}),fromStoredSession({...child,locationId:root.locationId})],{now:20});expect(cycle.cycles.length).toBeGreaterThan(0);
    bindSessionOrigin(t.db,root.id,"one","fixture");expect(()=>bindSessionOrigin(t.db,root.id,"two","fixture")).toThrow("conflicts");expect(()=>bindSessionOrigin(t.db,root.id,"one","upstream")).toThrow("conflicts");
  }finally{t.close();}});
  it("uses friendly disambiguated labels, Other locations, persisted aliases and unknown VCS",()=>{const t=createTestDb();try{
    location(t.db,"a","p1","/projects/atlas");location(t.db,"b","p2","/elsewhere/atlas");location(t.db,"c","p3","/root/.config/opencode");
    let c=readWorkspaceCatalog(t.db);expect(c.projects.filter(p=>p.label.startsWith("atlas ·"))).toHaveLength(2);expect(c.projects.find(p=>p.root?.includes(".config"))?.other).toBe(true);expect(c.workspaces.every(w=>w.branch===null&&w.vcsState==="unknown")).toBe(true);
    execute(t.db,"UPDATE observed_projects SET alias='My friendly project' WHERE id=?",[c.projects[0].id]);c=readWorkspaceCatalog(t.db);expect(c.projects[0].label).toBe("My friendly project");
  }finally{t.close();}});
});

describe("question fail-closed durable boundary",()=>{
  it("is idempotent, bounded, redacted and rate limited without sending upstream",()=>{const t=createTestDb();try{
    location(t.db);const s=session(t.db,"ses_root");forest(t.db,[s]);const assignmentId=queryOne<{id:string}>(t.db,"SELECT id FROM observed_assignments")!.id;
    const input={assignmentId,question:"Explain this task password=not-a-real-secret",requestKey:"request_1234567890"};const first=recordQuestion(t.db,"owner",input,100);expect(first.state).toBe("blocked");expect(recordQuestion(t.db,"owner",input,101)).toEqual(first);expect(()=>recordQuestion(t.db,"owner",{...input,question:"changed"},101)).toThrow("different question");
    expect(queryOne<{question:string}>(t.db,"SELECT question FROM question_jobs")!.question).not.toContain("not-a-real-secret");
    for(let i=1;i<5;i++)recordQuestion(t.db,"owner",{...input,requestKey:`request_123456789${i}`},100);expect(()=>recordQuestion(t.db,"owner",{...input,requestKey:"request_1234567899"},100)).toThrow("limit");
    expect(()=>recordQuestion(t.db,"owner",{...input,question:"x".repeat(4001)},100)).toThrow("Invalid");expect(()=>recordQuestion(t.db,"owner",{...input,assignmentId:"other",requestKey:"request_other_1234"},100)).toThrow("unavailable");
  }finally{t.close();}});
  it("does not retry ambiguous mutations after a crash and excludes registered investigations",()=>{const t=createTestDb();try{
    location(t.db);const s=session(t.db,"ses_root");const investigation=session(t.db,"ses_question");const tree=forest(t.db,[s,investigation]);const assignmentId=queryOne<{id:string}>(t.db,"SELECT id FROM observed_assignments WHERE session_id=?",[s.id])!.id;
    const job=recordQuestion(t.db,"owner",{assignmentId,question:"Why?",requestKey:"request_1234567890"},100);execute(t.db,"UPDATE question_jobs SET state='sending' WHERE id=?",[job.id]);recoverQuestionJobs(t.db,200);recoverQuestionJobs(t.db,300);expect(queryOne<{state:string}>(t.db,"SELECT state FROM question_jobs WHERE id=?",[job.id])!.state).toBe("ambiguous");
    execute(t.db,"INSERT INTO investigation_sessions VALUES(?,?,?,?,?,?,?)",[investigation.id,job.id,"connection","fixture",assignmentId,"task-investigation",100]);const p=readWorkspaceCatalog(t.db).projects[0].id;const run=tree.runs.find(r=>r.rootSessionId===investigation.id)!.id;expect(readRunGraph(t.db,p,run).assignments).toEqual([]);
  }finally{t.close();}});
});
