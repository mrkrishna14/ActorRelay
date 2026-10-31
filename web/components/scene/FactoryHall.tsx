"use client";

import { HALL, MEZZANINE } from "../../lib/plant-layout";
import { Box, FINISH, InstancedBoxes, type BoxInstance, type Vec } from "./parts";

export { HALL } from "../../lib/plant-layout";

const W = HALL.x1 - HALL.x0;
const D = HALL.z1 - HALL.z0;
const CX = (HALL.x0 + HALL.x1) / 2;
const CZ = (HALL.z0 + HALL.z1) / 2;
const range = (start: number, end: number, step: number) => Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => start + i * step);
const box = (position: Vec, size: Vec, rotation?: Vec): BoxInstance => ({ position, size, ...(rotation ? { rotation } : {}) });

const WALLS: BoxInstance[] = [
  box([CX, HALL.height / 2, HALL.z0 - .1], [W + .4, HALL.height, .2]),
  box([CX, HALL.height / 2, HALL.z1 + .1], [W + .4, HALL.height, .2]),
  box([HALL.x0 - .1, HALL.height / 2, CZ], [.2, HALL.height, D]),
  box([HALL.x1 + .1, HALL.height / 2, CZ], [.2, HALL.height, D]),
];
const DADO: BoxInstance[] = [
  box([CX, .6, HALL.z0 + .02], [W, 1.2, .06]), box([CX, .6, HALL.z1 - .02], [W, 1.2, .06]),
  box([HALL.x0 + .02, .6, CZ], [.06, 1.2, D]), box([HALL.x1 - .02, .6, CZ], [.06, 1.2, D]),
];
const COLUMNS: BoxInstance[] = [
  ...range(HALL.x0 + .2, HALL.x1 - .2, 4).flatMap((x) => [HALL.z0 + .2, HALL.z1 - .2].map((z) => box([x, HALL.height / 2, z], [.23, HALL.height, .23]))),
  ...range(HALL.z0 + 4, HALL.z1 - 4, 4).flatMap((z) => [HALL.x0 + .2, HALL.x1 - .2].map((x) => box([x, HALL.height / 2, z], [.23, HALL.height, .23]))),
];
const RIBS: BoxInstance[] = [
  ...range(HALL.x0 + .8, HALL.x1 - .8, .8).flatMap((x) => [HALL.z0 + .035, HALL.z1 - .035].map((z) => box([x, 4, z], [.025, 5.4, .035]))),
  ...range(HALL.z0 + .8, HALL.z1 - .8, .8).flatMap((z) => [HALL.x0 + .035, HALL.x1 - .035].map((x) => box([x, 4, z], [.035, 5.4, .025]))),
];
const WINDOWS: BoxInstance[] = [
  ...range(HALL.x0 + 2, HALL.x1 - 2, 4).flatMap((x) => [HALL.z0 + .065, HALL.z1 - .065].map((z) => box([x, 7.55, z], [3.45, 1.35, .06]))),
  ...range(HALL.z0 + 2, HALL.z1 - 2, 4).flatMap((z) => [HALL.x0 + .065, HALL.x1 - .065].map((x) => box([x, 7.55, z], [.06, 1.35, 3.45]))),
];
const WINDOW_RAILS: BoxInstance[] = [6.82, 8.28].flatMap((y) => [
  box([CX, y, HALL.z0 + .1], [W, .08, .07]), box([CX, y, HALL.z1 - .1], [W, .08, .07]),
  box([HALL.x0 + .1, y, CZ], [.07, .08, D]), box([HALL.x1 - .1, y, CZ], [.07, .08, D]),
]);
const TRUSSES: BoxInstance[] = range(HALL.z0 + 2, HALL.z1 - 2, 4).flatMap((z) => [
  box([CX, 9.15, z], [W, .16, .18]), box([CX, 8.35, z], [W, .12, .14]),
  ...range(HALL.x0 + 1, HALL.x1 - 1, 2).map((x, i) => box([x, 8.75, z], [2.15, .055, .055], [0, 0, i % 2 ? .38 : -.38])),
]);
const PURLINS = range(HALL.x0 + 2, HALL.x1 - 2, 4).map((x) => box([x, 9.36, CZ], [.075, .1, D]));
const LIGHTS = [-10, -3, 4, 11].flatMap((x) => [-7, 0, 7].map((z) => box([x, 8.15, z], [1.8, .07, .22])));
const JOINTS = [
  ...range(HALL.x0 + 4, HALL.x1 - 4, 4).map((x) => box([x, -.012, CZ], [.014, .004, D])),
  ...range(HALL.z0 + 4, HALL.z1 - 4, 4).map((z) => box([CX, -.012, z], [W, .004, .014])),
];
const AISLE = [5.2, 7.7].map((z) => box([CX, -.004, z], [W - 2, .006, .065]));
const BAY_LINES = [
  ...[-2.9, 2.6].map((z) => box([0, -.003, z], [9.4, .008, .06])),
  ...[-4.7, 4.7].map((x) => box([x, -.003, -.15], [.06, .008, 5.5])),
];
const M = MEZZANINE;
const MX0 = M.x - M.width / 2, MX1 = M.x + M.width / 2, MZ0 = M.z - M.depth / 2, MZ1 = M.z + M.depth / 2;
const MEZZ_POSTS = [MX0 + .15, MX1 - .15].flatMap((x) => [MZ0 + .15, MZ1 - .15].map((z) => box([x, M.height / 2, z], [.16, M.height, .16])));
const RAILS: BoxInstance[] = [];
function rail(a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  const count = Math.max(1, Math.ceil(length / 1.25));
  for (let i = 0; i <= count; i++) RAILS.push(box([a[0] + dx * i / count, M.height + .53, a[1] + dz * i / count], [.045, 1.05, .045]));
  for (const y of [.55, 1.05]) RAILS.push(box([(a[0] + b[0]) / 2, M.height + y, (a[1] + b[1]) / 2], [length, .045, .045], [0, -Math.atan2(dz, dx), 0]));
}
rail([MX0, MZ0], [MX1, MZ0]); rail([MX0, MZ0], [MX0, MZ1]); rail([MX1, MZ0], [MX1, MZ1]);
rail([MX0, MZ1], [-11.4, MZ1]); rail([-10.2, MZ1], [MX1, MZ1]);
const STEPS = Array.from({ length: 15 }, (_, i) => box([-10.8, M.height - (i + 1) * M.height / 15, MZ1 + .12 + i * .24], [1.12, .09, .28]));
const STAIR_RAILS = [-11.4, -10.2].flatMap((x) => [
  box([x, M.height / 2 + 1, MZ1 + 1.8], [.045, .045, Math.hypot(M.height, 3.6)], [Math.atan2(M.height, 3.6), 0, 0]),
  ...[0, 5, 10, 14].map((i) => box([x, M.height - (i + 1) * M.height / 15 + .5, MZ1 + .12 + i * .24], [.045, 1, .045])),
]);

