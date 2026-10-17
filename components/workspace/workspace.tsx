"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AssignmentCanvas } from "./canvas.tsx";
import { useRunGraph } from "./use-workspace.ts";
import { useApi } from "../client/use-api.ts";
import { SignOutButton } from "../client/sign-out-button.tsx";
import type { AssignmentDetail, ObservedAssignment, RunGraph, WorkspaceCatalog } from "../../lib/contracts/workspace.ts";
import { DEMO_CATALOG, DEMO_GRAPH } from "../../lib/workspace/demo.ts";

export function Workspace({demo=false}:{demo?:boolean}) {
  const workspaceElement=useRef<HTMLElement>(null);
  useEffect(()=>{const viewport=window.visualViewport;const resize=()=>workspaceElement.current?.style.setProperty("--workspace-height",`${viewport?.height??window.innerHeight}px`);resize();viewport?.addEventListener("resize",resize);window.addEventListener("resize",resize);return ()=>{viewport?.removeEventListener("resize",resize);window.removeEventListener("resize",resize);};},[]);
  const q=useSearchParams();const router=useRouter();
  const catalogRead=useApi<WorkspaceCatalog>(demo?null:"/api/workspace",{pollMs:10000});
  const catalog=demo?DEMO_CATALOG:catalogRead.state.status==="ready"?catalogRead.state.data:null;
  const project=q.get("project")??catalog?.projects.find(p=>!p.other&&p.runCount>0)?.id??catalog?.projects.find(p=>p.runCount>0)?.id??catalog?.projects[0]?.id??"";
  const runs=catalog?.runs.filter(r=>r.projectId===project)??[];
  const run=q.get("run")??runs[0]?.id??"";const workspace=q.get("workspace");const selected=q.get("assignment");
  useEffect(()=>{if(project&&(!q.has("project")||(run&&!q.has("run")))){const next=new URLSearchParams(q.toString());next.set("project",project);if(run)next.set("run",run);router.replace(`${demo?"/demo":"/"}?${next}`,{scroll:false});}},[project,run,q,router,demo]);
  const path=project&&run?`/api/workspace/graph?${new URLSearchParams({project,run,...(workspace?{workspace}:{})})}`:null;
  const observed=useRunGraph(demo?null:path);
  const data=demo&&project==="demo-project"?{...DEMO_GRAPH,scope:{project,run,workspace},assignments:DEMO_GRAPH.assignments.filter(a=>!workspace||a.workspaceId===workspace),edges:workspace?[]:DEMO_GRAPH.edges}:observed.data;
  const denied=catalogRead.state.status==="error"&&[401,403].includes(catalogRead.state.httpStatus);
  const navigate=(values:Record<string,string|null>)=>{const next=new URLSearchParams(q.toString());for(const [k,v] of Object.entries(values)){if(v)next.set(k,v);else next.delete(k);}router.replace(`${demo?"/demo":"/"}?${next}`,{scroll:false});};
  const [search,setSearch]=useState("");const [projectsOpen,setProjectsOpen]=useState(false);const [listMode,setListMode]=useState(false);const [technical,setTechnical]=useState(false);
  const [now,setNow]=useState<number|null>(null);useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  const currentProject=catalog?.projects.find(p=>p.id===project);
  const a=data?.assignments.find(a=>a.id===selected);
  const lastSelection=useRef<string|null>(null);
  useEffect(()=>{if(selected)lastSelection.current=selected;else if(lastSelection.current){const button=document.querySelector<HTMLButtonElement>(`[data-assignment="${CSS.escape(lastSelection.current)}"]`);button?.focus();lastSelection.current=null;}},[selected]);
  const scopeKey=`${project}:${run}:${workspace??"all"}`;
  const select=(id:string)=>navigate({project,run,workspace,assignment:id});
  if(denied||observed.error==="Sign-in required.")return <main className="workspace-denied"><h1>Sign-in required</h1><Link href="/login">Sign in to continue</Link></main>;
  return <main ref={workspaceElement} className={`workspace ${projectsOpen?"projects-open":""} ${a?"inspector-open":""}`} id="main-content" data-mode={demo?"demo":"observed"}>
    <aside className="project-sidebar" aria-label="Projects">
      <Link className="workspace-brand" href="/" prefetch={false}><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M4 7h8v6h12M12 13v8h12" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="4" cy="7" r="3" fill="currentColor"/><circle cx="24" cy="13" r="3" fill="currentColor"/><circle cx="24" cy="21" r="3" fill="currentColor"/></svg>tracework<span>OBSERVE</span></Link>
      <div className="sidebar-content"><div className="sidebar-heading">WORKSPACE <span>01</span></div><input type="search" aria-label="Search projects" placeholder="Search projects…" value={search} onChange={e=>setSearch(e.target.value)}/>
      {[false,true].map(other=><section key={String(other)}><h2>{other?"Other locations":"Projects"}</h2>{catalog?.projects.filter(p=>p.other===other&&`${p.label} ${p.root}`.toLowerCase().includes(search.toLowerCase())).map(p=><button key={p.id} className={`project-row ${project===p.id?"active":""}`} aria-pressed={project===p.id} onClick={()=>{navigate({project:p.id,run:null,workspace:null,assignment:null});setProjectsOpen(false);}}><span className="project-symbol" aria-hidden="true">{p.label.slice(0,1).toUpperCase()}</span><span>{p.label}<small>{p.source==="fixture"?"Fixture observations":"Observed project"}</small></span><b>{p.runCount}</b></button>)}</section>)}
      {!catalog&&<p role="status">{catalogRead.state.status==="error"?catalogRead.state.message:"Loading projects…"}</p>}
      <div className="sidebar-note">Evidence before inference.<br/>Navigate work. Never dispatch it.</div></div>
      <div className="sidebar-footer"><Link href="/status">Collection health ↗</Link>{!demo&&<SignOutButton/>}<Link href={demo?"/":"/demo"}>{demo?"Observed workspace":"Fixture preview"}</Link></div>
    </aside>
    <section className="workspace-main">
      <header className="workspace-topbar"><button className="projects-toggle" aria-expanded={projectsOpen} onClick={()=>setProjectsOpen(v=>!v)}>Projects</button><span className="context-project">{currentProject?.label??"Workspace"}</span><span className="context-divider">/</span><select aria-label="Run" value={run} onChange={e=>navigate({project,run:e.target.value,assignment:null})}>{!runs.length&&<option value="">No observed runs</option>}{runs.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select><span className="observation-badge">{demo?"FIXTURE PREVIEW":data?.source==="fixture"?"FIXTURE":"OBSERVED"}</span></header>
      <div className="scopebar"><div><span className="section-label">RUN GRAPH</span><span className="scope-count">{data?.assignments.length??0} session groupings</span></div><select aria-label="Workspace location" value={workspace??""} onChange={e=>navigate({project,run,workspace:e.target.value||null,assignment:null})}><option value="">All workspaces</option>{catalog?.workspaces.filter(w=>w.projectId===project).map(w=><option key={w.id} value={w.id}>{w.label}{w.branch?` · ${w.branch}`:" · branch unknown"}</option>)}</select><button aria-pressed={listMode} onClick={()=>setListMode(v=>!v)}>{listMode?"Canvas":"List"}</button><button aria-label="Refresh observations" onClick={()=>{observed.refresh();catalogRead.refresh();}}>↻</button><button aria-expanded={technical} onClick={()=>setTechnical(v=>!v)}>Technical</button></div>
      <div className="graph-body">
        <section className={`graph-region ${listMode?"list-mode":""}`} aria-label="Run observation">
          {observed.error&&<div className="workspace-alert" role="alert">{data?"STALE · LAST KNOWN SNAPSHOT — ":""}{observed.error}</div>}
          {data?<><div className="canvas-view"><AssignmentCanvas key={scopeKey} data={data} selected={selected} onSelect={select}/></div><div className="assignment-list" aria-label="Assignments"><h2>Observed assignments <small>Session grouping fallback</small></h2>{data.assignments.map(item=><button key={item.id} data-assignment={item.id} aria-pressed={selected===item.id} onClick={()=>select(item.id)}><span>{item.agents.join(" · ")||"Unknown attribution"}</span><strong>{item.title}</strong><small>{item.turnCount} turns · {item.status.replace("reported-","Reported ")}</small></button>)}</div></>:<div className="workspace-empty"><span className="empty-glyph" aria-hidden="true">◇</span><h1>{!run?"Choose an observed run":"Loading this scope"}</h1><p>{!run?"Projects and runs appear after collection. No synthetic data is substituted.":"Retrieving the retained graph and its evidence…"}</p></div>}
          <div className="freshness" role="status"><span className="status-dot"/>{demo?"Synthetic fixture · not live":`Collector ${data?.collector.state??"unknown"}`}{data?.collector.lastSuccessAt&&<span>Last success {Math.max(0,Math.floor(((now??data.generatedAt)-data.collector.lastSuccessAt)/1000))}s ago</span>}<span>{!demo&&(observed.connected?"Local updates connected":"Polling · local updates disconnected")}</span><span>{data?.coverage.partialStreams??0} partial streams · {data?.coverage.gaps.length??0} open gaps</span></div>
        </section>
        <Inspector key={`${scopeKey}:${selected??"none"}`} assignment={a} data={data} demo={demo} onClose={()=>navigate({assignment:null})}/>
      </div>
      {technical&&<section className="technical-drawer" aria-label="Technical evidence"><button onClick={()=>setTechnical(false)}>Close technical details</button><p>Local SSE invalidates stored observations; it is not the upstream event stream. Polling continues.</p><p>{data?.coverage.limitations.join(" ")}</p><dl><dt>Project identity</dt><dd>{project||"Unknown"}</dd><dt>Authoritative root</dt><dd>{currentProject?.root??"Unknown"}</dd><dt>Provenance</dt><dd>{currentProject?.provenance??"Unknown"} · {currentProject?.metadataState??"unknown"}</dd><dt>Run / generation</dt><dd>{run} / {data?.generation??"unknown"}</dd></dl>{data?.coverage.gaps.map(g=><p key={g.id}>{g.reason}</p>)}</section>}
    </section>
  </main>;
}

function Inspector({assignment:a,data,demo,onClose}:{assignment:ObservedAssignment|undefined;data:RunGraph|null;demo:boolean;onClose:()=>void}) {
  const [tab,setTab]=useState<"task"|"conversation"|"activity">("task");const [cursor,setCursor]=useState<string|null>(null);
  const detailPath=!demo&&a&&data&&tab!=="task"?`/api/workspace/detail?${new URLSearchParams({project:data.scope.project,run:data.scope.run,assignment:a.id,kind:tab,...(cursor?{cursor}:{})})}`:null;
  const detail=useApi<AssignmentDetail>(detailPath,{pollMs:cursor?undefined:5000});
  const [question,setQuestion]=useState("");
  const title=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{title.current?.focus();},[a?.id]);
  useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();};window.addEventListener("keydown",close);return ()=>window.removeEventListener("keydown",close);},[onClose]);
  return <aside className="task-inspector" aria-label="Task inspector"><div className="inspector-heading"><span>INSPECTOR</span>{a&&<button aria-label="Close task inspector" onClick={onClose}>×</button>}</div>
    {!a?<div className="inspector-placeholder"><span aria-hidden="true">⌖</span><h2>Follow the evidence</h2><p>Select a node to explore its task context, conversation and observed activity.</p><p>Each card is a session grouping. Multiple turns do not imply multiple assignments.</p></div>:<><div className="inspector-title"><span className="section-label">{a.agents.join(" · ")||"Unknown attribution"}</span><h1 ref={title} tabIndex={-1}>{a.title}</h1><span className="grouping-label">Session grouping · boundary unavailable</span></div>
      <div className="inspector-tabs" role="tablist" aria-label="Assignment details">{(["task","conversation","activity"] as const).map((t,index)=><button key={t} role="tab" tabIndex={tab===t?0:-1} aria-selected={tab===t} aria-controls="inspector-panel" onKeyDown={e=>{const tabs=["task","conversation","activity"] as const;const next=e.key==="ArrowRight"?(index+1)%3:e.key==="ArrowLeft"?(index+2)%3:e.key==="Home"?0:e.key==="End"?2:null;if(next!==null){e.preventDefault();setTab(tabs[next]);setCursor(null);(e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}} onClick={()=>{setTab(t);setCursor(null);}}>{t[0].toUpperCase()+t.slice(1)}</button>)}</div>
      <div className="inspector-content" id="inspector-panel" role="tabpanel" tabIndex={0}>
        {tab==="task"?<><h2>Observed context</h2><p>{a.boundaryEvidence}</p><dl><dt>Reported state</dt><dd>{a.status}</dd><dt>Observed turns</dt><dd>{a.turnCount}</dd><dt>Activity records</dt><dd>{a.activityCount}</dd></dl><div className="evidence-note"><strong>What this means</strong><p>Turns remain separate evidence. This grouping does not infer a task boundary from a trigger, a tool call or an agent name.</p></div></>:demo?<div className="evidence-note"><strong>Fixture evidence</strong><p>This preview demonstrates a session containing {a.turnCount} distinct observed turns. No live conversation is loaded.</p></div>:detail.state.status==="ready"?<><p className="detail-total">{detail.state.data.total} retained records · newest first</p>{detail.state.data.items.filter(e=>tab==="activity"||e.kind!=="tool").map(e=><article className="evidence-event" key={e.id}><header>{e.kind.replace("message-","")}<time>{new Date(e.occurredAt).toLocaleTimeString()}</time></header><p className="untrusted-text">{e.content??e.summary}</p>{(e.redacted||e.truncated)&&<small>{e.redacted?"Redacted ":""}{e.truncated?"Truncated":""}</small>}</article>)}<div className="detail-pagination">{cursor&&<button onClick={()=>setCursor(null)}>Latest records</button>}{detail.state.data.nextCursor&&<button onClick={()=>setCursor(detail.state.status==="ready"?detail.state.data.nextCursor:null)}>Older records</button>}</div></>:detail.state.status==="error"?<div role="alert">{detail.state.message}<button onClick={()=>{setCursor(null);detail.refresh();}}>Reload details</button></div>:<p>Loading evidence…</p>}
      </div>
      <form className="question-composer" onSubmit={e=>e.preventDefault()}><label htmlFor="task-question">Ask about this task</label><p id="question-reason">{data?.questionCapability.reason}</p><textarea id="task-question" aria-describedby="question-reason" value={question} maxLength={4000} placeholder="Read-only investigation unavailable" onChange={e=>setQuestion(e.target.value)} rows={2}/><div><span>Source task stays untouched</span><button type="submit" disabled>Ask</button></div></form>
    </>}
  </aside>;
}
