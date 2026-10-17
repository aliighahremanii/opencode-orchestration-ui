import type { NodeChange, XYPosition } from "@xyflow/react";

/** Diagram changes may move known observations, never add/remove/replace them. */
export function moveObservedPositions(
  current:Record<string,XYPosition>, changes:readonly NodeChange[], observedIds:ReadonlySet<string>,
):Record<string,XYPosition> {
  let next=current;
  for(const change of changes){
    if(change.type!=="position"||!observedIds.has(change.id)||!change.position)continue;
    const {x,y}=change.position;
    if(!Number.isFinite(x)||!Number.isFinite(y))continue;
    if(next===current)next={...current};
    next[change.id]={x,y};
  }
  return next;
}
