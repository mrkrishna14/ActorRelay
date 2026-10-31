// Live adapter: glue's API (simulator + durable actors + agents) → the dashboard's existing DemoState shape.
// Pure mapping functions plus thin fetch helpers. The UI components are unchanged.
import type { AuditItem, DemoState } from "./demo";
import type { ChatMessage, ComponentTag, Equipment, EvidenceItem, PlantId, Proposal, ProposalVote, TrendPoint } from "./types";

export const GLUE_URL: string = process.env.NEXT_PUBLIC_GLUE_URL ?? "http://127.0.0.1:7200";

export type GlueState = { plant: any; company: any; components: any[]; mode: string; integrations?: any };

const TAG_ORDER: ComponentTag[] = ["P-100", "TK-101", "LV-101", "E-101", "TV-101"];
const PLANT_ORDER: PlantId[] = ["plant-a", "plant-b"];
const ROLE_LABEL: Record<string, string> = { mechanic: "Mechanic", process_engineer: "Process engineer", chemical_engineer: "Chemical engineer", safety: "Safety" };
const TREND_WINDOW_MS = 120_000;
const TREND_MAX_POINTS = 121;

const tagOf = (componentId: string) => (componentId.split("/")[1] ?? componentId) as ComponentTag;
const plantOf = (componentId: string) => componentId.split("/")[0] as PlantId;
const ms = (iso: string | null | undefined) => {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
};
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

