"use client";

import { addAfterEffect, Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, Color, CylinderGeometry, InstancedMesh, Object3D, SphereGeometry, Vector3 } from "three";
import type { BufferGeometry } from "three";
import type { SceneProps } from "./office-map.tsx";
import { officeAreas, TONE_COLORS, type PlacedPerson } from "../../lib/office/model.ts";

function Camera({ viewport, visible }: Pick<SceneProps, "viewport" | "visible">) {
  const { camera, invalidate, gl, size } = useThree();
  useLayoutEffect(() => {
    camera.position.set(viewport.x + 18, 22, viewport.z + 18);
    camera.lookAt(new Vector3(viewport.x, 0, viewport.z));
    // Three's camera is an imperative engine object, not React-owned state.
    // eslint-disable-next-line react-hooks/immutability
    camera.zoom = 35 * viewport.zoom * Math.min(1, size.width / 650);
    camera.updateProjectionMatrix();
    if (visible) invalidate();
  }, [camera, invalidate, viewport, visible, size.width]);
  useEffect(() => {
    // Measurable renderer counters, no telemetry/network and no frame loop.
    const canvas = gl.domElement;
    const report = () => {
      canvas.dataset.drawCalls = String(gl.info.render.calls);
      canvas.dataset.triangles = String(gl.info.render.triangles);
      canvas.dataset.frames = String(gl.info.render.frame);
    };
    return addAfterEffect(report);
  }, [gl]);
  return null;
}

function ContextGuard({ onUnavailable }: Pick<SceneProps, "onUnavailable">) {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    canvas.addEventListener("webglcontextlost", onUnavailable);
    // R3F intentionally loses its context on unmount. Unsubscribe first so a
    // manual 2D switch isn't incorrectly reported as a device failure.
    return () => canvas.removeEventListener("webglcontextlost", onUnavailable);
  }, [gl, onUnavailable]);
  return null;
}

function Instances({ people, geometry, offset, scale, color, onSelect }: {
  people: readonly PlacedPerson[]; geometry: BufferGeometry; offset: [number, number, number];
  scale: [number, number, number]; color: string | null; onSelect: SceneProps["onSelect"];
}) {
  const mesh = useRef<InstancedMesh>(null);
  const { invalidate } = useThree();
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const object = new Object3D();
    people.forEach((person, index) => {
      object.position.set(person.x + offset[0], offset[1], person.z + offset[2]);
      object.scale.set(...scale); object.updateMatrix();
      mesh.current!.setMatrixAt(index, object.matrix);
      mesh.current!.setColorAt(index, new Color(color ?? TONE_COLORS[person.tone]));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
    invalidate();
  }, [people, color, offset, scale, invalidate]);
  const choose = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const person = people[event.instanceId ?? -1];
    if (person) onSelect(person.key);
  };
  return <instancedMesh ref={mesh} args={[geometry, undefined, people.length]} onClick={choose} castShadow receiveShadow>
    <meshStandardMaterial roughness={0.82} />
  </instancedMesh>;
}

function Furniture({ people, selected, onSelect, areas }: Pick<SceneProps, "people" | "selected" | "onSelect"> & { areas: ReturnType<typeof officeAreas> }) {
  const geometries = useMemo(() => ({ box: new BoxGeometry(1, 1, 1), sphere: new SphereGeometry(1, 12, 8), cylinder: new CylinderGeometry(1, 1, 1, 12) }), []);
  useEffect(() => () => Object.values(geometries).forEach((geometry) => geometry.dispose()), [geometries]);
  const chosen = people.find((person) => person.key === selected);
  return <>
    {areas.map((area) => <group key={area.area} position={[area.x, 0, 0]}>
      <mesh position={[0, -0.22, (area.depth - 7) / 2]} receiveShadow><boxGeometry args={[7.6, 0.35, area.depth]} /><meshStandardMaterial color="#e7e1d5" /></mesh>
      <mesh position={[0, 0.75, -3.6]} receiveShadow castShadow><boxGeometry args={[7.6, 1.6, 0.15]} /><meshStandardMaterial color="#c5cece" /></mesh>
      <mesh position={[-3.8, 0.75, (area.depth - 7) / 2]} receiveShadow castShadow><boxGeometry args={[0.15, 1.6, area.depth]} /><meshStandardMaterial color="#d5d9d1" /></mesh>
      <mesh position={[3, 0.25, -2.9]} castShadow><cylinderGeometry args={[0.35, 0.25, 0.6, 12]} /><meshStandardMaterial color="#b28663" /></mesh>
      <mesh position={[3, 0.95, -2.9]} castShadow><sphereGeometry args={[0.55, 10, 8]} /><meshStandardMaterial color="#768c6e" /></mesh>
      <mesh position={[-2.8, 1.25, -3.48]}><boxGeometry args={[0.7, 0.6, 0.08]} /><meshStandardMaterial color="#f3eee4" /></mesh>
    </group>)}
    <Instances people={people} geometry={geometries.box} offset={[0, 0.95, 0]} scale={[2.2, 0.14, 1.15]} color="#bc9871" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.box} offset={[-0.85, 0.44, 0]} scale={[0.12, 0.9, 0.9]} color="#788286" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.box} offset={[0.85, 0.44, 0]} scale={[0.12, 0.9, 0.9]} color="#788286" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.box} offset={[0, 1.35, -0.3]} scale={[0.9, 0.6, 0.09]} color="#3c505d" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.box} offset={[0, 1.35, -0.245]} scale={[0.76, 0.44, 0.02]} color="#a5bfc0" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.box} offset={[0, 1.04, 0.18]} scale={[0.7, 0.03, 0.25]} color="#e2e3dc" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.cylinder} offset={[0, 0.55, 1.02]} scale={[0.4, 0.13, 0.4]} color="#4c626b" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.box} offset={[0, 0.85, 1.3]} scale={[0.7, 0.65, 0.13]} color="#4c626b" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.cylinder} offset={[0, 0.91, 0.95]} scale={[0.25, 0.58, 0.24]} color={null} onSelect={onSelect} />
    <Instances people={people} geometry={geometries.sphere} offset={[0, 1.43, 0.95]} scale={[0.23, 0.27, 0.23]} color="#d9ae89" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.sphere} offset={[0, 1.58, 0.98]} scale={[0.235, 0.17, 0.23]} color="#574c43" onSelect={onSelect} />
    <Instances people={people} geometry={geometries.cylinder} offset={[0.8, 1.15, 0.18]} scale={[0.1, 0.2, 0.1]} color="#f4eee2" onSelect={onSelect} />
    {chosen ? <mesh position={[chosen.x, 0.01, chosen.z + 0.4]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.22, 1.29, 48]} /><meshBasicMaterial color="#2f7d6d" /></mesh> : null}
  </>;
}