/** Compact simulator-style process hall. Shared metre layout matches the 2D plan. */
export default function FactoryHall({ light }: { light: boolean }) {
  return <group name="process-hall">
    <Box position={[CX, -.1, CZ]} size={[W, .16, D]} color={light ? "#c7cccf" : "#525b64"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={JOINTS} color={light ? "#b7bec3" : "#46515b"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={[...AISLE, ...BAY_LINES]} color={FINISH.safety} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={range(-12, 12, 4).map((x) => box([x, -.003, 6.45], [.7, .006, .055]))} color="#e6e9e8" roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={WALLS} color={light ? "#d3dce2" : "#697c8e"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={DADO} color={light ? "#b4c0c9" : "#566575"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={RIBS} color={light ? "#c3cdd5" : "#748494"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={WINDOWS} color={light ? "#e0f1fa" : "#91b6cf"} emissive="#c9e2f0" emissiveIntensity={.15} roughness={.9} metalness={0} shadow={false} />
    <InstancedBoxes items={[...COLUMNS, ...WINDOW_RAILS, ...TRUSSES, ...PURLINS]} color={FINISH.structure} roughness={.9} metalness={.05} shadow={false} />
    <Box position={[CX, HALL.height + .06, CZ]} size={[W + .4, .12, D + .4]} color={light ? "#b6c1ca" : "#556779"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={LIGHTS} color="#f5f4df" emissive="#f5f4df" emissiveIntensity={.45} roughness={1} metalness={0} shadow={false} />
    <Box position={[M.x, M.height, M.z]} size={[M.width, .14, M.depth]} color={FINISH.structure} roughness={.9} metalness={.05} />
    <InstancedBoxes items={MEZZ_POSTS} color={FINISH.structure} roughness={.9} metalness={.05} />
    <InstancedBoxes items={STEPS} color={light ? "#7e94a6" : "#617a91"} roughness={.95} metalness={.05} />
    <InstancedBoxes items={[...RAILS, ...STAIR_RAILS]} color={FINISH.safety} roughness={.9} metalness={.05} shadow={false} />
    <Box position={[M.x, 1.4, MZ0 + .15]} size={[M.width - .4, 2.8, .18]} color={light ? "#c4cdd4" : "#607385"} roughness={1} metalness={0} shadow={false} />
    <InstancedBoxes items={[-13.6, -12.1, -10.6].map((x) => box([x, 1.18, MZ0 + .3], [1.1, 2.2, .3]))} color={light ? "#e2e5e5" : "#8d9ca8"} roughness={1} metalness={0} shadow={false} />
    <Box position={[HALL.x1 - .08, 1.25, 6.5]} size={[.08, 2.5, 1.25]} color={FINISH.structure} roughness={1} metalness={0} shadow={false} />
  </group>;
}
