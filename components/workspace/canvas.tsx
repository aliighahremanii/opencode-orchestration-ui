"use client";
import { useMemo, useState } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps, type Viewport } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import type { ObservedAssignment, RunGraph } from "../../lib/contracts/workspace.ts";
import { moveObservedPositions } from "../../lib/workspace/presentation.ts";

type AssignmentNode=Node<{assignment:ObservedAssignment},"assignment">;
function Card({data,selected}:NodeProps<AssignmentNode>) {
  const a=data.assignment;
  return <div className={`assignment-card ${selected?"selected":""}`}>
    <Handle type="target" position={Position.Left} isConnectable={false}/>
    <div className="card-agent"><span className="agent-mark" aria-hidden="true">{(a.agents[0]??"?").slice(0,2).toUpperCase()}</span><span>{a.agents.join(" · ")||"Unknown attribution"}</span></div>
    <strong>{a.title}</strong><div className="card-status"><span className={`status-dot ${a.status==="unknown"?"unknown":""}`} />{a.status.replace("reported-","Reported ")}</div>
    <div className="card-foot"><span>{a.turnCount} observed turns</span><span>Session grouping</span></div>
    <Handle type="source" position={Position.Right} isConnectable={false}/>
  </div>;
}
const nodeTypes={assignment:Card};
export function layoutAssignments(data:RunGraph):Record<string,{x:number;y:number}> {
  const g=new dagre.graphlib.Graph();g.setGraph({rankdir:"LR",ranksep:100,nodesep:40});g.setDefaultEdgeLabel(()=>({}));
  data.assignments.forEach(a=>g.setNode(a.id,{width:250,height:164}));data.edges.forEach(e=>g.setEdge(e.source,e.target));dagre.layout(g);
  return Object.fromEntries(data.assignments.map(a=>{const n=g.node(a.id);return [a.id,{x:n.x-125,y:n.y-82}];}));
}
function CanvasInner({data,selected,onSelect}:{data:RunGraph;selected:string|null;onSelect:(id:string)=>void}) {
  const flow=useReactFlow<AssignmentNode>();
  const defaults=useMemo(()=>layoutAssignments(data),[data]);
  const [positions,setPositions]=useState<Record<string,{x:number;y:number}>>(()=>defaults);
  const missing=data.assignments.filter(a=>!positions[a.id]);
  if(missing.length) setPositions({...positions,...Object.fromEntries(missing.map((a,i)=>[a.id,{x:defaults[a.id].x,y:Math.max(0,...Object.values(positions).map(p=>p.y))+210*(i+1)}]))});
  const key=`tracework:layout:v1:${data.scope.project}:${data.scope.run}:${data.scope.workspace??"all"}`;
  const [find,setFind]=useState("");
  const nodes:AssignmentNode[]=data.assignments.map(a=>({id:a.id,type:"assignment",width:250,height:164,position:positions[a.id]??defaults[a.id],data:{assignment:a},selected:a.id===selected,ariaLabel:`${a.title}, ${a.turnCount} observed turns, session grouping`,deletable:false,connectable:false}));
  const edges=data.edges.map(e=>({...e,label:"Parent session",type:"smoothstep",deletable:false,reconnectable:false,selectable:false,focusable:false,style:{stroke:"#6b8292",strokeWidth:1.5},labelStyle:{fill:"#b6c4ce",fontSize:10},labelBgStyle:{fill:"#151b23"}}));
  const save=(viewport:Viewport,p=positions)=>{try{localStorage.setItem(key,JSON.stringify({viewport,positions:p}));}catch{/* Storage optional. */}};
  const restore=()=>{try{const raw=JSON.parse(localStorage.getItem(key)??"null");if(raw?.positions&&typeof raw.positions==="object"){
    const valid=Object.fromEntries(Object.entries(raw.positions).filter(([,p])=>p&&typeof p==="object"&&"x" in p&&"y" in p&&Number.isFinite(p.x)&&Number.isFinite(p.y))) as Record<string,{x:number;y:number}>;setPositions(valid);
    const v=raw.viewport;if(v&&[v.x,v.y,v.zoom].every(Number.isFinite)&&v.zoom>=0.15&&v.zoom<=2)void flow.setViewport(v);
  }}catch{/* Invalid saved presentation state never affects observations. */}};
  return <div className="graph-canvas" role="region" tabIndex={0} aria-label="Observed assignment graph" onKeyDownCapture={event=>{
    // Suppress diagram/browser deletion shortcuts, but preserve text editing in Find.
    const target=event.target;
    if((event.key==="Delete"||event.key==="Backspace")&&target instanceof HTMLElement&&!target.closest("input,textarea,select,[contenteditable=true]")){
      event.preventDefault();event.stopPropagation();
    }
  }}>
    <div className="canvas-tools"><form onSubmit={e=>{e.preventDefault();const match=data.assignments.find(a=>`${a.title} ${a.agents.join(" ")}`.toLowerCase().includes(find.toLowerCase()));if(match){onSelect(match.id);void flow.fitView({nodes:[{id:match.id}],maxZoom:1});}}}><input aria-label="Find assignment" type="search" placeholder="Find in this run…" value={find} onChange={e=>setFind(e.target.value)}/><button type="submit">Find</button></form>
      <button onClick={()=>{setPositions(defaults);save(flow.getViewport(),defaults);}}>Tidy</button><button onClick={()=>void flow.fitView({padding:.18,maxZoom:1})}>Fit</button>
      <button aria-label="Pan left" onClick={()=>{const v=flow.getViewport();void flow.setViewport({...v,x:v.x+100});}}>←</button><button aria-label="Pan right" onClick={()=>{const v=flow.getViewport();void flow.setViewport({...v,x:v.x-100});}}>→</button>
    </div>
    <ReactFlow<AssignmentNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="dark" fitView fitViewOptions={{padding:.2,minZoom:.65,maxZoom:.95}} minZoom={.15} maxZoom={2}
      onInit={restore} onNodeClick={(_,n)=>onSelect(n.id)} onNodesChange={changes=>setPositions(old=>moveObservedPositions(old,changes,new Set(data.assignments.map(a=>a.id))))}
      onEdgesChange={()=>{/* Observation edges come only from the scoped response. Ignore diagram changes, including removals. */}}
      onNodeDragStop={(_,node)=>save(flow.getViewport(),{...positions,[node.id]:node.position})} onMoveEnd={(_,v)=>save(v)}
      nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} multiSelectionKeyCode={null} connectionRadius={0} onBeforeDelete={async()=>false}
      ariaLabelConfig={{"node.a11yDescription.default":"Press Enter to inspect. Arrow keys move presentation only. Observations cannot be deleted.","edge.a11yDescription.default":"Observed parent-session relationship. Connections cannot be edited or deleted."}}>
      <Background color="#35414d" gap={22} size={1}/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor="#4f827d" maskColor="#10151dbb"/>
    </ReactFlow>
    <div className="canvas-caption">OBSERVATION ONLY <span>Explicit parent links · not execution order</span></div>
  </div>;
}
export function AssignmentCanvas(props:{data:RunGraph;selected:string|null;onSelect:(id:string)=>void}){return <ReactFlowProvider><CanvasInner {...props}/></ReactFlowProvider>;}
