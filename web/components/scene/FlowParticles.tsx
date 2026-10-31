"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { stepOf, useSceneMotion } from "./motion";
import type { Vec } from "./parts";

const noRaycast = () => null;

function seeded(index: number, salt = 1) {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Glowing slugs travelling along a pipe centerline. `speed` is in scene units per second;
 * the same Catmull-Rom curve as the tube keeps every particle inside its pipe.
 */
export function FlowParticles({ points, count, speed, color, radius, stretch = 2.6, opacity = .92 }: {
  points: Vec[]; count: number; speed: number; color: string; radius: number; stretch?: number; opacity?: number;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const animate = useSceneMotion();
  const path = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", .18);
    const length = curve.getLength();
    return { length, samples: curve.getSpacedPoints(Math.max(48, Math.ceil(length * 30))) };
  }, [points]);
  const offsets = useMemo(() => Array.from({ length: count }, (_, i) => (i + seeded(i) * .45) / count), [count]);
  const phase = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const ahead = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, delta) => {
    const instance = mesh.current;
    if (!instance) return;
    phase.current = (phase.current + stepOf(animate, delta) * speed / path.length) % 1;
    const last = path.samples.length - 1;
    for (let i = 0; i < count; i++) {
      const t = (offsets[i] + phase.current) % 1;
      const f = t * last;
      const index = Math.min(last - 1, Math.floor(f));
      dummy.position.lerpVectors(path.samples[index], path.samples[index + 1], f - index);
      ahead.copy(path.samples[index + 1]);
      if (ahead.distanceToSquared(dummy.position) < 1e-8) ahead.copy(path.samples[Math.min(last, index + 2)]);
      dummy.lookAt(ahead);
      const fade = Math.min(1, t * 14, (1 - t) * 14);
      const visible = speed > .001 ? fade : fade * .8;
      dummy.scale.set(radius * visible, radius * visible, radius * stretch * visible);
      dummy.updateMatrix();
      instance.setMatrixAt(i, dummy.matrix);
    }
    instance.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[undefined, undefined, count]} raycast={noRaycast} frustumCulled={false}>
    <sphereGeometry args={[1, 10, 8]} />
    <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} depthWrite={false} />
  </instancedMesh>;
}

/** Rising, expanding vapour puffs that fade toward the scene background. */
export function SteamPlume({ origin, count = 16, rise = 1.7, spread = .45, rate = 1, size = .11, color = "#f4f6f8", fadeTo, drift = [.25, 0, -.1] }: {
  origin: Vec; count?: number; rise?: number; spread?: number; rate?: number; size?: number; color?: string; fadeTo: string; drift?: Vec;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const animate = useSceneMotion();
  const phase = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const start = useMemo(() => new THREE.Color(color), [color]);
  const end = useMemo(() => new THREE.Color(fadeTo), [fadeTo]);
  const mixed = useMemo(() => new THREE.Color(), []);
  useLayoutEffect(() => {
    const instance = mesh.current;
    if (!instance) return;
    for (let i = 0; i < count; i++) instance.setColorAt(i, start);
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
  }, [count, start]);
  useFrame((_, delta) => {
    const instance = mesh.current;
    if (!instance) return;
    phase.current = (phase.current + stepOf(animate, delta) * .32 * Math.max(.15, rate)) % 1;
    for (let i = 0; i < count; i++) {
      const t = (i / count + phase.current) % 1;
      const wobble = Math.sin((t * 5 + seeded(i, 3) * 6.28)) * spread * t * .35;
      dummy.position.set(
        origin[0] + drift[0] * t * rise + (seeded(i, 2) - .5) * spread * t + wobble,
        origin[1] + rise * t * (.75 + seeded(i, 5) * .5),
        origin[2] + drift[2] * t * rise + (seeded(i, 4) - .5) * spread * t,
      );
      const scale = size * (.45 + 2.6 * t) * Math.min(1, t * 9) * (rate > .05 ? 1 : 0);
      dummy.scale.setScalar(Math.max(.0001, scale));
      dummy.updateMatrix();
      instance.setMatrixAt(i, dummy.matrix);
      mixed.copy(start).lerp(end, Math.min(1, t * t * 1.15));
      instance.setColorAt(i, mixed);
    }
    instance.instanceMatrix.needsUpdate = true;
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[undefined, undefined, count]} raycast={noRaycast} frustumCulled={false}>
    <icosahedronGeometry args={[1, 1]} />
    <meshBasicMaterial transparent opacity={.42} depthWrite={false} toneMapped={false} />
  </instancedMesh>;
}

/** Bubbles and suspended solids swirling in the agitated tank liquid. */
export function TankBubbles({ count = 34, center, radius, bottom, surface, swirl, rise, color = "#d9f1ff" }: {
  count?: number; center: [number, number]; radius: number; bottom: number; surface: number; swirl: number; rise: number; color?: string;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const animate = useSceneMotion();
  const clock = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, delta) => {
    const instance = mesh.current;
    if (!instance) return;
    clock.current += stepOf(animate, delta);
    const height = Math.max(0, surface - bottom);
    for (let i = 0; i < count; i++) {
      const life = (seeded(i, 7) + clock.current * rise * (.6 + seeded(i, 8) * .7) / Math.max(.3, height)) % 1;
      const angle = seeded(i, 9) * Math.PI * 2 + clock.current * swirl * (.7 + seeded(i, 10) * .6);
      const r = radius * (.25 + seeded(i, 11) * .72);
      dummy.position.set(center[0] + Math.cos(angle) * r, bottom + life * height, center[1] + Math.sin(angle) * r);
      const s = height < .05 ? 0 : (.018 + seeded(i, 12) * .022) * Math.min(1, (1 - life) * 8);
      dummy.scale.setScalar(Math.max(.0001, s));
      dummy.updateMatrix();
      instance.setMatrixAt(i, dummy.matrix);
    }
    instance.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[undefined, undefined, count]} raycast={noRaycast} frustumCulled={false}>
    <sphereGeometry args={[1, 8, 6]} />
    <meshBasicMaterial color={color} transparent opacity={.75} toneMapped={false} depthWrite={false} />
  </instancedMesh>;
}
