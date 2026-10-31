"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { stepOf, useSceneMotion } from "./motion";
import { Box, Cylinder, FINISH, InstancedBoxes, makeCanvasTexture, useHazardTexture, type Vec } from "./parts";

const noRaycast = () => null;
const smooth = (value: number) => value * value * (3 - 2 * value);

/** Blinking amber beacon used on mobile equipment. */
export function Beacon({ position, color = "#ffb020", rate = 2.4, offset = 0 }: { position: Vec; color?: string; rate?: number; offset?: number }) {
  const material = useRef<THREE.MeshStandardMaterial>(null);
  const animate = useSceneMotion();
  const clock = useRef(offset);
  useFrame((_, delta) => {
    clock.current += stepOf(animate, delta);
    if (material.current) material.current.emissiveIntensity = animate ? .4 + 3.2 * Math.pow(Math.max(0, Math.sin(clock.current * rate * Math.PI)), 6) : 1.4;
  });
  return <group position={position}>
    <Cylinder radius={.05} height={.04} color="#2a2a2a" paint segments={12} shadow={false} />
    <mesh position={[0, .055, 0]} raycast={noRaycast}><sphereGeometry args={[.05, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial ref={material} color={color} emissive={color} emissiveIntensity={1.4} toneMapped={false} /></mesh>
  </group>;
}

/** Machine status tower: steady running lamp, a slow blinking top lamp, and an occasional attention lamp. */
export function StackLight({ position, attention = false, offset = 0 }: { position: Vec; attention?: boolean; offset?: number }) {
  const lamps = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const animate = useSceneMotion();
  const clock = useRef(offset);
  const colors = ["#3fbf6f", "#ffb020", "#dfe9ff"];
  useFrame((_, delta) => {
    clock.current += stepOf(animate, delta);
    const t = clock.current;
    const [run, amber, top] = lamps.current;
    if (run) run.emissiveIntensity = 1.7;
    if (amber) amber.emissiveIntensity = attention ? (Math.sin(t * 5) > 0 ? 2.4 : .12) : .1;
    if (top) top.emissiveIntensity = animate ? (Math.sin(t * 1.6) > .3 ? 2 : .15) : 1;
  });
  return <group position={position}>
    <Cylinder radius={.018} height={.22} position={[0, .11, 0]} color="#5d6268" segments={8} shadow={false} />
    {colors.map((color, index) => <mesh key={color} position={[0, .27 + index * .085, 0]} raycast={noRaycast}>
      <cylinderGeometry args={[.042, .042, .075, 16]} />
      <meshStandardMaterial ref={(material) => { lamps.current[index] = material; }} color={color} emissive={color} emissiveIntensity={.2} roughness={.3} toneMapped={false} />
    </mesh>)}
    <Cylinder radius={.044} height={.02} position={[0, .5, 0]} color="#2b2b2b" segments={16} shadow={false} />
  </group>;
}

/** Row of pilot lights on the motor control centre, flickering in a steady pattern. */
export function PilotLights({ positions }: { positions: Vec[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const animate = useSceneMotion();
  const clock = useRef(0);
  const palette = useMemo(() => ["#46d17f", "#46d17f", "#ffb020", "#8ec5ff"].map((c) => new THREE.Color(c)), []);
  const color = useMemo(() => new THREE.Color(), []);
  useLayoutEffect(() => {
    const instance = mesh.current;
    if (!instance) return;
    const object = new THREE.Object3D();
    positions.forEach((position, index) => { object.position.set(...position); object.updateMatrix(); instance.setMatrixAt(index, object.matrix); instance.setColorAt(index, palette[index % palette.length]); });
    instance.instanceMatrix.needsUpdate = true;
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
  }, [positions, palette]);
  useFrame((_, delta) => {
    const instance = mesh.current;
    if (!instance || !animate) return;
    clock.current += stepOf(animate, delta);
    positions.forEach((_, index) => {
      const on = Math.sin(clock.current * (1.3 + (index % 5) * .7) + index * 1.7) > -.55;
      color.copy(palette[index % palette.length]).multiplyScalar(on ? 1.6 : .18);
      instance.setColorAt(index, color);
    });
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[undefined, undefined, positions.length]} raycast={noRaycast}>
    <sphereGeometry args={[.022, 8, 6]} />
    <meshBasicMaterial toneMapped={false} />
  </instancedMesh>;
}

/** Control-room displays with gently moving trend bars. */
export function ControlRoomScreens({ light }: { light: boolean }) {
  const bars = useRef<THREE.InstancedMesh>(null);
  const animate = useSceneMotion();
  const clock = useRef(0);
  const count = 36;
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, delta) => {
    const instance = bars.current;
    if (!instance) return;
    clock.current += stepOf(animate, delta);
    for (let i = 0; i < count; i++) {
      const screen = Math.floor(i / 12), column = i % 12;
      const height = .08 + .22 * (.5 + .5 * Math.sin(clock.current * (.6 + screen * .25) + column * .55 + screen));
      dummy.position.set(2.55 + screen * 1.25 + column * .075, 1.32 + height / 2, -5.2);
      dummy.scale.set(.05, height, .01);
      dummy.updateMatrix();
      instance.setMatrixAt(i, dummy.matrix);
    }
    instance.instanceMatrix.needsUpdate = true;
  });
  const screen = light ? "#16324f" : "#0f2740";
  return <group>
    {[0, 1, 2].map((index) => <Box key={index} position={[3 + index * 1.25, 1.55, -5.225]} size={[1.1, .62, .03]} color={screen} emissive="#1d4f80" emissiveIntensity={.9} shadow={false} />)}
    <instancedMesh ref={bars} args={[undefined, undefined, count]} raycast={noRaycast} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color="#5fd1ff" toneMapped={false} />
    </instancedMesh>
    {[2.6, 3.3, 4.0, 4.7, 5.4].map((x, index) => <Box key={x} position={[x, 1.02, -3.95]} rotation={[-.18, 0, 0]} size={[.5, .32, .03]} color="#101820" emissive={index % 2 ? "#3a8fd8" : "#58c4b8"} emissiveIntensity={1.1} shadow={false} />)}
  </group>;
}

function useBeltTexture(light: boolean) {
  const texture = useMemo(() => makeCanvasTexture(64, 16, (context) => {
    context.fillStyle = light ? "#3a3d42" : "#25272b"; context.fillRect(0, 0, 64, 16);
    context.fillStyle = light ? "#55595f" : "#3a3d42";
    for (let x = 0; x < 64; x += 8) context.fillRect(x, 0, 3, 16);
  }, [24, 1]), [light]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

const BELT = { start: -8.25, end: -1.65, z: 4.2, top: .8 };
const CONVEYOR_LEGS = Array.from({ length: 7 }, (_, i) => -8.1 + i * 1.05).flatMap((x) => [3.92, 4.48].map((z) => ({ position: [x, .37, z] as Vec, size: [.06, .74, .06] as Vec })));
const STACKED_CARTONS = [0, 1].flatMap((y) => [0, 1].flatMap((x) => [0, 1].map((z) => ({ position: [-.62 + x * .44, .3 + y * .34, 3.98 + z * .38] as Vec, size: [.42, .32, .36] as Vec }))));

/** Packaging line: belt, cartons and drums riding it, and a pick-and-place arm stacking a pallet. */
export function PackagingLine({ light, rate }: { light: boolean; rate: number }) {
  const belt = useBeltTexture(light);
  const animate = useSceneMotion();
  const items = useRef<THREE.Group>(null);
  const yaw = useRef<THREE.Group>(null);
  const shoulder = useRef<THREE.Group>(null);
  const elbow = useRef<THREE.Group>(null);
  const clock = useRef(0);
  const length = BELT.end - BELT.start;
  const speed = .42 * rate;
  useFrame((_, delta) => {
    const step = stepOf(animate, delta);
    clock.current += step * Math.max(.2, rate);
    belt.offset.x -= step * speed * 24 / length;
    const group = items.current;
    if (group) group.children.forEach((child, index) => {
      const travel = ((index / group.children.length) * length + clock.current * .42) % length;
      child.position.x = BELT.start + .25 + travel;
      const endFade = Math.min(1, (length - travel) / .35, travel / .25);
      child.scale.setScalar(Math.max(.001, endFade));
    });
    const swing = smooth(.5 + .5 * Math.sin(clock.current * 1.15));
    if (yaw.current) yaw.current.rotation.y = 2.35 + (.62 - 2.35) * swing;
    if (shoulder.current) shoulder.current.rotation.z = -.55 - .25 * Math.sin(clock.current * 2.3);
    if (elbow.current) elbow.current.rotation.z = -1.35 + .3 * Math.sin(clock.current * 2.3 + .6);
  });
  const frame = light ? "#2f5d8a" : "#3a6a99";
  return <group>
    <InstancedBoxes items={CONVEYOR_LEGS} color="#59616a" metalness={.5} />
    {[3.86, 4.54].map((z) => <Box key={z} position={[(BELT.start + BELT.end) / 2, BELT.top - .03, z]} size={[length + .1, .14, .06]} color={frame} roughness={.5} metalness={.3} />)}
    <Box position={[(BELT.start + BELT.end) / 2, BELT.top - .04, BELT.z]} size={[length, .04, .62]} color="#ffffff" map={belt} roughness={.85} />
    {[BELT.start, BELT.end].map((x) => <Cylinder key={x} radius={.07} height={.66} position={[x, BELT.top - .06, BELT.z]} rotation={[Math.PI / 2, 0, 0]} color="#7d858d" segments={16} />)}
    <group ref={items}>
      {Array.from({ length: 9 }, (_, index) => <group key={index} position={[BELT.start, BELT.top, BELT.z]}>
        {index % 3 === 2
          ? <Cylinder radius={.17} height={.42} position={[0, .21, 0]} color={index % 2 ? "#6a7681" : "#2c5687"} paint roughness={.45} segments={20} />
          : <Box position={[0, .16, 0]} size={[.42, .32, .36]} color="#b48a5a" roughness={.9} />}
      </group>)}
    </group>
    <StackLight position={[BELT.end - .1, BELT.top, 4.58]} offset={1.3} />
    {/* Pick-and-place arm and its pallet stack. */}
    <Box position={[-.4, .07, 4.18]} size={[1.0, .12, .85]} color="#9b7b52" roughness={.9} />
    <InstancedBoxes items={STACKED_CARTONS} color="#b48a5a" roughness={.9} metalness={0} />
    <group position={[-1.15, 0, 4.85]}>
      <Cylinder radius={.2} height={.18} position={[0, .06, 0]} color="#4b5157" paint />
      <group ref={yaw} rotation={[0, 2.35, 0]}>
        <Cylinder radius={.14} height={.42} position={[0, .36, 0]} color="#e7eaee" paint roughness={.35} segments={24} />
        <group ref={shoulder} position={[0, .6, 0]} rotation={[0, 0, -.55]}>
          <Cylinder radius={.1} height={.2} rotation={[Math.PI / 2, 0, 0]} color="#3d4248" paint segments={18} />
          <Box position={[0, .3, 0]} size={[.12, .6, .12]} color="#e7eaee" roughness={.35} />
          <group ref={elbow} position={[0, .6, 0]} rotation={[0, 0, -1.35]}>
            <Cylinder radius={.08} height={.18} rotation={[Math.PI / 2, 0, 0]} color="#3d4248" paint segments={18} />
            <Box position={[0, .27, 0]} size={[.09, .54, .09]} color="#e7eaee" roughness={.35} />
            <Box position={[0, .58, 0]} size={[.16, .08, .16]} color="#3d4248" />
          </group>
        </group>
      </group>
    </group>
  </group>;
}

/** Overhead travelling crane: bridge runs along the hall, trolley runs across it. */
export function OverheadCrane({ light }: { light: boolean }) {
  const bridge = useRef<THREE.Group>(null);
  const trolley = useRef<THREE.Group>(null);
  const animate = useSceneMotion();
  const clock = useRef(3);
  const hazard = useHazardTexture([1, 2]);
  useFrame((_, delta) => {
    clock.current += stepOf(animate, delta);
    if (bridge.current) bridge.current.position.z = -3.6 + 1.9 * Math.sin(clock.current * .11);
    if (trolley.current) trolley.current.position.x = 4.6 * Math.sin(clock.current * .17 + .8);
  });
  return <group ref={bridge}>
    <Box position={[0, 5.32, 0]} size={[17.05, .34, .26]} color={light ? "#5d7590" : "#55708e"} roughness={.5} metalness={.35} />
    <Box position={[0, 5.32, .38]} size={[17.05, .22, .1]} color={light ? "#5d7590" : "#55708e"} roughness={.5} metalness={.35} />
    {[-8.5, 8.5].map((x) => <Box key={x} position={[x, 5.25, .18]} size={[.42, .3, 1.0]} color="#ffffff" map={hazard} roughness={.6} />)}
    <group ref={trolley}>
      <Box position={[0, 5.6, .18]} size={[.75, .26, .72]} color="#3b4046" roughness={.5} metalness={.4} />
      <Cylinder radius={.12} height={.62} position={[0, 5.6, .18]} rotation={[Math.PI / 2, 0, 0]} color="#5a6067" />
      <Beacon position={[.25, 5.74, .18]} offset={.4} />
      <Cylinder radius={.008} height={.42} position={[0, 5.27, .18]} color="#2a2a2a" segments={6} shadow={false} />
      <Box position={[0, 4.98, .18]} size={[.2, .22, .12]} color="#ffffff" map={hazard} />
      <mesh position={[0, 4.8, .18]} rotation={[0, 0, Math.PI]}><torusGeometry args={[.06, .016, 8, 16, Math.PI * 1.4]} /><meshStandardMaterial color="#3a3a3a" metalness={.7} roughness={.35} /></mesh>
    </group>
  </group>;
}

/** Counterbalance forklift shuttling pallets along the main floor lane. */
export function Forklift() {
  const body = useRef<THREE.Group>(null);
  const carriage = useRef<THREE.Group>(null);
  const animate = useSceneMotion();
  const clock = useRef(0);
  useFrame((_, delta) => {
    clock.current += stepOf(animate, delta);
    const phase = clock.current * .22;
    if (body.current) body.current.position.x = -.6 + 7.0 * Math.cos(phase);
    if (carriage.current) carriage.current.position.y = .12 + .22 * Math.max(0, Math.cos(phase * 2));
  });
  return <group ref={body} position={[0, 0, 2.9]}>
    <Box position={[0, .36, 0]} size={[1.2, .42, .78]} color="#e9ecef" roughness={.45} metalness={.2} />
    <Box position={[-.62, .42, 0]} size={[.32, .55, .8]} color="#2a2d31" roughness={.6} />
    {[[-.42, .15, .38], [-.42, .15, -.38], [.38, .17, .38], [.38, .17, -.38]].map((position, index) => <Cylinder key={index} radius={index < 2 ? .15 : .17} height={.14} position={position as Vec} rotation={[Math.PI / 2, 0, 0]} color="#1b1c1e" paint roughness={.8} segments={18} />)}
    {[[-.4, .32], [-.4, -.32], [.25, .32], [.25, -.32]].map(([x, z], index) => <Box key={index} position={[x, 1.05, z]} size={[.04, 1.0, .04]} color="#2a2d31" />)}
    <Box position={[-.08, 1.56, 0]} size={[.75, .04, .72]} color="#2a2d31" />
    <Box position={[-.15, .72, 0]} size={[.32, .3, .38]} color="#30343a" />
    <Beacon position={[-.08, 1.6, 0]} offset={1.1} />
    {[.24, -.24].map((z) => <Box key={z} position={[.66, 1.05, z]} size={[.06, 1.9, .07]} color="#3a3e44" metalness={.5} roughness={.4} />)}
    <group ref={carriage}>
      <Box position={[.72, .45, 0]} size={[.05, .5, .62]} color="#3a3e44" metalness={.5} />
      {[.2, -.2].map((z) => <Box key={z} position={[1.15, .05, z]} size={[.85, .035, .1]} color="#4a4f55" metalness={.6} roughness={.35} />)}
      <Box position={[1.17, .13, 0]} size={[.85, .1, .8]} color="#9b7b52" roughness={.9} />
      <Box position={[1.17, .4, 0]} size={[.78, .44, .72]} color="#b48a5a" roughness={.9} />
    </group>
  </group>;
}

/** Automated guided vehicle ferrying a tote along the east lane. */
export function GuidedVehicle() {
  const body = useRef<THREE.Group>(null);
  const strip = useRef<THREE.MeshStandardMaterial>(null);
  const animate = useSceneMotion();
  const clock = useRef(5);
  useFrame((_, delta) => {
    clock.current += stepOf(animate, delta);
    if (body.current) body.current.position.z = -1.8 + 3.6 * Math.cos(clock.current * .24);
    if (strip.current) strip.current.emissiveIntensity = animate ? 1.2 + .8 * Math.sin(clock.current * 6) : 1.4;
  });
  return <group ref={body} position={[7.8, 0, 0]}>
    <Box position={[0, .16, 0]} size={[.72, .24, 1.05]} color="#d9dde2" roughness={.4} metalness={.2} />
    <mesh position={[0, .17, .53]} raycast={noRaycast}><boxGeometry args={[.6, .05, .01]} /><meshStandardMaterial ref={strip} color="#cfe8ff" emissive="#cfe8ff" emissiveIntensity={1.4} toneMapped={false} /></mesh>
    <mesh position={[0, .17, -.53]} raycast={noRaycast}><boxGeometry args={[.6, .05, .01]} /><meshStandardMaterial color="#ffb020" emissive="#ffb020" emissiveIntensity={1.2} toneMapped={false} /></mesh>
    <Box position={[0, .58, 0]} size={[.62, .58, .78]} color="#f1f1ee" roughness={.3} transparent opacity={.85} />
    <InstancedBoxes items={[[-.31, -.39], [.31, -.39], [-.31, .39], [.31, .39]].map(([x, z]) => ({ position: [x, .58, z] as Vec, size: [.03, .6, .03] as Vec }))} color="#7c838a" metalness={.6} />
    <Beacon position={[.24, .3, .4]} offset={2.2} rate={3} />
  </group>;
}

/** Thin painted toe-plates, rungs and rails reused by the platform and ladders. */
export function SafetyRail({ from, to, height = 1.0, postEvery = .8, color = FINISH.safety }: { from: Vec; to: Vec; height?: number; postEvery?: number; color?: string }) {
  const items = useMemo(() => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const length = a.distanceTo(b);
    const middle = a.clone().add(b).multiplyScalar(.5);
    const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
    const pitch = Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z));
    const posts = Math.max(1, Math.round(length / postEvery));
    const list: { position: Vec; size: Vec; rotation?: Vec }[] = [
      { position: [middle.x, middle.y + height, middle.z], size: [length, .045, .045], rotation: [0, yaw, pitch] },
      { position: [middle.x, middle.y + height * .5, middle.z], size: [length, .03, .03], rotation: [0, yaw, pitch] },
    ];
    for (let i = 0; i <= posts; i++) {
      const p = a.clone().lerp(b, i / posts);
      list.push({ position: [p.x, p.y + height / 2, p.z], size: [.04, height, .04] });
    }
    return list;
  }, [from, to, height, postEvery]);
  return <InstancedBoxes items={items} color={color} roughness={.45} metalness={.25} />;
}

