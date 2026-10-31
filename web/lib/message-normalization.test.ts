import { describe, expect, test } from "bun:test";
import { evidenceLabel, normalizeChatMessage } from "./message-normalization";
import type { ChatMessage } from "./types";

const message = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text, sender: "", channel: "company", at: 123, ...extra });
const vote = { componentId: "plant-b/TV-101", proposalId: "proposal-long-id", vote: "no", reason: "[openai:gpt-5] Predicted positionPct 89 exceeds threshold 81 (similar events: 5, newest run event-long, rules: rule-long)", predicted: { positionPct: 89 }, similarCount: 5, evidenceEventIds: ["event-long"], evidenceRuleIds: ["rule-long"] };

describe("conversation normalization", () => {
  test("flat and nested protocol votes preserve source identity, references and evidence", () => {
    for (const envelope of [{ type: "vote", vote }, { type: "vote", payload: { vote } }]) {
      const result = normalizeChatMessage(message(JSON.stringify(envelope), { evidence: ["original"] }));
      expect(result.text).toBe("Rejected · Predicted valve position 89 exceeds threshold 81");
      expect(result.vendor).toBe("OpenAI");
      expect(result.plantId).toBe("plant-b");
      expect(result.tag).toBe("TV-101");
      expect(result.sender).toBe("TV-101");
      expect(result.channel).toBe("company");
      expect(result.proposalId).toBe("proposal-long-id");
      expect(result.evidence).toEqual(["original", "event-long", "rule-long"]);
      expect(result.facts).toEqual(["5 similar past runs consulted."]);
      expect(result.rawText).toBe(JSON.stringify(envelope));
    }
  });
  test("plain actor vote keeps unsafe reason and numbers without provenance noise", () => {
    const result = normalizeChatMessage(message(`NO · ${vote.reason}`, { evidence: ["event-long"] }));
    expect(result.text).toBe("Rejected · Predicted valve position 89 exceeds threshold 81");
    expect(result.evidence).toEqual(["event-long"]);
    expect(result.facts?.[0]).toContain("5 similar");
  });
  test("baseline remains baseline even when an equipment vendor says Codex", () => {
    const result = normalizeChatMessage(message("YES · [baseline: no LLM configured] positionPct 66 is below 81", { vendor: "Codex" }));
    expect(result.vendor).toBe("Baseline");
    expect(result.text).toBe("Accepted · valve position 66 is below 81");
  });
  test("inline evidence IDs and tightly spaced metric values stay readable", () => {
    const source = "NO · [openai:gpt-qa] predicted positionPct89 >=81 (critical=90, marginPct=10). Similar events event-qa-long; rule rule-qa-long.";
    const result = normalizeChatMessage(message(source, { evidence: ["event-qa-long", "rule-qa-long"] }));
    expect(result.text).toContain("valve position 89 >=81");
    expect(result.text).toContain("safety margin=10");
    expect(result.text).not.toContain("event-qa-long");
    expect(result.text).not.toContain("rule-qa-long");
    expect(result.rawText).toBe(source);
  });
  test("execution and calibration distinguish applied values from predictions", () => {
    expect(normalizeChatMessage(message(JSON.stringify({ type: "executed", event: { metric: "speedPct", before: 50, after: 65 } }))).text).toContain("Change applied · pump speed 50% → 65%");
    expect(normalizeChatMessage(message(JSON.stringify({ type: "calibration", payload: { componentId: "plant-a/LV-101", entry: { metric: "positionPct", predicted: 66, observed: 67, absError: 1 } } }))).text).toBe("valve position · Predicted 66%; observed 67%; difference 1%.");
  });
  test("unknown structured payload has a useful summary and retained original", () => {
    const raw = JSON.stringify({ type: "telemetry", payload: { secretInternalField: "x" } });
    const result = normalizeChatMessage(message(raw));
    expect(result.text).toBe("Agent coordination update received.");
    expect(result.rawText).toBe(raw);
  });
  test("operator natural language remains exactly intact", () => {
    const source = message("Check positionPct and say YES · [baseline: sample]", { kind: "operator" });
    expect(normalizeChatMessage(source)).toEqual(source);
  });
  test("evidence labels hide long internal identifiers", () => {
    expect(evidenceLabel("rule-lv-03")).toBe("Shared rule");
    expect(evidenceLabel("learned-rule-9")).toBe("Learned rule");
    expect(evidenceLabel("event-uuid-long", 1)).toBe("Past run 2");
    expect(evidenceLabel("uuid-long", 0)).toBe("Observation 1");
  });
});
