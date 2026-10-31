"use client";

import { useMemo } from "react";
import { Forklift, GuidedVehicle, OverheadCrane, PackagingLine, PilotLights, SafetyRail, StackLight } from "./FactoryLife";
import { Box, FINISH, InstancedBoxes, InstancedCylinders, useHazardTexture, type BoxInstance, type CylinderInstance, type Vec } from "./parts";

/** Interior extents of the enclosed hall. The camera is clamped inside these bounds. */
export const HALL = { x0: -34, x1: 34, z0: -27, z1: 19, height: 18 } as const;
/** The TK-101 bay inside the hall (crane runway, mezzanine and storage are local to it). */
const BAY = { x0: -12, x1: 12, z0: -9, z1: 8 } as const;
const W = HALL.x1 - HALL.x0, D = HALL.z1 - HALL.z0;
const CX = (HALL.x0 + HALL.x1) / 2, CZ = (HALL.z0 + HALL.z1) / 2;

function seeded(index: number, salt = 1) {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const range = (from: number, to: number, step: number) => { const list: number[] = []; for (let v = from; v <= to + 1e-6; v += step) list.push(+v.toFixed(3)); return list; };

/* Structure: columns on every wall, roof trusses, crane runway. */
const COLUMNS: BoxInstance[] = [
  ...range(HALL.x0, HALL.x1, 4).map((x) => ({ position: [x, HALL.height / 2, HALL.z0 + .2] as Vec, size: [.4, HALL.height, .38] as Vec })),
  ...range(HALL.x0, HALL.x1, 4).map((x) => ({ position: [x, HALL.height / 2, HALL.z1 - .2] as Vec, size: [.4, HALL.height, .38] as Vec })),
  ...range(HALL.z0 + 4, HALL.z1 - 4, 4).flatMap((z) => [HALL.x0 + .2, HALL.x1 - .2].map((x) => ({ position: [x, HALL.height / 2, z] as Vec, size: [.38, HALL.height, .4] as Vec }))),
];
const TRUSS_Z = range(HALL.z0 + 2, HALL.z1 - 2, 4);
const TRUSSES: BoxInstance[] = TRUSS_Z.flatMap((z) => {
  const list: BoxInstance[] = [
    { position: [CX, HALL.height - .2, z], size: [W, .2, .2] },
    { position: [CX, HALL.height - 1.3, z], size: [W, .14, .14] },
  ];
  range(HALL.x0 + 1, HALL.x1 - 3, 2).forEach((x, i) => {
    list.push({ position: [x, HALL.height - .75, z], size: [.08, 1.1, .08] });
    list.push({ position: [x + 1, HALL.height - .75, z], size: [2.28, .07, .07], rotation: [0, 0, i % 2 ? .5 : -.5] });
  });
  return list;
});
const PURLINS: BoxInstance[] = range(HALL.x0 + 2, HALL.x1 - 2, 3).map((x) => ({ position: [x, HALL.height - .05, CZ] as Vec, size: [.1, .12, D] as Vec }));
const RUNWAY: BoxInstance[] = [BAY.x0 + .45, BAY.x1 - .45].map((x) => ({ position: [x, 6.45, -.5] as Vec, size: [.22, .24, 16] as Vec }));
const RUNWAY_POSTS: BoxInstance[] = [BAY.x0 + .45, BAY.x1 - .45].flatMap((x) => range(-8, 7, 5).map((z) => ({ position: [x, 3.2, z] as Vec, size: [.24, 6.4, .24] as Vec })));

/* Lighting fixtures and skylights. */
const LIGHT_SPOTS: Vec[] = range(HALL.x0 + 5, HALL.x1 - 5, 7).flatMap((x) => range(HALL.z0 + 4, HALL.z1 - 4, 6).map((z) => [x, HALL.height - 1.9, z] as Vec));
const LAMP_SHADES: CylinderInstance[] = LIGHT_SPOTS.map((p) => ({ position: p, radius: .4, height: .22 }));
const LAMP_RODS: BoxInstance[] = LIGHT_SPOTS.map((p) => ({ position: [p[0], HALL.height - 1.6, p[2]] as Vec, size: [.03, .6, .03] as Vec }));
const LAMP_GLOW: CylinderInstance[] = LIGHT_SPOTS.map((p) => ({ position: [p[0], p[1] - .12, p[2]] as Vec, radius: .35, height: .03 }));
const SKYLIGHTS: BoxInstance[] = TRUSS_Z.slice(0, -1).map((z) => ({ position: [CX, HALL.height - .03, z + 2] as Vec, size: [W - 4, .03, 1.4] as Vec }));

/* Windows high on the walls. */
const WINDOWS: BoxInstance[] = [
  ...range(HALL.x0 + 2, HALL.x1 - 2, 4).map((x) => ({ position: [x, HALL.height - 4, HALL.z0 + .03] as Vec, size: [3.2, 1.6, .04] as Vec })),
  ...range(HALL.x0 + 2, HALL.x1 - 2, 4).map((x) => ({ position: [x, HALL.height - 4, HALL.z1 - .03] as Vec, size: [3.2, 1.6, .04] as Vec })),
  ...range(HALL.z0 + 2, HALL.z1 - 2, 4).map((z) => ({ position: [HALL.x0 + .03, HALL.height - 4, z] as Vec, size: [.04, 1.6, 3.2] as Vec })),
  ...range(HALL.z0 + 2, HALL.z1 - 2, 4).map((z) => ({ position: [HALL.x1 - .03, HALL.height - 4, z] as Vec, size: [.04, 1.6, 3.2] as Vec })),
];

/* Color-coded pipe runs along the rear and left walls. */
const WALL_PIPES: { y: number; r: number; color: string }[] = [
  { y: 2.7, r: .07, color: FINISH.condensate }, { y: 3.05, r: .1, color: FINISH.water },
  { y: 3.45, r: .12, color: FINISH.steamClad }, { y: 3.8, r: .06, color: FINISH.air }, { y: 4.05, r: .07, color: FINISH.fireWater },
];
const STEAM_BANDS: CylinderInstance[] = [
  ...range(HALL.x0 + 2, HALL.x1 - 2, 3).map((x) => ({ position: [x, 3.45, HALL.z0 + .45] as Vec, radius: .13, height: .14, rotation: [0, 0, Math.PI / 2] as Vec })),
  ...range(HALL.z0 + 2, HALL.z1 - 3, 3).map((z) => ({ position: [HALL.x0 + .45, 3.45, z] as Vec, radius: .13, height: .14, rotation: [Math.PI / 2, 0, 0] as Vec })),
];
const PIPE_BRACKETS: BoxInstance[] = [
  ...range(HALL.x0 + 1, HALL.x1 - 1, 4).map((x) => ({ position: [x, 3.35, HALL.z0 + .32] as Vec, size: [.06, 1.6, .28] as Vec })),
  ...range(HALL.z0 + 2, HALL.z1 - 2, 4).map((z) => ({ position: [HALL.x0 + .32, 3.35, z] as Vec, size: [.28, 1.6, .06] as Vec })),
];

/* Ductwork along the ceiling. */
const DUCTS: BoxInstance[] = [
  { position: [CX, HALL.height - 2.4, HALL.z0 + 1.4], size: [W - 1.2, 1.0, 1.3] },
  { position: [HALL.x1 - 1.6, HALL.height - 2.4, CZ], size: [1.2, .9, D - 2] },
  ...range(HALL.x0 + 4, HALL.x1 - 4, 8).map((x) => ({ position: [x, HALL.height - 3.2, HALL.z0 + 1.4] as Vec, size: [.6, .7, .6] as Vec })),
];
const DIFFUSERS: BoxInstance[] = range(HALL.x0 + 4, HALL.x1 - 4, 8).map((x) => ({ position: [x, HALL.height - 3.6, HALL.z0 + 1.4] as Vec, size: [.8, .08, .8] as Vec }));

/* Mezzanine with offices underneath, along the west wall. */
const MEZZ = { x0: BAY.x0 + .3, x1: -9.2, z0: BAY.z0 + .3, z1: -1.2, y: 3.2 };
const MEZZ_POSTS: BoxInstance[] = range(MEZZ.z0 + .2, MEZZ.z1, 2.5).map((z) => ({ position: [MEZZ.x1, MEZZ.y / 2, z] as Vec, size: [.16, MEZZ.y, .16] as Vec }));
const STAIR_STEPS: BoxInstance[] = Array.from({ length: 14 }, (_, i) => ({ position: [-10.55, MEZZ.y - (i + 1) * (MEZZ.y / 15), MEZZ.z1 + .2 + i * .2] as Vec, size: [1.1, .05, .26] as Vec }));

/* Pallet racking along the front (south) wall. */
const RACK_X = range(-10.5, 10.5, 3);
const RACK_UPRIGHTS: BoxInstance[] = [...RACK_X, 12 - .1].flatMap((x, i) => i === RACK_X.length ? [] : [x - 1.4, x + 1.4].flatMap((ux) => [BAY.z1 + 7.65, BAY.z1 + 6.65].map((z) => ({ position: [ux, 2.9, z] as Vec, size: [.08, 5.8, .08] as Vec }))));
const RACK_BEAMS: BoxInstance[] = RACK_X.flatMap((x) => [.15, 1.95, 3.75, 5.55].flatMap((y) => [BAY.z1 + 7.65, BAY.z1 + 6.65].map((z) => ({ position: [x, y, z] as Vec, size: [2.8, .12, .07] as Vec }))));
const RACK_LOADS: BoxInstance[] = RACK_X.flatMap((x, i) => [.2, 2.0, 3.8].flatMap((y, level) => [-.7, .7].flatMap((dx, slot) => {
  if (seeded(i * 7 + level * 3 + slot, 2) < .2) return [];
  const h = .7 + seeded(i + level + slot, 3) * .55;
  return [{ position: [x + dx, y + .12 + h / 2, BAY.z1 + 7.15] as Vec, size: [1.15, h, .95] as Vec }];
})));
const RACK_PALLETS: BoxInstance[] = RACK_LOADS.map((load) => ({ position: [load.position[0], load.position[1] - load.size[1] / 2 - .06, load.position[2]] as Vec, size: [1.2, .12, 1.0] as Vec }));

/* Drum and IBC storage along the east wall. */
const DRUMS: CylinderInstance[] = [0, 1, 2, 3].flatMap((row) => [0, 1, 2, 3].map((col) => ({ position: [10.2 + (col % 2) * .62 + (col > 1 ? 1.4 : 0) - .7, .52, -7.6 + row * 1.25 + (col % 2 ? .3 : 0)] as Vec, radius: .28, height: .88 })));
const DRUM_BANDS: CylinderInstance[] = DRUMS.map((drum) => ({ position: [drum.position[0], .7, drum.position[2]] as Vec, radius: .285, height: .06 }));
const IBC_TOTES: BoxInstance[] = [4.3, 5.5].flatMap((z) => [10.4, 11.4].map((x) => ({ position: [x, .62, z] as Vec, size: [.95, 1.0, 1.05] as Vec })));
const IBC_CAGES: BoxInstance[] = IBC_TOTES.flatMap((tote) => [-.5, .5].flatMap((dx) => [-.55, .55].map((dz) => ({ position: [tote.position[0] + dx, .62, tote.position[2] + dz] as Vec, size: [.04, 1.1, .04] as Vec }))));

/* Small fittings: bollards, extinguishers, signage. */
const BOLLARDS: CylinderInstance[] = ([[1.7, -3], [7.2, -3], [-7.95, -2.75], [-3.9, -2.75], [4.15, 2.15], [5.75, 2.15], [-1.0, 3.75], [9.1, -1.6], [9.1, 1.6]] as [number, number][]).map(([x, z]) => ({ position: [x, .5, z] as Vec, radius: .09, height: 1.0 }));
const BOLLARD_BANDS: CylinderInstance[] = BOLLARDS.map((b) => ({ position: [b.position[0], .78, b.position[2]] as Vec, radius: .095, height: .12 }));
const EXTINGUISHERS: CylinderInstance[] = ([[-6, HALL.z0 + .45], [3, HALL.z0 + .45], [HALL.x0 + .45, 2.1], [HALL.x1 - .45, -4.4], [HALL.x1 - .45, 3.0]] as [number, number][]).map(([x, z]) => ({ position: [x, .55, z] as Vec, radius: .085, height: .5 }));
const RED_SIGNS: BoxInstance[] = EXTINGUISHERS.map((e) => ({ position: [e.position[0], 1.4, e.position[2]] as Vec, size: [.28, .28, .28] as Vec }));
const BLUE_SIGNS: BoxInstance[] = [
  { position: [-1.6, 2.4, HALL.z0 + .04], size: [.6, .6, .03] }, { position: [HALL.x0 + .04, 2.4, 1.3], size: [.03, .6, .6] }, { position: [7.6, 2.4, HALL.z1 - .04], size: [.6, .6, .03] },
];
const WHITE_SIGNS: BoxInstance[] = [
  { position: [-.2, 2.45, HALL.z0 + .04], size: [1.6, .9, .03] }, { position: [HALL.x1 - .04, 2.45, -6], size: [.03, .9, 1.6] }, { position: [HALL.x0 + .04, 2.45, 6.4], size: [.03, .9, 1.6] },
];
const WARNING_SIGNS: CylinderInstance[] = [
  { position: [-.9, 2.4, HALL.z0 + .06], radius: .38, height: .03, rotation: [Math.PI / 2, 0, 0] },
  { position: [-5.9, 3.0, -3.08], radius: .3, height: .03, rotation: [Math.PI / 2, 0, 0] },
  { position: [HALL.x1 - .06, 2.4, -4.8], radius: .38, height: .03, rotation: [0, 0, Math.PI / 2] },
];

/* MCC cabinet front details and pilot lights on the electrical room face. */
const MCC_DOORS: BoxInstance[] = range(-7.55, -4.3, .55).map((x) => ({ position: [x, 1.15, -3.1] as Vec, size: [.5, 1.9, .03] as Vec }));
const MCC_LEDS: Vec[] = range(-7.55, -4.3, .55).flatMap((x) => [-.12, 0, .12].map((dx) => [x + dx, 1.85, -3.07] as Vec));

function Floor({ light }: { light: boolean }) {
  const lane = light ? "#8d949b" : "#23272c";
  const hatch = useHazardTexture([10, 1]);
  return <group>
    <Box position={[CX, -.13, CZ]} size={[W, .2, D]} color={light ? "#b9bcbf" : "#3a3f45"} roughness={.92} metalness={0} shadow={false} />
    {/* Concrete slab joints. */}
    <InstancedBoxes items={[...range(-9, 9, 3).map((x) => ({ position: [x, -.028, CZ] as Vec, size: [.025, .004, D] as Vec })), ...range(-6, 6, 3).map((z) => ({ position: [CX, -.028, z] as Vec, size: [W, .004, .025] as Vec }))]} color={light ? "#a2a6aa" : "#2c3035"} shadow={false} />
    <Box position={[CX, -.027, 2.9]} size={[W, .006, 1.3]} color={lane} shadow={false} />
    <InstancedBoxes items={[2.25, 3.55].map((z) => ({ position: [CX, -.02, z] as Vec, size: [W, .008, .08] as Vec }))} color={FINISH.safety} roughness={.6} metalness={0} shadow={false} />
    <InstancedBoxes items={[7.25, 8.35].map((x) => ({ position: [x, -.02, -2.6] as Vec, size: [.08, .008, 9.6] as Vec }))} color={FINISH.safety} roughness={.6} metalness={0} shadow={false} />
    <InstancedBoxes items={[...[-1.5, 1.6].map((z) => ({ position: [.1, -.02, z] as Vec, size: [8.8, .01, .16] as Vec })), ...[-4.3, 4.5].map((x) => ({ position: [x, -.02, .05] as Vec, size: [.16, .01, 3.26] as Vec }))]} color={FINISH.safety} roughness={.6} metalness={0} shadow={false} />
    <InstancedBoxes items={range(-9, 9, 3).map((x) => ({ position: [x, -.02, 2.9] as Vec, size: [.7, .008, .12] as Vec }))} color="#f2f2f2" roughness={.6} metalness={0} shadow={false} />
    <InstancedBoxes items={range(.85, 2.15, .26).map((x) => ({ position: [x, -.02, 2.9] as Vec, size: [.13, .008, 1.15] as Vec }))} color="#f2f2f2" roughness={.6} metalness={0} shadow={false} />
    <Box position={[-6.6, -.02, -2.8]} size={[2.6, .01, .45]} color="#ffffff" map={hatch} roughness={.7} shadow={false} />
    <Box position={[4.45, -.02, -2.85]} size={[5.2, .01, .4]} color="#ffffff" map={hatch} roughness={.7} shadow={false} />
  </group>;
}

function Shell({ light }: { light: boolean }) {
  const cladding = light ? "#8fa7c0" : "#33475e";
  const dado = light ? "#a9a49a" : "#4d4a45";
  const glass = light ? "#dcefff" : "#5d86b5";
  const door = light ? "#6f7a85" : "#262d35";
  const hatch = useHazardTexture([1, 8]);
  const walls: { position: Vec; size: Vec; dadoPosition: Vec; dadoSize: Vec }[] = [
    { position: [CX, HALL.height / 2, HALL.z0 - .1], size: [W + .4, HALL.height, .2], dadoPosition: [CX, .75, HALL.z0 + .02], dadoSize: [W, 1.5, .06] },
    { position: [CX, HALL.height / 2, HALL.z1 + .1], size: [W + .4, HALL.height, .2], dadoPosition: [CX, .75, HALL.z1 - .02], dadoSize: [W, 1.5, .06] },
    { position: [HALL.x0 - .1, HALL.height / 2, CZ], size: [.2, HALL.height, D], dadoPosition: [HALL.x0 + .02, .75, CZ], dadoSize: [.06, 1.5, D] },
    { position: [HALL.x1 + .1, HALL.height / 2, CZ], size: [.2, HALL.height, D], dadoPosition: [HALL.x1 - .02, .75, CZ], dadoSize: [.06, 1.5, D] },
  ];
  return <group>
    {walls.map((wall, index) => <group key={index}>
      <Box position={wall.position} size={wall.size} color={cladding} roughness={.7} metalness={.25} shadow={false} />
      <Box position={wall.dadoPosition} size={wall.dadoSize} color={dado} roughness={.95} metalness={0} shadow={false} />
    </group>)}
    {/* Roof deck with glowing skylights. */}
    <Box position={[CX, HALL.height + .1, CZ]} size={[W + .4, .2, D + .4]} color={light ? "#7d8792" : "#20262d"} roughness={.8} shadow={false} />
    <InstancedBoxes items={SKYLIGHTS} color="#eef6ff" emissive="#e6f2ff" emissiveIntensity={light ? 1.1 : 1.6} shadow={false} />
    <InstancedBoxes items={WINDOWS} color={glass} emissive={glass} emissiveIntensity={light ? .5 : .9} roughness={.2} metalness={.3} shadow={false} />
    <InstancedBoxes items={COLUMNS} color={FINISH.structure} roughness={.5} metalness={.35} shadow={false} />
    <InstancedBoxes items={COLUMNS.map((c) => ({ position: [c.position[0], .6, c.position[2]] as Vec, size: [c.size[0] + .04, 1.2, c.size[2] + .04] as Vec }))} color="#ffffff" map={hatch} roughness={.6} metalness={0} shadow={false} />
    <InstancedBoxes items={TRUSSES} color={light ? "#5a7088" : "#4a5f78"} roughness={.5} metalness={.35} shadow={false} />
    <InstancedBoxes items={PURLINS} color={light ? "#6e7f90" : "#3c4b5c"} roughness={.6} metalness={.3} shadow={false} />
    <InstancedBoxes items={RUNWAY} color={FINISH.structure} roughness={.5} metalness={.35} shadow={false} />
    <InstancedBoxes items={RUNWAY_POSTS} color={FINISH.structure} roughness={.5} metalness={.35} />
    {/* High-bay lights. */}
    <InstancedBoxes items={LAMP_RODS} color="#555b61" shadow={false} />
    <InstancedCylinders items={LAMP_SHADES} color="#3a3f45" segments={18} shadow={false} />
    <InstancedCylinders items={LAMP_GLOW} color="#fff4d8" emissive="#fff1cf" emissiveIntensity={2.4} segments={18} shadow={false} />
    {/* Roll-up doors and personnel doors. */}
    <Box position={[HALL.x0 + .06, 2.6, 4.0]} size={[.06, 5.2, 4.4]} color={door} metalness={.5} roughness={.45} shadow={false} />
    <InstancedBoxes items={range(.3, 5.0, .3).map((y) => ({ position: [HALL.x0 + .1, y, 4.0] as Vec, size: [.02, .03, 4.35] as Vec }))} color={light ? "#5b656f" : "#1a2027"} shadow={false} />
    <InstancedBoxes items={[1.7, 6.3].map((z) => ({ position: [HALL.x0 + .15, 2.2, z] as Vec, size: [.15, 4.4, .15] as Vec }))} color="#ffffff" map={hatch} roughness={.6} metalness={0} shadow={false} />
    <Box position={[HALL.x1 - .06, 2.6, 0]} size={[.06, 5.2, 4.4]} color={door} metalness={.5} roughness={.45} shadow={false} />
    <InstancedBoxes items={[-2.3, 2.3].map((z) => ({ position: [HALL.x1 - .15, 2.2, z] as Vec, size: [.15, 4.4, .15] as Vec }))} color="#ffffff" map={hatch} roughness={.6} metalness={0} shadow={false} />
    <InstancedBoxes items={[{ position: [-2, 1.05, HALL.z0 + .05] as Vec, size: [1.0, 2.1, .06] as Vec }, { position: [HALL.x0 + .05, 1.05, -.2] as Vec, size: [.06, 2.1, 1.0] as Vec }]} color="#2f5e8f" roughness={.5} shadow={false} />
    <InstancedBoxes items={[{ position: [-2, 2.35, HALL.z0 + .07] as Vec, size: [.5, .18, .04] as Vec }, { position: [HALL.x0 + .07, 2.35, -.2] as Vec, size: [.04, .18, .5] as Vec }]} color="#1fae5b" emissive="#1fae5b" emissiveIntensity={1.4} shadow={false} />
    {/* Signage panels (text-free). */}
    <InstancedBoxes items={BLUE_SIGNS} color="#1f5fa8" roughness={.5} metalness={0} shadow={false} />
    <InstancedBoxes items={WHITE_SIGNS} color="#f1f1ee" roughness={.5} metalness={0} shadow={false} />
    <InstancedBoxes items={WHITE_SIGNS.map((s) => ({ position: [s.position[0], s.position[1] + .36, s.position[2]] as Vec, size: [s.size[0] + .01, .16, s.size[2] + .01] as Vec }))} color="#1f5fa8" roughness={.5} metalness={0} shadow={false} />
    <InstancedCylinders items={WARNING_SIGNS} color={FINISH.safety} segments={3} shadow={false} />
  </group>;
}

function Utilities({ light }: { light: boolean }) {
  return <group>
    {WALL_PIPES.map((pipe) => <group key={pipe.y}>
      <mesh position={[CX, pipe.y, HALL.z0 + .45]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[pipe.r, pipe.r, W - .6, 14]} /><meshStandardMaterial color={pipe.color} roughness={.45} metalness={.3} /></mesh>
      <mesh position={[HALL.x0 + .45, pipe.y, CZ - .5]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[pipe.r, pipe.r, D - 1.6, 14]} /><meshStandardMaterial color={pipe.color} roughness={.45} metalness={.3} /></mesh>
    </group>)}
    <InstancedCylinders items={STEAM_BANDS} color={FINISH.steamBand} segments={14} shadow={false} />
    <InstancedBoxes items={PIPE_BRACKETS} color="#59616a" shadow={false} />
    {/* Cable tray along the rear wall. */}
    <InstancedBoxes items={[{ position: [CX, 4.5, HALL.z0 + .5] as Vec, size: [W - .6, .03, .45] as Vec }, { position: [CX, 4.56, HALL.z0 + .28] as Vec, size: [W - .6, .12, .02] as Vec }, { position: [CX, 4.56, HALL.z0 + .72] as Vec, size: [W - .6, .12, .02] as Vec }]} color="#9aa3ab" metalness={.6} shadow={false} />
    <InstancedCylinders items={[[.0, "#1c1d1f"], [.12, "#e2611f"], [-.12, "#2a62a0"]].map(([dz]) => ({ position: [CX, 4.55, HALL.z0 + .5 + (dz as number)] as Vec, radius: .035, height: W - .8, rotation: [0, 0, Math.PI / 2] as Vec }))} color="#26282b" segments={8} shadow={false} />
    <InstancedBoxes items={DUCTS} color={light ? "#aab2ba" : "#7b848d"} roughness={.35} metalness={.7} shadow={false} />
    <InstancedBoxes items={DIFFUSERS} color="#c7cdd2" roughness={.4} metalness={.5} shadow={false} />
    <InstancedBoxes items={[...BOLLARDS.map((b) => ({ position: b.position, size: [0, 0, 0] as Vec }))].slice(0, 0)} color="#000" />
    <InstancedCylinders items={BOLLARDS} color={FINISH.safety} segments={14} />
    <InstancedCylinders items={BOLLARD_BANDS} color={FINISH.black} segments={14} shadow={false} />
    <InstancedCylinders items={EXTINGUISHERS} color="#c62f28" segments={14} />
    <InstancedBoxes items={RED_SIGNS.map((s) => ({ ...s, size: [s.size[0], s.size[1], .02] as Vec }))} color="#c62f28" shadow={false} />
  </group>;
}

function Mezzanine({ light }: { light: boolean }) {
  const hatch = useHazardTexture([12, 1]);
  return <group>
    <Box position={[(MEZZ.x0 + MEZZ.x1) / 2, MEZZ.y, (MEZZ.z0 + MEZZ.z1) / 2]} size={[MEZZ.x1 - MEZZ.x0, .14, MEZZ.z1 - MEZZ.z0]} color={light ? "#5d6670" : "#3a4048"} roughness={.7} metalness={.4} />
    <Box position={[MEZZ.x1 + .02, MEZZ.y - .12, (MEZZ.z0 + MEZZ.z1) / 2]} size={[.04, .14, MEZZ.z1 - MEZZ.z0]} color="#ffffff" map={hatch} />
    <InstancedBoxes items={MEZZ_POSTS} color={FINISH.structure} />
    <SafetyRail from={[MEZZ.x1, MEZZ.y + .07, MEZZ.z0]} to={[MEZZ.x1, MEZZ.y + .07, MEZZ.z1 - .1]} />
    <SafetyRail from={[MEZZ.x1, MEZZ.y + .07, MEZZ.z1]} to={[-9.95, MEZZ.y + .07, MEZZ.z1]} />
    {/* Stair down toward the south. */}
    <InstancedBoxes items={STAIR_STEPS} color={light ? "#5d6670" : "#4a525b"} metalness={.4} />
    <SafetyRail from={[-9.95, MEZZ.y - .1, MEZZ.z1 + .1]} to={[-9.95, .05, MEZZ.z1 + 3]} postEvery={.9} />
    {/* Offices under the mezzanine: glazed front facing the floor. */}
    <Box position={[MEZZ.x1 + .05, 1.5, -6.2]} size={[.06, 1.2, 4.6]} color={light ? "#bfd8ee" : "#3d6a96"} emissive={light ? "#000000" : "#3d6a96"} emissiveIntensity={.5} roughness={.15} metalness={.3} transparent opacity={.7} shadow={false} />
    <Box position={[MEZZ.x1 + .05, .45, -6.2]} size={[.08, .9, 4.6]} color={light ? "#e4e6e8" : "#59616a"} />
    <Box position={[MEZZ.x1 + .05, 2.6, -6.2]} size={[.08, 1.0, 4.6]} color={light ? "#e4e6e8" : "#59616a"} />
    <InstancedBoxes items={range(-11.6, -10.0, .4).map((x) => ({ position: [x, .95, -2.0] as Vec, size: [.36, 1.9, .45] as Vec }))} color="#41678f" roughness={.45} metalness={.4} />
    {/* Equipment on the mezzanine deck. */}
    <InstancedBoxes items={[{ position: [-11.1, MEZZ.y + .7, -7.6] as Vec, size: [1.1, 1.3, .9] as Vec }, { position: [-11.1, MEZZ.y + .55, -5.8] as Vec, size: [1.1, 1.0, 1.4] as Vec }, { position: [-11.1, MEZZ.y + .45, -3.8] as Vec, size: [1.1, .8, 1.0] as Vec }]} color={light ? "#c8ccd0" : "#6d747c"} roughness={.5} metalness={.3} />
    <StackLight position={[-11.1, MEZZ.y + 1.35, -7.6]} offset={2.1} />
  </group>;
}

function Storage({ light }: { light: boolean }) {
  return <group>
    <InstancedBoxes items={RACK_UPRIGHTS} color="#2f5d8a" roughness={.45} metalness={.3} />
    <InstancedBoxes items={RACK_BEAMS} color="#e0662a" roughness={.45} metalness={.25} />
    <InstancedBoxes items={RACK_PALLETS} color="#9b7b52" roughness={.9} metalness={0} />
    <InstancedBoxes items={RACK_LOADS} color={light ? "#b48a5a" : "#9a7650"} roughness={.9} metalness={0} />
    <InstancedCylinders items={DRUMS} color="#2c5687" roughness={.45} metalness={.3} segments={18} />
    <InstancedCylinders items={DRUM_BANDS} color="#d9dde2" segments={18} shadow={false} />
    <InstancedBoxes items={[0, 1, 2, 3].map((row) => ({ position: [10.55, .04, -7.45 + row * 1.25] as Vec, size: [2.4, .08, 1.15] as Vec }))} color="#9b7b52" roughness={.9} metalness={0} />
    <InstancedBoxes items={IBC_TOTES} color="#f1f1ee" roughness={.35} metalness={0} />
    <InstancedBoxes items={IBC_CAGES} color="#7c838a" metalness={.6} shadow={false} />
    {/* Workbench and tool cabinets on the east wall. */}
    <Box position={[11.3, .45, -2.8]} size={[1.0, .9, 1.8]} color="#41678f" roughness={.45} metalness={.4} />
    <Box position={[11.3, .93, -2.8]} size={[1.1, .06, 1.9]} color="#8a6a45" roughness={.8} metalness={0} />
    <Box position={[11.75, 1.6, -2.8]} size={[.06, 1.2, 1.8]} color={light ? "#c8ccd0" : "#59616a"} />
  </group>;
}

/** The enclosed factory hall around the process skid. */
export default function FactoryHall({ light }: { light: boolean }) {
  const mcc = useMemo(() => MCC_LEDS, []);
  return <group>
    <Floor light={light} />
    <Shell light={light} />
    <Utilities light={light} />
    <Mezzanine light={light} />
    <Storage light={light} />
    {/* MCC cabinet doors and pilot lights on the electrical room face. */}
    <InstancedBoxes items={MCC_DOORS} color={light ? "#c8ccd0" : "#7a828b"} roughness={.5} metalness={.3} shadow={false} />
    <PilotLights positions={mcc} />
    <StackLight position={[4.55, 1.58, 1.85]} attention offset={.6} />
    <StackLight position={[5.35, 1.58, 1.85]} offset={1.9} />
    <group position={[0, 1.35, 0]}><OverheadCrane light={light} /></group>
    <Forklift />
    <GuidedVehicle />
    <PackagingLine light={light} rate={1} />
    {/* Access platform behind the tank. */}
    <Box position={[0, 4.25, -1.55]} size={[2.8, .05, .8]} color="#3a3f45" metalness={.4} roughness={.6} />
    <SafetyRail from={[-1.4, 4.27, -1.95]} to={[1.4, 4.27, -1.95]} />
    <SafetyRail from={[1.4, 4.27, -1.95]} to={[1.4, 4.27, -1.15]} />
    <SafetyRail from={[-1.4, 4.27, -1.95]} to={[-1.4, 4.27, -1.15]} />
  </group>;
}
