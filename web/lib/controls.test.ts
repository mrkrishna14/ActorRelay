import { describe, expect, test } from "bun:test";
import { controlTarget, parseControlRequest } from "./controls";

describe("parseControlRequest", () => {
  const cases: [string, string, string, number][] = [
    ["Propose 85%", "P-100", "speedPct", 85],
    ["Propose 65%", "P-100", "speedPct", 65],
    ["Set pump speed to 70%", "P-100", "speedPct", 70],
    ["Set tank temperature to 78", "TK-101", "tempC", 78],
    ["tank temp 78", "TK-101", "tempC", 78],
    ["Set temperature to 76°C", "TK-101", "tempC", 76],
    ["Set TK-101 temp to 74.5", "TK-101", "tempC", 74.5],
    ["TIC-101 to 77", "TK-101", "tempC", 77],
    ["Set tank level to 60", "TK-101", "levelPct", 60],
    ["tank level 60%", "TK-101", "levelPct", 60],
    ["LIC-101 55", "TK-101", "levelPct", 55],
    ["Lower tank level from 50 to 40%", "TK-101", "levelPct", 40],
    ["Set steam to 1540 kg/h", "TV-101", "steamKgH", 1540],
  ];
  for (const [text, tag, metric, to] of cases) {
    test(text, () => expect(parseControlRequest(text)).toEqual({ tag: tag as never, metric: metric as never, to }));
  }
  test("ignores text without a number", () => expect(parseControlRequest("why was that blocked?")).toBeNull());
  test("parsed targets map to a known control with units", () => {
    expect(controlTarget("TK-101", "tempC")).toMatchObject({ loop: "TIC-101", unit: "°C", min: 70, max: 80 });
    expect(controlTarget("TK-101", "levelPct")).toMatchObject({ loop: "LIC-101", unit: "%", min: 20, max: 70 });
  });
});
