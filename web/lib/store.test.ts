import { describe, expect, test } from "bun:test";
import { appendSamples, seriesKey, SERIES_WINDOW_MS } from "./store";
import type { ComponentView } from "./types";

const component = (value: number) => ({ id: "plant-a/LV-101", metrics: { positionPct: value } }) as unknown as ComponentView;

describe("appendSamples", () => {
  test("records every metric and drops samples older than the window", () => {
    const key = seriesKey("plant-a/LV-101", "positionPct");
    const first = appendSamples({}, [component(50)], 1000);
    const second = appendSamples(first, [component(51)], 2000);
    expect(second[key]?.map((sample) => sample.v)).toEqual([50, 51]);
    const later = appendSamples(second, [component(52)], 1000 + SERIES_WINDOW_MS + 500);
    expect(later[key]?.map((sample) => sample.v)).toEqual([51, 52]);
  });

  test("does not mutate the previous snapshot", () => {
    const key = seriesKey("plant-a/LV-101", "positionPct");
    const first = appendSamples({}, [component(50)], 1000);
    appendSamples(first, [component(51)], 2000);
    expect(first[key]).toHaveLength(1);
  });
});