function OfficeScene(props: SceneProps) {
  const drag = useRef<{ x: number; y: number; viewport: SceneProps["viewport"] } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 650, height: 500 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const zoom = 35 * props.viewport.zoom * Math.min(1, size.width / 650);
  const areas = officeAreas(props.people);
  // Instanced meshes have one bounding sphere for every instance. Cull seats
  // individually before uploading matrices, with a generous furniture margin.
  const visiblePeople = props.people.filter((person) => {
    const x = person.x - props.viewport.x;
    const z = person.z - props.viewport.z;
    return Math.abs((x - z) * Math.SQRT1_2 * zoom) < size.width / 2 + 120 &&
      Math.abs((x + z) * 22 / Math.sqrt(2264) * zoom) < size.height / 2 + 120;
  });
  return <div ref={container} className="office-webgl" onPointerDown={(event) => {
    if (event.button === 1 || event.shiftKey) drag.current = { x: event.clientX, y: event.clientY, viewport: props.viewport };
  }} onPointerMove={(event) => {
    if (!drag.current) return;
    const dx = (event.clientX - drag.current.x) / (50 * props.viewport.zoom);
    const dz = (event.clientY - drag.current.y) / (30 * props.viewport.zoom);
    props.onViewport({ ...props.viewport, x: drag.current.viewport.x - dx - dz, z: drag.current.viewport.z + dx - dz });
  }} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
    <Canvas orthographic frameloop={props.visible ? "demand" : "never"} dpr={[1, 1.5]}
      camera={{ position: [18, 22, 18], zoom: 35, near: 0.1, far: 1000 }}
      gl={{ antialias: true, powerPreference: "low-power" }} shadows
      fallback={<p>WebGL unavailable. Choose the 2D floor plan.</p>}>
      <color attach="background" args={["#efede6"]} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[5, 18, 8]} intensity={2.4} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-30} shadow-camera-right={30} shadow-camera-top={30} shadow-camera-bottom={-30} shadow-bias={-0.001} />
      <Camera viewport={props.viewport} visible={props.visible} />
      <ContextGuard onUnavailable={props.onUnavailable} />
      <Furniture people={visiblePeople} areas={areas} selected={props.selected} onSelect={props.onSelect} />
    </Canvas>
    {/* React owns this DOM. Avoid an imperative second React root per label;
        that integration failed cleanup during WebGL/fallback transitions. */}
    <div className="office-label-layer">{props.people.filter((person, index) => index < 12 || person.key === props.selected).slice(0, 13).map((person) => {
      const x = person.x - props.viewport.x;
      const z = person.z + 0.8 - props.viewport.z;
      return <button key={person.key} className={`office-projected-label ${person.key === props.selected ? "selected" : ""}`}
        style={{ left: `calc(50% + ${(x - z) * Math.SQRT1_2 * zoom}px)`, top: `calc(50% + ${((x + z) * 22 / Math.sqrt(2264) - 2.1 * Math.sqrt(648 / 1132)) * zoom}px)` }}
        onClick={() => props.onSelect(person.key)} aria-label={`Inspect ${person.name}, ${person.invocation?.id ?? "profile"}`} aria-pressed={person.key === props.selected}>
        {person.name.slice(0, 20)}<span>{person.kind === "invocation" ? `Turn ${person.slot + 1}` : "Profile"}</span>
      </button>;
    })}{officeAreas(props.people).slice(0, 7).map((area) => {
      const x = area.x - props.viewport.x;
      const z = area.depth - 4 - props.viewport.z;
      return <span key={area.area} className="office-area-label" style={{ left: `calc(50% + ${(x - z) * Math.SQRT1_2 * zoom}px)`, top: `calc(50% + ${(x + z) * 22 / Math.sqrt(2264) * zoom}px)` }}>{area.label.slice(0, 32)}</span>;
    })}</div>
  </div>;
}

export default memo(OfficeScene, (previous, next) =>
  previous.selected === next.selected && previous.visible === next.visible && previous.reducedMotion === next.reducedMotion &&
  previous.viewport === next.viewport && previous.onSelect === next.onSelect && previous.onViewport === next.onViewport &&
  previous.onUnavailable === next.onUnavailable && previous.people.length === next.people.length &&
  previous.people.every((person, index) => {
    const other = next.people[index];
    return person.key === other.key && person.name === other.name && person.tone === other.tone &&
      person.x === other.x && person.z === other.z && person.area === other.area && person.areaLabel === other.areaLabel;
  }),
);
