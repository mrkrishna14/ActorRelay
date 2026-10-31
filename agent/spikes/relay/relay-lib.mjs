// Small identity layer over @agent-relay/sdk: one workspace, one persisted token per identity.
import fs from 'node:fs';
import path from 'node:path';
import { AgentRelay } from '@agent-relay/sdk';

export const PLANTS = ['plant-a', 'plant-b'];
export const TAGS = ['P-100', 'TK-101', 'LV-101', 'E-101', 'TV-101'];
export const SYSTEM_NAME = 'actorrelay-system';

// ComponentId is `plant-a/LV-101`. Relay names stay flat, so the slash becomes a dash.
export const agentNameFor = (componentId) => componentId.replace('/', '-');
export const componentIds = () => PLANTS.flatMap((plant) => TAGS.map((tag) => `${plant}/${tag}`));

export function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { workspaceKey: null, tokens: {} };
    throw error;
  }
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, statePath);
}

export async function openWorkspace({ baseUrl, statePath, name = 'actorrelay' }) {
  const state = loadState(statePath);
  if (!state.workspaceKey) {
    const relay = await AgentRelay.createWorkspace({ name, baseUrl });
    state.workspaceKey = relay.workspaceKey;
    state.tokens = {};
    saveState(statePath, state);
  }
  return state;
}

// `register` is create-only and rejects an existing name, so a saved token always wins.
export async function openIdentity({ baseUrl, statePath, state, name, type = 'agent', onError }) {
  const relay = new AgentRelay({ workspaceKey: state.workspaceKey, baseUrl, onError });
  const saved = state.tokens[name];
  if (saved) return { name, relay, client: await relay.workspace.reconnect({ apiToken: saved }) };

  const client = await relay.workspace.register({ name, type });
  state.tokens[name] = client.token;
  saveState(statePath, state);
  return { name, relay, client };
}

export async function ensureChannel(client, channel, topic) {
  try {
    await client.channels.create({ name: channel, topic });
  } catch (error) {
    if (error?.status !== 409) throw error;
  }
  await client.channels.join(channel);
}
