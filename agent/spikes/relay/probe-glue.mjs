// Drives the REAL glue/ code on port 7200 in WSL against the REAL Relay server.
// The only stand-in is the actor port (probe-actor-port.mjs), because Terse is not installed yet.
// Run with Bun inside WSL. Env: GLUE_DIR (a Linux-filesystem copy of glue/), PROBE_DIR, RELAY_BASE_URL.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AgentRelay } from '@agent-relay/sdk';

const relayUrl = process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:8787';
const glueDir = process.env.GLUE_DIR;
const probeDir = process.env.PROBE_DIR;
const gluePort = Number(process.env.GLUE_PORT ?? 7200);
const glueUrl = `http://127.0.0.1:${gluePort}`;
const holdMs = Number(process.env.PROBE_HOLD_MS ?? 0);
const actorLog = path.join(probeDir, 'actor-calls.jsonl');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
const actorCalls = () => (fs.existsSync(actorLog) ? fs.readFileSync(actorLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

fs.rmSync(actorLog, { force: true });
fs.rmSync(path.join(probeDir, 'glue.sqlite'), { force: true });
fs.copyFileSync(new URL('./probe-actor-port.mjs', import.meta.url), path.join(probeDir, 'probe-actor-port.mjs'));

const workspace = await AgentRelay.createWorkspace({ name: `glue-probe-${Date.now().toString(36)}`, baseUrl: relayUrl });

const glueLog = fs.openSync(path.join(probeDir, 'glue.log'), 'w');
const glue = spawn('bun', ['run', 'server.ts'], {
  cwd: glueDir,
  stdio: ['ignore', glueLog, glueLog],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GLUE_MODE: 'live',
    HOST: '127.0.0.1',
    PORT: String(gluePort),
    RELAY_WORKSPACE_KEY: workspace.workspaceKey,
    RELAY_BASE_URL: relayUrl,
    RELAY_SYSTEM_NAME: 'actorrelay-system',
    ACTOR_CLIENT_MODULE: path.join(probeDir, 'probe-actor-port.mjs'),
    PROBE_ACTOR_LOG: actorLog,
    GLUE_JOURNAL_PATH: path.join(probeDir, 'glue.sqlite'),
    BRIDGE_PUSHES_MIRROR: '1',
    EXECUTION_CALLBACK_TOKEN: 'probe-only',
    SIM_URL: 'http://127.0.0.1:7300',
  },
});

const stop = () => {
  try {
    glue.kill('SIGKILL');
  } catch {
    // Already gone.
  }
};
process.on('exit', stop);

let health = null;
const healthStart = performance.now();
for (let i = 0; i < 400; i++) {
  health = await fetch(`${glueUrl}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).catch(() => null);
  if (health?.integrations?.relay) break;
  await sleep(100);
}
check('agent side in WSL reaches real glue /health on 7200', Boolean(health), {
  mode: health?.mode,
  waitedMs: Math.round(performance.now() - healthStart),
});
check('real glue connected to Relay as its system participant', health?.integrations?.relay === true, health?.integrations);

const openAgent = async (name) => {
  const relay = new AgentRelay({ workspaceKey: workspace.workspaceKey, baseUrl: relayUrl });
  const client = await relay.workspace.register({ name, type: 'agent' });
  await client.channels.join('plant-a');
  return { relay, client, inbox: [] };
};
const valve = await openAgent('agent:plant-a/LV-101');
const tank = await openAgent('agent:plant-a/TK-101');
valve.relay.addListener('message.created', ({ message, envelope }) => {
  valve.inbox.push({ at: performance.now(), text: message.text, from: envelope.from?.name });
});
await sleep(1500);

const proposeAt = performance.now();
const proposed = await fetch(`${glueUrl}/propose`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ plantId: 'plant-a', proposerComponentId: 'plant-a/P-100', metric: 'speedPct', to: 85, rationale: 'probe' }),
});
const proposedBody = await proposed.json().catch(() => null);
check('POST /propose on real glue returns 200', proposed.status === 200, { status: proposed.status });

for (let i = 0; i < 100 && valve.inbox.length === 0; i++) await sleep(50);
const published = valve.inbox[0];
const envelope = published ? JSON.parse(published.text) : null;
check('glue published the proposal to #plant-a and an agent received it', envelope?.type === 'proposal', {
  from: published?.from,
  topLevelKeys: envelope ? Object.keys(envelope) : null,
  payloadKeys: envelope?.payload ? Object.keys(envelope.payload) : null,
  msFromPost: published ? Math.round(published.at - proposeAt) : null,
});

const proposalId = proposedBody?.proposal?.id ?? proposedBody?.id;
const vote = (componentId, agentId) => ({
  proposalId,
  componentId,
  agentId,
  vote: 'no',
  reason: 'probe',
  predicted: { positionPct: 89 },
  marginPct: 10,
  evidenceEventIds: [],
  evidenceRuleIds: [],
  similarCount: 3,
});

await valve.client.sendMessage({
  to: '#plant-a',
  text: JSON.stringify({ type: 'vote', payload: { vote: vote('plant-a/LV-101', 'agent:plant-a/LV-101') } }),
});
await sleep(1500);
const forwarded = actorCalls().filter((call) => call.method === 'vote');
check('vote posted on Relay by agent:plant-a/LV-101 reached the actor port through glue', forwarded.length === 1, {
  forwarded: forwarded.map((call) => ({ id: call.id, agentId: call.args[0]?.agentId })),
});

await tank.client.sendMessage({
  to: '#plant-a',
  text: JSON.stringify({ type: 'vote', payload: { vote: vote('plant-a/E-101', 'agent:plant-a/E-101') } }),
});
await sleep(1500);
const afterForgery = actorCalls().filter((call) => call.method === 'vote');
check('a vote sent by the wrong identity is refused by glue', afterForgery.length === 1, { voteCalls: afterForgery.length });

// agent/schemas.ts posts `{type, vote}` with no payload wrapper. A fresh vote, so dedupe cannot hide the result.
const flat = { type: 'vote', vote: vote('plant-a/TK-101', 'agent:plant-a/TK-101') };
await tank.client.sendMessage({ to: '#plant-a', text: JSON.stringify(flat) });
await sleep(1500);
const flatForwarded = actorCalls().filter((call) => call.method === 'vote' && call.args[0]?.componentId === 'plant-a/TK-101');
console.log(`NOTE flat {type,vote} wire shape reached the actor port: ${flatForwarded.length === 1}`);

if (holdMs > 0) {
  console.log(`HOLD glue stays up on ${gluePort} for ${holdMs}ms`);
  await sleep(holdMs);
}
stop();
const passed = results.filter((r) => r.pass).length;
console.log(`${passed} passed, ${results.length - passed} failed`);
console.log('--- glue.log tail');
console.log(fs.readFileSync(path.join(probeDir, 'glue.log'), 'utf8').split('\n').slice(-12).join('\n').slice(0, 1500));
process.exit(results.length === passed ? 0 : 1);
