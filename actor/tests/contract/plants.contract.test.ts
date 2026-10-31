// shared/plants.json against the plant table in CLAUDE.MD, field by field, for both plants.
import { describe, expect, test } from "bun:test";
import plantsFile from "../../../shared/plants.json";
import type { ComponentState } from "../../../shared/types";
import { claudeMd, parsePlantTable, task2 } from "./lib/docs";
import { ComponentStateS, CompanySeedS, EmittedComponentS, PlantsFileS } from "./lib/schemas";

const seed = PlantsFileS.parse(plantsFile);
const rows = parsePlantTable();
const PLANTS = ["plant-a", "plant-b"] as const;
const qualify = (plant: string, tags: string[]) => tags.map((t) => `${plant}/${t}`);

// Physics summary and TASK2 fallback coefficients. The seed must start at the design steady state (50 %).
const DESIGN_SPEED = 50;
const fallback = {
  steamKgH: (s: number) => 29.7 * s + 48,
  dutyKw: (s: number) => 17.43 * s + 27,
  positionPct: (s: number) => 0.36 * s + 32.5,
};

describe("parser sanity", () => {
  test("the doc table has exactly the five tags the task names", () => {
    expect(rows.map((r) => r.tag)).toEqual(["P-100", "TK-101", "LV-101", "E-101", "TV-101"]);
  });
  test("every limit in the table parsed", () => {
    expect(rows.map((r) => Object.keys(r.limits))).toEqual([
      ["speedPct"],
      ["levelPct", "tempC"],
      ["positionPct"],
      ["dutyKw"],
      ["positionPct", "steamKgH"],
    ]);
  });
  test("the table is what TASK1 and TASK2 point at", () => {
    expect(claudeMd()).toContain("Every component starts at `marginPct: 10`.");
    expect(task2()).toContain("exactly the CLAUDE.MD plant table");
  });
});

describe("file shape", () => {
  test("two plants in company order, five components each", () => {
    expect(seed.plants.map((p) => p.id)).toEqual([...PLANTS]);
    expect(seed.company.plants).toEqual([...PLANTS]);
    for (const p of seed.plants) expect(p.components.length).toBe(5);
  });
  test("every seeded component is a strict ComponentState", () => {
    for (const p of seed.plants) for (const c of p.components) expect(() => ComponentStateS.parse(c)).not.toThrow();
  });
  test("ids are unique across the file", () => {
    const ids = seed.plants.flatMap((p) => p.components.map((c) => c.id));
    expect(new Set(ids).size).toBe(10);
  });
  test("the file is parseable as a seed and is NOT an emitted state", () => {
    // Guards the loadSeed conversion: components here are objects, PlantState.components is ComponentId[].
    expect(typeof seed.plants[0]!.components[0]).toBe("object");
    expect(() => EmittedComponentS.parse(seed.plants[0]!.components[0])).toThrow();
    expect(() => CompanySeedS.parse(seed.company)).not.toThrow();
    expect(Object.keys(seed.company).sort()).toEqual(["plants", "sharedResources"]);
  });
});

