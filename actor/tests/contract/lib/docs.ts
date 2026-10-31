// Parsers for the project docs. The tests compare code against what the docs actually say today, so a teammate's
// edit to CLAUDE.MD or TASK*.MD surfaces as a failure instead of the tests quietly restating an old copy.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
export const readRepo = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
export const claudeMd = () => readRepo("CLAUDE.MD");
export const task1 = () => readRepo("TASK1.MD");
export const task2 = () => readRepo("TASK2.MD");
export const task3 = () => readRepo("TASK3.MD");

export type PlantRow = {
  tag: string;
  name: string;
  model: string;
  role: string;
  vendor: string;
  limits: Record<string, { min: number; max: number; critical: number }>;
  infoMetrics: string[];
  upstream: string[];
  downstream: string[];
  sharedResources: string[];
};

export function section(md: string, heading: string): string {
  const start = md.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const body = md.slice(start + heading.length + 2);
  const level = heading.match(/^#+/)![0];
  const next = body.search(new RegExp(`^${level} `, "m"));
  return next < 0 ? body : body.slice(0, next);
}

export function parsePlantTable(md = claudeMd()): PlantRow[] {
  const lines = section(md, "## The plant (both plants identical, same `model` strings)")
    .split("\n")
    .filter((l) => l.startsWith("|"));
  const rows = lines.slice(2); // header and separator
  return rows.map((line) => {
    const cells = line.slice(1, -1).split("|").map((c) => c.trim());
    if (cells.length !== 7) throw new Error(`plant table row has ${cells.length} cells: ${line}`);
    const [tag, name, model, role, vendor, metricsCell, linksCell] = cells as [string, string, string, string, string, string, string];
    const limits: PlantRow["limits"] = {};
    const infoMetrics: string[] = [];
    for (const m of metricsCell.matchAll(/`([^`]+)`/g)) {
      const body = m[1]!;
      const limit = body.match(/^(\w+) \{(-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\}$/);
      if (limit) limits[limit[1]!] = { min: Number(limit[2]), max: Number(limit[3]), critical: Number(limit[4]) };
      else infoMetrics.push(body);
    }
    const links = (key: string) =>
      (linksCell.match(new RegExp(`${key} ([^;]+)`))?.[1] ?? "").split(",").map((s) => s.trim().replace(/`/g, "")).filter(Boolean);
    return {
      tag,
      name,
      model: model.replace(/`/g, ""),
      role,
      vendor,
      limits,
      infoMetrics,
      upstream: links("upstream"),
      downstream: links("downstream"),
      sharedResources: links("sharedResources"),
    };
  });
}

export type MethodList = Record<string, string[]>;

// "`similar(a, b, k=5)`" => { similar: ["a", "b", "k"] }. Bare backticked names give an empty list.
export function parseMethods(line: string): MethodList {
  const out: MethodList = {};
  for (const m of line.matchAll(/`(\w+)(?:\(([^)]*)\))?`/g)) {
    out[m[1]!] = (m[2] ?? "").split(",").map((s) => s.trim().replace(/=.*$/, "")).filter(Boolean);
  }
  return out;
}

export function claudeMethods(md = claudeMd()): Record<"Component" | "Plant" | "Company", MethodList> {
  const body = section(md, "## Actor methods");
  const line = (actor: string) => {
    const l = body.split("\n").find((x) => x.startsWith(`${actor}: `));
    if (!l) throw new Error(`no method line for ${actor}`);
    return l;
  };
  return { Component: parseMethods(line("Component")), Plant: parseMethods(line("Plant")), Company: parseMethods(line("Company")) };
}

export type Route = { method: "GET" | "POST"; path: string; bodyKeys: string[]; caller: string };

export function task3Routes(md = task3()): Route[] {
  const body = md.slice(md.indexOf("## Deliverable 1: HTTP service"), md.indexOf("## Deliverable 2: Relay bridge"));
  const out: Route[] = [];
  for (const line of body.split("\n").filter((l) => l.startsWith("- `"))) {
    const caller = line.match(/←\s*([^→]+)/)?.[1]?.trim() ?? "";
    for (const m of line.matchAll(/`(GET|POST) (\/[^\s`?{]*)(\?[^`]*)?(?: \{([^}]*)\})?`/g)) {
      if (line.slice(0, m.index).endsWith("bridge ")) continue; // an outbound call to the simulator, not a glue route
      out.push({
        method: m[1] as "GET" | "POST",
        path: m[2]!,
        bodyKeys: (m[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        caller,
      });
    }
  }
  return out;
}

export type RelayLine = { type: string; fields: string[]; flow: string };

export function relayProtocol(md = claudeMd()): RelayLine[] {
  const body = section(md, "## Relay protocol");
  const out: RelayLine[] = [];
  for (const line of body.split("\n").filter((l) => l.startsWith("- `"))) {
    const m = line.match(/^- `(\w+) \{([^}]*)\}` ([^.]+)/);
    if (m) out.push({ type: m[1]!, fields: m[2]!.split(",").map((s) => s.trim()), flow: m[3]!.trim() });
  }
  return out;
}

export function relayChannels(md = claudeMd()): string[] {
  const line = section(md, "## Relay protocol").split("\n").find((l) => l.startsWith("Channels:"));
  if (!line) throw new Error("no Channels line");
  return [...line.matchAll(/`([\w-]+)`/g)].map((m) => m[1]!);
}

export function claudeTypesBlock(md = claudeMd()): string {
  const m = md.match(/## Frozen contract: shared\/types\.ts[\s\S]*?```ts\n([\s\S]*?)```/);
  if (!m) throw new Error("no ts block under the frozen contract heading");
  return m[1]!;
}
