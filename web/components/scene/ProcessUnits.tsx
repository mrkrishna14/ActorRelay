"use client";

import { useMemo } from "react";
import { CONTEXT_ROUTES, EXCHANGER, FEED_VESSELS, PRODUCT_VESSELS, RACK, UTILITY } from "../../lib/plant-layout";
import { FlowParticles } from "./FlowParticles";
import { Box, Cylinder, FINISH, Flange, InstancedBoxes, InstancedCylinders, Metal, Pipe, PipeBands, type BoxInstance, type CylinderInstance, type Vec } from "./parts";

/** Supporting equipment belongs to the same liquid-process hall; only the central skid has agents. */
function Vessel({ x, z, radius, height, feed }: { x: number; z: number; radius: number; height: number; feed: boolean }) {
  const feet: BoxInstance[] = [-.68, .68].flatMap((dx) => [-.52, .52].map((dz) => ({ position: [dx * radius, .21, dz * radius] as Vec, size: [.12, .42, .14] as Vec })));
  const ladder: BoxInstance[] = Array.from({ length: 8 }, (_, i) => ({ position: [radius + .09, .46 + i * .34, 0] as Vec, size: [.08, .035, .39] as Vec }));
  return <group position={[x, 0, z]}>
    <Cylinder radius={radius} height={height} position={[0, height / 2 + .3, 0]} color={FINISH.stainless} roughness={.43} segments={32} shadow={false} />
    <mesh position={[0, height + .3, 0]} scale={[1, .24, 1]}><sphereGeometry args={[radius, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2]} /><Metal color={FINISH.stainless} roughness={.4} /></mesh>
    <InstancedBoxes items={feet} color={FINISH.casing} shadow={false} />
    <InstancedBoxes items={ladder} color={FINISH.structure} shadow={false} />
    <InstancedBoxes items={[-.24, .24].map((dz) => ({ position: [radius + .09, height / 2 + .3, dz] as Vec, size: [.045, height, .045] as Vec }))} color={FINISH.structure} shadow={false} />
    {[.4, height * .65 + .3].map((y) => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[radius + .012, .018, 6, 40]} /><Metal color="#858d96" roughness={.5} /></mesh>)}
    <Cylinder radius={.12} height={.18} position={[0, height + .62, 0]} color={FINISH.stainless} segments={16} shadow={false} />
    <Flange position={[0, height + .73, 0]} axis="y" radius={.19} />
    <Cylinder radius={.07} height={.7} position={[radius + .05, 1.1, .2]} color={FINISH.stainless} segments={12} shadow={false} />
    <mesh position={[radius + .14, 1.38, .2]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[.13, .13, .055, 18]} /><meshStandardMaterial color="#e6e8eb" roughness={.7} /></mesh>
    <PipeBands positions={[[0, feed ? 1.1 : .9, 0]]} axis="y" radius={radius} color={FINISH.water} />
  </group>;
}

