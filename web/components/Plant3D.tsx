"use client";

// The live plant in 3D. Every moving part reads the same glue state as the rest of the dashboard: no state, no motion.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { metricLevel, PLANT_IDS, TAGS, type Caption, type Outline } from "@/lib/derive";
import { formatMetric, metricLabel } from "@/lib/format";
import type { ComponentView, PlantId } from "@/lib/types";
import { CaptionBand } from "./PidStage";

const ORIGIN: Record<PlantId, THREE.Vector3> = { "plant-a": new THREE.Vector3(0, 0, 0), "plant-b": new THREE.Vector3(24, 0, 0) };
const CAMERA_OFFSET = new THREE.Vector3(13, 8.5, 17);
const TANK_RADIUS = 2.4;
const TANK_HEIGHT = 4.6;
const TANK_BASE = 1.1;
const HEADER_Y = 8.6;

const RING = { voting: 0xe0a93a, yes: 0x3fce8c, no: 0xff4d4f, "no vote": 0x7f8ea3, proposer: 0x5ec8f2, selected: 0xa9d8f5 };

const PLATES: { tag: string; metrics: string[] }[] = [
  { tag: "P-100", metrics: ["speedPct", "feedM3h"] },
  { tag: "TK-101", metrics: ["levelPct", "tempC"] },
  { tag: "E-101", metrics: ["dutyKw"] },
  { tag: "LV-101", metrics: ["positionPct"] },
  { tag: "TV-101", metrics: ["positionPct", "steamKgH", "headerBarg"] },
];

const CHIP: Record<string, string> = {
  voting: "border-vote text-ink bg-lift",
  yes: "border-ok text-ok bg-[#0b2219]",
  no: "border-bad text-bad bg-[#2a1214]",
  "no vote": "border-rule text-ink-2 bg-lift",
  proposer: "border-ice text-ice bg-[#0d2230]",
};

type Flow = { curve: THREE.Curve<THREE.Vector3>; dots: THREE.Mesh[]; offset: number };

type Unit = {
  liquid: THREE.Mesh;
  surface: THREE.Mesh;
  liquidMaterial: THREE.MeshPhysicalMaterial;
  impeller: THREE.Group;
  rotor: THREE.Group;
  coil: THREE.MeshStandardMaterial;
  lvStem: THREE.Group;
  lvWheel: THREE.Mesh;
  tvStem: THREE.Group;
  tvWheel: THREE.Mesh;
  feed: Flow;
  outlet: Flow;
  steam: Flow;
  rings: Record<string, THREE.Mesh>;
  anchors: Record<string, THREE.Vector3>;
};

type Live = {
  plantId: PlantId;
  components: Record<string, ComponentView>;
  outlines: Map<string, Outline>;
  proposer: string | null;
  selected: string;
};

function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, root: THREE.Object3D, tag?: string) {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.08);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, radius, 14, false), material);
  mesh.castShadow = true;
  if (tag) mesh.userData.tag = tag;
  root.add(mesh);
  return curve;
}

function flanges(curve: THREE.Curve<THREE.Vector3>, radius: number, material: THREE.Material, root: THREE.Object3D, count: number) {
  for (let i = 1; i < count; i += 1) {
    const t = i / count;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.7, radius * 1.7, 0.09, 20), material);
    ring.position.copy(curve.getPointAt(t));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangentAt(t));
    root.add(ring);
  }
}

function flow(curve: THREE.Curve<THREE.Vector3>, count: number, color: number, size: number, root: THREE.Object3D): Flow {
  const material = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const geometry = new THREE.SphereGeometry(size, 10, 10);
  const dots = Array.from({ length: count }, () => {
    const dot = new THREE.Mesh(geometry, material);
    root.add(dot);
    return dot;
  });
  return { curve, dots, offset: 0 };
}

function advance(item: Flow, rate: number, delta: number) {
  item.offset = (item.offset + rate * delta) % 1;
  item.dots.forEach((dot, index) => {
    dot.visible = rate > 0;
    if (rate > 0) dot.position.copy(item.curve.getPointAt((item.offset + index / item.dots.length) % 1));
  });
}

