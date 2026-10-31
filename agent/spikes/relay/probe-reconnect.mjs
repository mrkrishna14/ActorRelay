// A single identity's stream after a server kill, default backoff against a shorter one, same outage.
// Usage: bun run probe-reconnect.mjs   Env: PROOF_PORT (default 8795), OUTAGE_MS (default 8000), RELAY_RUNTIME_DIR.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRelay } from '@agent-relay/sdk';

const port = Number(process.env.PROOF_PORT ?? 8795);
const outageMs = Number(process.env.OUTAGE_MS ?? 8000);
const baseUrl = `http://127.0.0.1:${port}`;
const runtimeDir = process.env.RELAY_RUNTIME_DIR ?? path.join(os.homedir(), '.actorrelay', 'relay-runtime');
const dataDir = path.join(os.homedir(), '.actorrelay', `reconnect-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
async function startServer() {
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const child = spawn('node', [path.join(runtimeDir, 'node_modules/@relaycast/engine/dist/bin/serve.js'), '--db', path.join(dataDir, 'relaycast.db'), '--port', String(port), '--env', 'development'], { cwd: dataDir, stdio: ['ignore', log, log] });
  server = { child, exited: new Promise((resolve) => child.once('exit', resolve)) };
  const started = performance.now();
  for (;;) {
    if (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false)) return Math.round(performance.now() - started);
    await sleep(25);
  }
}

await startServer();
const admin = await AgentRelay.createWorkspace({ name: 'reconnect', baseUrl });

const open = async (name, options = {}) => {
  const relay = new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl, ...options });
  const client = await relay.workspace.register({ name, type: 'agent' });
  await client.channels.join('general');
  const got = new Map();
  relay.addListener('message.created', ({ message }) => got.set(message.text, performance.now()));
  return { name, relay, client, got };
};

const sender = await open('sender');
const tuned = { agentClientOptions: { ws: { reconnectBaseDelayMs: 250, reconnectMaxDelayMs: 1500 } } };
const streams = [
  await open('default-1'),
  await open('default-2'),
  await open('default-3'),
  await open('tuned-1', tuned),
  await open('tuned-2', tuned),
  await open('tuned-3', tuned),
];
await sleep(2500);

const warm = await sender.client.sendMessage({ to: '#general', text: 'warm' });
await sleep(1500);
console.log(JSON.stringify({ allLiveBeforeKill: streams.every((s) => s.got.has('warm')), warmId: Boolean(warm.messageId) }));

server.child.kill('SIGKILL');
await server.exited;
const killedAt = performance.now();
await sleep(outageMs);
const bootMs = await startServer();
const upAt = performance.now();

const reachedAt = new Map();
for (let i = 0; i < 600 && reachedAt.size < streams.length; i++) {
  const text = `after:${i}`;
  await sender.client.sendMessage({ to: '#general', text }).catch(() => null);
  await sleep(100);
  for (const stream of streams) {
    if (!reachedAt.has(stream.name) && stream.got.has(text)) reachedAt.set(stream.name, Math.round(stream.got.get(text) - upAt));
  }
}
console.log(JSON.stringify({ outageMs, bootMs, downForMs: Math.round(upAt - killedAt) }));
console.log(JSON.stringify({ msAfterServerUpUntilStreamLive: Object.fromEntries(reachedAt) }));
server.child.kill('SIGKILL');
process.exit(0);