function HandValve({ position, color }: { position: Vec; color: string }) {
  return <group position={position}>
    <Cylinder radius={.14} height={.32} rotation={[0, 0, Math.PI / 2]} color={color} paint segments={16} shadow={false} />
    <Flange position={[-.2, 0, 0]} radius={.18} /><Flange position={[.2, 0, 0]} radius={.18} />
    <Cylinder radius={.035} height={.28} position={[0, .2, 0]} color={FINISH.stainless} segments={8} shadow={false} />
    <mesh position={[0, .37, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[.14, .025, 6, 18]} /><meshStandardMaterial color={color} roughness={.5} /></mesh>
  </group>;
}

function ShellTubeExchanger() {
  return <group position={[EXCHANGER.x, 0, EXCHANGER.z]}>
    <Cylinder radius={.49} height={2.9} rotation={[0, 0, Math.PI / 2]} position={[0, 1.45, 0]} color={FINISH.stainless} roughness={.48} segments={28} shadow={false} />
    <InstancedBoxes items={[-.95, .95].map((x) => ({ position: [x, .5, 0] as Vec, size: [.25, .95, .74] as Vec }))} color={FINISH.structure} shadow={false} />
    <Flange position={[-1.47, 1.45, 0]} radius={.55} /><Flange position={[1.47, 1.45, 0]} radius={.55} />
    <Cylinder radius={.42} height={.19} rotation={[0, 0, Math.PI / 2]} position={[-1.61, 1.45, 0]} color={FINISH.casing} segments={24} shadow={false} />
    <Cylinder radius={.42} height={.19} rotation={[0, 0, Math.PI / 2]} position={[1.61, 1.45, 0]} color={FINISH.casing} segments={24} shadow={false} />
    <Cylinder radius={.085} height={.28} position={[0, 2, 0]} color={FINISH.steamPaint} paint segments={12} shadow={false} />
    <Cylinder radius={.065} height={.24} position={[0, .95, 0]} color={FINISH.condensate} paint segments={12} shadow={false} />
    <PipeBands positions={[[-1.22, 1.45, 0], [1.22, 1.45, 0]]} axis="x" radius={.49} color={FINISH.steamBand} />
  </group>;
}

function SteamUtility() {
  const bases: BoxInstance[] = [{ position: [0, .12, 0], size: [2.9, .18, 2.3] }, { position: [-1.25, .45, 0], size: [.14, .55, 2] }, { position: [1.25, .45, 0], size: [.14, .55, 2] }];
  return <group position={[UTILITY.x, 0, UTILITY.z]}>
    <InstancedBoxes items={bases} color={FINISH.structure} shadow={false} />
    <Cylinder radius={.67} height={1.65} position={[0, 1.3, 0]} color={FINISH.steamClad} roughness={.5} segments={28} shadow={false} />
    <mesh position={[0, 2.12, 0]} scale={[1, .24, 1]}><sphereGeometry args={[.67, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><Metal color={FINISH.steamClad} roughness={.5} /></mesh>
    <Cylinder radius={.12} height={.27} position={[0, 2.3, 0]} color={FINISH.steamPaint} paint segments={12} shadow={false} />
    <Cylinder radius={.2} height={.95} position={[.72, .65, 0]} color={FINISH.condensate} paint segments={16} shadow={false} />
    <Pipe points={[[.7, .7, 0], [1.05, .7, 0], [1.05, 1.5, 0], [.58, 1.5, 0]]} radius={.055} color={FINISH.condensate} paint segments={32} />
    <Cylinder radius={.18} height={.08} position={[0, 1.85, .69]} rotation={[Math.PI / 2, 0, 0]} color="#edf0f3" segments={20} shadow={false} />
    <Box position={[0, 1.85, .74]} size={[.02, .16, .01]} color={FINISH.black} rotation={[0, 0, -.4]} shadow={false} />
    <HandValve position={[0, 2.3, 0]} color={FINISH.steamPaint} />
    <PipeBands positions={[[0, 1.1, 0]]} axis="y" radius={.67} color={FINISH.steamBand} />
  </group>;
}

export default function ProcessUnits({ light, fadeTo: _fadeTo }: { light: boolean; fadeTo: string }) {
  const rack = useMemo(() => {
    const posts: BoxInstance[] = [], beams: BoxInstance[] = [], pads: BoxInstance[] = [];
    for (let x = RACK.x0; x <= RACK.x1 + .01; x += 4.5) {
      for (const z of [RACK.z - .48, RACK.z + .48]) {
        posts.push({ position: [x, RACK.height / 2, z], size: [.13, RACK.height, .13] });
        pads.push({ position: [x, .045, z], size: [.4, .09, .4] });
      }
      beams.push({ position: [x, RACK.height - .19, RACK.z], size: [.14, .14, 1.25] });
    }
    beams.push({ position: [0, RACK.height - .35, RACK.z - .48], size: [RACK.x1 - RACK.x0, .12, .1] }, { position: [0, RACK.height - .35, RACK.z + .48], size: [RACK.x1 - RACK.x0, .12, .1] });
    return { posts, beams, pads };
  }, []);
  const supports = useMemo<CylinderInstance[]>(() => CONTEXT_ROUTES.flatMap((route) => route.points.filter((point) => point[1] < 1.2).map((point) => ({ position: [point[0], Math.max(.1, point[1] / 2), point[2]] as Vec, radius: .035, height: Math.max(.15, point[1]) }))), []);
  return <group>
    <InstancedBoxes items={rack.posts} color={FINISH.structure} roughness={.6} shadow={false} />
    <InstancedBoxes items={rack.beams} color={FINISH.structure} roughness={.6} shadow={false} />
    <InstancedBoxes items={rack.pads} color={light ? "#b9b5ac" : "#57534d"} roughness={.95} metalness={0} shadow={false} />
    <InstancedCylinders items={supports} color={FINISH.casing} segments={8} shadow={false} />
    {FEED_VESSELS.map((vessel) => <Vessel key={vessel.id} {...vessel} feed />)}
    {PRODUCT_VESSELS.map((vessel) => <Vessel key={vessel.id} {...vessel} feed={false} />)}
    <ShellTubeExchanger /><SteamUtility />
    {CONTEXT_ROUTES.map((route) => {
      const color = route.service === "water" ? FINISH.water : route.service === "steam" ? FINISH.steamClad : FINISH.condensate;
      const glow = route.service === "water" ? "#83c7ff" : route.service === "steam" ? "#ffe0bc" : "#d3ad86";
      const length = route.points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - route.points[i][0], point[1] - route.points[i][1], point[2] - route.points[i][2]), 0);
      return <group key={route.id}>
        <Pipe points={route.points} radius={route.radius} color={color} paint segments={Math.max(28, route.points.length * 12)} />
        <FlowParticles points={route.points} count={Math.max(6, Math.round(length * 1.7))} speed={route.service === "steam" ? 2.3 : 1.4} color={glow} radius={route.radius * 1.13} opacity={.8} />
        {route.service === "steam" && <PipeBands positions={[route.points[0]]} axis="x" radius={route.radius} color={FINISH.steamBand} />}
      </group>;
    })}
    <HandValve position={[-5.1, .62, -.5]} color={FINISH.water} />
    <HandValve position={[7.8, .73, 1]} color={FINISH.water} />
  </group>;
}