function valve(root: THREE.Object3D, position: THREE.Vector3, tag: string, steel: THREE.Material, accent: THREE.Material) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.userData.tag = tag;
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.46, 28, 20), accent);
  body.castShadow = true;
  body.userData.tag = tag;
  group.add(body);
  [-0.55, 0.55].forEach((x) => {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 24), steel);
    flange.rotation.z = Math.PI / 2;
    flange.position.x = x;
    group.add(flange);
  });
  const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.55, 12), steel);
  yoke.position.y = 0.62;
  group.add(yoke);
  const stem = new THREE.Group();
  stem.position.y = 0.85;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), steel);
  rod.position.y = 0.3;
  stem.add(rod);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.05, 12, 36), accent);
  wheel.rotation.x = Math.PI / 2;
  wheel.position.y = 0.72;
  wheel.userData.tag = tag;
  stem.add(wheel);
  for (let i = 0; i < 3; i += 1) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.03, 0.05), steel);
    spoke.rotation.y = (i * Math.PI) / 3;
    spoke.position.y = 0.72;
    stem.add(spoke);
  }
  group.add(stem);
  root.add(group);
  return { stem, wheel };
}

function buildUnit(scene: THREE.Scene, origin: THREE.Vector3): Unit {
  const root = new THREE.Group();
  root.position.copy(origin);
  scene.add(root);

  const steel = new THREE.MeshStandardMaterial({ color: 0x9fb2c2, metalness: 0.92, roughness: 0.28 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x3a4856, metalness: 0.85, roughness: 0.42 });
  const pipeSteel = new THREE.MeshStandardMaterial({ color: 0x7f93a6, metalness: 0.9, roughness: 0.32 });
  const steamPipe = new THREE.MeshStandardMaterial({ color: 0xb98a5b, metalness: 0.85, roughness: 0.34 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x2f7fb8, metalness: 0.65, roughness: 0.34 });

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(TANK_RADIUS + 1.1, TANK_RADIUS + 1.3, 0.28, 72), darkSteel);
  plinth.position.y = 0.14;
  plinth.receiveShadow = true;
  root.add(plinth);

  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, TANK_BASE, 12), steel);
    leg.position.set(Math.cos(angle) * (TANK_RADIUS - 0.2), TANK_BASE / 2 + 0.18, Math.sin(angle) * (TANK_RADIUS - 0.2));
    leg.castShadow = true;
    root.add(leg);
  }

  // Liquid sits inside the shell, so its height is the level with no scaling tricks hidden by the glass.
  const liquidMaterial = new THREE.MeshPhysicalMaterial({ color: 0x2fb6d6, roughness: 0.16, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.84, emissive: 0x0b6f8c, emissiveIntensity: 0.55 });
  const liquid = new THREE.Mesh(new THREE.CylinderGeometry(TANK_RADIUS * 0.965, TANK_RADIUS * 0.965, 1, 72), liquidMaterial);
  liquid.userData.tag = "TK-101";
  root.add(liquid);
  const surface = new THREE.Mesh(new THREE.CircleGeometry(TANK_RADIUS * 0.965, 72), new THREE.MeshBasicMaterial({ color: 0xa9f0ff, transparent: true, opacity: 0.5, toneMapped: false }));
  surface.rotation.x = -Math.PI / 2;
  root.add(surface);

  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(TANK_RADIUS, TANK_RADIUS, TANK_HEIGHT, 96, 1, true),
    new THREE.MeshPhysicalMaterial({ color: 0xd8ecf7, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.8, clearcoat: 1 }),
  );
  shell.position.y = TANK_BASE + TANK_HEIGHT / 2;
  shell.userData.tag = "TK-101";
  root.add(shell);

  [TANK_BASE, TANK_BASE + TANK_HEIGHT * 0.5, TANK_BASE + TANK_HEIGHT].forEach((y) => {
    const band = new THREE.Mesh(new THREE.TorusGeometry(TANK_RADIUS + 0.03, 0.075, 14, 96), steel);
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    band.castShadow = true;
    root.add(band);
  });
  const top = new THREE.Mesh(new THREE.SphereGeometry(TANK_RADIUS, 72, 24, 0, Math.PI * 2, 0, Math.PI / 2), steel);
  top.scale.y = 0.34;
  top.position.y = TANK_BASE + TANK_HEIGHT;
  top.castShadow = true;
  root.add(top);
  const bottom = new THREE.Mesh(new THREE.SphereGeometry(TANK_RADIUS, 72, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), steel);
  bottom.scale.y = 0.2;
  bottom.position.y = TANK_BASE;
  root.add(bottom);

  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.85, 24), accent);
  motor.position.y = TANK_BASE + TANK_HEIGHT + 1.15;
  motor.castShadow = true;
  root.add(motor);
  const impeller = new THREE.Group();
  impeller.position.y = TANK_BASE + 0.9;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, TANK_HEIGHT, 12), steel);
  shaft.position.y = TANK_HEIGHT / 2 - 0.2;
  impeller.add(shaft);
  for (let i = 0; i < 4; i += 1) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.3), steel);
    blade.rotation.y = (i * Math.PI) / 2;
    blade.rotation.z = 0.32;
    impeller.add(blade);
  }
  root.add(impeller);

  const helix: THREE.Vector3[] = [];
  for (let i = 0; i <= 150; i += 1) {
    const t = i / 150;
    const angle = t * Math.PI * 12;
    helix.push(new THREE.Vector3(Math.cos(angle) * (TANK_RADIUS - 0.42), TANK_BASE + 0.45 + t * 2.7, Math.sin(angle) * (TANK_RADIUS - 0.42)));
  }
  const coil = new THREE.MeshStandardMaterial({ color: 0xc98a4e, metalness: 0.8, roughness: 0.3, emissive: 0xff8a3c, emissiveIntensity: 0 });
  tube(helix, 0.06, coil, root, "E-101");

  // Feed: pump on the left into the shell.
  const pumpAt = new THREE.Vector3(-8.4, 0.95, 3.2);
  const skid = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.22, 1.8), darkSteel);
  skid.position.set(pumpAt.x - 0.5, 0.11, pumpAt.z);
  skid.receiveShadow = true;
  root.add(skid);
  const volute = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.5, 40), accent);
  volute.rotation.x = Math.PI / 2;
  volute.position.copy(pumpAt);
  volute.castShadow = true;
  volute.userData.tag = "P-100";
  root.add(volute);
  const drive = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 1.5, 28), steel);
  drive.rotation.z = Math.PI / 2;
  drive.position.set(pumpAt.x - 1.15, pumpAt.y, pumpAt.z);
  drive.castShadow = true;
  drive.userData.tag = "P-100";
  root.add(drive);
  for (let i = 0; i < 9; i += 1) {
    const fin = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.022, 8, 28), darkSteel);
    fin.rotation.y = Math.PI / 2;
    fin.position.set(pumpAt.x - 1.75 + i * 0.15, pumpAt.y, pumpAt.z);
    root.add(fin);
  }
  const rotor = new THREE.Group();
  rotor.position.set(pumpAt.x, pumpAt.y, pumpAt.z + 0.27);
  for (let i = 0; i < 5; i += 1) {
    const vane = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.09, 0.05), new THREE.MeshBasicMaterial({ color: 0x9fe6ff, toneMapped: false }));
    vane.rotation.z = (i * Math.PI) / 5;
    rotor.add(vane);
  }
  root.add(rotor);

  const feedCurve = tube(
    [pumpAt.clone().add(new THREE.Vector3(0.1, 0.6, 0)), pumpAt.clone().add(new THREE.Vector3(0.2, 1.7, 0)), new THREE.Vector3(-5.5, 3.2, 3.2), new THREE.Vector3(-3.6, 4.6, 1.2), new THREE.Vector3(-TANK_RADIUS + 0.05, 4.6, 0)],
    0.17,
    pipeSteel,
    root,
    "P-100",
  );
  flanges(feedCurve, 0.17, darkSteel, root, 5);

  // Outlet: bottom of the tank to the level valve and out.
  const lvAt = new THREE.Vector3(7.1, 1.25, 3.2);
  const outletIn = tube([new THREE.Vector3(0.4, TANK_BASE - 0.3, 0.3), new THREE.Vector3(2.6, 0.72, 1.6), new THREE.Vector3(5, 1.1, 3.2), lvAt.clone().add(new THREE.Vector3(-0.55, 0, 0))], 0.17, pipeSteel, root, "LV-101");
  const outletOut = tube([lvAt.clone().add(new THREE.Vector3(0.55, 0, 0)), new THREE.Vector3(9.2, 1.25, 3.2), new THREE.Vector3(11.2, 1.25, 4.8)], 0.17, pipeSteel, root, "LV-101");
  flanges(outletIn, 0.17, darkSteel, root, 4);
  const outletPath = new THREE.CurvePath<THREE.Vector3>();
  outletPath.add(outletIn);
  outletPath.add(new THREE.LineCurve3(lvAt.clone().add(new THREE.Vector3(-0.55, 0, 0)), lvAt.clone().add(new THREE.Vector3(0.55, 0, 0))));
  outletPath.add(outletOut);
  const lv = valve(root, lvAt, "LV-101", steel, accent);

  // Steam: down from the shared header through TV-101 into the coil.
  const tvAt = new THREE.Vector3(3.6, 6.2, -2.2);
  const steamCurve = tube([new THREE.Vector3(3.6, HEADER_Y, -4.2), new THREE.Vector3(3.6, 7.6, -3.4), tvAt.clone().add(new THREE.Vector3(-0.55, 0, 0)), new THREE.Vector3(1.4, 5.8, -1.3), new THREE.Vector3(TANK_RADIUS - 0.75, 4.05, -0.3)], 0.13, steamPipe, root, "TV-101");
  const tv = valve(root, tvAt, "TV-101", steel, accent);

  const feed = flow(feedCurve, 16, 0x7fe8ff, 0.1, root);
  const outlet = flow(outletPath, 20, 0x7fe8ff, 0.1, root);
  const steam = flow(steamCurve, 14, 0xfff1dd, 0.08, root);

  const anchors: Record<string, THREE.Vector3> = {
    "P-100": new THREE.Vector3(pumpAt.x - 0.4, 2.2, pumpAt.z).add(origin),
    "TK-101": new THREE.Vector3(0, TANK_BASE + TANK_HEIGHT + 2.5, 0).add(origin),
    "E-101": new THREE.Vector3(-TANK_RADIUS * 0.3, TANK_BASE + 1.5, TANK_RADIUS).add(origin),
    "LV-101": lvAt.clone().add(new THREE.Vector3(0, 2.1, 0)).add(origin),
    "TV-101": tvAt.clone().add(new THREE.Vector3(1.4, 2.0, 0)).add(origin),
  };

  const rings: Record<string, THREE.Mesh> = {};
  const ringSpots: Record<string, [THREE.Vector3, number]> = {
    "P-100": [new THREE.Vector3(pumpAt.x - 0.5, 0.3, pumpAt.z), 2.1],
    "TK-101": [new THREE.Vector3(0, 0.34, 0), TANK_RADIUS + 1.45],
    "E-101": [new THREE.Vector3(0, TANK_BASE + 1.9, 0), TANK_RADIUS + 0.28],
    "LV-101": [new THREE.Vector3(lvAt.x, 0.1, lvAt.z), 1.5],
    "TV-101": [new THREE.Vector3(tvAt.x, tvAt.y - 0.75, tvAt.z), 1.25],
  };
  TAGS.forEach((tag) => {
    const spot = ringSpots[tag];
    if (spot === undefined) return;
    const [at, radius] = spot;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.055, 14, 96), new THREE.MeshBasicMaterial({ color: RING.voting, toneMapped: false, transparent: true }));
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(at);
    ring.visible = false;
    root.add(ring);
    rings[tag] = ring;
  });

  return { liquid, surface, liquidMaterial, impeller, rotor, coil, lvStem: lv.stem, lvWheel: lv.wheel, tvStem: tv.stem, tvWheel: tv.wheel, feed, outlet, steam, rings, anchors };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const metric = (components: Record<string, ComponentView>, plantId: PlantId, tag: string, key: string) => components[`${plantId}/${tag}`]?.metrics[key];

