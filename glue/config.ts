// Every setting glue reads. Run it in WSL beside Terse, Relay and the bridge: WSL cannot reach services on Windows.
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const trimSlash = (url: string) => url.replace(/\/+$/, "");
const number = (value: string | undefined, fallback: number) => (value === undefined || value === "" ? fallback : Number(value));

export const PLANT_IDS = ["plant-a", "plant-b"] as const;
export const CHANNELS = ["plant-a", "plant-b", "company"] as const;
export const COMPANY_ACTOR_ID = "company";

export type GlueConfig = {
  host: string;
  port: number;
  terseUrl: string;
  bridgeUrl: string;
  relayUrl: string;
  systemName: string;
  relayKeyFile: string;
  relayTokenFile: string;
  repoRoot: string;
  wakeMs: number;
  allowedOrigins: string[];
};

export function loadConfig(): GlueConfig {
  return {
    // 127.0.0.1 exactly: a Windows browser reaches a WSL service on that address only with this bind.
    host: env.GLUE_HOST ?? "127.0.0.1",
    port: number(env.GLUE_PORT ?? env.PORT, 7200),
    terseUrl: trimSlash(env.TERSE_URL ?? env.DURABLE_ACTORS_CONTROL_PLANE_URL ?? "http://127.0.0.1:7100"),
    bridgeUrl: trimSlash(env.BRIDGE_URL ?? "http://127.0.0.1:7300"),
    relayUrl: trimSlash(env.RELAY_URL ?? env.RELAY_BASE_URL ?? "http://127.0.0.1:8787"),
    systemName: env.RELAY_SYSTEM_NAME ?? "actorrelay-system",
    relayKeyFile: env.RELAY_KEY_FILE ?? join(homedir(), ".actorrelay", "relay-workspace-key"),
    relayTokenFile: env.RELAY_SYSTEM_TOKEN_FILE ?? join(import.meta.dir, ".relay-system.json"),
    repoRoot: env.GLUE_REPO_ROOT ?? join(import.meta.dir, ".."),
    wakeMs: number(env.GLUE_WAKE_MS, 1000),
    allowedOrigins: (env.GLUE_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  };
}
