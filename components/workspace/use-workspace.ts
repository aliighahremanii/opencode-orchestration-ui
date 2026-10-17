"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveChanges } from "../client/use-api.ts";
import type { RunGraph } from "../../lib/contracts/workspace.ts";

/** Scope is part of state identity, not an effect-time reset. Old data cannot flash. */
export function useRunGraph(path:string|null) {
  const [snapshot,setSnapshot]=useState<{path:string;data:RunGraph|null;error:string|null;denied:boolean}|null>(null);
  const refreshRef=useRef<(()=>void)|null>(null);
  const refresh=useCallback(()=>refreshRef.current?.(),[]);
  const live=useLiveChanges(refresh,{enabled:path!==null});
  useEffect(()=>{
    if(!path||live.authExpired)return;
    const controller=new AbortController();let cancelled=false;let running=false;let invalidated=false;
    const load=async()=>{if(running)return;running=true;try{
      const response=await fetch(path,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
      if(cancelled)return;
      if(!response.ok){const denied=response.status===401||response.status===403;setSnapshot(old=>({path,data:!denied&&old?.path===path?old.data:null,error:denied?"Sign-in required.":`Observation unavailable (HTTP ${response.status}).`,denied}));return;}
      const data=await response.json() as RunGraph;
      if(!cancelled)setSnapshot({path,data,error:null,denied:false});
    }catch{if(!cancelled)setSnapshot(old=>({path,data:old?.path===path?old.data:null,error:"Observation connection lost. Last known data may be stale.",denied:false}));}finally{running=false;if(invalidated&&!cancelled){invalidated=false;void load();}}};
    refreshRef.current=()=>{if(running)invalidated=true;else void load();};
    void load();const timer=setInterval(()=>void load(),5000);
    return ()=>{cancelled=true;refreshRef.current=null;controller.abort();clearInterval(timer);};
  },[path,live.authExpired]);
  const current=snapshot?.path===path?snapshot:null;
  return {data:live.authExpired?null:current?.data ?? null,error:live.authExpired?"Sign-in required.":current?.error ?? null,refresh,connected:live.connected};
}
