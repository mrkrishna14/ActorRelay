// Fast check of one send, one reply and the shape of the events the SDK hands back.
import { AgentRelay } from '@agent-relay/sdk';

const baseUrl = process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:8787';
const stamp = Date.now().toString(36);

const admin = await AgentRelay.createWorkspace({ name: `smoke-${stamp}`, baseUrl });
console.log('workspace ok', { runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}` });

const openClient = async (name, type) => {
  const relay = new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl });
  const client = await relay.workspace.register({ name, type });
  return { relay, client };
};

const a = await openClient('plant-a-P-100', 'agent');
const b = await openClient('plant-a-LV-101', 'agent');
const sys = await openClient('actorrelay-system', 'system');
console.log('registered', a.client.name, a.client.handle, 'token?', Boolean(a.client.token), a.client.id);

await sys.client.channels.create({ name: 'plant-a', topic: 'plant-a proposals and votes' });
await a.client.channels.join('plant-a');
await b.client.channels.join('plant-a');

const log = (who) => (event) => {
  const { type, message, envelope } = event;
  console.log(who, type, JSON.stringify({ text: message?.text, id: message?.messageId, thread: message?.threadId, parent: envelope?.parent, channel: envelope?.channel, from: envelope?.from?.handle }));
};
for (const [who, side] of [['A', a], ['B', b], ['S', sys]]) {
  side.relay.addListener('*', (event) => {
    if (['agent.online', 'agent.offline', 'connected', 'member.joined'].includes(event.type)) return;
    log(who)(event);
  });
}
await new Promise((r) => setTimeout(r, 1500));

const sent = await a.client.sendMessage({ to: '#plant-a', text: 'hello from P-100' });
console.log('sent', JSON.stringify(sent));
await new Promise((r) => setTimeout(r, 500));
const replied = await b.client.reply({ messageId: sent.messageId, text: 'reply from LV-101' });
console.log('replied', JSON.stringify(replied));
await new Promise((r) => setTimeout(r, 1000));

let conflict = null;
try {
  await new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl }).workspace.register({ name: 'plant-a-P-100', type: 'agent' });
} catch (error) {
  conflict = { name: error?.name, code: error?.code, status: error?.status, message: error?.message };
}
console.log('re-register', conflict);
process.exit(0);
