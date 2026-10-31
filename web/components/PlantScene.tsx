"use client";

import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges, Environment, Lightformer, OrbitControls, useCursor } from "@react-three/drei";
import { ArrowsOut, ArrowCounterClockwise, Cube, Factory, Crosshair, Minus, Plus } from "@phosphor-icons/react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsType } from "three-stdlib";
import type { ComponentTag, PlantViewProps } from "../lib/types";
import { agentColor, agentColorStyle } from "../lib/agent-colors";
import { FINISH } from "./scene/parts";
import { FlowParticles, SteamPlume, TankBubbles } from "./scene/FlowParticles";
import { Forklift, GuidedVehicle, OverheadCrane, PackagingLine, SafetyRail } from "./scene/FactoryLife";
import { SceneMotionContext, metricOf, stepOf, usePageVisible, usePrefersReducedMotion, useSceneMotion } from "./scene/motion";
import "./plant-views.css";
import "./plant-scene-factory.css";

type Vec = [number, number, number];
type SceneScope = "plant" | "unit" | "equipment";
const START_POSITION: Vec = [6.4, 4.8, 8.8];
const LOOK_AT: Vec = [-.15, 2.15, 0];
const FRAME_POINTS: Vec[] = [];
for (const x of [-3.7, 3.1]) for (const y of [-.12, .3]) for (const z of [-1.12, 1.12]) FRAME_POINTS.push([x, y, z]);
for (const x of [-1.13, 1.13]) for (const y of [1, 4.35]) for (const z of [-1.13, 1.13]) FRAME_POINTS.push([x, y, z]);
FRAME_POINTS.push([0, 5.53, 0], [-4.3, 4.6, -.55], [4.25, .8, .6]);
const CAMPUS_POINTS: Vec[] = [];
for (const x of [-8.3, 8.1]) for (const z of [-5.6, 4.1]) CAMPUS_POINTS.push([x, -.15, z], [x, 4.2, z]);
const EQUIPMENT_CENTERS: Record<ComponentTag, Vec> = { "P-100": [-2.5, .8, .3], "TK-101": [0, 2.6, 0], "LV-101": [2.67, 1, .52], "E-101": [.2, 2.95, 0], "TV-101": [1.46, 4.7, -.55] };

function frameFor(scope: SceneScope, selected: ComponentTag) {
  if (scope === "plant") return { target: new THREE.Vector3(0, 1.6, -.7), points: [...CAMPUS_POINTS, ...FRAME_POINTS], direction: new THREE.Vector3(14, 12, 19).normalize(), minDistance: 12 };
  if (scope === "equipment") {
    const target = new THREE.Vector3(...EQUIPMENT_CENTERS[selected]);
    const radius = selected === "TK-101" ? 1.7 : selected === "E-101" ? 1.15 : .95;
    const points: Vec[] = [];
    for (const x of [-radius, radius]) for (const y of [-radius, radius]) for (const z of [-radius, radius]) points.push([target.x + x, target.y + y, target.z + z]);
    return { target, points, direction: new THREE.Vector3(...START_POSITION).sub(new THREE.Vector3(...LOOK_AT)).normalize(), minDistance: 3 };
  }
  return { target: new THREE.Vector3(...LOOK_AT), points: FRAME_POINTS, direction: new THREE.Vector3(...START_POSITION).sub(new THREE.Vector3(...LOOK_AT)).normalize(), minDistance: 6 };
}

function plantFits(camera: THREE.Camera, points: Vec[], scope: SceneScope) {
  camera.updateMatrixWorld();
  const projected = new THREE.Vector3();
  return points.every((point) => {
    projected.set(...point).project(camera);
    return Math.abs(projected.x) <= (scope === "plant" ? .95 : .9) && Math.abs(projected.y) <= (scope === "plant" ? 1.02 : .87) && projected.z > -1 && projected.z < 1;
  });
}

function fitPlant(controls: OrbitControlsType, scope: SceneScope, selected: ComponentTag, resetOrientation = false, onlyIfClipped = false) {
  const camera = controls.object;
  const frame = frameFor(scope, selected);
  if (onlyIfClipped && plantFits(camera, frame.points, scope)) return;
  const target = frame.target;
  const direction = resetOrientation ? frame.direction : camera.position.clone().sub(controls.target).normalize();
  if (!direction.lengthSq()) direction.set(6.4, 2.65, 8.8).normalize();
  controls.target.copy(target);
  let low = frame.minDistance, high = 110;
  for (let i = 0; i < 20; i++) {
    const distance = (low + high) / 2;
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    if (plantFits(camera, frame.points, scope)) high = distance;
    else low = distance;
  }
  camera.position.copy(target).addScaledVector(direction, high);
  camera.lookAt(target);
  controls.update();
}

function ResponsiveFraming({ controls, manualCamera, scope, selected }: { controls: RefObject<OrbitControlsType | null>; manualCamera: RefObject<boolean>; scope: SceneScope; selected: ComponentTag }) {
  const { size, invalidate } = useThree();
  const initialized = useRef(false);
  const lastScope = useRef<SceneScope>(scope);
  useLayoutEffect(() => {
    if (!controls.current || !size.width || !size.height) return;
    const camera = controls.current.object;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
    }
    const scopeChanged = lastScope.current !== scope;
    fitPlant(controls.current, scope, selected, !initialized.current || (scopeChanged && scope === "plant"), initialized.current && !scopeChanged && manualCamera.current);
    initialized.current = true;
    lastScope.current = scope;
    invalidate();
  }, [size.width, size.height, controls, manualCamera, invalidate, scope, scope === "equipment" ? selected : null]);
  useEffect(() => {
    const orbit = controls.current;
    if (!orbit) return;
    const onStart = () => { manualCamera.current = true; };
    orbit.addEventListener("start", onStart);
    return () => orbit.removeEventListener("start", onStart);
  }, [controls, manualCamera]);
  return null;
}
const LABEL_ANCHORS: Record<ComponentTag | "steam-header", Vec> = {
  "P-100": [-3.25, 1.45, .4], "TK-101": [-1.65, 2.95, .35],
  "E-101": [1.4, 3.45, .1], "TV-101": [1.5, 5.35, -.35],
  "LV-101": [2.9, 1.55, .8], "steam-header": [-3.35, 4.85, -.55],
};
type LabelRefs = RefObject<Partial<Record<keyof typeof LABEL_ANCHORS, HTMLElement | null>>>;
type LeaderRefs = RefObject<Partial<Record<ComponentTag, SVGLineElement | null>>>;

