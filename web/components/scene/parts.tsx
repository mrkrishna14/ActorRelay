"use client";

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";

export type Vec = [number, number, number];

/** Pipe classes and painted finishes shared by the factory hall and the process skid. */
export const FINISH = {
  water: "#2a62a0",        // process water / feed and product lines
  steamClad: "#c3c9cf",    // aluminium-clad insulated steam
  steamBand: "#e2611f",    // steam class band, red-orange
  steamPaint: "#c4532b",   // short uninsulated steam drop to the coil
  condensate: "#8c5a34",
  air: "#e0b52a",          // utilities, plant air
  coolingWater: "#4b7f8c",
  fireWater: "#b5352d",
  structure: "#3f5873",    // painted structural steel
  machine: "#35577d",      // motor / machine blue
  casing: "#4a5560",
  safety: "#efc12a",       // safety-yellow rails and guards
  black: "#1c1d1f",
  stainless: "#b8bec4",
  copper: "#b9713d",
} as const;

export function Metal({ color = "#a4a4a4", roughness = .27, metalness = .88 }: { color?: string; roughness?: number; metalness?: number }) {
  return <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} />;
}

export function Paint({ color, roughness = .55, metalness = .18, emissive, emissiveIntensity = 0, map }: { color: string; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number; map?: THREE.Texture | null }) {
  return <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} emissive={emissive ?? "#000000"} emissiveIntensity={emissiveIntensity} map={map ?? null} />;
}

export function Cylinder({ radius, height, position = [0, 0, 0], rotation = [0, 0, 0], color, roughness, paint = false, segments = 40, shadow = true, children }: {
  radius: number; height: number; position?: Vec; rotation?: Vec; color?: string; roughness?: number; paint?: boolean; segments?: number; shadow?: boolean; children?: ReactNode;
}) {
  return <mesh position={position} rotation={rotation} castShadow={shadow} receiveShadow>
    <cylinderGeometry args={[radius, radius, height, segments]} />
    {paint ? <Paint color={color ?? "#888888"} roughness={roughness} /> : <Metal color={color} roughness={roughness} />}
    {children}
  </mesh>;
}

export function Pipe({ points, radius = .075, color = "#a6a6a6", paint = false, segments = 90 }: { points: Vec[]; radius?: number; color?: string; paint?: boolean; segments?: number }) {
  const curve = useMemo(() => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", .18), [points]);
  return <mesh castShadow receiveShadow>
    <tubeGeometry args={[curve, segments, radius, 12, false]} />
    {paint ? <Paint color={color} roughness={.42} metalness={.3} /> : <Metal color={color} roughness={.22} />}
  </mesh>;
}

export function Flange({ position, axis = "x", radius = .18, color }: { position: Vec; axis?: "x" | "y" | "z"; radius?: number; color?: string }) {
  const rotation: Vec = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return <group position={position} rotation={rotation}>
    <Cylinder radius={radius} height={.075} roughness={.34} color={color} paint={Boolean(color)} />
    {Array.from({ length: 8 }, (_, i) => <Cylinder key={i} radius={.018} height={.11} color="#6e6e6e" shadow={false} segments={8} position={[Math.sin(i * Math.PI / 4) * radius * .8, 0, Math.cos(i * Math.PI / 4) * radius * .8]} />)}
  </group>;
}

/** Colored identification bands on a pipe run (pipe-class marking). */
export function PipeBands({ positions, axis, radius, color }: { positions: Vec[]; axis: "x" | "y" | "z"; radius: number; color: string }) {
  const rotation: Vec = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return <>{positions.map((position, index) => <mesh key={index} position={position} rotation={rotation}>
    <cylinderGeometry args={[radius * 1.06, radius * 1.06, Math.max(.06, radius * 1.1), 20]} />
    <Paint color={color} roughness={.5} />
  </mesh>)}</>;
}

export function Box({ position, size, color, rotation = [0, 0, 0], roughness = .8, metalness = .08, map, emissive, emissiveIntensity = 0, shadow = true, transparent = false, opacity = 1 }: {
  position: Vec; size: Vec; color: string; rotation?: Vec; roughness?: number; metalness?: number; map?: THREE.Texture | null;
  emissive?: string; emissiveIntensity?: number; shadow?: boolean; transparent?: boolean; opacity?: number;
}) {
  return <mesh position={position} rotation={rotation} castShadow={shadow} receiveShadow>
    <boxGeometry args={size} />
    <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} map={map ?? null} emissive={emissive ?? "#000000"} emissiveIntensity={emissiveIntensity} transparent={transparent} opacity={opacity} depthWrite={!transparent} />
  </mesh>;
}

export type BoxInstance = { position: Vec; size: Vec; rotation?: Vec };

/** Many static boxes sharing one material, drawn in one call. */
export function InstancedBoxes({ items, color, roughness = .6, metalness = .3, emissive, emissiveIntensity = 0, shadow = true, map }: {
  items: BoxInstance[]; color: string; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number; shadow?: boolean; map?: THREE.Texture | null;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const object = new THREE.Object3D();
    items.forEach((item, index) => {
      object.position.set(...item.position);
      object.rotation.set(...(item.rotation ?? [0, 0, 0]));
      object.scale.set(...item.size);
      object.updateMatrix();
      mesh.current!.setMatrixAt(index, object.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [items]);
  return <instancedMesh ref={mesh} args={[undefined, undefined, items.length]} castShadow={shadow} receiveShadow>
    <boxGeometry args={[1, 1, 1]} />
    <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} emissive={emissive ?? "#000000"} emissiveIntensity={emissiveIntensity} map={map ?? null} />
  </instancedMesh>;
}

export type CylinderInstance = { position: Vec; radius: number; height: number; rotation?: Vec };

export function InstancedCylinders({ items, color, roughness = .5, metalness = .3, emissive, emissiveIntensity = 0, shadow = true, segments = 16 }: {
  items: CylinderInstance[]; color: string; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number; shadow?: boolean; segments?: number;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const object = new THREE.Object3D();
    items.forEach((item, index) => {
      object.position.set(...item.position);
      object.rotation.set(...(item.rotation ?? [0, 0, 0]));
      object.scale.set(item.radius, item.height, item.radius);
      object.updateMatrix();
      mesh.current!.setMatrixAt(index, object.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [items]);
  return <instancedMesh ref={mesh} args={[undefined, undefined, items.length]} castShadow={shadow} receiveShadow>
    <cylinderGeometry args={[1, 1, 1, segments]} />
    <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} emissive={emissive ?? "#000000"} emissiveIntensity={emissiveIntensity} />
  </instancedMesh>;
}

/** Canvas textures are generated in the browser, so the scene ships no image assets. */
export function makeCanvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat) { texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(...repeat); }
  return texture;
}

/** Diagonal yellow and black hazard hatching. */
export function useHazardTexture(repeat: [number, number] = [1, 1]) {
  const texture = useMemo(() => makeCanvasTexture(64, 64, (context) => {
    context.fillStyle = "#1d1d1d"; context.fillRect(0, 0, 64, 64);
    context.fillStyle = FINISH.safety;
    for (let offset = -64; offset < 128; offset += 32) {
      context.beginPath(); context.moveTo(offset, 0); context.lineTo(offset + 16, 0); context.lineTo(offset + 16 - 64, 64); context.lineTo(offset - 64, 64); context.closePath(); context.fill();
    }
  }, repeat), [repeat[0], repeat[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return texture;
}
