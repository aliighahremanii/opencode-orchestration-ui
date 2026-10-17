// @vitest-environment jsdom
import { act,cleanup,render } from "@testing-library/react";
import { afterEach,describe,expect,it,vi } from "vitest";
import type { ReactNode } from "react";
import type { ReactFlowProps } from "@xyflow/react";
import { DEMO_GRAPH } from "../../lib/workspace/demo.ts";
import { AssignmentCanvas } from "../../components/workspace/canvas.tsx";

const captured=vi.hoisted(()=>({props:null as ReactFlowProps|null}));
vi.mock("@xyflow/react",()=>({
  ReactFlow:(props:ReactFlowProps)=>{captured.props=props;return null;},
  ReactFlowProvider:({children}:{children:ReactNode})=>children,
  useReactFlow:()=>({getViewport:()=>({x:0,y:0,zoom:1}),setViewport:vi.fn(),fitView:vi.fn()}),
  Background:()=>null,Controls:()=>null,MiniMap:()=>null,Handle:()=>null,Position:{Left:"left",Right:"right"},
}));
afterEach(cleanup);
describe("canvas observation topology guard",()=>{
  it("rejects library deletion/removal changes while retaining presentation movement",async()=>{
    render(<AssignmentCanvas data={DEMO_GRAPH} selected="demo-assignment-2" onSelect={()=>{}}/>);
    const original=captured.props!;
    expect(original.deleteKeyCode).toBeNull();expect(original.nodes?.every(n=>n.deletable===false)).toBe(true);expect(original.edges?.every(e=>e.deletable===false&&e.reconnectable===false)).toBe(true);
    expect(await original.onBeforeDelete!({nodes:original.nodes!,edges:original.edges!})).toBe(false);
    act(()=>{
      original.onNodesChange!([{type:"remove",id:"demo-assignment-2"},{type:"position",id:"demo-assignment-1",position:{x:123,y:456}},{type:"replace",id:"demo-assignment-0",item:{id:"injected",position:{x:0,y:0},data:{}}}]);
      original.onEdgesChange!([{type:"remove",id:DEMO_GRAPH.edges[0].id}]);
    });
    const next=captured.props!;
    expect(next.nodes?.map(n=>n.id)).toEqual(original.nodes?.map(n=>n.id));expect(next.edges?.map(e=>e.id)).toEqual(original.edges?.map(e=>e.id));
    expect(next.nodes?.find(n=>n.id==="demo-assignment-2")?.selected).toBe(true);expect(next.nodes?.find(n=>n.id==="demo-assignment-1")?.position).toEqual({x:123,y:456});
  });
});