function LabelProjector({ labels, leaders, overview }: { labels: LabelRefs; leaders: LeaderRefs; overview: boolean }) {
  const projected = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const [tag, position] of Object.entries(LABEL_ANCHORS)) {
      const element = labels.current[tag as keyof typeof LABEL_ANCHORS];
      if (!element) continue;
      projected.set(...position).project(camera);
      const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.15 && Math.abs(projected.y) < 1.15;
      const offsets: Record<string, [number, number]> = {};
      const [offsetX, offsetY] = offsets[tag] ?? [0, 0];
      const originalX = (projected.x * .5 + .5) * size.width;
      const originalY = (-projected.y * .5 + .5) * size.height;
      const edge = size.width < 550 ? 73 : 84;
      const docked: Record<string, [number, number]> = { "P-100": [edge, size.height * .68], "TK-101": [edge, size.height * .44], "E-101": [size.width - edge, size.height * .43], "TV-101": [size.width - edge, size.height * .2], "LV-101": [size.width - edge, size.height * .7], "steam-header": [edge, size.height * .19] };
      const [x, y] = overview ? docked[tag] : [Math.max(80, Math.min(size.width - 80, originalX + offsetX)), Math.max(26, Math.min(size.height - 39, originalY + offsetY))];
      element.style.visibility = visible ? "visible" : "hidden";
      element.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`;
      const leader = leaders.current[tag as ComponentTag];
      if (leader) {
        leader.style.visibility = visible && overview ? "visible" : "hidden";
        leader.setAttribute("x1", String(originalX)); leader.setAttribute("y1", String(originalY)); leader.setAttribute("x2", String(x)); leader.setAttribute("y2", String(y));
      }
    }
  });
  return null;
}

function SceneLabels({ components, selected, onSelect, labels, leaders, activities = [] }: PlantViewProps & { labels: LabelRefs; leaders: LeaderRefs }) {
  const value = (tag: ComponentTag, key: string, precision = 0) => {
    const metric = components.find((item) => item.tag === tag)?.metrics[key];
    return typeof metric === "number" && Number.isFinite(metric) ? metric.toFixed(precision) : "—";
  };
  const contents: Record<ComponentTag, ReactNode> = {
    "P-100": <><span>{value("P-100", "speedPct")} %</span><br /><span>{value("P-100", "feedM3h", 1)} m³/h</span></>,
    "TK-101": <><span>{value("TK-101", "levelPct", 1)} %</span><br /><span>{value("TK-101", "tempC", 1)} °C</span></>,
    "E-101": <span>{value("E-101", "dutyKw")} kW</span>,
    "TV-101": <span>{value("TV-101", "positionPct")} %</span>,
    "LV-101": <span>{value("LV-101", "positionPct")} %</span>,
  };
  return <div className="scene-label-layer">
    <svg className="scene-label-leaders" aria-hidden="true">{(Object.keys(contents) as ComponentTag[]).map((tag) => <line key={tag} ref={(element) => { leaders.current[tag] = element; }} />)}</svg>
    {(Object.keys(contents) as ComponentTag[]).map((tag) => {
      const item = components.find((component) => component.tag === tag);
      const activity = activities.find((entry) => entry.tag === tag && entry.plantId === item?.plantId);
      return <button key={tag} ref={(element) => { labels.current[tag] = element; }} className={`scene-equipment-label scene-agent-label ${selected === tag ? "is-selected" : ""}`} onClick={() => onSelect(tag)} aria-pressed={selected === tag} aria-label={`Select ${tag}, ${activity?.equipmentName ?? item?.name}, ${activity?.state ?? "activity unavailable"}`} title={activity ? `${activity.task} · ${activity.latestAction}` : item?.name}>
        <strong>{tag}<i className={`scene-agent-state state-${activity?.state ?? "unavailable"}`}>{activity?.state ?? "unavailable"}</i></strong>
        <span className="scene-agent-provider">{activity?.vendor ?? item?.vendor} · {(activity?.role ?? item?.role ?? "").replaceAll("_", " ")}</span>
        {selected === tag && <span className="scene-equipment-name">{activity?.equipmentName ?? item?.name}</span>}
        {selected === tag && <span className="scene-agent-metrics">{contents[tag]}</span>}
      </button>;
    })}
    <div ref={(element) => { labels.current["steam-header"] = element; }} className="scene-equipment-label scene-header-label">Steam header<br /><span>{value("TV-101", "headerBarg", 1)} barg</span></div>
  </div>;
}

function Metal({ color = "#a4a4a4", roughness = .27 }: { color?: string; roughness?: number }) {
  return <meshStandardMaterial color={color} roughness={roughness} metalness={.88} />;
}

function Cylinder({ radius, height, position = [0, 0, 0], rotation = [0, 0, 0], color, roughness, children }: {
  radius: number; height: number; position?: Vec; rotation?: Vec; color?: string; roughness?: number; children?: ReactNode;
}) {
  return <mesh position={position} rotation={rotation} castShadow receiveShadow><cylinderGeometry args={[radius, radius, height, 40]} /><Metal color={color} roughness={roughness} />{children}</mesh>;
}

function Pipe({ points, radius = .075, color = "#a6a6a6" }: { points: Vec[]; radius?: number; color?: string }) {
  const curve = useMemo(() => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", .18), [points]);
  return <mesh castShadow receiveShadow><tubeGeometry args={[curve, 90, radius, 12, false]} />{color === "#a6a6a6" ? <Metal color={color} roughness={.22} /> : <meshStandardMaterial color={color} roughness={.42} metalness={.3} />}</mesh>;
}

function Flange({ position, axis = "x", radius = .18 }: { position: Vec; axis?: "x" | "y" | "z"; radius?: number }) {
  const rotation: Vec = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return <group position={position} rotation={rotation}>
    <Cylinder radius={radius} height={.075} roughness={.34} />
    {Array.from({ length: 8 }, (_, i) => <Cylinder key={i} radius={.018} height={.11} color="#6e6e6e" position={[Math.sin(i * Math.PI / 4) * radius * .8, 0, Math.cos(i * Math.PI / 4) * radius * .8]} />)}
  </group>;
}

function Selectable({ tag, selected, onSelect, children }: { tag: ComponentTag; selected: ComponentTag; onSelect: PlantViewProps["onSelect"]; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);
  return <group onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(tag); }} onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
    {children}
    {selected === tag && tag === "TK-101" && <mesh position={[0, 2.62, 0]}><cylinderGeometry args={[1.118, 1.118, 3.12, 42, 1, true, .35, 4.9]} /><meshBasicMaterial wireframe color="#e1e1e1" transparent opacity={.045} /></mesh>}
  </group>;
}

function Valve({ position, selected, scale = 1 }: { position: Vec; selected: boolean; scale?: number }) {
  return <group position={position} scale={scale}>
    <Cylinder radius={.15} height={.4} rotation={[0, 0, Math.PI / 2]} color="#858585" />
    <mesh position={[0, .12, 0]} castShadow><sphereGeometry args={[.17, 24, 18]} /><Metal /></mesh>
    <Cylinder radius={.065} height={.4} position={[0, .25, 0]} />
    <Cylinder radius={.17} height={.07} position={[0, .43, 0]} />
    <Cylinder radius={.26} height={.07} position={[0, .5, 0]} color="#7f7f7f" />
    <mesh position={[0, .542, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.24, .028, 8, 36]} /><Metal color={selected ? "#e8e8e8" : "#b5b5b5"} /></mesh>
    <Flange position={[-.25, 0, 0]} /><Flange position={[.25, 0, 0]} />
    {selected && <>
      <mesh position={[0, .5, 0]}><cylinderGeometry args={[.278, .278, .1, 36]} /><meshBasicMaterial color="#fff" transparent opacity={.06} /><Edges color="#f4f4f4" threshold={35} /></mesh>
      <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.194, .194, .62, 32, 1, true]} /><meshBasicMaterial color="#fff" transparent opacity={.035} /><Edges color="#d8d8d8" threshold={35} /></mesh>
    </>}
  </group>;
}

function YardBlock({ position, size, color = "#777777", metal = false }: { position: Vec; size: Vec; color?: string; metal?: boolean }) {
  return <mesh position={position} castShadow receiveShadow><boxGeometry args={size} /><meshStandardMaterial color={color} roughness={metal ? .4 : .94} metalness={metal ? .65 : .02} /></mesh>;
}

function YardPosts({ positions, height, color }: { positions: Vec[]; height: number; color: string }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const object = new THREE.Object3D();
    positions.forEach((position, index) => { object.position.set(...position); object.updateMatrix(); mesh.current!.setMatrixAt(index, object.matrix); });
    mesh.current.instanceMatrix.needsUpdate = true;
  }, [positions]);
  return <instancedMesh ref={mesh} args={[undefined, undefined, positions.length]} castShadow receiveShadow><boxGeometry args={[.075, height, .075]} /><meshStandardMaterial color={color} roughness={.46} metalness={.6} /></instancedMesh>;
}

function IndustrialYard({ light, selected }: { light: boolean; selected: ComponentTag }) {
  const pad = light ? "#b4bac1" : "#3a4048";
  const building = light ? "#d9dee4" : "#4a5563";
  const railing = FINISH.safety;
  const posts = useMemo<Vec[]>(() => {
    const points: Vec[] = [];
    for (let x = -3.5; x <= 3.5; x += 1) points.push([x, .86, -1.5]);
    return points;
  }, []);
  const rackPosts = useMemo<Vec[]>(() => [-4.5, -1.3, 1.9, 5.1].flatMap((x) => [-2.45, -3.05].map((z) => [x, 2.05, z] as Vec)), []);
  return <group>
    <YardBlock position={[0, -.22, -.5]} size={[18, .25, 11.6]} color={light ? "#c3c6c9" : "#2c3035"} />
    {/* Factory hall: rear and side walls are cut away at the front so the camera sees in. */}
    <YardBlock position={[0, .7, -6.45]} size={[18, 1.5, .2]} color={light ? "#a9a49a" : "#4d4a45"} />
    <YardBlock position={[0, 3.9, -6.45]} size={[18, 4.9, .16]} color={light ? "#8fa7c0" : "#33475e"} />
    <YardBlock position={[-9, .7, -1.2]} size={[.2, 1.5, 10.6]} color={light ? "#a9a49a" : "#4d4a45"} />
    <YardBlock position={[-9, 3.9, -2.55]} size={[.16, 4.9, 7.9]} color={light ? "#8fa7c0" : "#33475e"} />
    <YardBlock position={[-9, 5.25, 3.0]} size={[.16, 2.2, 3.4]} color={light ? "#8fa7c0" : "#33475e"} />
    <YardBlock position={[-9.02, 2.1, 3.0]} size={[.08, 4.1, 3.3]} color={light ? "#6f7a85" : "#262d35"} metal />
    <YardBlock position={[9, .55, -.6]} size={[.2, 1.1, 11.6]} color={light ? "#a9a49a" : "#4d4a45"} />
    {[-7.3, -4.4, -1.5, 1.5, 4.4, 7.3].map((x) => <YardBlock key={`w${x}`} position={[x, 4.85, -6.34]} size={[2.4, .75, .04]} color={light ? "#dcefff" : "#5d86b5"} />)}
    {[-5.2, -2.3].map((z) => <YardBlock key={`lw${z}`} position={[-8.9, 4.85, z]} size={[.04, .75, 2.3]} color={light ? "#dcefff" : "#5d86b5"} />)}
    {[-8.75, -5.85, -2.9, 0, 2.9, 5.85, 8.75].map((x) => <YardBlock key={`c${x}`} position={[x, 3.1, -6.22]} size={[.28, 6.2, .26]} color={FINISH.structure} metal />)}
    {[-3.4, -.6, 1.2, 4.8].flatMap((z) => [-8.78, 8.78].map((x) => <YardBlock key={`sc${x}${z}`} position={[x, 3.1, z]} size={[.26, 6.2, .28]} color={FINISH.structure} metal />))}
    {[-6.1, -3.4, -.6].map((z) => <YardBlock key={`t${z}`} position={[0, 6.05, z]} size={[17.6, .22, .16]} color={FINISH.structure} metal />)}
    {[-8.55, 8.55].map((x) => <YardBlock key={`rw${x}`} position={[x, 5.05, -.65]} size={[.2, .22, 11]} color={FINISH.structure} metal />)}
    {/* Painted floor: forklift lane, AGV lane, and hatched process bay border. */}
    <YardBlock position={[0, -.085, 2.9]} size={[18, .01, 1.3]} color={light ? "#8d949b" : "#23272c"} />
    {[2.25, 3.55].map((z) => <YardBlock key={`lane${z}`} position={[0, -.078, z]} size={[18, .01, .08]} color={FINISH.safety} />)}
    {[7.25, 8.35].map((x) => <YardBlock key={`agv${x}`} position={[x, -.078, -1.9]} size={[.08, .01, 8.3]} color={FINISH.safety} />)}
    {[-1.5, 1.6].map((z) => <YardBlock key={`bay${z}`} position={[.1, -.07, z]} size={[8.8, .02, .16]} color={FINISH.safety} />)}
    {[-4.3, 4.5].map((x) => <YardBlock key={`bayx${x}`} position={[x, -.07, .05]} size={[.16, .02, 3.26]} color={FINISH.safety} />)}
    {[-5.5, -2.5, .5, 3.5, 6.5].map((x) => <YardBlock key={`ar${x}`} position={[x, -.075, 2.9]} size={[.7, .01, .12]} color="#f2f2f2" />)}
    <OverheadCrane light={light} />
    <Forklift />
    <GuidedVehicle />
    <PackagingLine light={light} rate={1} />
    <YardBlock position={[0, 4.25, -1.55]} size={[2.8, .05, .8]} color="#3a3f45" metal />
    <SafetyRail from={[-1.4, 4.27, -1.95]} to={[1.4, 4.27, -1.95]} />
    <SafetyRail from={[1.4, 4.27, -1.95]} to={[1.4, 4.27, -1.15]} />
    <YardBlock position={[-.3, -.055, 0]} size={[8.1, .13, 3.25]} color={pad} />
    <YardBlock position={[-6.1, -.04, .2]} size={[3.5, .17, 6.1]} color={pad} />
    <YardBlock position={[6.1, -.04, .6]} size={[3.1, .17, 4.2]} color={pad} />
    <YardBlock position={[7.6, -.01, -.4]} size={[.75, .18, 7.8]} color={light ? "#b7b7b7" : "#3d3d3d"} />
    <YardPosts positions={posts} height={1.15} color={railing} />
    <Pipe points={[[-3.6, 1.42, -1.5], [3.6, 1.42, -1.5]]} radius={.025} color={railing} />

    {/* Uninstrumented contextual storage and collection equipment are not extra agents. */}
    {[{ x: -6.2, z: 1.05, height: 3.65, radius: 1.05 }, { x: -6.2, z: -1.55, height: 2.85, radius: .94 }, { x: 6.15, z: .6, height: 3.05, radius: 1.05 }].map(({ x, z, height, radius }, index) => <group key={index} position={[x, .17, z]}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow><cylinderGeometry args={[radius, radius, height, 40]} /><meshStandardMaterial color={index === 2 ? "#c9d3dc" : "#e6e1d5"} roughness={.5} metalness={.15} /></mesh>
      <mesh position={[0, height * .7, 0]}><cylinderGeometry args={[radius + .01, radius + .01, .28, 40]} /><meshStandardMaterial color={FINISH.water} roughness={.5} metalness={.2} /></mesh>
      <mesh position={[0, height, 0]} scale={[1, .22, 1]} castShadow><sphereGeometry args={[radius, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2]} /><Metal color="#b3b3b3" roughness={.34} /></mesh>
      {[.12, height * .55, height - .12].map((y) => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[radius + .008, .022, 6, 40]} /><Metal color="#777777" /></mesh>)}
      <Cylinder radius={.13} height={.15} position={[0, height + .27, 0]} />
      <Flange position={[0, height + .35, 0]} axis="y" radius={.2} />
      {[0, 1, 2, 3, 4, 5, 6].map((rung) => <YardBlock key={rung} position={[radius + .08, .4 + rung * .35, .05]} size={[.14, .025, .42]} color="#777777" metal />)}
    </group>)}
    <Pipe points={SUCTION_PATH} radius={.09} color={FINISH.water} />
    <Pipe points={[[-6.2, .58, -1.55], [-4.9, .58, -1.55], [-4.8, .58, 1.05]]} radius={.075} color={FINISH.water} />
    <Pipe points={PRODUCT_PATH} radius={.1} color={FINISH.water} />
    <Flange position={[-4.05, .62, 1.05]} radius={.16} /><Flange position={[4.8, .81, .52]} radius={.18} />

    <YardPosts positions={rackPosts} height={4.05} color={FINISH.structure} />
    {[-4.5, -1.3, 1.9, 5.1].map((x) => <YardBlock key={x} position={[x, 4.08, -2.75]} size={[.13, .13, 1.1]} color="#777777" metal />)}
    {[-2.45, -3.05].map((z) => <YardBlock key={z} position={[.3, 3.85, z]} size={[10.15, .12, .085]} color="#777777" metal />)}
    <Pipe points={[[-4.2, 4.58, -.55], [-4.2, 4.58, -1.5], [-4.2, 4.58, -2.65], [-3.8, 4.58, -2.65], [4.5, 4.58, -2.65], [4.8, 4.35, -2.65], [4.8, 2.8, -3.8]]} radius={.08} color={FINISH.steamClad} />
    {[-3, -1, 1, 3].map((x) => <mesh key={`sb${x}`} position={[x, 4.58, -2.65]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.088, .088, .12, 16]} /><meshStandardMaterial color={FINISH.steamBand} /></mesh>)}
    <Cylinder radius={.14} height={6.9} position={[-7.7, 3.45, -5.7]} color="#8a9096" />
    <Pipe points={CONDENSATE_PATH} radius={.054} color={FINISH.condensate} />
    <Pipe points={[[-4.7, 4.3, -3], [5.2, 4.3, -3]]} radius={.045} color={FINISH.air} />

    <YardBlock position={[4.45, 1.24, -4.2]} size={[5.3, 2.65, 2.15]} color={building} />
    <YardBlock position={[4.45, 2.63, -4.2]} size={[5.55, .16, 2.4]} color={light ? "#a0a0a0" : "#555555"} metal />
    {[2.5, 3.55, 4.6, 5.65].map((x) => <YardBlock key={x} position={[x, 1.72, -3.11]} size={[.78, .65, .035]} color={light ? "#555555" : "#929292"} />)}
    <YardBlock position={[6.35, .87, -3.1]} size={[.65, 1.8, .05]} color="#777777" metal />
    {[-.65, .65].map((x) => <group key={x} position={[x + 4.1, 2.78, -4.3]}><YardBlock position={[0, .1, 0]} size={[.6, .25, .65]} color="#777777" metal /><Cylinder radius={.16} height={.15} position={[0, .3, 0]} color="#777777" /></group>)}
    <YardBlock position={[-5.9, 1.28, -4.2]} size={[3.9, 2.65, 2.15]} color={building} />
    <YardBlock position={[-5.9, 2.66, -4.2]} size={[4.1, .13, 2.35]} color="#777777" metal />
    <YardBlock position={[-5.95, 1.1, -3.1]} size={[1.45, 1.95, .04]} color={light ? "#888888" : "#626262"} metal />
    {[-7.45, -6.85, -6.25, -5.65, -5.05, -4.45].map((x) => <YardBlock key={x} position={[x, 2.08, -3.1]} size={[.025, .65, .035]} color="#444444" />)}

    {[4.55, 5.35].map((x) => <group key={x} position={[x, .8, 1.85]}><YardBlock position={[0, 0, 0]} size={[.62, 1.55, .45]} color={light ? "#bcbcbc" : "#686868"} metal /><YardBlock position={[0, .25, .235]} size={[.35, .2, .02]} color="#252525" /><YardBlock position={[.2, -.15, .237]} size={[.035, .3, .022]} color="#bdbdbd" metal /></group>)}
  </group>;
}


const FEED_PATH: Vec[] = [[-1.85, .58, .32], [-1.6, .58, .32], [-1.41, .77, .32], [-1.41, 1.2, .32], [-1.28, 1.39, .32], [-1.02, 1.4, .32]];
const OUTLET_PATH: Vec[] = [[.55, 1.01, .52], [.8, .73, .52], [1.2, .68, .52], [2.5, .68, .52], [3.6, .68, .52], [4.15, .73, .52]];
const STEAM_PATH: Vec[] = [[-4.2, 4.5, -.55], [-2.5, 4.5, -.55], [.6, 4.5, -.55], [1.7, 4.5, -.55], [2.12, 4.5, -.55], [2.32, 4.31, -.55], [2.32, 2.5, -.55], [2.15, 2.3, -.55], [1.1, 2.3, -.25]];
const SUCTION_PATH: Vec[] = [[-6.2, .62, 1.05], [-4.8, .62, 1.05], [-4.05, .62, 1.05], [-3.85, .62, 1.05], [-2.12, .62, 1.05], [-2.12, .66, .63]];
const PRODUCT_PATH: Vec[] = [[4.15, .81, .52], [4.8, .81, .52], [5.05, 1.1, .52], [5.15, 1.1, .6]];
const RACK_STEAM_PATH: Vec[] = [[4.8, 2.8, -3.8], [4.8, 4.35, -2.65], [4.5, 4.58, -2.65], [-3.8, 4.58, -2.65], [-4.2, 4.58, -2.65], [-4.2, 4.58, -1.5], [-4.2, 4.58, -.55]];
const CONDENSATE_PATH: Vec[] = [[-.2, .32, -.8], [-.2, .32, -2.92], [4.4, .32, -2.92], [4.9, .32, -3.5]];

type MarkerSpec = { halo: { position: Vec; radius: number; scale?: [number, number] }; band: { position: Vec; radius: number; rotation: Vec }; beacon: Vec };
const MARKERS: Record<ComponentTag, MarkerSpec> = {
  "P-100": { halo: { position: [-2.65, -.01, .32], radius: .62, scale: [1.7, 1] }, band: { position: [-2.75, .66, .32], radius: .32, rotation: [0, Math.PI / 2, 0] }, beacon: [-2.65, 1.75, .32] },
  "TK-101": { halo: { position: [0, -.005, 0], radius: 1.42 }, band: { position: [0, 1.75, 0], radius: 1.13, rotation: [Math.PI / 2, 0, 0] }, beacon: [0, 6.0, 0] },
  "E-101": { halo: { position: [.0, 2.36, 0], radius: .92 }, band: { position: [0, 3.72, 0], radius: .82, rotation: [Math.PI / 2, 0, 0] }, beacon: [.9, 3.6, 1.45] },
  "LV-101": { halo: { position: [2.67, -.01, .52], radius: .52 }, band: { position: [2.67, 1.26, .52], radius: .275, rotation: [Math.PI / 2, 0, 0] }, beacon: [2.67, 2.05, .52] },
  "TV-101": { halo: { position: [1.46, 4.32, -.55], radius: .45 }, band: { position: [1.46, 5.03, -.55], radius: .25, rotation: [Math.PI / 2, 0, 0] }, beacon: [1.46, 5.8, -.55] },
};

function AgentMarker({ tag, color, selected, highlighted, state }: { tag: ComponentTag; color: string; selected: boolean; highlighted: boolean; state?: string }) {
  const spec = MARKERS[tag];
  const ring = useRef<THREE.MeshBasicMaterial>(null);
  const fill = useRef<THREE.MeshBasicMaterial>(null);
  const band = useRef<THREE.MeshBasicMaterial>(null);
  const beacon = useRef<THREE.Group>(null);
  const animate = useSceneMotion();
  const clock = useRef(0);
  const busy = state === "thinking" || state === "reviewing";
  const blocked = state === "blocked";
  useFrame((_, delta) => {
    clock.current += stepOf(animate, delta);
    const pulse = animate ? .5 + .5 * Math.sin(clock.current * 4) : .7;
    const base = blocked ? .95 : selected ? .85 : busy ? .35 + .55 * pulse : highlighted ? .5 + .45 * pulse : .45;
    if (ring.current) ring.current.opacity = base;
    if (fill.current) fill.current.opacity = (selected || highlighted || blocked ? .2 : .08) * (busy || highlighted ? .6 + .6 * pulse : 1);
    if (band.current) band.current.opacity = Math.min(1, base + .1);
    if (beacon.current) { beacon.current.visible = highlighted; beacon.current.position.y = spec.beacon[1] + (animate ? Math.sin(clock.current * 3) * .12 : 0); beacon.current.rotation.y += stepOf(animate, delta) * 1.6; }
  });
  const [sx, sz] = spec.halo.scale ?? [1, 1];
  const r = spec.halo.radius;
  return <group>
    <group position={spec.halo.position} scale={[sx, 1, sz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}><ringGeometry args={[r * (blocked ? .8 : .87), r, 64]} /><meshBasicMaterial ref={ring} color={color} transparent opacity={.5} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .002, 0]} raycast={() => null}><circleGeometry args={[r * .87, 48]} /><meshBasicMaterial ref={fill} color={color} transparent opacity={.1} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} /></mesh>
      {blocked && <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}><ringGeometry args={[r * 1.08, r * 1.15, 64]} /><meshBasicMaterial color={color} toneMapped={false} side={THREE.DoubleSide} /></mesh>}
    </group>
    <mesh position={spec.band.position} rotation={spec.band.rotation} raycast={() => null}><torusGeometry args={[spec.band.radius, .028, 8, 48]} /><meshBasicMaterial ref={band} color={color} transparent opacity={.8} toneMapped={false} /></mesh>
    <group ref={beacon} position={spec.beacon} visible={false}>
      <mesh rotation={[Math.PI, 0, 0]} raycast={() => null}><coneGeometry args={[.16, .34, 4]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>
      <mesh position={[0, -spec.beacon[1] / 2 - .1, 0]} raycast={() => null}><cylinderGeometry args={[.05, .05, Math.max(.2, spec.beacon[1] - .3), 12]} /><meshBasicMaterial color={color} transparent opacity={.22} toneMapped={false} depthWrite={false} /></mesh>
    </group>
  </group>;
}

function AgentMarkers({ components, selected, activities = [], highlighted }: PlantViewProps) {
  const plantId = components[0]?.plantId ?? "plant-a";
  return <>{(Object.keys(MARKERS) as ComponentTag[]).map((tag) => {
    const color = agentColor(plantId, tag)?.color ?? "#cccccc";
    const state = activities.find((entry) => entry.tag === tag && entry.plantId === plantId)?.state;
    return <AgentMarker key={tag} tag={tag} color={color} selected={selected === tag} highlighted={highlighted === tag} state={state} />;
  })}</>;
}

function ProcessFlows({ components, light }: { components: PlantViewProps["components"]; light: boolean }) {
  const speed = metricOf(components, "P-100", "speedPct", 50);
  const valve = metricOf(components, "LV-101", "positionPct", 50);
  const steam = metricOf(components, "TV-101", "steamKgH", 1980);
  const temp = metricOf(components, "TK-101", "tempC", 75);
  const level = Math.max(0, Math.min(100, metricOf(components, "TK-101", "levelPct", 50)));
  const water = "#7cc4ff", steamColor = "#ffd9b8";
  const feed = 1.1 * speed / 50, out = 1.1 * valve / 50, steamRate = 2.0 * steam / 1980;
  return <>
    <group position={[0, .08, 0]}>
      <FlowParticles points={FEED_PATH} count={10} speed={feed} color={water} radius={.105} />
      <FlowParticles points={OUTLET_PATH} count={16} speed={out} color={water} radius={.11} />
      <FlowParticles points={STEAM_PATH} count={26} speed={steamRate} color={steamColor} radius={.075} />
      <TankBubbles center={[0, 0]} radius={.9} bottom={1.15} surface={1.12 + 2.9 * level / 100} swirl={1.4} rise={.35 + .25 * steam / 1980} />
    </group>
    <FlowParticles points={SUCTION_PATH} count={18} speed={feed} color={water} radius={.1} />
    <FlowParticles points={PRODUCT_PATH} count={6} speed={out} color={water} radius={.115} />
    <FlowParticles points={RACK_STEAM_PATH} count={34} speed={steamRate} color={steamColor} radius={.088} />
    <FlowParticles points={CONDENSATE_PATH} count={14} speed={.6 * steam / 1980} color="#ffb877" radius={.06} />
    <SteamPlume origin={[-.52, 4.75, -.19]} rate={Math.max(0, (temp - 55) / 20)} fadeTo={light ? "#e4e8ec" : "#151a20"} />
    <SteamPlume origin={[-7.7, 6.9, -5.7]} count={20} rise={2.2} size={.16} rate={steam / 1980} fadeTo={light ? "#e4e8ec" : "#151a20"} />
  </>;
}

function SceneModel({ components, selected, onSelect }: PlantViewProps) {
  const rawLevel = components.find((item) => item.tag === "TK-101")?.metrics.levelPct;
  const level = typeof rawLevel === "number" && Number.isFinite(rawLevel) ? Math.max(0, Math.min(100, rawLevel)) : 0;
  const liquidHeight = 2.9 * level / 100;
  const coilPoints = useMemo(() => {
    const points: Vec[] = [];
    for (let i = 0; i <= 210; i++) {
      const angle = (i / 210) * Math.PI * 2 * 4.2;
      points.push([Math.cos(angle) * .78, 2.3 + (i / 210) * 1.3, Math.sin(angle) * .78]);
    }
    return points;
  }, []);

  return <>
    <group position={[0, .08, 0]}>
      {/* The skid is a modeled engineering assembly, with every asset independently selectable. */}
      {[-.95, .95].map((z) => <mesh key={z} position={[-.35, .1, z]} castShadow receiveShadow><boxGeometry args={[6.8, .17, .13]} /><Metal color="#777777" roughness={.4} /></mesh>)}
      {[-3.55, -.9, 2.95].map((x) => <mesh key={x} position={[x, .1, 0]} castShadow><boxGeometry args={[.14, .17, 2.03]} /><Metal color="#777777" roughness={.4} /></mesh>)}
      {[-3.4, -.8, 2.8].flatMap((x) => [-.87, .87].map((z) => <mesh key={`${x}-${z}`} position={[x, -.04, z]} castShadow><boxGeometry args={[.22, .14, .22]} /><Metal color="#7b7b7b" /></mesh>))}
      {[-.7, .7].flatMap((x) => [-.57, .57].map((z) => <mesh key={`${x}-${z}`} position={[x, .63, z]} castShadow><boxGeometry args={[.1, 1.0, .13]} /><Metal color="#979797" /></mesh>))}

      <Selectable tag="TK-101" selected={selected} onSelect={onSelect}>
        <mesh position={[0, 2.53, 0]} castShadow receiveShadow><cylinderGeometry args={[1.1, 1.1, 3.03, 70, 1, true, 1.05, Math.PI * 2 - 1.9]} /><meshStandardMaterial color="#a6a6a6" roughness={.22} metalness={.91} side={THREE.DoubleSide} />{selected === "TK-101" && <Edges color="#dcdcdc" threshold={30} />}</mesh>
        <Cylinder radius={1.1} height={.16} position={[0, 1.03, 0]} roughness={.22} />
        <Cylinder radius={1.1} height={.16} position={[0, 4.06, 0]} roughness={.22} />
        {[1.09, 4.01].map((y) => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow><torusGeometry args={[1.09, .045, 10, 64]} /><Metal color="#c3c3c3" /></mesh>)}
        <mesh position={[0, 4.12, 0]} scale={[1, .17, 1]} castShadow><sphereGeometry args={[1.08, 48, 22, 0, Math.PI * 2, 0, Math.PI / 2]} /><Metal /></mesh>
        {liquidHeight > 0 && <>
          <mesh position={[0, 1.12 + liquidHeight / 2, 0]}><cylinderGeometry args={[1.045, 1.045, liquidHeight, 64]} /><meshPhysicalMaterial color="#a1a1a1" roughness={.2} metalness={.48} transparent opacity={.83} /></mesh>
          <mesh position={[0, 1.125 + liquidHeight, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[1.048, 64]} /><meshStandardMaterial color="#aaaaaa" metalness={.78} roughness={.13} /></mesh>
          {[.28, .53, .81].map((radius) => <mesh key={radius} position={[0, 1.13 + liquidHeight, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[radius, .004, 4, 50]} /><meshBasicMaterial color="#bdbdbd" transparent opacity={.25} /></mesh>)}
        </>}
        <Cylinder radius={.12} height={.22} position={[.58, 4.34, .17]} />
        <Flange position={[.58, 4.43, .17]} axis="y" radius={.16} />
        <Cylinder radius={.09} height={.35} position={[-.52, 4.42, -.19]} />
        <Cylinder radius={.21} height={.07} position={[-.52, 4.61, -.19]} />
        <Cylinder radius={.3} height={.22} position={[0, 4.4, 0]} color="#888888" />
        <Flange position={[0, 4.55, 0]} axis="y" radius={.34} />
        <Cylinder radius={.22} height={.75} position={[0, 4.99, 0]} color="#757575" roughness={.4} />
        {Array.from({ length: 16 }, (_, i) => <mesh key={i} position={[Math.sin(i * Math.PI / 8) * .23, 4.99, Math.cos(i * Math.PI / 8) * .23]} rotation={[0, i * Math.PI / 8, 0]} castShadow><boxGeometry args={[.025, .65, .065]} /><Metal color="#646464" roughness={.45} /></mesh>)}
        <Cylinder radius={.245} height={.07} position={[0, 5.39, 0]} />
        <Cylinder radius={.032} height={1.85} position={[0, 3.18, 0]} color="#d3d3d3" />
      </Selectable>

      <Selectable tag="E-101" selected={selected} onSelect={onSelect}>
        <Pipe points={coilPoints} radius={.045} color={selected === "E-101" ? "#e2e2e2" : "#c7c7c7"} />
        <Pipe points={[[.78, 2.3, 0], [.93, 2.3, -.17], [1.1, 2.3, -.25]]} radius={.05} />
        <Pipe points={[[.24, 3.6, .742], [.24, 3.83, .742], [.24, 4.15, .742], [.52, 4.35, .742]]} radius={.043} />
      </Selectable>

      <Selectable tag="P-100" selected={selected} onSelect={onSelect}>
        <Cylinder radius={.3} height={.75} position={[-2.97, .58, .32]} rotation={[0, 0, Math.PI / 2]} color="#7d7d7d" roughness={.4} />
        <Cylinder radius={.32} height={.1} position={[-3.4, .58, .32]} rotation={[0, 0, Math.PI / 2]} />
        {Array.from({ length: 18 }, (_, i) => <mesh key={i} position={[-2.97, .58 + Math.sin(i * Math.PI / 9) * .3, .32 + Math.cos(i * Math.PI / 9) * .3]} rotation={[i * -Math.PI / 9, 0, 0]} castShadow><boxGeometry args={[.68, .025, .055]} /><Metal color="#747474" roughness={.4} /></mesh>)}
        <Cylinder radius={.1} height={.3} position={[-2.45, .58, .32]} rotation={[0, 0, Math.PI / 2]} color="#676767" />
        <Cylinder radius={.29} height={.4} position={[-2.12, .58, .32]} rotation={[0, 0, Math.PI / 2]} />
        <Flange position={[-1.88, .58, .32]} radius={.26} />
        <Cylinder radius={.09} height={.27} position={[-2.12, .95, .32]} /><Flange position={[-2.12, 1.1, .32]} axis="y" radius={.14} />
        <mesh position={[-2.97, .95, .32]} castShadow><boxGeometry args={[.25, .14, .25]} /><Metal color="#8e8e8e" /></mesh>
        {[-3.23, -2.65, -2.12].map((x) => <mesh key={x} position={[x, .27, .32]} castShadow><boxGeometry args={[.14, .18, .55]} /><Metal color="#828282" /></mesh>)}
        {selected === "P-100" && <mesh position={[-2.12, .58, .32]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.303, .303, .43, 32]} /><meshBasicMaterial color="#fff" transparent opacity={.04} /><Edges color="#e7e7e7" /></mesh>}
      </Selectable>
      <Pipe points={FEED_PATH} radius={.095} color={FINISH.water} />
      <Flange position={[-1.15, 1.4, .32]} radius={.19} />

      <Pipe points={OUTLET_PATH} radius={.1} color={FINISH.water} />
      <Flange position={[1.05, .68, .52]} radius={.19} />
      <Selectable tag="LV-101" selected={selected} onSelect={onSelect}><Valve position={[2.67, .68, .52]} selected={selected === "LV-101"} /></Selectable>

      <Pipe points={STEAM_PATH} radius={.066} color={FINISH.steamPaint} />
      <Flange position={[.7, 4.5, -.55]} radius={.14} /><Flange position={[2.32, 3.5, -.55]} axis="y" radius={.13} /><Flange position={[1.1, 2.3, -.25]} radius={.15} />
      <Selectable tag="TV-101" selected={selected} onSelect={onSelect}><Valve position={[1.46, 4.5, -.55]} selected={selected === "TV-101"} scale={.9} /></Selectable>
      <Cylinder radius={.045} height={1.9} position={[2.06, 1.3, -.55]} color="#898989" />
    </group>

  </>;
}

class SceneErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function SceneFallback({ components, selected, onSelect }: PlantViewProps) {
  const points: { tag: ComponentTag; left: string; top: string; metric: string; unit: string }[] = [
    { tag: "P-100", left: "16%", top: "68%", metric: "speedPct", unit: "%" },
    { tag: "TK-101", left: "40%", top: "37%", metric: "levelPct", unit: "%" },
    { tag: "E-101", left: "60%", top: "32%", metric: "dutyKw", unit: "kW" },
    { tag: "TV-101", left: "67%", top: "10%", metric: "positionPct", unit: "%" },
    { tag: "LV-101", left: "77%", top: "73%", metric: "positionPct", unit: "%" },
  ];
  return <div className="scene-fallback">
    {/* A local pre-render preserves the engineering view on devices without WebGL. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/assets/plant-3d.png" alt="Cutaway 3D engineering visualization of the heated tank, steam coil, feed pump, and valves" />
    {points.map(({ tag, left, top, metric, unit }) => {
      const value = components.find((item) => item.tag === tag)?.metrics[metric];
      return <button key={tag} className="scene-fallback-target" style={{ left, top }} aria-pressed={selected === tag} onClick={() => onSelect(tag)}>{tag}<br />{typeof value === "number" && Number.isFinite(value) ? value.toFixed(0) : "—"} {unit}</button>;
    })}
    <div className="scene-fallback-note">3D preview · WebGL unavailable</div>
  </div>;
}

export default function PlantScene(props: PlantViewProps) {
  const light = props.theme === "light";
  const [scope, setScope] = useState<SceneScope>("plant");
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [autoRotate, setAutoRotate] = useState(false);
  const controls = useRef<OrbitControlsType>(null);
  const manualCamera = useRef(false);
  const labels = useRef<Partial<Record<keyof typeof LABEL_ANCHORS, HTMLElement | null>>>({});
  const leaders = useRef<Partial<Record<ComponentTag, SVGLineElement | null>>>({});
  useEffect(() => {
    const canvas = document.createElement("canvas");
    let context: WebGL2RenderingContext | WebGLRenderingContext | null = null;
    try { context = canvas.getContext("webgl2") ?? canvas.getContext("webgl"); setWebgl(Boolean(context)); }
    catch { setWebgl(false); }
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  }, []);
  const reset = () => {
    setAutoRotate(false);
    if (!controls.current) return;
    manualCamera.current = false;
    setScope("plant");
    fitPlant(controls.current, "plant", props.selected, true);
  };
  const fit = () => {
    setAutoRotate(false);
    if (!controls.current) return;
    manualCamera.current = false;
    setScope("unit");
    fitPlant(controls.current, "unit", props.selected);
  };
  const overview = () => {
    setAutoRotate(false); manualCamera.current = false; setScope("plant");
    if (controls.current) fitPlant(controls.current, "plant", props.selected, true);
  };
  const focusSelected = () => {
    setAutoRotate(false); manualCamera.current = false; setScope("equipment");
    if (controls.current) fitPlant(controls.current, "equipment", props.selected);
  };
  const zoom = (factor: number) => {
    if (!controls.current) return;
    manualCamera.current = true;
    const offset = controls.current.object.position.clone().sub(controls.current.target).multiplyScalar(factor);
    if (offset.length() > 3 && offset.length() < 110) controls.current.object.position.copy(controls.current.target).add(offset);
    controls.current.update();
  };
  const fallback = <SceneFallback {...props} />;

  return <div className={`plant-scene engineering-viewport ${scope === "plant" ? "is-plant-overview" : ""}`} role="group" aria-label="Interactive 3D plant. Drag to orbit, scroll to zoom, or select equipment labels.">
    {webgl === true ? <SceneErrorBoundary fallback={fallback} onFailure={() => setWebgl(false)}>
      <Suspense fallback={fallback}>
        <Canvas shadows dpr={[1, 1.7]} camera={{ position: START_POSITION, fov: 34, near: .1, far: 160 }} frameloop={autoRotate ? "always" : "demand"} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }} onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
          gl.domElement.addEventListener("webglcontextlost", (event) => { event.preventDefault(); setWebgl(false); }, { once: true });
        }}>
          <color attach="background" args={[light ? "#f5f5f5" : "#0b0b0b"]} />
          <ambientLight intensity={.7} />
          <directionalLight position={[-4, 12, 5]} intensity={3} castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-.001} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={10} shadow-camera-bottom={-10} />
          <directionalLight position={[5, 4, -4]} intensity={1.8} />
          <Environment resolution={128}>
            <Lightformer form="rect" intensity={2} color="#ffffff" scale={[5, 7, 1]} position={[-5, 5, 3]} rotation={[0, Math.PI / 2, 0]} />
            <Lightformer form="rect" intensity={2.5} color="#ffffff" scale={[2, 9, 1]} position={[5, 4, -3]} rotation={[0, -Math.PI / 2, 0]} />
            <Lightformer form="rect" intensity={1.5} color="#ffffff" scale={[7, 3, 1]} position={[0, 8, 0]} rotation={[Math.PI / 2, 0, 0]} />
          </Environment>
          <SceneModel {...props} />
          <IndustrialYard light={light} selected={props.selected} />
          <LabelProjector labels={labels} leaders={leaders} overview={scope === "plant"} />
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.08, 0]} receiveShadow><planeGeometry args={[45, 45]} /><meshStandardMaterial color={light ? "#ededed" : "#040404"} roughness={.95} metalness={0} /></mesh>
          <gridHelper key={light ? "light-grid" : "dark-grid"} args={[40, 40, light ? "#c9c9c9" : "#252525", light ? "#dedede" : "#1b1b1b"]} position={[0, -.075, 0]} />
          <OrbitControls ref={controls} makeDefault target={LOOK_AT} enableDamping dampingFactor={.08} minDistance={3} maxDistance={110} maxPolarAngle={Math.PI / 2 - .04} minPolarAngle={.2} autoRotate={autoRotate} autoRotateSpeed={.45} />
          <ResponsiveFraming controls={controls} manualCamera={manualCamera} scope={scope} selected={props.selected} />
        </Canvas>
      </Suspense>
    </SceneErrorBoundary> : webgl === false ? fallback : <div className="scene-fallback"><span className="scene-fallback-note">Preparing 3D view…</span></div>}
    <div className="scene-orientation" aria-hidden="true"><span>TOP / FRONT</span></div>
    {props.forecast && <div className="scene-forecast"><span>Proposal forecast</span>{props.forecast.predicted}% predicted /<br />{props.forecast.threshold}% safety threshold.</div>}
    {webgl && <>
      <SceneLabels {...props} labels={labels} leaders={leaders} />
      <div className="scene-campus-caption"><span>{scope === "plant" ? "Plant overview" : scope === "unit" ? "Process unit" : `Focused · ${props.selected}`}</span><small>Surrounding facilities are schematic context</small></div>
      <div className="scene-help">DRAG TO ORBIT <span aria-hidden="true">·</span> SCROLL TO ZOOM</div>
      <div className="scene-controls" aria-label="3D camera controls">
        <button title="Whole plant overview" aria-label="Show whole plant overview" aria-pressed={scope === "plant"} onClick={overview}><Factory size={17} /></button>
        <button title="Focus selected equipment" aria-label="Focus selected equipment" aria-pressed={scope === "equipment"} onClick={focusSelected}><Crosshair size={17} /></button>
        <button title="Rotate plant" aria-label="Toggle automatic orbit" aria-pressed={autoRotate} onClick={() => setAutoRotate((current) => !current)}><Cube size={17} /></button>
        <button title="Zoom in" aria-label="Zoom in" onClick={() => zoom(.85)}><Plus size={15} /></button>
        <button title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.18)}><Minus size={15} /></button>
        <button title="Fit process unit" aria-label="Fit process unit to view" aria-pressed={scope === "unit"} onClick={fit}><ArrowsOut size={16} /></button>
        <button title="Reset view" aria-label="Reset 3D camera" onClick={reset}><ArrowCounterClockwise size={17} /></button>
      </div>
    </>}
  </div>;
}