function applyState(unit: Unit, plantId: PlantId, live: Live, delta: number, time: number) {
  const c = live.components;
  const level = metric(c, plantId, "TK-101", "levelPct");
  const temp = metric(c, plantId, "TK-101", "tempC");
  const speed = metric(c, plantId, "P-100", "speedPct") ?? 0;
  const feedM3h = metric(c, plantId, "P-100", "feedM3h") ?? 0;
  const lvPos = metric(c, plantId, "LV-101", "positionPct");
  const tvPos = metric(c, plantId, "TV-101", "positionPct");
  const steamKgH = metric(c, plantId, "TV-101", "steamKgH") ?? 0;
  const duty = metric(c, plantId, "E-101", "dutyKw") ?? 0;

  const hasLevel = level !== undefined;
  unit.liquid.visible = hasLevel;
  unit.surface.visible = hasLevel;
  if (hasLevel) {
    const height = (clamp(level, 0, 100) / 100) * TANK_HEIGHT;
    unit.liquid.scale.y = THREE.MathUtils.lerp(unit.liquid.scale.y, height, 1 - Math.exp(-delta * 3));
    unit.liquid.position.y = TANK_BASE + unit.liquid.scale.y / 2;
    unit.surface.position.y = TANK_BASE + unit.liquid.scale.y + Math.sin(time * 1.8) * 0.012;
  }
  const warmth = temp === undefined ? 0 : clamp((temp - 65) / 25, 0, 1);
  unit.liquidMaterial.color.setRGB(0.14 + warmth * 0.42, 0.62 + warmth * 0.2, 0.84 - warmth * 0.3);

  unit.rotor.rotation.z -= (speed / 100) * 22 * delta;
  unit.impeller.rotation.y += (speed > 0 ? 1.6 : 0) * delta;
  unit.coil.emissiveIntensity = THREE.MathUtils.lerp(unit.coil.emissiveIntensity, clamp(duty / 1800, 0, 1) * 3.2, 1 - Math.exp(-delta * 2));

  advance(unit.feed, feedM3h * 0.022, delta);
  advance(unit.outlet, (lvPos ?? 0) * 0.0066, delta);
  advance(unit.steam, steamKgH * 0.00024, delta);

  if (lvPos !== undefined) {
    unit.lvStem.position.y = THREE.MathUtils.lerp(unit.lvStem.position.y, 0.75 + (lvPos / 100) * 0.55, 1 - Math.exp(-delta * 3));
    unit.lvWheel.rotation.z = lvPos * 0.06;
  }
  if (tvPos !== undefined) {
    unit.tvStem.position.y = THREE.MathUtils.lerp(unit.tvStem.position.y, 0.75 + (tvPos / 100) * 0.55, 1 - Math.exp(-delta * 3));
    unit.tvWheel.rotation.z = tvPos * 0.06;
  }

  TAGS.forEach((tag) => {
    const ring = unit.rings[tag];
    if (ring === undefined) return;
    const active = plantId === live.plantId;
    const outline = active ? live.outlines.get(tag) : undefined;
    const proposer = active && live.proposer === tag;
    const selected = active && live.selected === `${plantId}/${tag}`;
    ring.visible = Boolean(outline || proposer || selected);
    if (!ring.visible) return;
    const material = ring.material as THREE.MeshBasicMaterial;
    const key = outline ? outline.state : proposer ? "proposer" : "selected";
    material.color.setHex(RING[key as keyof typeof RING] ?? RING.selected);
    const pulsing = outline?.pulsing ?? false;
    const beat = pulsing ? 1 + Math.sin(time * 5) * 0.05 : 1;
    ring.scale.set(beat, beat, 1);
    material.opacity = pulsing ? 0.65 + Math.sin(time * 5) * 0.35 : outline || proposer ? 0.95 : 0.5;
  });
}

