import type { ChatMessage, ComponentTag, PlantId } from "./types";

export interface NormalizedChatMessage extends ChatMessage {
  badge?: string;
  rawText?: string;
  facts?: string[];
}

type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const metricNames: Record<string, string> = {
  speedPct: "pump speed", positionPct: "valve position", levelPct: "tank level", tempC: "temperature",
  dutyKw: "heating duty", steamKgH: "steam flow", headerBarg: "steam-header pressure", feedM3h: "feed flow",
  marginPct: "safety margin", absError: "prediction error", ticksToSettle: "settling time",
};
const metric = (value: unknown) => metricNames[string(value)] ?? string(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
const units: Record<string, string> = { speedPct: "%", positionPct: "%", levelPct: "%", tempC: "°C", dutyKw: " kW", steamKgH: " kg/h", headerBarg: " bar", feedM3h: " m³/h" };
const amount = (value: unknown, name: unknown) => finite(value) ? `${Math.round(value * 100) / 100}${units[string(name)] ?? ""}` : "";

function clean(value: string): string {
  return value.replace(/\[(?:openai|anthropic|claude|codex|gemini|baseline)(?::[^\]]*)?\]\s*/gi, "")
    .replace(/\s*\(similar events\s*:[\s\S]*\)\s*$/i, "")
    .replace(/\b(speedPct|positionPct|levelPct|tempC|dutyKw|steamKgH|headerBarg|feedM3h|marginPct|absError|ticksToSettle)(?=\d)/g, (name) => `${metricNames[name]} `)
    .replace(/\b(speedPct|positionPct|levelPct|tempC|dutyKw|steamKgH|headerBarg|feedM3h|marginPct|absError|ticksToSettle)\b/g, (name) => metricNames[name])
    .replace(/\s+/g, " ").trim();
}

function provider(text: string): string | undefined {
  if (/\[baseline(?::|\])/i.test(text)) return "Baseline";
  if (/\[openai(?::|\])|\[codex(?::|\])/i.test(text)) return "OpenAI";
  if (/\[(?:anthropic|claude)(?::|\])/i.test(text)) return "Claude";
  if (/\[gemini(?::|\])/i.test(text)) return "Gemini";
  return undefined;
}

/** Friendly display labels retain the real identifier on the underlying message. */
export function evidenceLabel(id: string, index?: number): string {
  const suffix = index === undefined ? "" : ` ${index + 1}`;
  if (/rule/i.test(id)) return /learned|component-rule|plant-rule/i.test(id) ? "Learned rule" : "Shared rule";
  if (/event|history|(?:^|[-_])run(?:[-_]|$)|mock-plant/i.test(id)) return `Past run${suffix}`;
  return `Observation${suffix}`;
}

