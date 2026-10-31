// Does one post get slower as a channel gains members? Uses the shared Relay server in a throwaway workspace.
// Usage: bun run probe-fanout.mjs   Env: RELAY_BASE_URL.
import { AgentRelay } from '@agent-relay/sdk';

const baseUrl = process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:8787';
const admin = await AgentRelay.createWorkspace({ name: `fanout-${Date.now().toString(36)}`, baseUrl });
const open = async (name) => {
  const relay = new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl });
  return { relay, client: await relay.workspace.register({ name, type: 'agent' }), name };
};

const sender = await open('sender');
const pool = [];
for (let i = 0; i < 10; i++) pool.push(await open(`member-${i}`));

const pct = (samples, q) => [...samples].sort((a, b) => a - b)[Math.floor(q * samples.length)];
const fmt = (samples) => ({ p50: Math.round(pct(samples, 0.5)), p95: Math.round(pct(samples, 0.95)) });

const order = (process.env.FANOUT_ORDER ?? '10,5,1,5,10').split(',').map(Number);
for (const [round, memberCount] of order.entries()) {
  const channel = `fan-${round}-${memberCount}`;
  await sender.client.channels.create({ name: channel });
  const members = pool.slice(0, memberCount);
  const arrivals = new Map();
  const unsubscribe = [];
  for (const member of members) {
    await member.client.channels.join(channel);
    unsubscribe.push(
      member.relay.addListener('message.created', ({ message }) => {
        if (arrivals.has(message.text)) arrivals.get(message.text).push(performance.now());
      }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const ack = [];
  const allArrived = [];
  for (let i = 0; i < 50; i++) {
    const text = `${channel}:${i}`;
    arrivals.set(text, []);
    const start = performance.now();
    await sender.client.sendMessage({ to: `#${channel}`, text });
    ack.push(performance.now() - start);
    for (let wait = 0; wait < 2000 && arrivals.get(text).length < memberCount; wait++) await new Promise((resolve) => setTimeout(resolve, 1));
    allArrived.push(Math.max(...arrivals.get(text)) - start);
  }
  for (const off of unsubscribe) off();
  console.log(JSON.stringify({ members: memberCount, sendAckMs: fmt(ack), allMembersReceivedMs: fmt(allArrived) }));
}
process.exit(0);
