import { describe,expect,it } from "vitest";
import type { NodeChange } from "@xyflow/react";
import { moveObservedPositions } from "../../lib/workspace/presentation.ts";

describe("observation presentation changes",()=>{
  it("ignores removals, replacements and additions without changing identities",()=>{
    const positions={one:{x:10,y:20},two:{x:30,y:40}};
    const changes:NodeChange[]=[{type:"remove",id:"one"},{type:"replace",id:"two",item:{id:"replacement",position:{x:0,y:0},data:{}}},{type:"add",item:{id:"new",position:{x:0,y:0},data:{}}}];
    expect(moveObservedPositions(positions,changes,new Set(["one","two"]))).toBe(positions);
  });
  it("permits only finite positions for known observations, preserving all other identities",()=>{
    const positions={one:{x:10,y:20},two:{x:30,y:40}};
    const moved=moveObservedPositions(positions,[{type:"remove",id:"two"},{type:"position",id:"one",position:{x:11,y:22}},{type:"position",id:"injected",position:{x:0,y:0}},{type:"position",id:"two",position:{x:NaN,y:0}}],new Set(["one","two"]));
    expect(Object.keys(moved).sort()).toEqual(["one","two"]);expect(moved).toEqual({one:{x:11,y:22},two:{x:30,y:40}});expect(positions.one).toEqual({x:10,y:20});
  });
});
