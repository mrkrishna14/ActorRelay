// Which identity names does Relay accept, and does the sender name survive to the receiver unchanged?
// glue/relay.ts requires the sender name `agent:<componentId>`, so that exact form is the one that matters.
import { AgentRelay } from '@agent-relay/sdk';

const baseUrl = process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:8787';
const candidates = ['plant-a-LV-101', 'plant-a/LV-101', 'agent:plant-a/LV-101', 'agent:plant-b/TV-101'];

const admin = await AgentRelay.createWorkspace({ name: `names-${Date.now().toString(36)}`, baseUrl });
const open = async (name, type = 'agent') => {
  const relay = new AgentRelay({ workspaceKey: admin.workspaceKey, baseUrl });
  return { relay, client: await relay.workspace.register({ name, type }) };
};

const system = await open('actorrelay-system', 'system');
await system.client.channels.create({ name: 'plant-a' });
const inbound = [];
system.relay.addListener('message.created', ({ message, envelope }) => inbound.push({ kind: 'message.created', text: message.text, from: envelope.from?.name, fromMessage: message.from?.name }));
system.relay.addListener('dm.received', ({ message, envelope }) => inbound.push({ kind: 'dm.received', text: message.text, from: envelope.from?.name, fromMessage: message.from?.name }));
await new Promise((resolve) => setTimeout(resolve, 1000));

for (const name of candidates) {
  const row = { name };
  try {
    const agent = await open(name);
    row.register = 'accepted';
    row.storedName = agent.client.name;
    await agent.client.channels.join('plant-a');
    await agent.client.sendMessage({ to: '#plant-a', text: `hello from ${name}` });
    row.channelPost = 'accepted';
    row.dmToSystem = await agent.client
      .sendMessage({ to: '@actorrelay-system', text: `dm from ${name}` })
      .then(() => 'accepted', (error) => `rejected ${error.code ?? error.message}`);
    row.dmFromSystem = await system.client
      .sendMessage({ to: `@${name}`, text: `dm to ${name}` })
      .then(() => 'accepted', (error) => `rejected ${error.code ?? error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const seen = inbound.find((entry) => entry.text === `hello from ${name}`);
    row.senderAsSeenByReceiver = seen ? { envelope: seen.from, message: seen.fromMessage } : 'not received';
  } catch (error) {
    row.error = `${error.code ?? ''} ${error.message}`.trim();
  }
  console.log(JSON.stringify(row));
}
process.exit(0);
