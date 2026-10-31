import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { check, clone, deepFreeze, plantComponents, seedComponents, type ComponentState } from "./harness";
import { engine } from "./target";

const TAGS = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"];
const other = (plantId: string) => (plantId === "plant-a" ? "plant-b" : "plant-a");

const sorted = (xs: string[]) => [...xs].sort();

function graphComponent(id: string, plantId: "plant-a" | "plant-b"): ComponentState {
  return {
    id,
    plantId,
    tag: id.split("/")[1]!,
    name: id,
    model: "m",
    role: "mechanic",
    vendor: "codex",
    metrics: {},
    limits: {},
    upstream: [],
    downstream: [],
    sharedResources: [],
    status: "ok",
    marginPct: 10,
    lastTick: "1970-01-01T00:00:00.000Z",
  };
}

// Sparse random plants: islands, one-sided links, cycles, self-links, dangling links.
const oneSidedGraphArb = fc
  .record({
    sizeA: fc.integer({ min: 1, max: 6 }),
    sizeB: fc.integer({ min: 0, max: 6 }),
    links: fc.array(fc.tuple(fc.nat(11), fc.nat(11), fc.boolean()), { maxLength: 14 }),
    shared: fc.array(fc.tuple(fc.nat(11), fc.constantFrom("r1", "r2")), { maxLength: 6 }),
    proposer: fc.nat(11),
  })
  .map(({ sizeA, sizeB, links, shared, proposer }) => {
    const a = Array.from({ length: sizeA }, (_, i) => graphComponent(`plant-a/C${i}`, "plant-a"));
    const b = Array.from({ length: sizeB }, (_, i) => graphComponent(`plant-b/C${i}`, "plant-b"));
    for (const [plant] of [[a], [b]] as const) {
      if (plant.length === 0) continue;
      for (const [x, y, up] of links) {
        const from = plant[x % plant.length]!;
        const to = plant[y % plant.length]!;
        (up ? from.upstream : from.downstream).push(to.id);
      }
    }
    const all = [...a, ...b];
    for (const [i, r] of shared) all[i % all.length]!.sharedResources.push(r);
    return { components: all, proposerId: a[proposer % a.length]!.id };
  });

// plants.json records every link on both ends, so this is the shape real seeds take.
const mirrored = (components: ComponentState[]) => {
  const byId = new Map(components.map((c) => [c.id, c]));
  for (const c of components) {
    for (const id of c.upstream) {
      const other = byId.get(id)!;
      if (!other.downstream.includes(c.id)) other.downstream.push(c.id);
    }
    for (const id of c.downstream) {
      const other = byId.get(id)!;
      if (!other.upstream.includes(c.id)) other.upstream.push(c.id);
    }
  }
  return components;
};
const graphArb = oneSidedGraphArb.map((g) => ({ ...g, components: mirrored(g.components) }));

function oracle(proposerId: string, components: ComponentState[]) {
  const proposer = components.find((c) => c.id === proposerId)!;
  const local = components.filter((c) => c.plantId === proposer.plantId);
  const linked = (x: ComponentState, y: ComponentState) =>
    x.upstream.includes(y.id) ||
    x.downstream.includes(y.id) ||
    y.upstream.includes(x.id) ||
    y.downstream.includes(x.id);
  const reached = new Set([proposer]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of local) {
      if (!reached.has(c) && [...reached].some((r) => linked(r, c))) {
        reached.add(c);
        grew = true;
      }
    }
  }
  const resources = new Set([...reached].flatMap((c) => c.sharedResources));
  const cross = components
    .filter((c) => c.plantId !== proposer.plantId && c.sharedResources.some((r) => resources.has(r)))
    .map((c) => c.id);
  reached.delete(proposer);
  return { local: [...reached].map((c) => c.id), cross };
}

describe(`requiredVoters [${engine.name}]`, () => {
  test("is exact for every component in both plants", () => {
    for (const c of seedComponents) {
      const got = engine.requiredVoters(c.id, seedComponents);
      const want = [
        ...TAGS.filter((t) => t !== c.tag).map((t) => `${c.plantId}/${t}`),
        `${other(c.plantId)}/TV-101`,
      ];
      expect(sorted(got.requiredVoters)).toEqual(sorted(want));
      expect(got.crossPlant).toBe(true);
    }
  });

  test("pump in plant-a matches TASK1 exactly", () => {
    const got = engine.requiredVoters("plant-a/P-100", seedComponents);
    expect(sorted(got.requiredVoters)).toEqual(
      sorted(["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"]),
    );
  });

  test("no shared resources means local voters only, crossPlant false", () => {
    const local = clone(seedComponents).map((c) => ({ ...c, sharedResources: [] }));
    for (const c of local) {
      const got = engine.requiredVoters(c.id, local);
      expect(sorted(got.requiredVoters)).toEqual(
        sorted(TAGS.filter((t) => t !== c.tag).map((t) => `${c.plantId}/${t}`)),
      );
      expect(got.crossPlant).toBe(false);
    }
  });

  test("the other plant's non-shared components never vote", () => {
    for (const c of plantComponents("plant-a")) {
      const got = engine.requiredVoters(c.id, seedComponents);
      const foreign = got.requiredVoters.filter((v) => v.startsWith("plant-b/"));
      expect(foreign).toEqual(["plant-b/TV-101"]);
    }
  });

  test("matches graph reachability and resource sharing on random plants", () => {
    check(
      fc.property(graphArb, ({ components, proposerId }) => {
        const got = engine.requiredVoters(proposerId, components);
        const want = oracle(proposerId, components);
        expect(sorted(got.requiredVoters)).toEqual(sorted([...want.local, ...want.cross]));
        expect(got.crossPlant).toBe(want.cross.length > 0);
      }),
    );
  });

  test("a link recorded on one side only still makes a required voter", () => {
    check(
      fc.property(oneSidedGraphArb, ({ components, proposerId }) => {
        const got = engine.requiredVoters(proposerId, components);
        const want = oracle(proposerId, components);
        expect(sorted(got.requiredVoters)).toEqual(sorted([...want.local, ...want.cross]));
      }),
    );
  });

  test("every link in plants.json is recorded on both ends", () => {
    for (const c of seedComponents) {
      const peer = (id: string) => seedComponents.find((x) => x.id === id)!;
      for (const id of c.upstream) expect(peer(id).downstream).toContain(c.id);
      for (const id of c.downstream) expect(peer(id).upstream).toContain(c.id);
    }
  });

  test("never includes the proposer, has no duplicates, ignores input order", () => {
    check(
      fc.property(graphArb, ({ components, proposerId }) => {
        const got = engine.requiredVoters(proposerId, components).requiredVoters;
        expect(got).not.toContain(proposerId);
        expect(new Set(got).size).toBe(got.length);
        const reversed = engine.requiredVoters(proposerId, [...components].reverse()).requiredVoters;
        expect(sorted(reversed)).toEqual(sorted(got));
      }),
    );
  });

  test("does not mutate the components", () => {
    check(
      fc.property(graphArb, ({ components, proposerId }) => {
        const before = clone(components);
        deepFreeze(components);
        engine.requiredVoters(proposerId, components);
        expect(components).toEqual(before);
      }),
      1000,
    );
  });
});
