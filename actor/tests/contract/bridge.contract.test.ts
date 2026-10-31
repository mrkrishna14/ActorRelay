// The simulator boundary, real on both ends: the live_sim process against glue's own HttpBridge client and route validators.
// Only the glue on the far end of /mirror and /observed is a recorder. Ticks run at 100 ms, so this says nothing about pacing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { HttpBridge, parseSnapshot } from "../../../glue/bridge";
import { routeSchemas as ourGlue } from "../../../glue/contract";
import { REPO_ROOT } from "./lib/docs";
import { ALL_COMPONENT_IDS, seed } from "./lib/examples";
import { routeSchemas as spec } from "./lib/glue-spec";

const COMPONENTS = seed.plants.flatMap((p) => p.components);
const TICK_MS = 100;

type Posted = { path: string; body: any };
const posted: Posted[] = [];
const of = (path: string) => posted.filter((p) => p.path === path);

const recorder = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    posted.push({ path: new URL(request.url).pathname, body: await request.json().catch(() => null) });
    return Response.json({ ok: true });
  },
});

function freePort() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port;
}

const port = freePort();
const url = `http://127.0.0.1:${port}`;
const bridge = new HttpBridge(url);
let child: Subprocess;

async function until<T>(read: () => T | undefined | null | false, label: string, ms = 8000): Promise<T> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = read();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`never happened: ${label}`);
}

beforeAll(async () => {
  child = Bun.spawn([process.execPath, "run", join(REPO_ROOT, "bridge", "live_sim.ts")], {
    env: { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TICK_MS: String(TICK_MS), GLUE_URL: `http://127.0.0.1:${recorder.port}` },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("live_sim did not come up");
}, 40000);

afterAll(() => {
  child?.kill();
  recorder.stop(true);
});

describe("what the simulator pushes", () => {
  test("/mirror reaches all ten components", async () => {
    await until(() => new Set(of("/mirror").map((p) => p.body?.componentId)).size === 10, "ten components mirrored");
    expect(new Set(of("/mirror").map((p) => p.body.componentId))).toEqual(new Set(ALL_COMPONENT_IDS));
  });
  test("every /mirror body passes glue's validator and the TASK3 spec", () => {
    for (const { body } of of("/mirror")) {
      expect(ourGlue["/mirror"].safeParse(body).success).toBe(true);
      expect(spec["/mirror"]!.safeParse(body).success).toBe(true);
    }
  });
  test("every /mirror carries exactly the metrics plants.json declares", () => {
    for (const { body } of of("/mirror")) {
      const component = COMPONENTS.find((c) => c.id === body.componentId)!;
      expect(Object.keys(body.metrics).sort()).toEqual(Object.keys(component.metrics).sort());
    }
  });
});

describe("glue's client against the real simulator", () => {
  const proposalId = "plant-a-p00001-contract";

  test("snapshot returns one plant's five components with the declared metrics", async () => {
    for (const plant of seed.plants) {
      const snapshot = await bridge.snapshot(plant.id);
      expect(Object.keys(snapshot).sort()).toEqual(plant.components.map((c) => c.id).sort());
      for (const c of plant.components) expect(Object.keys(snapshot[c.id]!).sort()).toEqual(Object.keys(c.metrics).sort());
    }
  });
  test("snapshot keeps the plant filter even if handed both plants", async () => {
    const all = await (await fetch(`${url}/snapshot`)).json();
    expect(Object.keys(parseSnapshot(all, "plant-a")).length).toBe(5);
  });
  test("the design point matches the seed closely enough that a first reading raises no status", async () => {
    const snapshot = await bridge.snapshot("plant-a");
    expect(snapshot["plant-a/P-100"]!.speedPct).toBe(50);
    for (const c of seed.plants[0]!.components) {
      for (const [metric, limit] of Object.entries(c.limits)) expect(snapshot[c.id]![metric]!).toBeLessThan(limit.max);
    }
  });
  test("setpoint applies what it was given", async () => {
    await expect(bridge.setpoint({ componentId: "plant-a/P-100", metric: "speedPct", value: 65, proposalId })).resolves.toEqual({ applied: 65 });
    expect((await bridge.snapshot("plant-a"))["plant-a/P-100"]!.speedPct).toBe(65);
  });
  test("a retried setpoint for the same proposal writes once", async () => {
    await bridge.setpoint({ componentId: "plant-a/P-100", metric: "speedPct", value: 65, proposalId });
    const writes = (await (await fetch(`${url}/writes`)).json()) as { proposalId: string }[];
    expect(writes.filter((w) => w.proposalId === proposalId).length).toBe(1);
  });
  test("a write the simulator cannot take is refused, not ignored", async () => {
    await expect(bridge.setpoint({ componentId: "plant-a/LV-101", metric: "positionPct", value: 50, proposalId: "plant-a-p00002-contract" })).rejects.toThrow();
  });

  describe("the /observed report", () => {
    const report = () => of("/observed").find((p) => p.body?.proposalId === proposalId)?.body;

    test("arrives once, and passes glue's validator and the TASK3 spec", async () => {
      await until(report, "observed report");
      expect(ourGlue["/observed"].safeParse(report()).success).toBe(true);
      expect(spec["/observed"]!.safeParse(report()).success).toBe(true);
      expect(of("/observed").filter((p) => p.body?.proposalId === proposalId).length).toBe(1);
    });
    test("names only metrics the components declare", () => {
      for (const effect of report().effects) {
        const component = COMPONENTS.find((c) => c.id === effect.componentId);
        expect(`${effect.componentId} ${effect.metric}: ${component !== undefined && Object.hasOwn(component.metrics, effect.metric)}`).toBe(`${effect.componentId} ${effect.metric}: true`);
      }
    });
    test("covers the four other components, and the header on the other plant's steam valve", () => {
      const rows = new Set(report().effects.map((e: { componentId: string; metric: string }) => `${e.componentId} ${e.metric}`));
      for (const row of ["plant-a/LV-101 positionPct", "plant-a/TK-101 tempC", "plant-a/E-101 dutyKw", "plant-a/TV-101 steamKgH", "plant-b/TV-101 headerBarg"]) expect(rows.has(row)).toBe(true);
    });
  });

  test("reset returns both plants to the design point", async () => {
    await bridge.reset();
    await Bun.sleep(TICK_MS * 2);
    expect((await bridge.snapshot("plant-a"))["plant-a/P-100"]!.speedPct).toBe(50);
  });
});
