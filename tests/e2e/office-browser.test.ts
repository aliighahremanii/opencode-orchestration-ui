import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, expect as uiExpect, type Browser, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { DEMO_OFFICE } from "../../lib/office/demo.ts";
import type { OfficeResponse } from "../../lib/contracts/api.ts";
import { OWNER_PASSWORD, buildApp, login, makeDataDir, removeDataDir, runCollectorOnce, startServer, type ServerHandle } from "./harness.ts";

// Output directory is overridable so an independent verification run does not
// overwrite the implementer's captured evidence.
const ARTIFACTS = process.env.OFFICE_E2E_ARTIFACTS ?? "/tmp/opencode/living-office/review-fixes/browser";
let server: ServerHandle;
let browser: Browser;
let dataDir: string;
let ownerCookie: string;
beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  await buildApp();
  const made = makeDataDir("office-browser-"); dataDir = made.dir;
  const collected = await runCollectorOnce(made.dbPath, made.dir);
  expect(collected.code).toBe(0);
  server = await startServer({ dbPath: made.dbPath, dataDir: made.dir, ownerPassword: OWNER_PASSWORD });
  ownerCookie = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
  browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
}, 300_000);
afterAll(async () => { await browser?.close(); await server?.stop(); if (dataDir) removeDataDir(dataDir); });

async function demoPage(options: { width?: number; height?: number; reduced?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: options.height ?? 1050 }, reducedMotion: options.reduced ? "reduce" : "no-preference" });
  await authenticatePage(page);
  await page.goto(`${server.baseUrl}/demo`);
  await page.locator("canvas").waitFor();
  await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frames ?? 0) > 0);
  return page;
}

async function authenticatePage(page: Page, cookie = ownerCookie) {
  const [name, value] = cookie.split("=");
  await page.context().addCookies([{ name, value, url: server.baseUrl }]);
}

