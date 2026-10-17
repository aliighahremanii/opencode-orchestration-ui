import { mkdirSync,mkdtempSync,readFileSync,existsSync,lstatSync,writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { assertGuardLoaded,assertIsolatedRuntime,createIsolatedApp,isolatedAppEnv,ISOLATED_APP_ENTRIES } from "../helpers/isolated-app.ts";

describe("E2E application credential isolation",()=>{
  it.each(["node","bun"] as const)("copies only source/dependencies and guards %s child reads",runtime=>{
    const root="/tmp/opencode/orchestration-workspace-reset/review-fixes";
    mkdirSync(root,{recursive:true});const source=mkdtempSync(path.join(root,"synthetic-checkout-"));
    for(const entry of ISOLATED_APP_ENTRIES){
      if(entry.includes("."))writeFileSync(path.join(source,entry),entry==="package.json"?"{}":"");
      else mkdirSync(path.join(source,entry));
    }
    mkdirSync(path.join(source,"node_modules"));
    mkdirSync(path.join(source,"tests/helpers"));
    writeFileSync(path.join(source,"tests/helpers/dotenv-guard.cjs"),readFileSync("tests/helpers/dotenv-guard.cjs","utf8"));
    // Entirely task-owned canaries. No test ever reads the real checkout dotenv.
    writeFileSync(path.join(source,".env"),"ORCH_E2E_CHECKOUT_CANARY=must-not-be-loaded\n");
    writeFileSync(path.join(source,"app/.env.local"),"ORCH_E2E_NESTED_CANARY=must-not-be-copied\n");
    mkdirSync(path.join(source,".next"));writeFileSync(path.join(source,".next/BUILD_ID"),"unsafe-old-build");
    const isolated=createIsolatedApp(source);
    expect(readFileSync(path.join(isolated,".env"),"utf8")).toBe("ORCH_E2E_DOTENV_CANARY=synthetic-sandbox-only\n");
    expect(existsSync(path.join(isolated,"app/.env.local"))).toBe(false);
    expect(existsSync(path.join(isolated,".next"))).toBe(false);
    expect(lstatSync(path.join(isolated,"node_modules")).isSymbolicLink()).toBe(false);
    expect(()=>assertGuardLoaded(isolated)).toThrow("E2E guard did not load");
    const loaded=assertIsolatedRuntime(isolated,runtime,runtime);expect(loaded.runtime).toBe(runtime);
    expect(()=>assertGuardLoaded(isolated,-1)).toThrow("E2E guard did not load");
    const env=isolatedAppEnv(isolated,{NODE_OPTIONS:"must-not-override-guard",BUN_OPTIONS:"must-not-override-guard"});
    expect(env.NODE_OPTIONS).toContain("--require=");expect(env.BUN_OPTIONS).toContain("--preload=");
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();expect(env.ORCH_UPSTREAM_PASSWORD).toBeUndefined();
    const probePath=path.join(isolated,"guard-probe.mjs");
    writeFileSync(probePath,`
      import {readFileSync} from 'node:fs';
      import {readFile} from 'node:fs/promises';
      if(globalThis[Symbol.for('tracework.e2e.dotenvGuard')]?.runtime!==${JSON.stringify(runtime)})throw new Error('guard did not load in expected runtime');
      if(!readFileSync('.env','utf8').includes('synthetic-sandbox-only'))process.exit(2);
      for(const read of [()=>readFileSync(process.argv[2],'utf8'),()=>readFile(process.argv[2],'utf8')]){
        try{await read();process.exit(3);}catch(e){if(e.message!=='E2E_DOTENV_OUTSIDE_SANDBOX')throw e;}
      }
    `);
    const probe=spawnSync(runtime,[...(runtime==="bun"?["--no-env-file"]:[]),probePath,path.join(source,".env")],{cwd:isolated,env,encoding:"utf8"});
    expect(probe.status,probe.stderr).toBe(0);
    expect(assertGuardLoaded(isolated,probe.pid).some(r=>r.pid===probe.pid&&r.runtime===runtime)).toBe(true);
    if(runtime==="bun"){
      writeFileSync(path.join(isolated,"package.json"),JSON.stringify({scripts:{"guard-runtime":"node script-runtime.mjs"}}));
      writeFileSync(path.join(isolated,"script-runtime.mjs"),`const guard=globalThis[Symbol.for('tracework.e2e.dotenvGuard')];if(guard?.runtime!=='node')throw new Error('Pin Node first on PATH for Bun scripts');console.log(JSON.stringify(guard));`);
      const script=spawnSync("bun",["--no-env-file","run","guard-runtime"],{cwd:isolated,env,encoding:"utf8"});
      expect(script.status,script.stderr).toBe(0);
      const child=JSON.parse(script.stdout);expect(child.runtime).toBe("node");
      // `bun run` is a package-script launcher here, not a JS application:
      // --no-env-file protects the wrapper; the actual Node child must preload.
      expect(child.pid).not.toBe(script.pid);
      expect(assertGuardLoaded(isolated,child.pid).some(r=>r.pid===child.pid&&r.runtime==="node")).toBe(true);
    }
    const audit=readFileSync(path.join(isolated,"dotenv-access.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
    expect(audit.some(r=>r.allowed)).toBe(true);expect(audit.filter(r=>!r.allowed)).toHaveLength(2);
  });
});
