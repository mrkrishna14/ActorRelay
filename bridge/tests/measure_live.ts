// Measures the numbers in HANDOFF.md from real live_sim processes at the real 1 tick = 1 s: one process per speed, each
// stepped from the design point and sampled every tick for 150 ticks (7.5 simulated hours). Nothing here is fitted.
// Run: bun run bridge/tests/measure_live.ts   (about 2.6 min)
import { Bridge } from "./harness";

const SPEEDS = [50, 65, 85, 100];
const TICKS = 150;
const BASE_PORT = Number(process.env.MEASURE_BASE_PORT ?? 7341);

async function measure(speed: number, port: number) {
  const bridge = new Bridge(port, 7399, { BRIDGE_PUSH_MIRROR: "0", GLUE_URL: "http://127.0.0.1:9" });
  await bridge.start();
  try {
    const start = (await bridge.snapshot()).metrics;
    const write = await bridge.setpoint("plant-a/P-100", "speedPct", speed, `measure-${speed}`);
    const series = (await bridge.record(TICKS)).filter((s) => s.tick > write.body.tick);
    const pick = (id: string, metric: string) => series.map((s) => s.metrics[id][metric]);
    const lv = pick("plant-a/LV-101", "positionPct");
    const temp = pick("plant-a/TK-101", "tempC");
    const level = pick("plant-a/TK-101", "levelPct");
    const end = series[series.length - 1].metrics;
    const firstBack = temp.findIndex((value, n) => n >= temp.indexOf(Math.min(...temp)) && Math.abs(value - 75) <= 1);
    const health = await bridge.health();
    return {
      speed,
      ticksSampled: series.length,
      lvSteady: end["plant-a/LV-101"].positionPct,
      lvPeak: Math.max(...lv),
      lvPeakTick: lv.indexOf(Math.max(...lv)) + 1,
      lvTick3: lv[2],
      lvTick5: lv[4],
      tvSteady: end["plant-a/TV-101"].positionPct,
      steamSteady: end["plant-a/TV-101"].steamKgH,
      dutySteady: end["plant-a/E-101"].dutyKw,
      tempLow: Math.min(...temp),
      tempDip: Number((start["plant-a/TK-101"].tempC - Math.min(...temp)).toFixed(3)),
      tempLowTick: temp.indexOf(Math.min(...temp)) + 1,
      tempTick5: temp[4],
      tempWithin1CTick: firstBack + 1,
      tempSteady: end["plant-a/TK-101"].tempC,
      levelPeak: Math.max(...level),
      levelPeakTick: level.indexOf(Math.max(...level)) + 1,
      levelSteady: end["plant-a/TK-101"].levelPct,
      headerSteady: end["plant-a/TV-101"].headerBarg,
      plantBTvSteady: end["plant-b/TV-101"].positionPct,
      plantBSteamSteady: end["plant-b/TV-101"].steamKgH,
      lateTicks: health.stats.lateTicks,
      droppedTicks: health.stats.droppedTicks,
    };
  } finally {
    bridge.stop();
  }
}

const results = await Promise.all(SPEEDS.map((speed, n) => measure(speed, BASE_PORT + n)));
console.log(JSON.stringify(results, null, 1));
console.log("\n| Speed % | LV-101 steady % | LV-101 peak % (tick) | TV-101 % | Steam kg/h | Duty kW | Temp low C (tick) | Dip C | Within 1 C at tick | Header barg | Plant-b TV-101 % |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  console.log(`| ${r.speed} | ${r.lvSteady} | ${r.lvPeak} (${r.lvPeakTick}) | ${r.tvSteady} | ${r.steamSteady} | ${r.dutySteady} | ${r.tempLow} (${r.tempLowTick}) | ${r.tempDip} | ${r.tempWithin1CTick} | ${r.headerSteady} | ${r.plantBTvSteady} |`);
}