async function isolateOfficeReads(page: Page) {
  await authenticatePage(page);
  // Control invalidation in recovery/rolling tests; no upstream or telemetry SSE.
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor() { super(); Object.defineProperty(window, "officeTestEvents", { configurable: true, value: this }); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
}

describe("office browser verification (isolated fixture server, software WebGL)", () => {
  it("gates demo for anonymous, invalid and revoked sessions without serializing synthetic content", async () => {
    const anonymous = await fetch(`${server.baseUrl}/demo`, { redirect: "manual" });
    expect([302, 303, 307, 308]).toContain(anonymous.status);
    expect(anonymous.headers.get("location")).toContain("/login");
    expect(await anonymous.text()).not.toContain("demo-invocation");
    const page = await browser.newPage();
    await authenticatePage(page, "orch_session=forged-owner-session");
    const invalid = await page.goto(`${server.baseUrl}/demo`);
    await page.getByRole("heading", { name: "Sign-in required" }).waitFor();
    expect(await invalid!.text()).not.toContain("demo-invocation");
    expect(await page.locator('[data-office-mode="demo"]').count()).toBe(0);
    const revoked = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    const logout = await fetch(`${server.baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie: revoked, origin: server.origin, "content-type": "application/json" }, body: "{}" });
    expect(logout.status).toBe(200);
    await authenticatePage(page, revoked);
    const denied = await page.goto(`${server.baseUrl}/demo`);
    await page.getByRole("heading", { name: "Sign-in required" }).waitFor();
    expect(await denied!.text()).not.toContain("demo-invocation");
    await page.screenshot({ path: `${ARTIFACTS}/demo-revoked.png`, fullPage: true });
    await page.close();
  });

  it("keeps demo isolated, renders 3D, inspects distinct turns and supports search/camera/2D", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await authenticatePage(page);
    const api: string[] = []; const errors: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.baseUrl}/demo`);
    await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frames ?? 0) > 0);
    expect(await page.getByRole("button", { name: "Sign out" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Create session + initial prompt" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Continue an existing session" }).isDisabled()).toBe(true);
    await page.screenshot({ path: `${ARTIFACTS}/desktop-office.png`, fullPage: true });
    const implementer = page.locator(".office-person").filter({ hasText: "demo-invocation-1" });
    await implementer.click();
    expect(await page.locator("#office-inspector").textContent()).toContain("demo-invocation-1");
    await page.locator(".office-person").filter({ hasText: "demo-invocation-6" }).click();
    expect(await page.locator("#office-inspector").textContent()).toContain("demo-invocation-6");
    await page.getByRole("button", { name: "Reset view", exact: true }).click();
    await page.screenshot({ path: `${ARTIFACTS}/desktop-inspector.png`, fullPage: true });
    await page.getByRole("searchbox", { name: "Search directory" }).fill("Reviewer");
    expect(await page.locator(".office-person").count()).toBe(1);
    await page.getByRole("searchbox").fill("");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Pan right", exact: true }).click();
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    expect(await page.getByText("WebGL context lost.", { exact: false }).count()).toBe(0);
    await page.locator("svg.office-map g[role=button]").first().focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("#office-inspector").textContent()).toContain("Attribution evidence");
    await page.getByRole("button", { name: "People", exact: true }).click();
    expect(await page.locator(".office-person").count()).toBe(8);
    expect(await page.locator(".office-directory-note").textContent()).toContain("not execution");
    await page.getByRole("button", { name: "3D office", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frames ?? 0) > 0);
    await page.evaluate(() => document.querySelector("canvas")?.dispatchEvent(new Event("webglcontextlost")));
    await page.locator(".office-map").waitFor();
    expect(await page.getByRole("button", { name: "2D plan", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("button", { name: "Read selection details", exact: true }).click();
    expect(await page.locator("#office-inspector").evaluate((element) => element === document.activeElement)).toBe(true);
    expect(api).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("retains usable mobile layout and reduced-motion interaction", async () => {
    const page = await demoPage({ width: 375, height: 812, reduced: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    await page.locator(".office-person").first().click();
    expect(await page.locator("#office-inspector").textContent()).toContain("demo-invocation-0");
    await page.screenshot({ path: `${ARTIFACTS}/mobile-office.png`, fullPage: true });
    await page.setViewportSize({ width: 812, height: 375 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  });

  it("falls back on WebGL failure without losing the directory", async () => {
    const page = await browser.newPage();
    await authenticatePage(page);
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (kind.includes("webgl")) return null;
        return Reflect.apply(original, this, [kind, ...args]);
      } as typeof original;
    });
    await page.goto(`${server.baseUrl}/demo`);
    await page.locator(".office-map").waitFor();
    await page.locator(".office-person").first().click();
    expect(await page.locator("#office-inspector").textContent()).toContain("demo-invocation-0");
    await page.screenshot({ path: `${ARTIFACTS}/webgl-fallback.png`, fullPage: true });
    await page.close();
  });

  it("serves authenticated observations, not synthetic fallback, and denies anonymous DTO access", async () => {
    const response = await fetch(`${server.baseUrl}/api/office`);
    expect(response.status).toBe(401);
    const cookie = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const [name, value] = cookie.split("=");
    await page.context().addCookies([{ name, value, url: server.baseUrl }]);
    await page.goto(server.baseUrl);
    await page.locator('[data-office-mode="observed"]').waitFor();
    expect(await page.locator(".office-title-actions").textContent()).toContain("Fixture observations");
    expect(await page.locator(".office").textContent()).not.toContain("demo-invocation");
    await page.screenshot({ path: `${ARTIFACTS}/fixture-office.png`, fullPage: true });
    await page.route("**/api/office", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Observation unavailable", code: "unavailable" }) }));
    await page.getByRole("button", { name: "Refresh observations" }).click();
    await page.getByRole("alert").filter({ hasText: "STALE · LAST KNOWN SNAPSHOT" }).waitFor();
    expect(await page.locator('[data-office-mode="observed"]').count()).toBe(1);
    expect(await page.locator('[data-office-mode="demo"]').count()).toBe(0);
    await page.close();
  });

  it("preserves navigation, selection and seat placement through transient error and reordered recovery, but clears on auth denial", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await isolateOfficeReads(page);
    let data: OfficeResponse = { ...DEMO_OFFICE, source: "fixture" };
    let status = 200;
    await page.route("**/api/office", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? data : { error: "Observation unavailable", code: "unavailable" }) }));
    await page.goto(server.baseUrl);
    await page.locator('[data-office-mode="observed"]').waitFor();
    await page.getByRole("button", { name: "Interface Lab", exact: false }).click();
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    await page.locator(".office-person").filter({ hasText: "demo-invocation-9" }).click();
    await page.getByRole("searchbox").fill("demo-agent-1");
    await page.getByLabel("Run area", { exact: true }).selectOption("demo-run-2");
    const selectedSeat = page.locator('svg.office-map g[role="button"][aria-pressed="true"]');
    const initialPosition = await selectedSeat.getAttribute("transform");
    const officeElement = await page.locator(".office").elementHandle();
    status = 503;
    await page.getByRole("button", { name: "Refresh observations" }).click();
    await page.getByRole("alert").filter({ hasText: "STALE · LAST KNOWN SNAPSHOT" }).waitFor();
    await uiExpect(page.getByRole("searchbox")).toHaveValue("demo-agent-1");
    await uiExpect(page.getByLabel("Run area", { exact: true })).toHaveValue("demo-run-2");
    await uiExpect(page.locator(".office-location.selected")).toContainText("Interface Lab");
    await uiExpect(page.locator("#office-inspector")).toContainText("demo-invocation-9");
    expect(await selectedSeat.getAttribute("transform")).toBe(initialPosition);
    await page.screenshot({ path: `${ARTIFACTS}/stale-retained-office.png`, fullPage: true });
    // A lexically earlier identity would move retained seats if recovery rebuilt
    // the ledger instead of retaining the mounted view.
    data = { ...data, invocations: [{ ...data.invocations[9], id: "aaa-new-turn" }, ...data.invocations.slice().reverse()],
      coverage: { ...data.coverage, totalInvocations: data.invocations.length + 1 } };
    status = 200;
    await page.getByRole("button", { name: "Refresh observations" }).click();
    await uiExpect(page.locator(".office").getByRole("alert")).toHaveCount(0);
    await uiExpect(page.locator(".office-person")).toHaveCount(2);
    await uiExpect(page.getByRole("searchbox")).toHaveValue("demo-agent-1");
    await uiExpect(page.getByLabel("Run area", { exact: true })).toHaveValue("demo-run-2");
    expect(await selectedSeat.getAttribute("transform")).toBe(initialPosition);
    expect(await officeElement!.evaluate((element) => element === document.querySelector(".office"))).toBe(true);
    await uiExpect(page.locator("#office-inspector")).toContainText("demo-invocation-9");
    await page.screenshot({ path: `${ARTIFACTS}/recovered-office.png`, fullPage: true });
    status = 403;
    await page.getByRole("button", { name: "Refresh observations" }).click();
    await page.getByRole("heading", { name: "Sign-in required" }).waitFor();
    expect(await page.locator(".office").count()).toBe(0);
    // A later transport failure must not resurrect the cleared protected cache.
    status = 503;
    await page.evaluate(() => (window as unknown as { officeTestEvents: EventTarget }).officeTestEvents.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ seq: 1 }) })));
    await page.getByRole("heading", { name: "The office is unavailable." }).waitFor();
    expect(await page.locator(".office").count()).toBe(0);
    await page.close();
  });

  it("keeps both manual dispatch actions disabled and sends zero non-GET API requests on the observed office", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await isolateOfficeReads(page);
    const mutations: string[] = [];
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      apiRequests.push(`${request.method()} ${url.pathname}`);
      if (request.method() !== "GET" && request.method() !== "HEAD") mutations.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto(server.baseUrl);
    await page.locator('[data-office-mode="observed"]').waitFor();
    await uiExpect(page.getByRole("button", { name: "Create session + initial prompt" })).toBeDisabled();
    await uiExpect(page.getByRole("button", { name: "Continue an existing session" })).toBeDisabled();
    await page.locator(".office-person").first().click();
    await page.getByRole("button", { name: "Refresh observations" }).click();
    await page.waitForTimeout(1500);
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(mutations).toEqual([]);
    await page.close();
  });

  it("shows the unavailable state on first load without falling back to demo content", async () => {
    const page = await browser.newPage();
    await isolateOfficeReads(page);
    await page.route("**/api/office", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Offline", code: "unavailable" }) }));
    await page.goto(server.baseUrl);
    await page.getByRole("heading", { name: "The office is unavailable." }).waitFor();
    expect(await page.locator('[data-office-mode="demo"]').count()).toBe(0);
    expect(await page.locator("body").textContent()).not.toContain("demo-invocation");
    await page.close();
  });

  it("clears protected cached observations immediately on SSE auth expiry even when the read fails", async () => {
    const page = await browser.newPage();
    await isolateOfficeReads(page);
    let status = 200;
    await page.route("**/api/office", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { ...DEMO_OFFICE, source: "fixture" } : { error: "Offline", code: "unavailable" }) }));
    await page.goto(server.baseUrl);
    await page.locator(".office").waitFor();
    status = 503;
    await page.evaluate(() => (window as unknown as { officeTestEvents: EventTarget }).officeTestEvents.dispatchEvent(new Event("auth-expired")));
    await page.getByRole("heading", { name: "Sign-in required" }).waitFor();
    expect(await page.locator(".office").count()).toBe(0);
    await page.close();
  });

  it("focuses allocated rooms beyond the old camera limit in both 2D and 3D after rolling snapshots", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await isolateOfficeReads(page);
    let batch = 0;
    const original = DEMO_OFFICE.invocations[0];
    await page.route("**/api/office", (route) => {
      const invocations = Array.from({ length: 100 }, (_, index) => ({ ...original, id: `rolling-${batch * 100 + index}`, runId: `rolling-run-${batch * 100 + index}`,
        sessionId: `ses_rolling_${batch * 100 + index}`, assistantMessageId: `msg_rolling_${batch * 100 + index}`, task: null, action: null }));
      const runs = invocations.map((invocation) => ({ ...DEMO_OFFICE.runs[0], id: invocation.runId, rootSessionId: invocation.sessionId, title: invocation.runId, invocationCount: 1 }));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...DEMO_OFFICE, source: "fixture", invocations, runs,
        coverage: { ...DEMO_OFFICE.coverage, totalInvocations: invocations.length } }) });
    });
    await page.goto(server.baseUrl);
    await page.locator(".office-person").filter({ hasText: "rolling-99" }).waitFor();
    await page.getByRole("button", { name: "2D plan", exact: true }).click();
    for (batch = 1; batch < 3; batch++) {
      await page.getByRole("button", { name: "Refresh observations" }).click();
      await page.locator(".office-person").filter({ hasText: `rolling-${batch * 100 + 99}` }).waitFor();
    }
    await page.locator(".office-person").filter({ hasText: "rolling-299" }).click();
    const seat = page.locator('svg.office-map g[role="button"][aria-pressed="true"]');
    // At the camera target, both axes project to the center regardless of the
    // far-away absolute coordinate (old 1500 clamp left it offscreen).
    await uiExpect(seat).toHaveAttribute("transform", "translate(480,245)");
    await page.screenshot({ path: `${ARTIFACTS}/rolling-300-2d.png`, fullPage: true });
    await page.getByRole("button", { name: "3D office", exact: true }).click();
    const label = page.locator('.office-projected-label[aria-pressed="true"]');
    await label.waitFor();
    const floor = await page.locator(".office-webgl").boundingBox();
    const box = await label.boundingBox();
    expect(box!.x).toBeGreaterThan(floor!.x);
    expect(box!.x + box!.width).toBeLessThan(floor!.x + floor!.width);
    expect(box!.y).toBeGreaterThan(floor!.y);
    expect(box!.y + box!.height).toBeLessThan(floor!.y + floor!.height);
    await page.screenshot({ path: `${ARTIFACTS}/rolling-300-3d.png`, fullPage: true });
    await page.close();
  });

  it("measures software-rendered scene and verifies simulated hidden-tab quiescence", async () => {
    const page = await demoPage();
    const measures: Record<string, unknown> = { renderer: "Chromium headless / SwiftShader, not target hardware", targetHardwareVerified: false };
    measures.initial = await page.locator("canvas").evaluate((element) => { const canvas = element as HTMLCanvasElement; return { ...canvas.dataset, labels: document.querySelectorAll(".office-projected-label").length, dpr: canvas.width / canvas.clientWidth }; });
    const latency: number[] = [];
    for (let index = 0; index < 20; index++) {
      latency.push(await page.evaluate(async () => {
        const start = performance.now();
        (document.querySelector('button[aria-label="Zoom in"]') as HTMLButtonElement).click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return performance.now() - start;
      }));
    }
    measures.interactionToTwoFramesMs = latency.sort((a, b) => a - b);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForTimeout(1000);
    const before = await page.locator("canvas").getAttribute("data-frames");
    await page.waitForTimeout(30_000);
    expect(await page.locator("canvas").getAttribute("data-frames")).toBe(before);
    measures.hidden = { simulated: true, settleMs: 1000, observedMs: 30_000, framesAdded: 0 };
    measures.syntheticDataset = { invocations: DEMO_OFFICE.invocations.length, displayedLocationInvocations: 8, runAreas: 2 };
    await writeFile(`${ARTIFACTS}/measurements.json`, JSON.stringify(measures, null, 2));
    await page.close();
  }, 90_000);

  it("measures 10/2/2 and 100/10/20 synthetic workloads through invalidation", async () => {
    const workloads: unknown[] = [];
    const cookie = await login(server.baseUrl, OWNER_PASSWORD, server.origin);
    for (const [agents, rooms, eventsPerSecond] of [[10, 2, 2], [100, 10, 20]]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
      const [name, value] = cookie.split("=");
      await context.addCookies([{ name, value, url: server.baseUrl }]);
      const page = await context.newPage();
      let requests = 0;
      const data = stressOffice(agents, rooms);
      await page.route("**/api/office", (route) => {
        requests++;
        const invocations = data.invocations.map((invocation, index) => index === 0 ? { ...invocation, upstreamOutcome: requests % 2 === 0 ? "failed" : null } : invocation);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...data, invocations, generatedAt: data.generatedAt + requests }) });
      });
      // A disposable EventSource test double, not production activity. It drives
      // the real application's coalescing and refetch path at the target rate.
      await page.addInitScript(({ eventsPerSecond }) => {
        class SyntheticEvents extends EventTarget {
          timer: ReturnType<typeof setInterval>;
          constructor() {
            super(); let seq = 0;
            this.timer = setInterval(() => this.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ seq: ++seq }) })), 1000 / eventsPerSecond);
          }
          close() { clearInterval(this.timer); }
        }
        Object.defineProperty(window, "EventSource", { value: SyntheticEvents });
      }, { eventsPerSecond });
      const coldStart = Date.now();
      await page.goto(server.baseUrl);
      await page.waitForFunction(() => Number(document.querySelector("canvas")?.dataset.frames ?? 0) > 0);
      const coldSceneMs = Date.now() - coldStart;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      const before = await cdp.send("Performance.getMetrics");
      const scheduling = await page.evaluate(async () => {
        const intervals: number[] = []; const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(entry.duration)));
        observer.observe({ type: "longtask", buffered: false });
        let previous = performance.now(); const start = previous;
        await new Promise<void>((resolve) => {
          const tick = (now: number) => { intervals.push(now - previous); previous = now; if (now - start >= 10_000) resolve(); else requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
        observer.disconnect(); intervals.sort((a, b) => a - b);
        return { samples: intervals.length, rafP95Ms: intervals[Math.ceil(intervals.length * 0.95) - 1], rafP99Ms: intervals[Math.ceil(intervals.length * 0.99) - 1], above50msPercent: intervals.filter((value) => value > 50).length * 100 / intervals.length, longTasksMs: longTasks };
      });
      const after = await cdp.send("Performance.getMetrics");
      const taskTime = (metrics: typeof before) => metrics.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
      const renderer = await page.locator("canvas").evaluate((element) => { const canvas = element as HTMLCanvasElement; return { ...canvas.dataset, labels: document.querySelectorAll(".office-projected-label,.office-area-label").length, dpr: canvas.width / canvas.clientWidth }; });
      expect(renderer.labels).toBeLessThanOrEqual(20);
      expect(renderer.dpr).toBeLessThanOrEqual(1.5);
      expect(requests).toBeGreaterThan(5);
      workloads.push({ agents, rooms, eventsPerSecond, coldSceneMs, windowSeconds: 10, refetches: requests, renderer, scheduling, browserMainThreadTaskMs: (taskTime(after) - taskTime(before)) * 1000 });
      await page.screenshot({ path: `${ARTIFACTS}/stress-${agents}.png`, fullPage: true });
      await context.close();
    }
    await writeFile(`${ARTIFACTS}/workloads.json`, JSON.stringify({ renderer: "headless Chromium / SwiftShader", actualDevice: false, note: "RAF scheduling and browser task duration, not GPU timing or per-frame app CPU. Local fixture/mock observations only.", workloads }, null, 2));
  }, 90_000);
});

function stressOffice(count: number, rooms: number): OfficeResponse {
  return {
    ...DEMO_OFFICE, source: "fixture", locations: [DEMO_OFFICE.locations[0]],
    agents: Array.from({ length: count }, (_, index) => ({ ...DEMO_OFFICE.agents[index % 8], agentId: `stress-agent-${index}`, name: `Agent ${index + 1}`, observedInvocationCount: 1 })),
    invocations: Array.from({ length: count }, (_, index) => ({ ...DEMO_OFFICE.invocations[0], id: `stress-turn-${index}`, agentId: `stress-agent-${index}`, runId: `stress-run-${Math.floor(index / (count / rooms))}`, sessionId: `ses_stress_${index}`, action: null, task: null })),
    runs: Array.from({ length: rooms }, (_, index) => ({ ...DEMO_OFFICE.runs[0], id: `stress-run-${index}`, title: `Synthetic area ${index + 1}`, invocationCount: count / rooms })),
    coverage: { ...DEMO_OFFICE.coverage, totalAgents: count, totalInvocations: count },
  };
}
