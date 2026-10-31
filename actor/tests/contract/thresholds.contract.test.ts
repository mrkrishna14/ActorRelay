// One safety threshold, shared by agents and actors. Main's 13:01 decision: max(critical × (1 − margin/100), limit.max),
// so a wide margin cannot turn a healthy reading into a violation. Real agent and actor code; both functions are pure.
import { describe, expect, test } from "bun:test";
import type { Limit, Vote } from "../../../shared/types";
import { thresholdFor } from "../../../agent/vote";
import { enforceVoteSafety } from "../../src/logic/proposals";
import * as ex from "./lib/examples";

const VOTERS = ex.seed.plants[0]!.components.filter((c) => c.tag !== "P-100");
const decided = (limit: Limit, margin: number) => Math.max(limit.critical * (1 - margin / 100), limit.max);
const MARGINS = [5, 8, 10, 12, 15, 20, 25];

const yes = (component: (typeof VOTERS)[number], margin: number, metric: string, value: number): Vote => ({
  ...ex.vote,
  componentId: component.id,
  agentId: `agent:${component.id}`,
  vote: "yes",
  marginPct: margin,
  predicted: { ...Object.fromEntries(Object.entries(component.limits).map(([m, l]) => [m, l.min])), [metric]: value },
});

describe("agent and actor agree on the threshold", () => {
  for (const component of VOTERS) {
    for (const [metric, limit] of Object.entries(component.limits)) {
      test(`${component.tag} ${metric}: the agent uses the decided floor at every margin`, () => {
        for (const margin of MARGINS) expect(thresholdFor(limit, margin)).toBeCloseTo(decided(limit, margin), 6);
      });
      test(`${component.tag} ${metric}: the actor refuses a yes at that line and accepts one just under it`, () => {
        for (const margin of MARGINS) {
          const line = decided(limit, margin);
          expect(() => enforceVoteSafety(yes(component, margin, metric, line + 1e-6), component)).toThrow("unsafe_yes");
          expect(() => enforceVoteSafety(yes(component, margin, metric, line - 0.01), component)).not.toThrow();
        }
      });
    }
  }
});

describe("the demo numbers survive the floor", () => {
  const limitOf = (tag: string, metric: string) => VOTERS.find((c) => c.tag === tag)!.limits[metric]!;

  test("LV-101 is still 81 at margin 10, as CLAUDE.MD and the e2e expect", () => {
    expect(thresholdFor(limitOf("LV-101", "positionPct"), 10)).toBe(81);
  });
  test("TK-101 at 75 °C stays under the threshold at every margin", () => {
    for (const margin of MARGINS) expect(thresholdFor(limitOf("TK-101", "tempC"), margin)).toBeGreaterThan(75);
  });
  test("a healthy steady state never reaches a threshold, at any margin", () => {
    for (const component of VOTERS) {
      for (const [metric, limit] of Object.entries(component.limits)) {
        for (const margin of MARGINS) expect(component.metrics[metric]!).toBeLessThan(thresholdFor(limit, margin));
      }
    }
  });
});
