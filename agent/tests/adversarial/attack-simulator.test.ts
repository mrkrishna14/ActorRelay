// The real simulator process, bridge/live_sim.ts, on a private port with its clock parked. Nothing here needs glue.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const PORT = 7391 + Math.floor(Math.random() * 400);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const P100 = "plant-a/P-100";
let sim: ReturnType<typeof Bun.spawn>;

const setpoint = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${URL_BASE}/setpoint`, { method: "POST", headers, body: JSON.stringify(body) });
const speed = async () => ((await (await fetch(`${URL_BASE}/health`)).json()) as { speedPct: Record<string, number> }).speedPct["plant-a"];

beforeAll(async () => {
  sim = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "..", "..", "bridge", "live_sim.ts")], {
    env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_PUSH_MIRROR: "0", BRIDGE_TICK_MS: "3600000", GLUE_URL: "http://127.0.0.1:9" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${URL_BASE}/health`).then((r) => r.ok, () => false);
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error("simulator did not start");
}, 20_000);

afterAll(() => {
  sim.kill();
});

describe("simulator /setpoint [real live_sim, parked clock]", () => {
  test("a browser Origin is refused, so a page cannot reach it", async () => {
    const before = await speed();
    expect((await setpoint({ componentId: P100, metric: "speedPct", value: 70, proposalId: "x" }, { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect(await speed()).toBe(before);
  });

  test("text/plain is refused", async () => {
    expect((await setpoint({ componentId: P100, metric: "speedPct", value: 70, proposalId: "x" }, { "content-type": "text/plain" })).status).toBe(415);
  });

  for (const [name, body] of [
    ["the outlet valve", { componentId: "plant-a/LV-101", metric: "positionPct", value: 99, proposalId: "t1" }],
    ["the steam valve", { componentId: "plant-a/TV-101", metric: "positionPct", value: 99, proposalId: "t2" }],
    ["speed over 100", { componentId: P100, metric: "speedPct", value: 101, proposalId: "t3" }],
    ["negative speed", { componentId: P100, metric: "speedPct", value: -1, proposalId: "t4" }],
    ["a string value", { componentId: P100, metric: "speedPct", value: "70", proposalId: "t5" }],
    ["a null value", { componentId: P100, metric: "speedPct", value: null, proposalId: "t6" }],
    ["no proposal id", { componentId: P100, metric: "speedPct", value: 70 }],
    ["an unknown plant", { componentId: "plant-c/P-100", metric: "speedPct", value: 70, proposalId: "t7" }],
    ["a path in the id", { componentId: "plant-a/P-100/../x", metric: "speedPct", value: 70, proposalId: "t8" }],
    ["a proto metric", { componentId: P100, metric: "__proto__", value: 70, proposalId: "t9" }],
  ] as const) {
    test(`${name} is refused and moves nothing`, async () => {
      const before = await speed();
      expect((await setpoint(body)).status).toBeGreaterThanOrEqual(400);
      expect(await speed()).toBe(before);
    });
  }

  test("one proposal id moves the plant once, and cannot be reused for another value", async () => {
    const first = await setpoint({ componentId: P100, metric: "speedPct", value: 60, proposalId: "once" });
    expect(first.status).toBe(200);
    const repeat = (await (await setpoint({ componentId: P100, metric: "speedPct", value: 60, proposalId: "once" })).json()) as { duplicate: boolean };
    expect(repeat.duplicate).toBe(true);
    expect((await setpoint({ componentId: P100, metric: "speedPct", value: 99, proposalId: "once" })).status).toBe(409);
    expect(await speed()).toBe(60);
  });
});

// Pinned, not endorsed: the claim that only the approved path writes holds for glue, not for this port. See REPORT.md.
describe("known residual risk, no auth by project scope [real live_sim]", () => {
  test("any local process can write the simulator with an invented proposal id and no token", async () => {
    expect((await setpoint({ componentId: P100, metric: "speedPct", value: 100, proposalId: "invented" })).status).toBe(200);
    expect(await speed()).toBe(100);
  });
});