for (const plant of PLANTS) {
  describe(`${plant} against the CLAUDE.MD plant table`, () => {
    const components = new Map(seed.plants.find((p) => p.id === plant)!.components.map((c) => [c.tag, c]));
    const get = (tag: string): ComponentState => components.get(tag)!;

    for (const row of rows) {
      describe(row.tag, () => {
        test("present", () => expect(components.has(row.tag)).toBe(true));
        test("id and plantId", () => {
          expect(get(row.tag).id).toBe(`${plant}/${row.tag}`);
          expect(get(row.tag).plantId).toBe(plant);
        });
        test("tag", () => expect(get(row.tag).tag).toBe(row.tag));
        test("name", () => expect(get(row.tag).name).toBe(row.name));
        test("model", () => expect(get(row.tag).model).toBe(row.model));
        test("role", () => expect(get(row.tag).role).toBe(row.role as ComponentState["role"]));
        test("vendor", () => expect(get(row.tag).vendor).toBe(row.vendor as ComponentState["vendor"]));
        test("limits, exact keys and values", () => expect(get(row.tag).limits).toEqual(row.limits));
        test("min < max < critical on every limit", () => {
          for (const l of Object.values(get(row.tag).limits)) {
            expect(l.min).toBeLessThan(l.max);
            expect(l.max).toBeLessThan(l.critical);
          }
        });
        test("upstream in table order", () => expect(get(row.tag).upstream).toEqual(qualify(plant, row.upstream)));
        test("downstream in table order", () => expect(get(row.tag).downstream).toEqual(qualify(plant, row.downstream)));
        test("sharedResources", () => expect(get(row.tag).sharedResources).toEqual(row.sharedResources));
        test("marginPct starts at 10", () => expect(get(row.tag).marginPct).toBe(10));
        test("status starts ok", () => expect(get(row.tag).status).toBe("ok"));
        test("lastTick parses", () => expect(Number.isNaN(Date.parse(get(row.tag).lastTick))).toBe(false));
        test("every limited metric has a starting value", () => {
          for (const m of Object.keys(row.limits)) expect(get(row.tag).metrics[m]).toBeTypeOf("number");
        });
      });
    }

    describe("metric keys against the TASK2 metric mapping", () => {
      const mapping: Record<string, string[]> = {
        "P-100": ["speedPct", "feedM3h"],
        "TK-101": ["levelPct", "tempC"],
        "LV-101": ["positionPct"],
        "E-101": ["dutyKw"],
        "TV-101": ["positionPct", "steamKgH", "headerBarg"],
      };
      for (const [tag, keys] of Object.entries(mapping)) {
        test(tag, () => expect(Object.keys(get(tag).metrics)).toEqual(keys));
      }
      test("TASK2 still lists that mapping", () => {
        const t = task2();
        for (const needle of ["`speedPct`, `feedM3h`", "`levelPct = LI-101", "`tempC = TI-101`", "`dutyKw = CALC-DUTY`", "`headerBarg = PI-201`"]) {
          expect(t).toContain(needle);
        }
      });
    });

    describe("starting values are the design steady state", () => {
      test("P-100 at 50 %, feedM3h = 0.3 × speedPct", () => {
        expect(get("P-100").metrics.speedPct).toBe(DESIGN_SPEED);
        expect(get("P-100").metrics.feedM3h).toBeCloseTo(0.3 * DESIGN_SPEED, 9);
      });
      test("TK-101 level 2.0 m of 4.0 m and 75 °C", () => {
        expect(get("TK-101").metrics.levelPct).toBe((2.0 / 4.0) * 100);
        expect(get("TK-101").metrics.tempC).toBe(75);
      });
      test("LV-101 at the design 50 %", () => expect(get("LV-101").metrics.positionPct).toBe(50));
      test("E-101 duty fits the TASK2 steady-state line", () => {
        expect(get("E-101").metrics.dutyKw).toBeCloseTo(fallback.dutyKw(DESIGN_SPEED), 6);
      });
      test("TV-101 fits the TASK2 lines and half the 3066 kg/h design steam", () => {
        expect(get("TV-101").metrics.positionPct).toBeCloseTo(fallback.positionPct(DESIGN_SPEED), 6);
        expect(get("TV-101").metrics.steamKgH).toBeCloseTo(fallback.steamKgH(DESIGN_SPEED), 6);
        expect(get("TV-101").metrics.steamKgH! * 2).toBe(3066);
      });
      test("TV-101 header at 6 barg", () => expect(get("TV-101").metrics.headerBarg).toBe(6));
      test("no starting value sits at or past a warning limit", () => {
        for (const c of components.values()) {
          for (const [m, l] of Object.entries(c.limits)) expect(c.metrics[m]!).toBeLessThan(l.max);
        }
      });
    });

    describe("graph", () => {
      const all = [...components.values()];
      test("links are symmetric: X downstream of Y iff Y upstream of X", () => {
        for (const c of all) {
          for (const d of c.downstream) expect(all.find((x) => x.id === d)!.upstream).toContain(c.id);
          for (const u of c.upstream) expect(all.find((x) => x.id === u)!.downstream).toContain(c.id);
        }
      });
      test("no link leaves the plant", () => {
        for (const c of all) for (const l of [...c.upstream, ...c.downstream]) expect(l.startsWith(`${plant}/`)).toBe(true);
      });
      test("undirected reachability from P-100 is the other four, as requiredVoters needs", () => {
        const seen = new Set(["P-100"]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const c of all) {
            const touched = [c.id, ...c.upstream, ...c.downstream].some((id) => seen.has(id.split("/")[1]!));
            if (touched && !seen.has(c.tag)) (seen.add(c.tag), (grew = true));
            if (seen.has(c.tag)) for (const l of [...c.upstream, ...c.downstream]) if (!seen.has(l.split("/")[1]!)) (seen.add(l.split("/")[1]!), (grew = true));
          }
        }
        expect([...seen].sort()).toEqual(["E-101", "LV-101", "P-100", "TK-101", "TV-101"]);
      });
    });
  });
}

describe("company seed", () => {
  test("steam-header-1 is the only shared resource and holds both TV-101s", () => {
    expect(seed.company.sharedResources.map((r) => r.id)).toEqual(["steam-header-1"]);
    expect(seed.company.sharedResources[0]!.components).toEqual(["plant-a/TV-101", "plant-b/TV-101"]);
  });
  test("the resource list agrees with the components' own sharedResources both ways", () => {
    const declared = seed.plants.flatMap((p) => p.components).filter((c) => c.sharedResources.includes("steam-header-1")).map((c) => c.id);
    expect(declared.sort()).toEqual([...seed.company.sharedResources[0]!.components].sort());
  });
  test("both plants are identical apart from their plant prefix", () => {
    const strip = (id: string) => JSON.stringify(seed.plants.find((p) => p.id === id)!.components).replaceAll(id, "PLANT");
    expect(strip("plant-a")).toBe(strip("plant-b"));
  });
  test("every model appears in both plants, so every rule can reach company scope", () => {
    const models = (id: string) => seed.plants.find((p) => p.id === id)!.components.map((c) => c.model).sort();
    expect(models("plant-a")).toEqual(models("plant-b"));
  });
});
