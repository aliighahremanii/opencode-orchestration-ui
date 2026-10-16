"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Component, useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { OfficeResponse } from "../../lib/contracts/api.ts";
import { constrainOfficeViewport, officeCameraBounds, extendSeats, officePeople, placePeople, type OfficePerson, type SeatLedger } from "../../lib/office/model.ts";
import { formatTimestamp } from "../../lib/format.ts";
import { OfficeMap, type SceneProps, type Viewport } from "./office-map.tsx";
import { useApi, useLiveChanges } from "../client/use-api.ts";

const Scene = dynamic(() => import("./office-scene.tsx"), { ssr: false, loading: () => <div className="office-scene-loading">Preparing the studio…</div> });
const subscribeVisibility = (notify: () => void) => { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); };
const subscribeMotion = (notify: () => void) => { const query = window.matchMedia("(prefers-reduced-motion: reduce)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); };
const isVisible = () => document.visibilityState !== "hidden";
const isReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const serverVisible = () => true;
const serverReduced = () => true;

export function LiveOffice() {
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, serverVisible);
  const { state, refresh } = useApi<OfficeResponse>(visible ? "/api/office" : null, { pollMs: 15_000 });
  const live = useLiveChanges(refresh, { enabled: visible });
  const [lastKnown, setLastKnown] = useState<OfficeResponse | null>(null);
  const denied = live.authExpired || (state.status === "error" &&
    (state.httpStatus === 401 || state.httpStatus === 403 || state.code === "auth-not-configured"));
  // Retain the same OfficeView instance through observation failures, including
  // its append-only seat ledger and navigation state. Auth denial is different:
  // discard the protected snapshot immediately, even if a read is still pending.
  const data = denied ? null : state.status === "ready" ? state.data : lastKnown;
  if (data !== lastKnown) setLastKnown(data);
  if (data !== null) return <OfficeView data={data} connected={live.connected} refresh={refresh}
    observationError={state.status === "error" ? state.message : null} />;
  if (denied) return <div className="office-empty" role="alert"><h1>Sign-in required</h1><p>Protected observations have been cleared. Sign in again to reopen the office.</p><Link href="/login">Sign in</Link></div>;
  if (state.status === "loading") return <div className="office-empty"><span className="office-eyebrow">OPENCODE / STUDIO</span><h1>Opening your office.</h1><p>Loading authenticated observations. No synthetic data is substituted.</p></div>;
  if (state.status === "error") return <div className="office-empty" role="alert"><h1>The office is unavailable.</h1><p>{state.message}</p><button onClick={refresh}>Try observation again</button><Link href="/login">Sign in</Link><Link href="/demo" prefetch={false}>Visit the isolated demo</Link></div>;
  return null;
}

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function OfficeView({ data, connected = false, refresh, observationError = null }: { data: OfficeResponse; connected?: boolean; refresh?: () => void; observationError?: string | null }) {
  const demo = data.source === "demo";
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, serverVisible);
  const reducedMotion = useSyncExternalStore(subscribeMotion, isReduced, serverReduced);
  const people = useMemo(() => officePeople(data), [data]);
  const [locationChoice, setLocation] = useState(data.locations[0]?.id ?? "");
  const location = data.locations.some((item) => item.id === locationChoice) ? locationChoice : data.locations[0]?.id ?? "";
  const [tab, setTab] = useState<"invocation" | "profile">("invocation");
  const [query, setQuery] = useState("");
  const [run, setRun] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"3d" | "2d">("3d");
  const [webglLost, setWebglLost] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ x: 5, z: 0, zoom: 0.9 });
  // Render-time state adjustment preserves existing seats without an effect that
  // briefly draws newly arrived identities in somebody else's seat.
  const scope = `${location}:${tab}`;
  const scoped = useMemo(() => people.filter((person) => person.locationId === location && person.kind === tab), [people, location, tab]);
  const signature = `${scope}:${scoped.map((person) => `${person.key}:${person.invocation?.runId ?? "registry"}`).join(";")}`;
  const [layout, setLayout] = useState<{ signature: string; scopes: Record<string, SeatLedger> }>({ signature: "", scopes: {} });
  let seats = layout.scopes[scope] ?? {};
  if (layout.signature !== signature) {
    seats = extendSeats(seats, scoped);
    setLayout({ signature, scopes: { ...layout.scopes, [scope]: seats } });
  }
  const placed = placePeople(scoped, seats);
  const filtered = placed.filter((person) => (!run || person.invocation?.runId === run) &&
    `${person.name} ${person.invocation?.id ?? ""} ${person.invocation?.task?.summary ?? ""} ${person.status}`.toLowerCase().includes(query.toLowerCase()));
  const shown = filtered.slice(0, 100);
  const chosen = people.find((person) => person.key === selected) ?? null;
  const currentLocation = data.locations.find((item) => item.id === location);
  const inspector = useRef<HTMLElement>(null);
  const { minX, maxX, minZ, maxZ } = officeCameraBounds(seats);
  const updateViewport = useCallback((next: Viewport) => setViewport(constrainOfficeViewport(next,
    { minX, maxX, minZ, maxZ })), [minX, maxX, minZ, maxZ]);
  const unavailable = useCallback(() => { setWebglLost(true); setMode("2d"); }, []);
  const select = useCallback((key: string) => { setSelected(key); }, []);
  const focus = (key: string | null) => {
    const person = placed.find((item) => item.key === key);
    if (person) updateViewport({ x: person.x, z: person.z, zoom: 1.35 });
  };
  const changeLocation = (id: string) => { setLocation(id); setRun(""); setQuery(""); updateViewport({ x: 5, z: 0, zoom: 0.9 }); };
  const sceneProps: SceneProps = { people: shown, selected, onSelect: select, viewport, onViewport: updateViewport, visible, reducedMotion, onUnavailable: unavailable };
  const snapshotOld = !demo && (observationError !== null || data.collector.state !== "running" || data.collector.lastCycleOk === false ||
    data.collector.lastSuccessAt === null || data.generatedAt - data.collector.lastSuccessAt > 60_000);

  return <div className="office" data-office-mode={demo ? "demo" : "observed"}>
    <div className="office-titlebar">
      <div><span className="office-eyebrow">A PLACE FOR YOUR AGENTS</span><h1>The office<span className="office-title-dot">.</span></h1><p>People, projects, and the work we can actually observe.</p></div>
      <div className="office-title-actions"><span className={`office-pill ${demo || snapshotOld ? "amber" : "teal"}`}><i />{demo ? "Synthetic demo" : data.source === "fixture" ? "Fixture observations" : "Live source"}</span>
        {!demo ? <button onClick={refresh}>Refresh observations</button> : <Link href="/" prefetch={false}>Open your office ↗</Link>}
      </div>
    </div>
    {observationError !== null ? <div className="office-coverage caution" role="alert"><span>STALE · LAST KNOWN SNAPSHOT</span><p>{observationError} Showing observations from {formatTimestamp(data.generatedAt)}, not current state. Selection and layout are retained until observations recover.</p></div> : null}
    <div className={`office-coverage ${demo || snapshotOld ? "caution" : ""}`} role="status">
      <span>{demo ? "DEMO / NOT LIVE" : snapshotOld ? "OBSERVATIONS MAY BE STALE" : "OBSERVED, NOT INFERRED"}</span>
      <p>{demo ? "A fixed, synthetic studio. No live connections, prompts, or changes." : `Collector ${data.collector.state}. Last successful collection: ${formatTimestamp(data.collector.lastSuccessAt)}.`}</p>
      <span className="office-connection">{demo ? "Isolated" : connected ? "Updates connected" : "Updates disconnected"}</span>
    </div>
    <div className="office-workspace">
      <aside className="office-directory" aria-label="Office directory">
        <div className="office-section-heading"><h2>Workspace</h2><span>{data.locations.length.toString().padStart(2, "0")}</span></div>
        <div className="office-locations" aria-label="Projects and locations">
          {data.locations.map((item) => <button key={item.id} className={`office-location ${item.id === location ? "selected" : ""}`} onClick={() => changeLocation(item.id)} aria-pressed={item.id === location}>
            <span className="office-building" aria-hidden="true">▥</span><span><strong>{item.projectId}</strong><small>{item.directory.split("/").filter(Boolean).slice(-2).join("/") || item.directory} · {item.source}</small></span>
          </button>)}
          {data.locations.length === 0 ? <p>No locations observed yet.</p> : null}
        </div>
        <div className="office-directory-tabs" role="group" aria-label="Directory type">
          <button aria-pressed={tab === "invocation"} onClick={() => { setTab("invocation"); setRun(""); }}>Assignments</button>
          <button aria-pressed={tab === "profile"} onClick={() => { setTab("profile"); setRun(""); }}>People</button>
        </div>
        <label className="office-search"><span className="sr-only">Search directory</span><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a person or turn…" /></label>
        <p className="office-directory-note">{tab === "invocation" ? "Evidence-backed invocations. Each turn has its own seat." : "Location-scoped profiles. Registry membership is not execution."}</p>
        <div className="office-person-list">
          {filtered.map((person) => <button key={person.key} className={`office-person ${person.key === selected ? "selected" : ""}`} aria-pressed={person.key === selected} aria-controls="office-inspector" onClick={() => { select(person.key); focus(person.key); }}>
            <span className={`office-avatar ${person.tone}`}>{person.name.slice(0, 2).toUpperCase()}</span>
            <span><strong>{person.name}</strong><small>{person.invocation ? person.invocation.id : person.profile?.mode}</small><span className="office-person-status">{person.status}</span></span><span aria-hidden="true">↗</span>
          </button>)}
          {filtered.length === 0 ? <p className="office-no-results">{query ? "No matching observations. Try another search." : "No observations in this area. Nothing is inferred from silence."}</p> : null}
        </div>
        <div className="office-directory-foot">{filtered.length} {tab === "invocation" ? "turns" : "profiles"} in this view <span>↗ inspect</span></div>
      </aside>
      <section className="office-floor" aria-label="Interactive office">
        <div className="office-floor-heading"><div><span className="office-eyebrow">{tab === "invocation" ? "OBSERVED WORK / RUN AREAS" : "REGISTRY / PROFILE STUDIO"}</span><h2>{currentLocation?.projectId ?? "Your workspace"}</h2></div>
          <div className="office-view-switch" role="group" aria-label="Floor view"><button aria-pressed={mode === "3d"} onClick={() => { setWebglLost(false); setMode("3d"); }}>3D office</button><button aria-pressed={mode === "2d"} onClick={() => setMode("2d")}>2D plan</button></div>
        </div>
        {tab === "invocation" ? <div className="office-run-filter"><label htmlFor="office-run">Run area</label><select id="office-run" value={run} onChange={(event) => {
          setRun(event.target.value); const person = placed.find((item) => !event.target.value || item.invocation?.runId === event.target.value); if (person) focus(person.key);
        }}><option value="">All observed runs</option>{data.runs.filter((item) => item.locationId === location).map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id} · {item.source}</option>)}</select></div> : null}
        <div className="office-canvas-wrap">
          {mode === "3d" ? <SceneBoundary key={webglLost ? "lost" : "available"} fallback={<><div className="office-fallback-note">WebGL unavailable · equivalent 2D plan</div><OfficeMap {...sceneProps} /></>}><Scene {...sceneProps} /></SceneBoundary> : <OfficeMap {...sceneProps} />}
          {webglLost ? <p className="office-fallback-note">WebGL context lost. The 2D plan retains your selection.</p> : null}
          {shown.length === 0 ? <div className="office-floor-empty"><span>Room to grow.</span><p>No {tab === "invocation" ? "invocations" : "profiles"} observed in this view.</p></div> : null}
          <div className="office-floor-caption"><span>ORTHOGRAPHIC STUDIO</span><span>{demo ? "Synthetic observations" : "Spatial layout is presentation, not a workflow"}</span></div>
        </div>
        <div className="office-scene-toolbar" role="group" aria-label="Camera controls">
          <div><button onClick={() => updateViewport({ ...viewport, zoom: viewport.zoom - 0.15 })} aria-label="Zoom out">−</button><span>{Math.round(viewport.zoom * 100)}%</span><button onClick={() => updateViewport({ ...viewport, zoom: viewport.zoom + 0.15 })} aria-label="Zoom in">+</button></div>
          <div><button onClick={() => updateViewport({ ...viewport, x: viewport.x - 3 })} aria-label="Pan left">←</button><button onClick={() => updateViewport({ ...viewport, z: viewport.z - 3 })} aria-label="Pan up">↑</button><button onClick={() => updateViewport({ ...viewport, z: viewport.z + 3 })} aria-label="Pan down">↓</button><button onClick={() => updateViewport({ ...viewport, x: viewport.x + 3 })} aria-label="Pan right">→</button></div>
          <button onClick={() => updateViewport({ x: 5, z: 0, zoom: 0.9 })}>Reset view</button><button disabled={!placed.some((item) => item.key === selected)} onClick={() => focus(selected)}>Focus selection</button><button disabled={!chosen} onClick={() => inspector.current?.focus()}>Read selection details</button>
        </div>
        <div className="office-legend"><span><i className="teal" />Reported success</span><span><i className="red" />Reported failure / tool error</span><span><i className="slate" />Unknown / observed</span><span>Not a completion score</span></div>
        {filtered.length > shown.length ? <p className="office-limit">Scene shows 100 seats. All {filtered.length} entries remain available in the directory.</p> : null}
      </section>
      <aside className="office-inspector" id="office-inspector" aria-label="Selection inspector" tabIndex={-1} ref={inspector}>
        <div className="office-section-heading"><h2>At a glance</h2><span>↗</span></div>
        {chosen ? <Inspector person={chosen} data={data} /> : <div className="office-inspector-empty"><div className="office-mini-desk" aria-hidden="true"><span /><i /></div><span className="office-eyebrow">EVERY SEAT HAS A STORY</span><h3>Meet your team.</h3><p>Select a person or a desk to inspect their profile, assignment, and observed activity.</p><p className="office-small">A profile describes an agent. An invocation is evidence that it took a turn.</p></div>}
        {selected && !chosen ? <p role="status">The selected observation is outside this snapshot. It has not been reassigned to another identity.</p> : null}
        <div className="office-dispatch"><span className="office-eyebrow">MANUAL DISPATCH</span><h3>Give work a starting point.</h3><button disabled>Create session + initial prompt</button><button disabled>Continue an existing session</button><p>{data.dispatch.reason}</p></div>
      </aside>
    </div>
    <div className="office-bottom"><div><span className="office-eyebrow">THE OBSERVATION WINDOW</span><p>{data.invocations.length} / {data.coverage.totalInvocations} retained invocations · {data.agents.length} / {data.coverage.totalAgents} profiles</p></div><div><strong>{data.coverage.openGaps}</strong><span>open coverage gaps</span></div><div><strong>{data.coverage.partialStreams}</strong><span>partial streams</span></div><div><strong>{demo ? "Fixed sample" : formatTimestamp(data.generatedAt)}</strong><span>snapshot time · {data.coverage.limited ? "bounded view; see diagnostics for more" : "within display bounds"}</span></div>{!demo ? <Link href="/status" prefetch={false}>Collection health ↗</Link> : <span className="office-small">Handoffs unavailable: no verified evidence.</span>}</div>
  </div>;
}

