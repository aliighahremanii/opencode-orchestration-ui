import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const E2E_ARTIFACT_ROOT="/tmp/opencode/orchestration-workspace-reset/review-fixes/e2e";
// An allowlist, never a recursive copy of the checkout. In particular, neither
// credential files nor a build produced with checkout credentials can be copied.
export const ISOLATED_APP_ENTRIES=["app","components","lib","scripts","fixtures","public","tests",
  "package.json","bun.lock","next.config.ts","tsconfig.json","next-env.d.ts",
  "proxy.ts","eslint.config.mjs","vitest.config.mts","vitest.e2e.config.mts"];
const DOTENV=/^\.env(?:\.|$)/;

export function createIsolatedApp(sourceRoot:string):string {
  mkdirSync(E2E_ARTIFACT_ROOT,{recursive:true});
  const directory=mkdtempSync(path.join(E2E_ARTIFACT_ROOT,"app-"));
  const copy=(entry:string,dependencies=false)=>{
    const source=path.join(sourceRoot,entry);
    cpSync(source,path.join(directory,entry),{
      recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE,
      filter:from=>{
        // Check the name BEFORE any stat/open. Never inspect a dotenv candidate.
        if(DOTENV.test(path.basename(from))||path.basename(from)===".cache")return false;
        if(lstatSync(from).isSymbolicLink()){
          const target=readlinkSync(from);
          if(!dependencies||path.isAbsolute(target)||!path.resolve(path.dirname(from),target).startsWith(source+path.sep))
            throw new Error("Isolated app refuses a source or external dependency symlink.");
        }
        return true;
      },
    });
  };
  for(const entry of ISOLATED_APP_ENTRIES)copy(entry);
  // Real dependency files, not a node_modules symlink back into the checkout:
  // Next/Turbopack root discovery and module realpaths stay inside the sandbox.
  copy("node_modules",true);
  mkdirSync(path.join(directory,"home"));
  writeFileSync(path.join(directory,"home",".npmrc"),"");
  writeFileSync(path.join(directory,".env"),"ORCH_E2E_DOTENV_CANARY=synthetic-sandbox-only\n");
  return directory;
}

/** Allowlisted child environment: no inherited upstream/provider credentials or loaders. */
export function isolatedAppEnv(directory:string,overrides:Record<string,string>={}):NodeJS.ProcessEnv {
  return {
    PATH:process.env.PATH,
    HOME:path.join(directory,"home"),
    XDG_CONFIG_HOME:path.join(directory,"home","config"),
    npm_config_userconfig:path.join(directory,"home",".npmrc"),
    NEXT_TELEMETRY_DISABLED:"1",
    ...overrides,
    NODE_ENV:overrides.NODE_ENV==="development"?"development":"production",
    // Last: callers cannot turn off the guard through an env override.
    ORCH_E2E_APP_DIR:directory,
    NODE_OPTIONS:`--require=${path.join(directory,"tests/helpers/dotenv-guard.cjs")}`,
    BUN_OPTIONS:`--preload=${path.join(directory,"tests/helpers/dotenv-guard.cjs")}`,
  };
}

export interface GuardRuntime { pid:number; runtime:"node"|"bun"; version:string }
function guardMissing():Error {
  return new Error("E2E guard did not load. Pin Node first on PATH for Bun package scripts; preserve NODE_OPTIONS=--require for Node and BUN_OPTIONS=--preload for Bun. Run only inside the isolated application.");
}
export function assertGuardLoaded(directory:string,pid?:number):GuardRuntime[] {
  const file=path.join(directory,"guard-runtime.jsonl");
  if(!existsSync(file))throw guardMissing();
  const rows=readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line) as GuardRuntime);
  if(!rows.length||rows.some(r=>!["node","bun"].includes(r.runtime))||(pid!==undefined&&!rows.some(r=>r.pid===pid)))throw guardMissing();
  return rows;
}

/** Check the actual child runtime/preloader before an expensive Next build. */
export function assertIsolatedRuntime(directory:string,executable=process.execPath,expected?:"node"|"bun"):GuardRuntime {
  const probe=spawnSync(executable,["--eval",`const guard=globalThis[Symbol.for('tracework.e2e.dotenvGuard')];if(!guard)throw new Error('E2E guard did not load');process.stdout.write(JSON.stringify(guard));`],{
    cwd:directory,env:isolatedAppEnv(directory),encoding:"utf8",timeout:10000,
  });
  if(probe.status!==0)throw guardMissing();
  const runtime=JSON.parse(probe.stdout) as GuardRuntime;
  assertGuardLoaded(directory,runtime.pid);
  if(expected&&runtime.runtime!==expected)throw new Error(`E2E expected ${expected}, but the child ran ${runtime.runtime}. Pin the intended runtime first on PATH.`);
  return runtime;
}
