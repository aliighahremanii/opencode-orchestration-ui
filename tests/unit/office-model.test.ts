import { describe, expect, it } from "vitest";
import { DEMO_OFFICE } from "../../lib/office/demo.ts";
import { constrainOfficeViewport, officeCameraBounds, extendSeats, invocationStatus, officePeople, placePeople, type SeatLedger } from "../../lib/office/model.ts";

describe("office identities and placement", () => {
  it("keeps focus reachable beyond 250 rolling run areas without moving retained seats", () => {
    const initial = officePeople(DEMO_OFFICE)[0];
    let seats: SeatLedger = extendSeats({}, [initial]);
    const originalPosition = placePeople([initial], seats)[0];
    for (let index = 0; index < 300; index++) {
      const person = { ...initial, key: `rolling-${index}`, invocation: { ...initial.invocation!, id: `rolling-${index}`, runId: `rolling-run-${index}` } };
      // A small rolling snapshot, not 300 simultaneous visible rooms.
      seats = extendSeats(seats, [initial, person]);
      const placed = placePeople([initial, person], seats);
      const focus = { x: placed[1].x, z: placed[1].z, zoom: 1.35 };
      expect(constrainOfficeViewport(focus, officeCameraBounds(seats))).toEqual(focus);
      expect(placed[0]).toEqual(originalPosition);
    }
    expect(officeCameraBounds(seats).maxX).toBeGreaterThan(2500);
    const bounded = constrainOfficeViewport({ x: 100_000, z: -100_000, zoom: 50 }, officeCameraBounds(seats));
    expect(bounded).toEqual({ x: officeCameraBounds(seats).maxX, z: -15, zoom: 2 });
  });

  it("expands depth bounds for rolling turns within one run without recycling seats", () => {
    const initial = officePeople(DEMO_OFFICE)[0];
    let seats: SeatLedger = {};
    for (let index = 0; index < 700; index++) {
      const person = { ...initial, key: `rolling-${index}` };
      seats = extendSeats(seats, [person]);
      const placed = placePeople([person], seats)[0];
      const focus = { x: placed.x, z: placed.z, zoom: 1.35 };
      expect(constrainOfficeViewport(focus, officeCameraBounds(seats))).toEqual(focus);
      expect(placed.slot).toBe(index);
    }
    expect(officeCameraBounds(seats).maxZ).toBeGreaterThan(1000);
  });
  it("keeps multiple invocations of a profile separate from each other and the definition", () => {
    const people = officePeople(DEMO_OFFICE);
    const implementers = people.filter((person) => person.profile?.agentId === "demo-agent-1");
    expect(implementers).toHaveLength(3);
    expect(new Set(implementers.map((person) => person.key)).size).toBe(3);
    expect(implementers.filter((person) => person.kind === "profile")).toHaveLength(1);
  });

  it("never joins across a source or location boundary", () => {
    const data = { ...DEMO_OFFICE, invocations: DEMO_OFFICE.invocations.map((invocation) => ({ ...invocation, source: "upstream" as const })) };
    expect(officePeople(data).filter((person) => person.invocation).every((person) => person.profile === null)).toBe(true);
    expect(officePeople(DEMO_OFFICE).find((person) => person.invocation?.id === "demo-invocation-8")?.profile).toBeNull();
  });

  it("does not move retained seats when data is reordered, replayed, removed or inserted", () => {
    const initial = officePeople(DEMO_OFFICE).slice(1, 6);
    const seats = extendSeats({}, initial);
    const positions = placePeople(initial, seats);
    const changed = [...initial].reverse().slice(1);
    changed.push(officePeople(DEMO_OFFICE)[0]);
    const next = extendSeats(seats, changed);
    for (const person of placePeople(changed, next)) {
      const original = positions.find((item) => item.key === person.key);
      if (original) expect([person.x, person.z]).toEqual([original.x, original.z]);
    }
    expect(extendSeats(next, changed)).toEqual(next);
    expect(placePeople(initial, extendSeats(next, initial))).toEqual(positions);
  });

  it("gives a moved invocation a seat in its newly observed run without changing its identity", () => {
    const initial = officePeople(DEMO_OFFICE).slice(0, 2);
    const original = placePeople(initial, extendSeats({}, initial));
    const moved = initial.map((person) => ({ ...person, invocation: person.invocation ? { ...person.invocation, runId: "observed-new-root" } : null }));
    const positions = placePeople(moved, extendSeats(extendSeats({}, initial), moved));
    expect(positions[0].key).toBe(original[0].key);
    expect(positions[0].area).not.toBe(original[0].area);
    expect(positions[0].x).not.toBe(original[0].x);
  });

  it("does not interpret an open turn, a successful tool, or registry membership as running/completion", () => {
    const invocation = { ...DEMO_OFFICE.invocations[1], upstreamOutcome: null, endedAt: null, action: { ...DEMO_OFFICE.invocations[1].action!, toolStatus: "completed" as const } };
    expect(invocationStatus(invocation).status).toBe("Last observed: patch completed");
    expect(invocationStatus({ ...invocation, action: null }).status).toContain("outcome unknown");
    expect(officePeople(DEMO_OFFICE).find((person) => person.kind === "profile")?.status).toContain("not execution");
  });
});