/** Presentation-only: source channels, references, timestamps and original text are retained. */
export function normalizeChatMessage(message: ChatMessage): NormalizedChatMessage {
  if (message.kind === "operator") return { ...message };
  const original = message.text;
  const trimmed = original.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let decoded: unknown;
  let structured = false;
  if (/^[{[]/.test(trimmed)) {
    try { decoded = JSON.parse(trimmed); structured = true; } catch { /* Ordinary prose can start with a bracket. */ }
  }
  const envelope = record(decoded);
  const payload = Object.keys(record(envelope.payload)).length ? record(envelope.payload) : envelope;
  const type = string(envelope.type || payload.type).toLowerCase();
  const vote = record(payload.vote);
  const proposal = record(payload.proposal);
  const event = record(payload.event);
  const rule = record(payload.rule);
  const entry = record(payload.entry || payload.calibration);
  const data = type === "vote" ? Object.keys(vote).length ? vote : payload
    : type === "proposal" || type === "counter" || type === "counterproposal" ? Object.keys(proposal).length ? proposal : payload
    : type === "executed" ? Object.keys(event).length ? event : payload
    : type === "rule" ? Object.keys(rule).length ? rule : payload
    : type === "calibration" ? Object.keys(entry).length ? entry : payload : payload;
  const reason = string(data.reason || data.rationale);
  const sourceVendor = provider(`${original} ${reason}`);
  const evidence = [...new Set([...(message.evidence ?? []), ...[data.evidence, data.evidenceEventIds, data.evidenceRuleIds, data.supportEventIds, payload.evidence].flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])])];
  const reference = string(data.componentId || data.proposerComponentId || payload.componentId || record(data.condition).componentId || record(data.consequence).componentId);
  const identity = reference.match(/(plant-[ab])\/(P-100|TK-101|LV-101|E-101|TV-101)\b/i);
  const plantId = message.plantId ?? (identity?.[1].toLowerCase() as PlantId | undefined);
  const tag = message.tag ?? (identity?.[2].toUpperCase() as ComponentTag | undefined);
  const facts: string[] = [];
  const similar = finite(data.similarCount) ? data.similarCount : Number(original.match(/similar events\s*:\s*(\d+)/i)?.[1]);
  if (Number.isFinite(similar)) facts.push(`${similar} similar past ${similar === 1 ? "run" : "runs"} consulted.`);
  let text = clean(original);
  let badge: string | undefined;
  if (structured) {
    if (type === "vote") {
      const decision = string(data.vote).toLowerCase();
      badge = decision === "yes" ? "Accepted" : decision === "no" ? "Rejected" : "Review";
      text = `${badge}${clean(reason) ? ` · ${clean(reason)}` : " · Review received."}`;
      const predicted = record(data.predicted);
      if (!reason && Object.keys(predicted).length) text = `${badge} · Predicted ${Object.entries(predicted).filter(([, value]) => finite(value)).slice(0, 3).map(([key, value]) => `${metric(key)} ${amount(value, key)}`).join(", ")}.`;
    } else if (["proposal", "counter", "counterproposal"].includes(type)) {
      badge = type === "proposal" ? "Proposal" : "Counterproposal";
      text = `${badge} · ${metric(data.metric) || "Pump speed"}${finite(data.from) && finite(data.to) ? ` ${amount(data.from, data.metric)} → ${amount(data.to, data.metric)}` : finite(data.to) ? ` to ${amount(data.to, data.metric)}` : " change requested"}.${reason ? ` ${clean(reason)}` : ""}`;
    } else if (type === "executed") {
      badge = "Executed";
      text = `Change applied${finite(data.before) && finite(data.after) ? ` · ${metric(data.metric) || "Target"} ${amount(data.before, data.metric)} → ${amount(data.after, data.metric)}` : ""}.${string(data.incident) ? ` ${clean(string(data.incident))}` : ""}`;
    } else if (type === "rule") {
      badge = "Rule";
      text = `${data.scope === "company" ? "Shared rule" : "Learned rule"}${string(data.text) ? ` · ${clean(string(data.text))}` : " · New guidance recorded from past runs."}`;
    } else if (type === "calibration") {
      badge = "Calibration";
      text = `${metric(data.metric) || "Prediction"}${finite(data.predicted) ? ` · Predicted ${amount(data.predicted, data.metric)}` : ""}${finite(data.observed) ? `; observed ${amount(data.observed, data.metric)}` : ""}${finite(data.absError) ? `; difference ${amount(data.absError, data.metric)}` : ""}.`;
    } else {
      badge = "Update";
      text = "Agent coordination update received.";
    }
  } else {
    const decision = text.match(/^(YES|NO)\s*[.·:—-]?\s*/i);
    if (decision) { badge = decision[1].toUpperCase() === "YES" ? "Accepted" : "Rejected"; text = `${badge} · ${text.slice(decision[0].length) || "Review received."}`; }
  }
  evidence.forEach((id, index) => { text = text.replaceAll(id, evidenceLabel(id, index).toLowerCase()); });
  if (text.length > 720) text = `${text.slice(0, 717).trimEnd()}…`;
  const proposalId = message.proposalId ?? (string(data.proposalId || payload.proposalId) || (["proposal", "counter", "counterproposal"].includes(type) ? string(data.id) : "") || undefined);
  return { ...message, text, ...(badge ? { badge } : {}), ...(text !== original ? { rawText: original } : {}), ...(facts.length ? { facts } : {}), ...(sourceVendor ? { vendor: sourceVendor } : {}), ...(plantId ? { plantId } : {}), ...(tag ? { tag, sender: !message.sender || /^(ar-|agent:)/i.test(message.sender) ? tag : message.sender } : {}), ...(proposalId ? { proposalId } : {}), ...(evidence.length ? { evidence } : {}) };
}
