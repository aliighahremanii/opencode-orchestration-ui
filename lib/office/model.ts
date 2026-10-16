import type { AgentItem, OfficeInvocation, OfficeResponse } from "../contracts/api.ts";

export type OfficePerson = {
  key: string;
  name: string;
  kind: "invocation" | "profile";
  locationId: string;
  source: "upstream" | "fixture";
  profile: AgentItem | null;
  invocation: OfficeInvocation | null;
  status: string;
  areaLabel: string;
  tone: "teal" | "amber" | "red" | "slate";
};
export type PlacedPerson = OfficePerson & { x: number; z: number; slot: number; area: string };
export type SeatLedger = Readonly<Record<string, number>>;

/** Bounds follow all allocated (including temporarily absent) seats. Never
 * repack the ledger just to fit an arbitrary camera limit. Both renderers use
 * this same bounded viewport, so every retained/future focus remains reachable. */
export function officeCameraBounds(seats: SeatLedger) {
  let lastArea = 0;
  let lastSlot = 0;
  for (const [key, value] of Object.entries(seats)) {
    if (key.startsWith("area:")) lastArea = Math.max(lastArea, value);
    else lastSlot = Math.max(lastSlot, value);
  }
  return { minX: -15, maxX: Math.max(15, lastArea * 8.4 + 1.55 + 15),
    minZ: -15, maxZ: Math.max(15, Math.floor(lastSlot / 2) * 3.4 - 1.7 + 15) };
}

export function constrainOfficeViewport(viewport: { x: number; z: number; zoom: number }, bounds: ReturnType<typeof officeCameraBounds>) {
  return { x: Math.max(bounds.minX, Math.min(bounds.maxX, viewport.x)),
    z: Math.max(bounds.minZ, Math.min(bounds.maxZ, viewport.z)), zoom: Math.max(0.3, Math.min(2, viewport.zoom)) };
}

export function profileKey(agent: Pick<AgentItem, "source" | "locationId" | "agentId">): string {
  return JSON.stringify([agent.source, agent.locationId, agent.agentId]);
}

export function invocationStatus(invocation: OfficeInvocation): Pick<OfficePerson, "status" | "tone"> {
  if (invocation.upstreamOutcome !== null) return {
    status: `Upstream reported ${invocation.upstreamOutcome}`,
    tone: invocation.upstreamOutcome === "failed" ? "red" : invocation.upstreamOutcome === "interrupted" ? "amber" : "teal",
  };
  if (invocation.endedAt !== null) return { status: "Turn ended · outcome unknown", tone: "slate" };
  if (invocation.action?.toolStatus) return {
    status: `Last observed: ${invocation.action.toolName ?? "tool"} ${invocation.action.toolStatus}`,
    tone: invocation.action.toolStatus === "error" ? "red" : "slate",
  };
  return { status: "Turn observed · outcome unknown", tone: "slate" };
}

/** Profiles and invocations stay distinct, including concurrent turns of one agent. */
export function officePeople(data: OfficeResponse): OfficePerson[] {
  const profiles = new Map(data.agents.map((agent) => [profileKey(agent), agent]));
  return [
    ...data.invocations.map((invocation): OfficePerson => {
      const profile = profiles.get(profileKey(invocation)) ?? null;
      return { key: `invocation:${invocation.source}:${invocation.id}`, name: profile?.name ?? invocation.agentId,
        kind: "invocation", locationId: invocation.locationId, source: invocation.source, profile, invocation,
        areaLabel: data.runs.find((run) => run.id === invocation.runId && run.source === invocation.source && run.locationId === invocation.locationId)?.title ?? invocation.runId,
        ...invocationStatus(invocation) };
    }),
    ...data.agents.map((profile): OfficePerson => ({
      key: `profile:${profileKey(profile)}`, name: profile.name, kind: "profile", locationId: profile.locationId,
      source: profile.source, profile, invocation: null, tone: "slate",
      areaLabel: "Registry profiles",
      status: profile.active ? "Registry member · not execution" : "Historical · no longer reported",
    })),
  ];
}

/** Append-only seat allocation. A status/filter/reconnect cannot move an existing identity. */
export function extendSeats(previous: SeatLedger, people: readonly OfficePerson[]): SeatLedger {
  const next = { ...previous };
  for (const person of [...people].sort((a, b) => a.key.localeCompare(b.key))) {
    const area = areaKey(person);
    const groupKey = `area:${area}`;
    if (next[groupKey] === undefined) next[groupKey] = Object.keys(next).filter((key) => key.startsWith("area:")).length;
    const seatKey = `${area}|${person.key}`;
    if (next[seatKey] === undefined) next[seatKey] = Object.keys(next).filter((key) => key.startsWith(`${area}|`)).length;
  }
  return next;
}

export function areaKey(person: OfficePerson): string {
  return JSON.stringify([person.source, person.locationId, person.invocation?.runId ?? "registry"]);
}

export function placePeople(people: readonly OfficePerson[], seats: SeatLedger): PlacedPerson[] {
  return people.map((person) => {
    const area = areaKey(person);
    const slot = seats[`${area}|${person.key}`] ?? 0;
    const group = seats[`area:${area}`] ?? 0;
    return { ...person, area, slot, x: group * 8.4 + (slot % 2) * 3.1 - 1.55, z: Math.floor(slot / 2) * 3.4 - 1.7 };
  });
}

export const TONE_COLORS = { teal: "#377e75", amber: "#a57431", red: "#b34f46", slate: "#667e90" };

/** Shared room boundaries for both renderers, with run/provenance identity. */
export function officeAreas(people: readonly PlacedPerson[]) {
  return [...new Set(people.map((person) => person.area))].map((area) => {
    const members = people.filter((person) => person.area === area);
    const minX = Math.min(...members.map((person) => person.x - (person.slot % 2) * 3.1));
    return { area, label: members[0].areaLabel, x: minX + 1.55, depth: Math.max(9, ...members.map((person) => person.z + 5)) };
  });
}
