// A fresh process that resumes one identity from its persisted token, then proves it can talk.
import { AgentRelay } from '@agent-relay/sdk';
import { loadState } from './relay-lib.mjs';

const baseUrl = process.env.RELAY_BASE_URL;
const name = process.env.RELAY_IDENTITY;
const state = loadState(process.env.RELAY_STATE_PATH);

const relay = new AgentRelay({ workspaceKey: state.workspaceKey, baseUrl });
const registerResult = await relay.workspace.register({ name, type: 'agent' }).then(
  () => 'registered',
  (error) => error?.code ?? error?.message,
);
const client = await relay.workspace.reconnect({ apiToken: state.tokens[name] });

const nonce = `${Date.now()}`;
const gotReply = new Promise((resolve) => {
  relay.addListener('thread.reply', ({ message }) => {
    if (message.text === `child-ack:${nonce}`) resolve(true);
  });
  setTimeout(() => resolve(false), 6000);
});

await new Promise((resolve) => setTimeout(resolve, 800));
await client.sendMessage({ to: '#company', text: `child-hello:${nonce}` });
console.log(JSON.stringify({ registerResult, id: client.id, name: client.name, gotReply: await gotReply }));
process.exit(0);