function Inspector({ person, data }: { person: OfficePerson; data: OfficeResponse }) {
  const invocation = person.invocation;
  const run = data.runs.find((item) => item.id === invocation?.runId && item.source === person.source);
  const demo = data.source === "demo";
  return <div className="office-inspector-content">
    <div className={`office-avatar office-avatar-large ${person.tone}`}>{person.name.slice(0, 2).toUpperCase()}</div>
    <span className="office-eyebrow">{invocation ? "INVOCATION / DISTINCT TURN" : "AGENT PROFILE / DEFINITION"}</span><h3>{person.name}</h3>
    <span className={`office-pill ${person.tone}`}>{person.status}</span>
    <p>{person.profile?.description ?? "No matching location-scoped definition is retained. Historical attribution is preserved."}</p>
    <dl><dt>Provenance</dt><dd>{demo ? "Synthetic demo" : person.source}</dd><dt>Location</dt><dd>{person.locationId}</dd>
      <dt>Profile membership</dt><dd>{person.profile ? person.profile.active ? "Reported in registry" : "No longer reported" : "Unknown"}</dd>
      <dt>Model {invocation ? "observed" : "defined"}</dt><dd>{(invocation ? invocation.modelId : person.profile?.modelId) ?? "Unknown"}</dd>
      {invocation ? <><dt>Invocation</dt><dd>{invocation.id}</dd><dt>Session</dt><dd>{demo ? invocation.sessionId : <Link href={`/sessions/${encodeURIComponent(invocation.sessionId)}`} prefetch={false}>{invocation.sessionId} ↗</Link>}</dd><dt>Root run</dt><dd>{demo ? run?.title ?? invocation.runId : <Link href={`/runs/${encodeURIComponent(invocation.runId)}`} prefetch={false}>{run?.title ?? invocation.runId} ↗</Link>}</dd><dt>Started / ended</dt><dd>{formatTimestamp(invocation.startedAt)}<br />{invocation.endedAt === null ? "End not observed" : formatTimestamp(invocation.endedAt)}</dd></> : <><dt>Observed invocations</dt><dd>{person.profile?.observedInvocationCount ?? 0} · not a current-work count</dd><dt>Last registry observation</dt><dd>{formatTimestamp(person.profile?.lastSeenAt ?? null)}</dd></>}
    </dl>
    {invocation ? <><div className="office-observation"><span className="office-eyebrow">RECORDED TRIGGER / NOT INFERRED TASK</span><p>{invocation.task?.summary ?? "Task unavailable. No retained trigger content."}</p>{invocation.task ? <small>{formatTimestamp(invocation.task.occurredAt)} · {invocation.task.kind}{invocation.task.redacted ? " · redacted" : ""}{invocation.task.truncated ? " · truncated" : ""}</small> : null}</div><div className="office-observation"><span className="office-eyebrow">LAST OBSERVED ACTION IN THIS TURN</span><p>{invocation.action?.summary ?? "No retained action available."}</p>{invocation.action ? <small>{formatTimestamp(invocation.action.occurredAt)}{invocation.action.redacted ? " · redacted" : ""}{invocation.action.truncated ? " · truncated" : ""}</small> : null}</div><details><summary>Attribution evidence</summary><p>Assistant message: {invocation.assistantMessageId}</p><p>Confidence: {invocation.confidence}. Explicit assistant agent field; not inferred from ancestry.</p><pre>{JSON.stringify(invocation.evidence, null, 2)}</pre></details></> : null}
    <p className="office-small">Handoffs unavailable. Session ancestry alone does not establish a handoff. Outcomes are upstream reports, not a verdict on the work.</p>
  </div>;
}
