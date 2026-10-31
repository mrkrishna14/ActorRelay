// agent/spawn.ts holds all ten identities on ONE AgentRelay with one listener. proof.mjs uses one per identity.
// This checks that shape on a private server across a SIGKILL: one copy of each message, and recovery unaided.
// Usage: bun run probe-shared.mjs   Env: PROOF_PORT (default 8794), PROOF_DATA_ROOT, RELAY_RUNTIME_DIR.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRelay } from '@agent-relay/sdk';

const port = Number(process.env.PROOF_PORT ?? 8794);
const baseUrl = `http://127.0.0.1:${port}`;
const runtimeDir = process.env.RELAY_RUNTIME_DIR ?? path.join(os.homedir(), '.actorrelay', 'relay-runtime');
const dataDir = path.join(process.env.PROOF_DATA_ROOT ?? path.join(os.homedir(), '.actorrelay'), `shared-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
const results = [];
const check = (name, pass, detail) => {
  results.push(Boolean(pass));
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};

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
const admin = await AgentRelay.createWorkspace({ name: 'shared-listener', baseUrl });

const sender = new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl });
const system = await sender.workspace.register({ name: 'actorrelay-system', type: 'system' });
await system.channels.create({ name: 'plant-a' });
await system.channels.create({ name: 'company' });

const shared = new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl });
const names = ['plant-a', 'plant-b'].flatMap((plant) => ['P-100', 'TK-101', 'LV-101', 'E-101', 'TV-101'].map((tag) => `agent:${plant}/${tag}`));
const agents = [];
for (const name of names) {
  const client = await shared.workspace.register({ name, type: 'agent' });
  await client.channels.join('plant-a');
  await client.channels.join('company');
  agents.push(client);
}

const seen = new Map();
shared.addListener('message.created', ({ message }) => seen.set(message.messageId, { text: message.text, copies: (seen.get(message.messageId)?.copies ?? 0) + 1 }));

const sendRound = async (label, count) => {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const posted = await system.sendMessage({ to: '#plant-a', text: `${label}:${i}` });
    ids.push(posted.messageId);
  }
  return ids;
};
const report = (ids) => ({
  sent: ids.length,
  received: ids.filter((id) => seen.has(id)).length,
  extraCopies: ids.reduce((sum, id) => sum + Math.max(0, (seen.get(id)?.copies ?? 0) - 1), 0),
});

await sleep(1500);
const before = await sendRound('before', 20);
await sleep(1500);
const beforeReport = report(before);
check('shared listener: 20 messages, one copy each, across 10 identities in the channel', beforeReport.received === 20 && beforeReport.extraCopies === 0, beforeReport);

const killedAt = performance.now();
server.child.kill('SIGKILL');
await server.exited;
const bootMs = await startServer();

const recovery = performance.now();
let recoveredAfterMs = null;
for (let i = 0; i < 600 && recoveredAfterMs === null; i++) {
  const probe = await system.sendMessage({ to: '#company', text: `probe:${i}` }).catch(() => null);
  await sleep(100);
  if (probe && seen.has(probe.messageId)) recoveredAfterMs = Math.round(performance.now() - recovery);
}
check('shared listener: first message after SIGKILL arrives unaided', recoveredAfterMs !== null, { bootMs, recoveredAfterMs, totalOutageMs: Math.round(performance.now() - killedAt) });

await sleep(15_000);
const after = await sendRound('after', 20);
await sleep(2000);
const afterReport = report(after);
check('shared listener: 20 messages after restart, one copy each', afterReport.received === 20 && afterReport.extraCopies === 0, afterReport);
const earlier = report(before);
check('shared listener: no replayed copy of pre-restart messages', earlier.extraCopies === 0, earlier);

server.child.kill('SIGKILL');
console.log(`${results.filter(Boolean).length} passed, ${results.filter((r) => !r).length} failed`);
process.exit(results.every(Boolean) ? 0 : 1);
