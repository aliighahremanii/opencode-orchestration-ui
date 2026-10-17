import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { chromium,expect as uiExpect,type Browser,type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { DEMO_GRAPH,DEMO_CATALOG } from "../../lib/workspace/demo.ts";
import { OWNER_PASSWORD,buildApp,login,makeDataDir,removeDataDir,runCollectorOnce,startServer,type ServerHandle } from "./harness.ts";

const ARTIFACTS=process.env.WORKSPACE_E2E_ARTIFACTS??"/tmp/opencode/orchestration-workspace-reset/browser";
let server:ServerHandle;let browser:Browser;let dataDir:string;let cookie:string;
beforeAll(async()=>{await mkdir(ARTIFACTS,{recursive:true});await buildApp();const made=makeDataDir("workspace-browser-");dataDir=made.dir;expect((await runCollectorOnce(made.dbPath,made.dir)).code).toBe(0);server=await startServer({dbPath:made.dbPath,dataDir:made.dir,ownerPassword:OWNER_PASSWORD});cookie=await login(server.baseUrl,OWNER_PASSWORD,server.origin);browser=await chromium.launch({headless:true});},300000);
afterAll(async()=>{await browser?.close();await server?.stop();if(dataDir)removeDataDir(dataDir);});
async function page(width=1440,height=900):Promise<Page>{const p=await browser.newPage({viewport:{width,height},reducedMotion:"reduce"});const [name,value]=cookie.split("=");await p.context().addCookies([{name,value,url:server.baseUrl}]);return p;}

describe("Tracework browser verification",()=>{
  it("gates fixtures and graph data for anonymous and revoked owners",async()=>{
    expect((await fetch(`${server.baseUrl}/api/workspace`)).status).toBe(401);
    expect((await fetch(`${server.baseUrl}/api/workspace/graph?project=x&run=x`)).status).toBe(401);
    const p=await page();await p.context().clearCookies();await p.goto(`${server.baseUrl}/demo`);expect(p.url()).toContain("/login");
    const revoked=await login(server.baseUrl,OWNER_PASSWORD,server.origin);await fetch(`${server.baseUrl}/api/auth/logout`,{method:"POST",headers:{cookie:revoked,origin:server.origin,"content-type":"application/json"},body:"{}"});const [name,value]=revoked.split("=");await p.context().addCookies([{name,value,url:server.baseUrl}]);const response=await p.goto(`${server.baseUrl}/demo`);await p.getByRole("heading",{name:"Sign-in required"}).waitFor();expect(await response!.text()).not.toContain("demo-assignment");await p.close();
  });
  it("renders fixture-first desktop/tablet/mobile and keyboard-safe inspector",async()=>{
    for(const [width,height] of [[1440,900],[768,1024],[390,844]]){
      const p=await page(width,height);const requests:string[]=[];const errors:string[]=[];p.on("request",r=>{if(new URL(r.url()).pathname.startsWith("/api/"))requests.push(r.url());});p.on("pageerror",e=>errors.push(e.message));
      await p.goto(`${server.baseUrl}/demo?project=demo-project&run=demo-run`);
      if(width<600){await p.locator(".assignment-list button").filter({hasText:"Implement scoped access"}).click();}else{await p.locator('[data-id="demo-assignment-2"]').waitFor();await p.locator('[data-id="demo-assignment-2"]').click();}
      await uiExpect(p.locator(".task-inspector")).toContainText("Implement scoped access");await uiExpect(p.locator(".task-inspector")).toContainText("9");
      expect(new URL(p.url()).searchParams.get("assignment")).toBe("demo-assignment-2");
      await p.screenshot({path:`${ARTIFACTS}/fixture-${width}x${height}.png`,fullPage:true});
      expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await p.getByRole("tab",{name:"Conversation",exact:true}).click();await p.getByLabel("Ask about this task").fill("Explain the task boundary");await p.keyboard.press("Enter");await uiExpect(p.getByRole("button",{name:"Ask",exact:true})).toBeDisabled();
      if(width<600){await p.setViewportSize({width,height:520});await p.getByLabel("Ask about this task").focus();expect(await p.getByLabel("Ask about this task").evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;})).toBe(true);await p.screenshot({path:`${ARTIFACTS}/mobile-keyboard.png`,fullPage:true});await p.setViewportSize({width,height});}
      await p.getByRole("button",{name:"Close task inspector"}).click();
      if(width>=600){await p.getByRole("button",{name:"Tidy",exact:true}).click();await p.getByRole("button",{name:"Fit",exact:true}).click();await p.getByLabel("Find assignment").fill("Reviewer");await p.getByRole("button",{name:"Find",exact:true}).click();await uiExpect(p.locator(".task-inspector")).toContainText("Review isolation guarantees");}
      expect(requests).toEqual([]);expect(errors).toEqual([]);await p.close();
    }
  });
  it("has no deletion controls and preserves node/edge identities under focused Delete/Backspace",async()=>{
    const p=await page();
    try{
      await p.goto(`${server.baseUrl}/demo?project=demo-project&run=demo-run`);
      const canvas=p.getByRole("region",{name:"Observed assignment graph"});
      const ids=async(selector:string)=>p.locator(selector).evaluateAll(elements=>elements.map(e=>e.getAttribute("data-id")).sort());
      const expectedNodes=DEMO_GRAPH.assignments.map(a=>a.id).sort();const expectedEdges=DEMO_GRAPH.edges.map(e=>e.id).sort();
      await uiExpect.poll(()=>ids(".react-flow__node")).toEqual(expectedNodes);
      await uiExpect.poll(()=>ids(".react-flow__edge")).toEqual(expectedEdges);
      await uiExpect(p.getByRole("button",{name:/delete|remove/i})).toHaveCount(0);
      await canvas.click({button:"right",position:{x:10,y:100}});
      await uiExpect(p.getByRole("menuitem",{name:/delete|remove/i})).toHaveCount(0);
      const node=p.locator('[data-id="demo-assignment-2"]');await node.click();await p.waitForURL(/assignment=demo-assignment-2/);
      const selectedURL=p.url();
      for(const focus of [canvas,node]){
        await focus.focus();await uiExpect(focus).toBeFocused();
        for(const key of ["Delete","Backspace"]){
          await p.keyboard.press(key);
          expect(await ids(".react-flow__node")).toEqual(expectedNodes);expect(await ids(".react-flow__edge")).toEqual(expectedEdges);expect(p.url()).toBe(selectedURL);
        }
      }
      // Keyboard movement remains a permitted local-layout change.
      const before=await node.getAttribute("style");await node.focus();await p.keyboard.press("ArrowRight");
      await uiExpect.poll(()=>node.getAttribute("style")).not.toBe(before);
      await uiExpect.poll(()=>ids(".react-flow__node")).toEqual(expectedNodes);
      await uiExpect.poll(()=>ids(".react-flow__edge")).toEqual(expectedEdges);
      expect(p.url()).toBe(selectedURL);
      // Backspace in a text input must still edit text, not be intercepted.
      const find=p.getByLabel("Find assignment");await find.fill("Reviewer");await find.press("Backspace");await uiExpect(find).toHaveValue("Reviewe");
    }finally{await p.close();}
  });
  it("serves collected fixture observations and fails without synthetic fallback",async()=>{
    const p=await page();await p.goto(server.baseUrl);await p.locator('[data-mode="observed"] .react-flow__node').first().waitFor();expect(await p.locator(".workspace").textContent()).not.toContain("Atlas platform");await p.locator(".react-flow__node").first().click();await p.getByRole("tab",{name:"Activity",exact:true}).click();await p.locator(".evidence-event").first().waitFor();await p.screenshot({path:`${ARTIFACTS}/collected-fixture.png`,fullPage:true});
    await p.route("**/api/workspace/graph?**",r=>r.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Unavailable"})}));await p.getByRole("button",{name:"Refresh observations"}).click();await p.getByRole("alert").filter({hasText:"STALE"}).waitFor();expect(await p.locator('[data-mode="demo"]').count()).toBe(0);await p.close();
  });
  it("keeps viewport and selection on refresh, clears old scope immediately, and clears on auth denial",async()=>{
    const p=await page();await p.addInitScript(()=>{class Events extends EventTarget{close(){}}Object.defineProperty(window,"EventSource",{value:Events});});
    let status=200;let delay=false;
    await p.route("**/api/workspace",r=>r.fulfill({json:DEMO_CATALOG}));
    await p.route("**/api/workspace/graph?**",async r=>{if(delay)await new Promise(resolve=>setTimeout(resolve,800));await r.fulfill({status,json:status===200?DEMO_GRAPH:{error:"Unavailable"}});});
    await p.goto(`${server.baseUrl}/?project=demo-project&run=demo-run`);await p.locator(".react-flow__node").first().waitFor();await p.getByRole("button",{name:"Pan right"}).click();await p.locator('[data-id="demo-assignment-2"]').click();const transform=await p.locator(".react-flow__viewport").getAttribute("style");
    await p.getByRole("button",{name:"Refresh observations"}).click();await p.waitForTimeout(250);expect(await p.locator(".react-flow__viewport").getAttribute("style")).toBe(transform);
    status=503;await p.getByRole("button",{name:"Refresh observations"}).click();await p.getByRole("alert").filter({hasText:"STALE"}).waitFor();expect(await p.locator(".react-flow__viewport").getAttribute("style")).toBe(transform);
    status=200;delay=true;await p.getByLabel("Workspace location").selectOption("demo-review");await p.waitForURL(/workspace=demo-review/);expect(await p.locator(".react-flow__node").count()).toBe(0);await p.locator(".react-flow__node").first().waitFor();
    status=401;delay=false;await p.getByRole("button",{name:"Refresh observations"}).click();await p.getByRole("heading",{name:"Sign-in required"}).waitFor();expect(await p.locator(".react-flow__node").count()).toBe(0);await p.close();
  });
  it("rejects foreign-origin questions and reports the capability gate for authenticated bounded jobs",async()=>{
    const catalog=await (await fetch(`${server.baseUrl}/api/workspace`,{headers:{cookie}})).json();const run=catalog.runs[0];const graph=await (await fetch(`${server.baseUrl}/api/workspace/graph?project=${run.projectId}&run=${run.id}`,{headers:{cookie}})).json();
    const body=JSON.stringify({assignmentId:graph.assignments[0].id,question:"Why was this grouped?",requestKey:"browser_request_123456"});
    expect((await fetch(`${server.baseUrl}/api/questions`,{method:"POST",headers:{cookie,origin:"https://foreign.invalid","content-type":"application/json"},body})).status).toBe(403);
    const headers={cookie,origin:server.origin,"content-type":"application/json"};const a=await fetch(`${server.baseUrl}/api/questions`,{method:"POST",headers,body});expect(a.status).toBe(503);const job=await a.json();expect(job.state).toBe("blocked");expect((await (await fetch(`${server.baseUrl}/api/questions`,{method:"POST",headers,body})).json()).id).toBe(job.id);
  });
});
