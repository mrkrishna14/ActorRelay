// The Relay workspace glue and the agents share. Run this once before starting glue, which reads the key from the file:
//   RELAY_WORKSPACE_KEY="$(cat ~/.actorrelay/relay-workspace-key)"
import { AgentRelay } from "@agent-relay/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const RELAY_URL = process.env.RELAY_URL ?? process.env.RELAY_BASE_URL ?? "http://127.0.0.1:8787";
const KEY_FILE = process.env.RELAY_KEY_FILE ?? join(homedir(), ".actorrelay", "relay-workspace-key");

export async function workspaceKey(): Promise<string> {
  if (process.env.RELAY_WORKSPACE_KEY) return process.env.RELAY_WORKSPACE_KEY;
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  const relay = await AgentRelay.createWorkspace({ name: `actorrelay-${Date.now().toString(36)}`, baseUrl: RELAY_URL });
  if (!relay.workspaceKey) throw new Error("relay returned no workspace key");
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, relay.workspaceKey, { mode: 0o600 });
  return relay.workspaceKey;
}

if (import.meta.main) {
  await workspaceKey();
  console.log(`workspace key file: ${KEY_FILE}`);
  process.exit(0);
}