export async function fetchGlue(glueUrl: string, plantId: PlantId, signal?: AbortSignal): Promise<GlueState> {
  const res = await fetch(`${glueUrl.replace(/\/$/, "")}/state?plantId=${plantId}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`glue /state ${plantId}: HTTP ${res.status}`);
  return (await res.json()) as GlueState;
}

async function post(glueUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${glueUrl.replace(/\/$/, "")}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain-text reply */ }
  if (!res.ok) {
    const message = (data && typeof data === "object" && "error" in data) ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(`${path}: ${message}`);
  }
  return data;
}

export function liveApi(glueUrl: string) {
  return {
    propose(plantId: PlantId, to: number, rationale = `Operator request: P-100 to ${to}%`) {
      return post(glueUrl, "/propose", { plantId, proposerComponentId: `${plantId}/P-100`, metric: "speedPct", to, rationale });
    },
    veto(proposalId: string) {
      return post(glueUrl, "/veto", { proposalId, by: "operator" });
    },
    reset() {
      return post(glueUrl, "/reset", {});
    },
  };
}

// ---------------------------------------------------------------- mapping

function toEquipment(c: any): Equipment {
  return {
    id: c.id, plantId: c.plantId, tag: c.tag, name: c.name, role: ROLE_LABEL[c.role] ?? c.role,
    vendor: c.vendor, metrics: { ...(c.metrics ?? {}) }, status: c.status ?? "ok", marginPct: num(c.marginPct, 10),
    limits: c.limits ? { ...c.limits } : undefined,
  };
}

/** The one predicted number that matters most for this voter. */
function primaryPrediction(vote: any, proposalPlant: PlantId): number {
  const predicted: Record<string, number> = vote.predicted ?? {};
  const tag = tagOf(vote.componentId);
  const crossPlant = plantOf(vote.componentId) !== proposalPlant;
  const preferred: string[] =
    tag === "LV-101" ? ["positionPct"]
      : tag === "TV-101" ? (crossPlant ? ["headerBarg", "steamKgH", "positionPct"] : ["steamKgH", "positionPct", "headerBarg"])
        : tag === "TK-101" ? ["levelPct", "tempC"]
          : tag === "E-101" ? ["dutyKw"]
            : [];
  for (const key of preferred) if (typeof predicted[key] === "number") return predicted[key];
  const first = Object.values(predicted).find((value) => typeof value === "number");
  return num(first, 0);
}

function toVote(vote: any, proposalPlant: PlantId): ProposalVote {
  return {
    tag: tagOf(vote.componentId), plantId: plantOf(vote.componentId), vote: vote.vote === "yes" ? "yes" : "no",
    predicted: primaryPrediction(vote, proposalPlant), reason: String(vote.reason ?? ""),
    evidence: [...(vote.evidenceEventIds ?? []), ...(vote.evidenceRuleIds ?? [])],
  };
}

function toProposal(p: any): Proposal {
  return {
    id: p.id, plantId: p.plantId, from: num(p.from), to: num(p.to), status: p.status,
    votes: (p.votes ?? []).map((v: any) => toVote(v, p.plantId)),
    vetoDeadline: ms(p.vetoDeadline), parentId: p.parentProposalId ?? undefined, createdAt: ms(p.at) ?? 0,
  };
}

function eventEvidence(e: any): EvidenceItem {
  const lv = (e.effects ?? []).find((f: any) => typeof f.componentId === "string" && f.componentId.endsWith("/LV-101") && f.metric === "positionPct");
  const parts: string[] = [];
  if (lv) parts.push(`LV-101 positionPct ${round(num(lv.before))} → ${round(num(lv.after))}% (settled in ${num(lv.ticksToSettle)} ticks)`);
  if (e.incident) parts.push(`Incident: ${e.incident}`);
  if (e.proposalId) parts.push(`Observed after proposal ${e.proposalId}`);
  return {
    id: e.id, kind: "event",
    title: `${tagOf(e.componentId)} ${round(num(e.before))}→${round(num(e.after))}%${e.incident ? ` · ${e.incident}` : ""}`,
    plantId: e.plantId, at: e.at, summary: parts.join(". ") || `${e.metric} ${e.before} → ${e.after}`,
    before: num(e.before), after: num(e.after), observed: lv ? num(lv.after) : num(e.after),
  };
}

function ruleEvidence(r: any, fallbackPlant: PlantId): EvidenceItem {
  const plant = r.condition?.componentId ? plantOf(r.condition.componentId) : fallbackPlant;
  return {
    id: r.id, kind: "rule", title: r.text, plantId: plant, at: r.lastSeenAt ?? r.createdAt ?? new Date(0).toISOString(),
    summary: `${r.text} · seen ${num(r.timesSeen)}×`, before: num(r.condition?.value), after: num(r.consequence?.value),
    observed: num(r.consequence?.value), supportIds: [...(r.supportEventIds ?? [])],
  };
}

function vendorLabel(reason: string, fallback: string): string {
  if (reason.startsWith("[openai")) return "OpenAI";
  if (reason.startsWith("[claude")) return "Claude";
  if (reason.startsWith("[baseline")) return "Baseline";
  return fallback === "codex" ? "Codex" : fallback === "claude" ? "Claude" : fallback;
}

function buildMessages(proposals: any[], audits: any[], vendorById: Map<string, string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const p of proposals) {
    const at = ms(p.at) ?? 0;
    out.push({
      id: `live-${p.id}-proposal`, channel: p.plantId, sender: "P-100", kind: "agent", at,
      text: `Proposing ${num(p.from)} → ${num(p.to)}%. ${p.rationale ?? ""}`.trim(),
      vendor: vendorLabel("", vendorById.get(p.proposerComponentId) ?? "codex"), plantId: p.plantId, tag: "P-100", proposalId: p.id,
    });
    (p.votes ?? []).forEach((v: any, index: number) => {
      const voterPlant = plantOf(v.componentId);
      const voteAudit = audits.find((a) => a.kind === "vote" && a.refId === p.id && typeof a.summary === "string" && a.summary.includes(`(${v.componentId})`));
      out.push({
        id: `live-${p.id}-vote-${v.componentId}`, channel: voterPlant === p.plantId ? p.plantId : "company",
        sender: tagOf(v.componentId), kind: "agent", at: ms(voteAudit?.at) ?? at + index + 1,
        text: `${String(v.vote).toUpperCase()} · ${v.reason ?? ""}`,
        vendor: vendorLabel(String(v.reason ?? ""), vendorById.get(v.componentId) ?? ""),
        plantId: voterPlant, tag: tagOf(v.componentId),
        evidence: [...(v.evidenceEventIds ?? []), ...(v.evidenceRuleIds ?? [])], proposalId: p.id,
      });
    });
  }
  for (const a of audits) {
    if (a.kind !== "block" && a.kind !== "veto" && a.kind !== "execute") continue;
    out.push({
      id: `live-audit-${a.kind}-${a.refId}-${a.at}`, channel: a.plantId === "company" ? "company" : a.plantId,
      sender: "Plant", kind: "system", at: ms(a.at) ?? 0, text: String(a.summary ?? ""),
      plantId: a.plantId === "company" ? undefined : a.plantId, proposalId: a.refId,
    });
  }
  return out.sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
}

export function toDemoState(a: GlueState, b: GlueState, prev: DemoState | null, now: number): DemoState {
  // Components: glue returns all 10 in each response; take one copy per id.
  const byId = new Map<string, any>();
  for (const c of [...(a.components ?? []), ...(b.components ?? [])]) if (c?.id && !byId.has(c.id)) byId.set(c.id, c);
  const components: Equipment[] = PLANT_ORDER.flatMap((plantId) =>
    TAG_ORDER.map((tag) => byId.get(`${plantId}/${tag}`)).filter(Boolean).map(toEquipment));
  const vendorById = new Map<string, string>([...byId.values()].map((c) => [c.id, c.vendor]));

  const plants = [a.plant, b.plant].filter(Boolean);
  const rawProposals = plants.flatMap((p) => p.proposals ?? []).sort((x: any, y: any) => String(x.at).localeCompare(String(y.at)));
  const proposals = rawProposals.map(toProposal);

  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  const add = (item: EvidenceItem) => { if (!seen.has(item.id)) { seen.add(item.id); evidence.push(item); } };
  for (const p of plants) for (const e of p.history ?? []) add(eventEvidence(e));
  for (const p of plants) for (const r of p.rules ?? []) add(ruleEvidence(r, p.id));
  const company = a.company ?? b.company;
  for (const r of company?.rules ?? []) add(ruleEvidence(r, "plant-a"));

  const rawAudits = [...plants.flatMap((p) => p.audit ?? []), ...(company?.audit ?? [])];
  const auditSeen = new Set<string>();
  const audit: AuditItem[] = [];
  for (const entry of rawAudits) {
    const id = `${entry.kind}-${entry.refId}-${entry.at}`;
    if (auditSeen.has(id)) continue;
    auditSeen.add(id);
    audit.push({ id, at: ms(entry.at) ?? 0, plantId: entry.plantId, text: String(entry.summary ?? ""), evidenceId: seen.has(entry.refId) ? entry.refId : undefined });
  }
  audit.sort((x, y) => x.at - y.at);

  const messages = buildMessages(rawProposals, rawAudits, vendorById);

  const trends = {} as Record<PlantId, TrendPoint[]>;
  for (const plantId of PLANT_ORDER) {
    const value = components.find((c) => c.plantId === plantId && c.tag === "LV-101")?.metrics.positionPct;
    const previous = (prev?.trends?.[plantId] ?? []).filter((point) => point.time >= now - TREND_WINDOW_MS);
    trends[plantId] = typeof value === "number" ? [...previous, { time: now, value }].slice(-TREND_MAX_POINTS) : previous.slice(-TREND_MAX_POINTS);
  }

  let observation: DemoState["observation"] = null;
  for (const p of plants) {
    const newest = [...(p.proposals ?? [])].sort((x: any, y: any) => String(x.at).localeCompare(String(y.at))).at(-1);
    if (newest?.status === "executed" && !(p.history ?? []).some((e: any) => e.proposalId === newest.id)) {
      observation = { plantId: newest.plantId, proposalId: newest.id, from: num(newest.from), target: num(newest.to), startedAt: ms(newest.at) ?? now };
      break;
    }
  }

  return { now, components, messages, proposals, evidence, audit, trends, paused: prev?.paused ?? false, observation };
}
