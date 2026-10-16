"use client";

import type { PlacedPerson } from "../../lib/office/model.ts";
import { officeAreas, TONE_COLORS } from "../../lib/office/model.ts";

export interface Viewport { x: number; z: number; zoom: number }
export interface SceneProps {
  people: readonly PlacedPerson[];
  selected: string | null;
  onSelect: (key: string) => void;
  viewport: Viewport;
  onViewport: (viewport: Viewport) => void;
  visible: boolean;
  reducedMotion: boolean;
  onUnavailable: () => void;
}

/** The same coordinates/identities as WebGL, with native keyboard targets. */
export function OfficeMap({ people, selected, onSelect, viewport }: Pick<SceneProps, "people" | "selected" | "onSelect" | "viewport">) {
  const scale = viewport.zoom * 17;
  const project = (x: number, z: number) => [480 + (x - viewport.x - z + viewport.z) * scale, 245 + (x - viewport.x + z - viewport.z) * scale * 0.52];
  return <svg className="office-map" viewBox="0 0 960 520" role="group" aria-label="2D office floor plan. Select a desk or use the directory.">
    <defs><pattern id="office-grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#dedbd2" /></pattern></defs>
    <rect width="960" height="520" fill="url(#office-grid)" />
    {officeAreas(people).map((area) => {
      const points = [[area.x - 3.8, -3.5], [area.x + 3.8, -3.5], [area.x + 3.8, area.depth - 3.5], [area.x - 3.8, area.depth - 3.5]].map(([x, z]) => project(x, z));
      const [x, y] = project(area.x, area.depth - 4);
      return <g key={area.area}><polygon points={points.map((point) => point.join(",")).join(" ")} fill="#e6e1d5" stroke="#c0bbad" strokeWidth="2" /><text x={x} y={y + 15} fontSize="11" textAnchor="middle" fill="#54695f">{area.label.slice(0, 32)}</text></g>;
    })}
    {[...people].sort((a, b) => a.x + a.z - b.x - b.z).map((person) => {
      const [x, y] = project(person.x, person.z);
      return <g key={person.key} transform={`translate(${x},${y})`} role="button" tabIndex={0}
        aria-label={`${person.name}, ${person.kind}, ${person.status}`} aria-pressed={selected === person.key}
        onClick={() => onSelect(person.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(person.key); } }}>
        <title>{person.name} · {person.status}</title>
        <ellipse cy="20" rx="35" ry="17" fill={selected === person.key ? "#b4d8cc" : "#d4d1c8"} />
        <path d="M-35 -8 L0 -26 L36 -8 L0 10Z" fill="#bc9974" stroke="#897c65" />
        <path d="M-35 -8v10L0 20V10M36 -8v10L0 20" fill="#a58262" />
        <path d="M-10 -21v-18l24 9v18Z" fill="#435968" stroke="#344653" strokeWidth="2" />
        <rect x="-8" y="-33" width="10" height="2" fill="#b9d9cf" transform="rotate(20)" />
        <ellipse cx="0" cy="22" rx="10" ry="6" fill="#54636c" />
        <path d="M-9 14 Q-10 -5 0 -5 Q11 -5 10 14Z" fill={TONE_COLORS[person.tone]} />
        <circle cy="-8" r="7" fill="#d9ad86" />
        {selected === person.key ? <ellipse cy="25" rx="39" ry="21" fill="none" stroke="#22665c" strokeWidth="2" /> : null}
        {people.length <= 20 || selected === person.key ? <text y="52" textAnchor="middle" fontSize="12" fill="#354650">{person.name.slice(0, 20)}</text> : null}
      </g>;
    })}
  </svg>;
}
