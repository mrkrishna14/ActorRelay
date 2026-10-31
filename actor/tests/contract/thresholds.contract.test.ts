// Safety thresholds on both sides. The actor's net is always max(critical × (1 − margin/100), limit.max). The agent's line
// may sit inside that net, so this pins what has to hold whichever line the agent uses: agents are never looser than the
// actors, and a wide margin cannot turn a healthy reading into a violation. Real agent and actor code; both are pure.
import { describe, expect, test } from "bun:test";
import type { Limit, Vote } from "../../../shared/types";
import { thresholdFor } from "../../../agent/vote";
import { enforceVoteSafety } from "../../src/logic/proposals";
import * as ex from "./lib/examples";

// Typed with the optional reading so these checks hold with or without it.
const agentLine = thresholdFor as (limit: Limit, margin: number, reading?: number) => number;
const actorLine = (limit: Limit, margin: number) => Math.max(limit.critical * (1 - margin / 100), limit.max);

const VOTERS = ex.seed.plants[0]!.components.filter((c) => c.tag !== "P-100");
const MARGINS = [5, 8, 10, 12, 15, 20, 25];

const yes = (component: (typeof VOTERS)[number], margin: number, metric: string, value: number): Vote => ({
  ...ex.vote,
  componentId: component.id,
  agentId: `agent:${component.id}`,
  vote: "yes",
  marginPct: margin,
  predicted: { ...Object.fromEntries(Object.entries(component.limits).map(([m, l]) => [m, l.min])), [metric]: value },
});

describe("agents are never looser than the actors", () => {
  for (const component of VOTERS) {
    for (const [metric, limit] of Object.entries(component.limits)) {
      test(`${component.tag} ${metric}: at every margin and reading`, () => {
        for (const margin of MARGINS) {
          for (const reading of [limit.min, component.metrics[metric]!, limit.max - 0.01]) {
            expect(agentLine(limit, margin, reading)).toBeLessThanOrEqual(actorLine(limit, margin) + 1e-9);
          }
        }
      });
      test(`${component.tag} ${metric}: the actor refuses a yes at its line and accepts one just under it`, () => {
        for (const margin of MARGINS) {
          const line = actorLine(limit, margin);
          expect(() => enforceVoteSafety(yes(component, margin, metric, line + 1e-6), component)).toThrow("unsafe_yes");
          expect(() => enforceVoteSafety(yes(component, margin, metric, line - 0.01), component)).not.toThrow();
        }
      });
    }
  }
});

describe("the demo numbers hold at every margin", () => {
  const limitOf = (tag: string, metric: string) => VOTERS.find((c) => c.tag === tag)!.limits[metric]!;

  test("LV-101 is 81 at margin 10, as CLAUDE.MD and the e2e expect", () => {
    expect(agentLine(limitOf("LV-101", "positionPct"), 10)).toBe(81);
  });
  test("TK-101 at 75 °C stays under the threshold at every margin", () => {
    for (const margin of MARGINS) expect(agentLine(limitOf("TK-101", "tempC"), margin, 75)).toBeGreaterThan(75);
  });
  test("a healthy steady state never reaches a threshold, at any margin", () => {
    for (const component of VOTERS) {
      for (const [metric, limit] of Object.entries(component.limits)) {
        const reading = component.metrics[metric]!;
        for (const margin of MARGINS) expect(reading).toBeLessThan(agentLine(limit, margin, reading));
      }
    }
  });
});
