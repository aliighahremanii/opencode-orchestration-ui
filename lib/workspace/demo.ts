import type { RunGraph, WorkspaceCatalog } from "../contracts/workspace.ts";
export const DEMO_CATALOG:WorkspaceCatalog={
  projects:[{id:"demo-project",label:"Atlas platform",root:"/projects/atlas",source:"fixture",connectionId:"demo-connection",metadataState:"verified",provenance:"synthetic fixture",observedAt:1792108800000,other:false,runCount:1},
    {id:"demo-other",label:"Configuration",root:"/home/demo/.config",source:"fixture",connectionId:"demo-connection",metadataState:"verified",provenance:"synthetic fixture",observedAt:1792108800000,other:true,runCount:0}],
  workspaces:[{id:"demo-main",projectId:"demo-project",label:"atlas",directory:"/projects/atlas",branch:"main",vcsState:"verified",worktreeState:"unknown",observedAt:1792108800000},{id:"demo-review",projectId:"demo-project",label:"review",directory:"/worktrees/review",branch:"review/access",vcsState:"verified",worktreeState:"verified",observedAt:1792108800000}],
  runs:[{id:"demo-run",projectId:"demo-project",title:"Improve workspace access",source:"fixture",updatedAt:1792108800000,assignmentCount:6}],
};
const titles=["Coordinate access improvements","Investigate authorization boundaries","Implement scoped access","Review isolation guarantees","Verify recovery behavior","Unattributed session"];
const agents=[["orchestrator"],["explore"],["implementer"],["Reviewer"],["tester"],["Unknown attribution"]];
export const DEMO_GRAPH:RunGraph={
  scope:{project:"demo-project",run:"demo-run",workspace:null},generation:"synthetic-v1",generatedAt:1792108800000,source:"fixture",
  assignments:titles.map((title,i)=>({id:`demo-assignment-${i}`,sessionId:`demo-session-${i}`,workspaceId:i===3?"demo-review":"demo-main",title,grouping:"session-fallback",boundaryEvidence:"Synthetic session grouping; no assignment lifecycle claimed.",agents:agents[i],turnCount:i===2?9:i===5?0:2,activityCount:i===2?24:6,status:i===2?"unknown":"reported-idle",updatedAt:1792108800000,depth:i===0?0:i<4?1:2})),
  edges:[{id:"d1",source:"demo-assignment-0",target:"demo-assignment-1",evidence:"session.parentID"},{id:"d2",source:"demo-assignment-0",target:"demo-assignment-2",evidence:"session.parentID"},{id:"d3",source:"demo-assignment-0",target:"demo-assignment-3",evidence:"session.parentID"},{id:"d4",source:"demo-assignment-2",target:"demo-assignment-4",evidence:"session.parentID"}],
  collector:{state:"stopped",scope:"demo",holderId:null,epoch:null,lastCycleAt:null,lastCycleOk:null,lastSuccessAt:null,lastError:null,leaseExpiresAt:null},
  coverage:{topology:"complete-stored-scope",upstream:"not-proven",partialStreams:1,gaps:[],limitations:["Synthetic fixture, not live data.","Edges represent explicit session parent links, not execution order."]},
  questionCapability:{enabled:false,reason:"Fixture preview: questions are disabled. Nothing is sent upstream."},
};
