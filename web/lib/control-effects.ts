import type { Equipment, PlantId } from "./types";
import type { ControlMetric } from "./controls";

/** Browser-only illustrative mass/energy balance; this does not run the RK4 simulator. */
export function sampleControlEffects(baseline: Equipment[], plantId: PlantId, metric: ControlMetric, target: number): Equipment[] {
  const local = (tag: string) => baseline.find(c => c.plantId === plantId && c.tag === tag)!.metrics;
  const pump = local("P-100"), tank = local("TK-101"), steam = local("TV-101"), coil = local("E-101"), outlet = local("LV-101");
  const heatCapacity = pump.feedM3h * 1000 * 4180 / 3600 / 1000;
  const temperature = metric === "tempC" ? target : metric === "steamKgH" ? (target * 2109 / 3600 + heatCapacity * 25 + 10) / (heatCapacity + .5) : tank.tempC;
  const duty = metric === "steamKgH" ? target * 2109 / 3600 : metric === "tempC" ? heatCapacity * (temperature - 25) + .5 * (temperature - 20) : coil.dutyKw;
  const demand = metric === "steamKgH" ? target : metric === "tempC" ? duty * 3600 / 2109 : steam.steamKgH;
  const headerDelta = -.0005 * (demand - steam.steamKgH);
  const valve = Math.max(0, Math.min(100, steam.positionPct + 100 * Math.log(Math.max(.001, duty / Math.max(1, coil.dutyKw) * (165 - tank.tempC) / Math.max(1, 165 - temperature))) / Math.log(50)));
  return baseline.map(c => {
    const metrics = { ...c.metrics };
    if (c.tag === "TV-101") metrics.headerBarg = Math.max(4.5, Math.min(6.5, c.metrics.headerBarg + headerDelta));
    if (c.plantId !== plantId) return { ...c, metrics };
    if (c.tag === "TK-101") {
      metrics.tempC = temperature;
      if (metric === "levelPct") { metrics.levelPct = target; metrics.levelSetpointPct = target; }
      if (metric === "tempC") metrics.tempSetpointC = target;
    }
    if (c.tag === "LV-101" && metric === "levelPct") metrics.positionPct = Math.max(0, Math.min(100, outlet.positionPct * Math.sqrt(tank.levelPct / Math.max(1, target))));
    if (c.tag === "E-101") metrics.dutyKw = duty;
    if (c.tag === "TV-101") {
      Object.assign(metrics, { steamKgH: demand, steamSetpointKgH: demand, positionPct: valve });
      if (metric === "steamKgH") metrics.steamFlowLocal = 1;
      if (metric === "tempC") metrics.steamFlowLocal = 0;
    }
    return { ...c, metrics };
  });
}

export function interpolateSampleEffects(baseline: Equipment[], target: Equipment[], progress: number): Equipment[] {
  return baseline.map(c => {
    const end = target.find(item => item.id === c.id)!;
    return { ...c, metrics: Object.fromEntries(Object.entries(end.metrics).map(([key, value]) => [key, /Setpoint|FlowLocal/.test(key) ? value : (c.metrics[key] ?? value) + (value - (c.metrics[key] ?? value)) * progress])) };
  });
}
