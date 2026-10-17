import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Compose question worker database boundary",()=>{
  it("shares a nondefault database filename without inheriting upstream credentials",()=>{
    const root="/tmp/opencode/orchestration-workspace-reset/review-fixes";
    mkdirSync(root,{recursive:true});const dir=mkdtempSync(path.join(root,"compose-"));
    writeFileSync(path.join(dir,"compose.yml"),readFileSync("docker-compose.yml","utf8"));
    // Only synthetic configuration. Never let Compose auto-load checkout dotenv
    // or Docker client credentials, even for this non-daemon config command.
    writeFileSync(path.join(dir,".env"),"ORCH_DB_PATH=/data/observer.sqlite\nORCH_UPSTREAM_USERNAME=synthetic-user\nORCH_UPSTREAM_PASSWORD=synthetic-password\n");
    mkdirSync(path.join(dir,"docker"));
    const result=spawnSync("docker",["compose","-p","opencode-orchestration-workspace-reset","--project-directory",dir,"--env-file",path.join(dir,".env"),"-f",path.join(dir,"compose.yml"),"--profile","questions","config","--format","json"],{
      cwd:dir,env:{PATH:process.env.PATH,HOME:dir,DOCKER_CONFIG:path.join(dir,"docker"),NODE_ENV:"test"},encoding:"utf8",
    });
    expect(result.status,result.stderr).toBe(0);
    const services=JSON.parse(result.stdout).services;
    for(const name of ["web","collector","question-worker"])expect(services[name].environment.ORCH_DB_PATH).toBe("/data/observer.sqlite");
    expect(services["question-worker"].environment).toEqual({ORCH_DATA_DIR:"/data",ORCH_DB_PATH:"/data/observer.sqlite",ORCH_ROLE:"worker"});
    expect(services.collector.environment.ORCH_UPSTREAM_PASSWORD).toBe("synthetic-password");
  });
});