function Plate({ component, tag, metrics, word, fromPlant, selected, onSelect, bind }: { component: ComponentView | undefined; tag: string; metrics: string[]; word: string | null; fromPlant: string | null; selected: boolean; onSelect: () => void; bind: (element: HTMLButtonElement | null) => void }) {
  return (
    <button ref={bind} onClick={onSelect} aria-label={`Select ${tag}`} className={`absolute left-0 top-0 z-10 min-w-[176px] rounded-md border bg-[#071018]/80 px-3 py-1 text-left shadow-lg backdrop-blur-md will-change-transform ${selected ? "border-ice" : "border-white/15 hover:border-white/40"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="num font-semibold tracking-wide text-ice">{tag}</span>
        {word ? (
          <span className={`border px-2 text-[18px] font-bold uppercase tracking-wider ${CHIP[word] ?? ""}`}>
            {word}
            {fromPlant ? <span className="ml-1 font-medium normal-case tracking-normal">for {fromPlant}</span> : null}
          </span>
        ) : null}
      </div>
      {metrics.map((key) => {
        const value = component?.metrics[key];
        const limit = component?.limits[key];
        const level = value !== undefined && limit !== undefined ? metricLevel(value, limit) : "ok";
        return (
          <div key={key} className="flex items-baseline justify-between gap-4 whitespace-nowrap leading-[25px]">
            <span className="text-ink-2">{metricLabel(key)}</span>
            <span className={`num font-medium ${level === "critical" ? "text-bad" : level === "warning" ? "text-vote" : "text-ink"}`}>
              {value === undefined ? "--" : formatMetric(key, value)}
              {level === "ok" ? null : ` ${level}`}
            </span>
          </div>
        );
      })}
    </button>
  );
}

export function Plant3D({ plantId, components, outlines, proposer, selected, onSelect, caption, now, onUnavailable }: { plantId: PlantId; components: Record<string, ComponentView>; outlines: Map<string, Outline>; proposer: string | null; selected: string; onSelect: (id: string) => void; caption: Caption | null; now: number; onUnavailable: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const plates = useRef<Record<string, HTMLButtonElement | null>>({});
  const live = useRef<Live>({ plantId, components, outlines, proposer, selected });
  const pick = useRef(onSelect);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    live.current = { plantId, components, outlines, proposer, selected };
    pick.current = onSelect;
  }, [plantId, components, outlines, proposer, selected, onSelect]);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      onUnavailable();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    element.appendChild(renderer.domElement);
    renderer.domElement.className = "absolute inset-0 size-full";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05090f);
    scene.fog = new THREE.FogExp2(0x05090f, 0.017);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    scene.environmentIntensity = 0.5;

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 240);
    const focus = ORIGIN[live.current.plantId].clone().add(new THREE.Vector3(0, 3.1, 0));
    camera.position.copy(focus).add(CAMERA_OFFSET);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 11;
    controls.maxDistance = 58;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.target.copy(focus);
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotate = !calm;
    controls.autoRotateSpeed = 0.22;

    const floor = new THREE.Mesh(new THREE.CircleGeometry(150, 96), new THREE.MeshStandardMaterial({ color: 0x0a1119, metalness: 0.72, roughness: 0.46 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(170, 85, 0x1c3347, 0x101d2a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.set(12, 0.012, 0);
    scene.add(grid);

    scene.add(new THREE.HemisphereLight(0x8fbfe6, 0x0a0f14, 0.5));
    const key = new THREE.SpotLight(0xdff1ff, 900, 0, 0.62, 0.55, 1.75);
    key.position.set(10, 24, 16);
    key.target.position.set(12, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    scene.add(key, key.target);
    const rim = new THREE.PointLight(0x38bdf8, 260, 42, 1.8);
    rim.position.set(-13, 7.5, -8);
    scene.add(rim);
    const warm = new THREE.PointLight(0xffb066, 150, 34, 1.9);
    warm.position.set(14, 9, -9);
    scene.add(warm);

    const units = Object.fromEntries(PLANT_IDS.map((id) => [id, buildUnit(scene, ORIGIN[id])])) as Record<PlantId, Unit>;

    // The one physical link between plants: the steam header both TV-101 valves draw from.
    const headerMaterial = new THREE.MeshStandardMaterial({ color: 0xb98a5b, metalness: 0.88, roughness: 0.3 });
    const headerCurve = new THREE.LineCurve3(new THREE.Vector3(-13, HEADER_Y, -4.2), new THREE.Vector3(36, HEADER_Y, -4.2));
    const header = new THREE.Mesh(new THREE.TubeGeometry(headerCurve, 12, 0.3, 18, false), headerMaterial);
    header.castShadow = true;
    header.userData.tag = "TV-101";
    scene.add(header);
    for (let x = -12; x <= 36; x += 6) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, HEADER_Y, 10), headerMaterial);
      post.position.set(x, HEADER_Y / 2, -4.2);
      post.castShadow = true;
      scene.add(post);
    }
    const headerFlow = flow(headerCurve, 34, 0xfff1dd, 0.1, scene);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.62, 0.8);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const resize = () => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight, false);
      composer.setSize(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = { x: 0, y: 0 };
    const onDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
      const box = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      for (const hit of raycaster.intersectObjects(scene.children, true)) {
        const tag = hit.object.userData.tag as string | undefined;
        if (!tag) continue;
        const plant = hit.point.x > 12 ? "plant-b" : "plant-a";
        if (plant === live.current.plantId) pick.current(`${plant}/${tag}`);
        break;
      }
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    const projected = new THREE.Vector3();
    const clock = new THREE.Clock();
    let frame = 0;
    let lastPlant = live.current.plantId;
    let flying = false;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const delta = Math.min(clock.getDelta(), 0.05);
      const time = clock.elapsedTime;
      const state = live.current;

      if (state.plantId !== lastPlant) {
        lastPlant = state.plantId;
        flying = true;
      }
      if (flying) {
        const goal = ORIGIN[state.plantId].clone().add(new THREE.Vector3(0, 3.1, 0));
        const step = 1 - Math.exp(-delta * 3.2);
        const move = goal.clone().sub(controls.target).multiplyScalar(step);
        controls.target.add(move);
        camera.position.add(move);
        if (goal.distanceTo(controls.target) < 0.02) flying = false;
      }

      PLANT_IDS.forEach((id) => applyState(units[id], id, state, delta, time));
      const anySteam = PLANT_IDS.reduce((sum, id) => sum + (metric(state.components, id, "TV-101", "steamKgH") ?? 0), 0);
      advance(headerFlow, anySteam * 0.000045, delta);

      controls.update();
      composer.render(delta);

      const width = element.clientWidth;
      const height = element.clientHeight;
      PLATES.forEach(({ tag }) => {
        const plate = plates.current[tag];
        const anchor = units[state.plantId].anchors[tag];
        if (!plate || anchor === undefined) return;
        projected.copy(anchor).project(camera);
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        const visible = projected.z < 1 && x > -60 && x < width + 60 && y > -40 && y < height + 40;
        plate.style.opacity = visible ? "1" : "0";
        plate.style.transform = `translate(${Math.round(clamp(x, 100, width - 100))}px, ${Math.round(clamp(y, 74, height - 30))}px) translate(-50%, -100%)`;
      });
    };
    tick();
    setReady(true);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(material) ? material : material ? [material] : []).forEach((item) => item.dispose());
      });
      environment.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [onUnavailable]);

  const empty = Object.keys(components).length === 0;

  return (
    <div className="relative h-full overflow-hidden bg-[#05090f]">
      <div ref={host} className="absolute inset-0" />
      {ready
        ? PLATES.map(({ tag, metrics }) => {
            const outline = outlines.get(tag);
            return (
              <Plate
                key={tag}
                tag={tag}
                metrics={metrics}
                component={components[`${plantId}/${tag}`]}
                word={outline?.state ?? (proposer === tag ? "proposer" : null)}
                fromPlant={outline && outline.fromPlant !== plantId ? outline.fromPlant : null}
                selected={selected === `${plantId}/${tag}`}
                onSelect={() => onSelect(`${plantId}/${tag}`)}
                bind={(node) => {
                  plates.current[tag] = node;
                }}
              />
            );
          })
        : null}
      {empty ? <div className="absolute right-4 top-4 z-20 border border-rule bg-lift px-3 py-1 font-semibold text-ink-2">No live values yet</div> : null}
      {caption ? <CaptionBand caption={caption} now={now} /> : null}
    </div>
  );
}
