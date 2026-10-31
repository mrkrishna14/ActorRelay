// Our own glue, as a running service, against TASK3.MD and agent/glue.ts. Refused bodies have no side effects, and the
// reads change nothing, so this is safe against a live stack. Skipped until pointed at one:
//   CONTRACT_GLUE_URL=http://127.0.0.1:7200 bash run.sh glue-live
import { describe, expect, test } from "bun:test";
import { HttpGlue } from "../../../agent/glue";
import { ALL_COMPONENT_IDS, seed } from "./lib/examples";
import { nearMisses } from "./lib/near-misses";
import { CompanyStateS, EmittedComponentS, HistoryEventS, LearnedRuleS, PlantStateS } from "./lib/schemas";

const url = process.env.CONTRACT_GLUE_URL?.replace(/\/$/, "");
const live = url ? describe : describe.skip;
if (!url) console.warn("SKIPPED: glue-live needs CONTRACT_GLUE_URL. Nothing here has run against our own glue.");

const post = (path: string, body: unknown) =>
  fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });

live("our glue over HTTP", () => {
  const glue = new HttpGlue(url);

  for (const [path, what, body] of nearMisses) {
    test(`POST ${path} refuses ${what}`, async () => {
      expect((await post(path, body)).status).toBe(400);
    });
  }
  test("an unknown route is 404, not a silent success", async () => {
    expect((await post("/propse", {})).status).toBe(404);
  });
  test("a body that is not JSON is 400", async () => {
    const r = await fetch(`${url}/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(r.status).toBe(400);
  });
  for (const id of ALL_COMPONENT_IDS) {
    test(`GET /component/${id} is strictly the emitted shape`, async () => {
      const r = await fetch(`${url}/component/${encodeURIComponent(id)}`);
      expect(EmittedComponentS.safeParse(await r.json()).success).toBe(true);
    });
  }
  test("GET /similar takes upstreamSnapshot and returns strict events", async () => {
    const events = await glue.similar({ componentId: "plant-a/P-100", metric: "speedPct", to: 85, upstreamSnapshot: { feedM3h: 15, headerBarg: 6 }, k: 5 });
    for (const e of events) expect(HistoryEventS.safeParse(e).success).toBe(true);
  });
  test("GET /rules returns strict rules", async () => {
    for (const r of await glue.rules("plant-a/LV-101", "outlet-valve-A")) expect(LearnedRuleS.safeParse(r).success).toBe(true);
  });
  for (const plant of seed.plants) {
    test(`GET /state?plantId=${plant.id} holds strictly the contract states`, async () => {
      const body = (await (await fetch(`${url}/state?plantId=${plant.id}`)).json()) as any;
      expect(PlantStateS.safeParse(body.plant).success).toBe(true);
      expect(CompanyStateS.safeParse(body.company).success).toBe(true);
      for (const c of body.components) expect(EmittedComponentS.safeParse(c).success).toBe(true);
    });
  }
});
