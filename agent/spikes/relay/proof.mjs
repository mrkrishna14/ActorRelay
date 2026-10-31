// Runnable proof of Agent Relay 15.0.1 against a real local server. Nothing here is mocked.
// It spawns a private server on PROOF_PORT (default 8788) so the shared server on 8787 stays untouched.
// Usage: node proof.mjs [--only=core,latency,ordering,restart,midflight,offline,idempotency]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AgentRelay } from '@agent-relay/sdk';
import {
  PLANTS,
  SYSTEM_NAME,
  agentNameFor,
  componentIds,
  ensureChannel,
  openIdentity,
  openWorkspace,
  loadState,
} from './relay-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PROOF_PORT ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RUNTIME_DIR = process.env.RELAY_RUNTIME_DIR ?? path.join(os.homedir(), '.actorrelay', 'relay-runtime');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const DATA_ROOT = process.env.PROOF_DATA_ROOT ?? path.join(os.homedir(), '.actorrelay');
const DATA_DIR = path.join(DATA_ROOT, `proof-${RUN_ID}`);
const STATE_PATH = path.join(DATA_DIR, 'identities.json');
const RESULTS_DIR = path.join(HERE, 'results');

const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
const enabled = (section) => !only || only.has(section);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const report = {
  runId: RUN_ID,
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
  platform: process.platform,
  dataRoot: DATA_ROOT,
  sdk: JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules/@agent-relay/sdk/package.json'))).version,
  engine: JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'node_modules/@relaycast/engine/package.json'))).version,
  observations: {},
};

function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

function observe(name, detail) {
  report.observations[name] = detail;
  console.log(`NOTE ${name} ${JSON.stringify(detail)}`);
}

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (value) => Math.round(value * 10) / 10;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

// --- server lifecycle ------------------------------------------------------

let server = null;
const serverLog = () => path.join(DATA_DIR, 'server.log');

async function startServer() {
  const log = fs.openSync(serverLog(), 'a');
  const started = performance.now();
  // Always Node: the server needs better-sqlite3, which Bun cannot load.
  const child = spawn(
    'node',
    [
      path.join(RUNTIME_DIR, 'node_modules/@relaycast/engine/dist/bin/serve.js'),
      '--db',
      path.join(DATA_DIR, 'relaycast.db'),
      '--port',
      String(PORT),
      '--env',
      'development',
    ],
    { cwd: DATA_DIR, stdio: ['ignore', log, log] },
  );
  server = { child, exited: new Promise((resolve) => child.once('exit', resolve)) };
  for (;;) {
    try {
      const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null) throw new Error(`server exited early, see ${serverLog()}`);
    if (performance.now() - started > 60_000) throw new Error('server did not start within 60s');
    await sleep(20);
  }
  return Math.round(performance.now() - started);
}

// SIGTERM closes the database, then waits forever on open WebSockets, so it needs a fallback.
async function stopServer(signal, graceMs = 4000) {
  const started = performance.now();
  server.child.kill(signal);
  const exited = await Promise.race([server.exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!exited) {
    server.child.kill('SIGKILL');
    await server.exited;
  }
  server = null;
  return { exitedOnSignal: exited, ms: Math.round(performance.now() - started) };
}

// --- participants ----------------------------------------------------------

const quietEvents = new Set(['message.read', 'message.reacted']);

function attach(participant) {
  participant.seen = [];
  participant.waiters = new Set();
  const record = (kind) => (event) => {
    const message = event.message ?? {};
    const entry = {
      at: performance.now(),
      kind,
      messageId: message.messageId,
      threadId: message.threadId ?? null,
      parentId: event.envelope?.parent ?? null,
      text: message.text ?? '',
      channel: event.envelope?.channel?.name ?? null,
      from: event.envelope?.from?.handle ?? event.envelope?.from?.name ?? null,
    };
    participant.seen.push(entry);
    for (const waiter of [...participant.waiters]) waiter(entry);
  };
  participant.unsubscribers = [
    participant.relay.addListener('message.created', record('message.created')),
    participant.relay.addListener('thread.reply', record('thread.reply')),
    participant.relay.addListener('dm.received', record('dm.received')),
  ];
  void quietEvents;
}

function waitFor(participant, predicate, timeoutMs = 5000) {
  const existing = participant.seen.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      participant.waiters.delete(waiter);
      reject(new Error(`timeout waiting on ${participant.name}`));
    }, timeoutMs);
    const waiter = (entry) => {
      if (!predicate(entry)) return;
      clearTimeout(timer);
      participant.waiters.delete(waiter);
      resolve(entry);
    };
    participant.waiters.add(waiter);
  });
}

const receivedText = (participant, text) => participant.seen.filter((entry) => entry.text === text);

// Listeners connect lazily, so a sentinel on `company` tells us every stream is really live.
async function waitForStreams(sender, participants, label, timeoutMs = 20_000) {
  const started = performance.now();
  // A sender never receives its own channel post.
  const pending = new Set(participants.filter((participant) => participant !== sender));
  let attempt = 0;
  while (pending.size > 0) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`streams not live after ${timeoutMs}ms: ${[...pending].map((p) => p.name).join(', ')}`);
    }
    const text = `${label}:sentinel:${attempt++}`;
    try {
      await sender.client.sendMessage({ to: '#company', text });
    } catch {
      await sleep(100);
      continue;
    }
    await sleep(150);
    for (const participant of [...pending]) {
      if (receivedText(participant, text).length > 0) pending.delete(participant);
    }
  }
  return Math.round(performance.now() - started);
}

async function openEveryone(state) {
  const identities = [
    ...componentIds().map((id) => ({ name: agentNameFor(id), type: 'agent' })),
    { name: SYSTEM_NAME, type: 'system' },
  ];
  const participants = new Map();
  for (const { name, type } of identities) {
    const participant = await openIdentity({ baseUrl: BASE_URL, statePath: STATE_PATH, state, name, type });
    attach(participant);
    participants.set(name, participant);
  }
  return participants;
}

async function closeEveryone(participants) {
  await Promise.allSettled(
    [...participants.values()].map(async (participant) => {
      for (const off of participant.unsubscribers ?? []) off();
      await participant.relay.events.disconnect();
    }),
  );
}

function buildRoster(participants) {
  const members = (plant) => componentIds().filter((id) => id.startsWith(`${plant}/`)).map(agentNameFor);
  return {
    system: participants.get(SYSTEM_NAME),
    plant: Object.fromEntries(PLANTS.map((plant) => [plant, members(plant).map((name) => participants.get(name))])),
    all: [...participants.values()],
    named: (name) => participants.get(name),
  };
}

async function joinChannels(roster) {
  const { system, plant, all } = roster;
  await ensureChannel(system.client, 'plant-a', 'plant-a proposals and votes');
  await ensureChannel(system.client, 'plant-b', 'plant-b proposals and votes');
  await ensureChannel(system.client, 'company', 'cross-plant votes, rules and executed broadcasts');
  for (const name of PLANTS) {
    for (const participant of plant[name]) await participant.client.channels.join(name);
  }
  for (const participant of all) {
    if (participant !== system) await participant.client.channels.join('company');
  }
}

// --- sections --------------------------------------------------------------

async function sectionCore(roster) {
  const { system, plant, all, named } = roster;
  const pumpA = named('plant-a-P-100');
  const valveA = named('plant-a-LV-101');
  const pumpB = named('plant-b-P-100');

  check('11 identities registered with distinct ids', new Set(all.map((p) => p.client.id)).size === 11, {
    names: all.map((p) => p.client.name),
    types: 'agent x10, system x1',
  });

  const channelList = await system.client.channels.list();
  const channelNames = channelList.map((channel) => channel.name);
  check('channels plant-a, plant-b, company exist', ['plant-a', 'plant-b', 'company'].every((c) => channelNames.includes(c)), {
    channelNames,
  });

  const nonce = `core-${Date.now()}`;
  const aText = `${nonce}:plant-a`;
  await pumpA.client.sendMessage({ to: '#plant-a', text: aText });
  await sleep(600);
  const plantAOthers = [...plant['plant-a'], system].filter((p) => p !== pumpA);
  const plantAReceivers = plantAOthers.filter((p) => receivedText(p, aText).length === 1).map((p) => p.name);
  const plantBLeaks = plant['plant-b'].filter((p) => receivedText(p, aText).length > 0).map((p) => p.name);
  check('plant-a message reaches its 5 other members exactly once', plantAReceivers.length === plantAOthers.length, { plantAReceivers });
  check('plant-a message does not reach plant-b agents', plantBLeaks.length === 0, { plantBLeaks });
  observe('sender sees own channel post', receivedText(pumpA, aText).length > 0);

  const bText = `${nonce}:plant-b`;
  await pumpB.client.sendMessage({ to: '#plant-b', text: bText });
  await sleep(600);
  const plantBOthers = [...plant['plant-b'], system].filter((p) => p !== pumpB);
  check(
    'plant-b message reaches its 5 other members and not plant-a',
    plantBOthers.every((p) => receivedText(p, bText).length === 1) &&
      plant['plant-a'].every((p) => receivedText(p, bText).length === 0),
  );

  const companyText = `${nonce}:company`;
  await system.client.sendMessage({ to: '#company', text: companyText });
  await sleep(600);
  const companyOthers = all.filter((p) => p !== system);
  check('company message reaches the other 10 exactly once', companyOthers.every((p) => receivedText(p, companyText).length === 1), {
    received: companyOthers.filter((p) => receivedText(p, companyText).length === 1).length,
  });

  const question = `${nonce}:proposal`;
  const sent = await pumpA.client.sendMessage({ to: '#plant-a', text: question });
  const replyText = `${nonce}:vote`;
  await valveA.client.reply({ messageId: sent.messageId, text: replyText });
  const reply = await waitFor(pumpA, (entry) => entry.text === replyText, 5000).catch(() => null);
  check('reply reaches the original sender', Boolean(reply), reply && { kind: reply.kind, threadId: reply.threadId, parentId: reply.parentId, from: reply.from });
  await sleep(500);
  observe(
    'who else sees a thread reply',
    all.filter((p) => receivedText(p, replyText).length > 0).map((p) => `${p.name}:${receivedText(p, replyText).map((e) => e.kind).join('+')}`),
  );

  const directText = `${nonce}:dm`;
  await system.client.sendMessage({ to: `@${valveA.name}`, text: directText });
  const direct = await waitFor(valveA, (entry) => entry.text === directText, 5000).catch(() => null);
  check('direct message reaches its target', Boolean(direct), direct && { kind: direct.kind });

  const slashRelay = new AgentRelay({ workspaceKey: loadState(STATE_PATH).workspaceKey, baseUrl: BASE_URL });
  const slashClient = await slashRelay.workspace.register({ name: 'plant-a/LV-101', type: 'agent' }).catch((error) => error);
  if (slashClient instanceof Error) {
    observe('agent name containing a slash', `rejected ${slashClient.code ?? slashClient.message}`);
    return;
  }
  const slashDm = await system.client
    .sendMessage({ to: '@plant-a/LV-101', text: `${nonce}:slash` })
    .then(() => 'dm accepted', (error) => `dm rejected ${error?.code ?? error?.message}`);
  observe('agent name containing a slash', { register: 'accepted', dm: slashDm });
}

async function sectionLatency(roster) {
  const { named, plant, system } = roster;
  const sender = named('plant-a-P-100');
  const responder = named('plant-a-LV-101');
  const N = 100;

  const respond = (entry) => {
    if (entry.kind === 'message.created' && entry.text.startsWith('rtt:')) {
      void responder.client.reply({ messageId: entry.messageId, text: entry.text.replace('rtt:', 'pong:') });
    }
  };
  responder.waiters.add(respond);

  const roundTrip = [];
  const ack = [];
  const oneWay = [];
  for (let i = 0; i < N; i++) {
    const text = `rtt:${i}`;
    const pong = text.replace('rtt:', 'pong:');
    const delivered = waitFor(responder, (entry) => entry.text === text, 10_000);
    const replied = waitFor(sender, (entry) => entry.text === pong, 10_000);
    const start = performance.now();
    await sender.client.sendMessage({ to: '#plant-a', text });
    ack.push(performance.now() - start);
    const [deliveredEntry, repliedEntry] = await Promise.all([delivered, replied]);
    oneWay.push(deliveredEntry.at - start);
    roundTrip.push(repliedEntry.at - start);
  }
  responder.waiters.delete(respond);
  report.latencyMs = { send_ack: percentiles(ack), channel_one_way: percentiles(oneWay), round_trip_via_reply: percentiles(roundTrip) };
  check('100 round trips completed', roundTrip.length === N, report.latencyMs);

  const voters = plant['plant-a'];
  const voteRound = [];
  for (let round = 0; round < 20; round++) {
    const text = `vote-round:${round}`;
    const answered = voters.map((voter, index) =>
      waitFor(system, (entry) => entry.text === `vote:${round}:${index}`, 10_000),
    );
    const handlers = voters.map((voter, index) => {
      const handler = (entry) => {
        if (entry.text === text) void voter.client.reply({ messageId: entry.messageId, text: `vote:${round}:${index}` });
      };
      voter.waiters.add(handler);
      return [voter, handler];
    });
    const start = performance.now();
    await system.client.sendMessage({ to: '#plant-a', text });
    await Promise.all(answered);
    voteRound.push(performance.now() - start);
    for (const [voter, handler] of handlers) voter.waiters.delete(handler);
  }
  report.latencyMs.five_voter_round = percentiles(voteRound);
  check('20 rounds of proposal plus 5 replies completed', voteRound.length === 20, report.latencyMs.five_voter_round);
}

async function sectionOrdering(roster) {
  const { named, plant, all, system } = roster;
  const sender = named('plant-a-P-100');
  const receivers = all.filter((p) => p !== sender);
  const textsOf = (participant, prefix) => participant.seen.filter((e) => e.text.startsWith(prefix)).map((e) => e.text);

  const sequentialPrefix = `seq-${Date.now()}:`;
  const expected = [];
  for (let i = 0; i < 200; i++) {
    const text = `${sequentialPrefix}${i}`;
    expected.push(text);
    await sender.client.sendMessage({ to: '#company', text });
  }
  await sleep(1500);
  const sequentialBad = receivers
    .filter((p) => JSON.stringify(textsOf(p, sequentialPrefix)) !== JSON.stringify(expected))
    .map((p) => ({ name: p.name, got: textsOf(p, sequentialPrefix).length }));
  check('200 awaited sends arrive in order, once, at all 10 other members', sequentialBad.length === 0, { sequentialBad });

  const burstPrefix = `burst-${Date.now()}:`;
  const burst = await Promise.allSettled(
    Array.from({ length: 100 }, (_, i) => sender.client.sendMessage({ to: '#company', text: `${burstPrefix}${i}` })),
  );
  const burstFailed = burst.filter((r) => r.status === 'rejected');
  await sleep(1500);
  const orders = receivers.map((p) => JSON.stringify(textsOf(p, burstPrefix)));
  const distinctOrders = new Set(orders).size;
  const reference = JSON.parse(orders[0]);
  const history = await system.client.messages.list?.('company', { limit: 100 }).catch(() => null);
  const historyOrder = history
    ?.filter((message) => message.text?.startsWith(burstPrefix))
    .map((message) => message.text);
  const canonical = historyOrder ? [...historyOrder] : null;
  const matchesAscending = canonical && JSON.stringify(canonical) === JSON.stringify(reference);
  const matchesDescending = canonical && JSON.stringify([...canonical].reverse()) === JSON.stringify(reference);
  check('100 concurrent sends: all receivers agree on one order, no loss', distinctOrders === 1 && reference.length === 100 - burstFailed.length, {
    distinctOrders,
    received: reference.length,
    rejected: burstFailed.length,
    firstError: burstFailed[0]?.reason?.code ?? burstFailed[0]?.reason?.message,
  });
  observe('concurrent burst vs history order', { available: Boolean(canonical), matchesAscending, matchesDescending });

  const mixPrefix = `mix-${Date.now()}:`;
  const senders = [named('plant-a-LV-101'), named('plant-b-LV-101'), named('plant-a-TV-101')];
  await Promise.all(
    senders.map(async (who, senderIndex) => {
      for (let i = 0; i < 50; i++) await who.client.sendMessage({ to: '#company', text: `${mixPrefix}${senderIndex}:${i}` });
    }),
  );
  await sleep(1500);
  const mixReceivers = all.filter((p) => !senders.includes(p));
  const mixOrders = mixReceivers.map((p) => JSON.stringify(textsOf(p, mixPrefix)));
  const fifoPerSender = mixReceivers.every((p) => {
    const lastSeen = [-1, -1, -1];
    return textsOf(p, mixPrefix).every((text) => {
      const [, senderIndex, i] = text.split(':').map(Number);
      if (i !== lastSeen[senderIndex] + 1) return false;
      lastSeen[senderIndex] = i;
      return true;
    });
  });
  check('3 interleaved senders: per-sender FIFO holds at every receiver', fifoPerSender, {
    receivers: mixReceivers.length,
    eachGot: JSON.parse(mixOrders[0]).length,
  });
  check('3 interleaved senders: all receivers see one global order', new Set(mixOrders).size === 1, {
    distinctOrders: new Set(mixOrders).size,
  });
  void plant;
}

function duplicateAudit(all, label) {
  const duplicates = [];
  for (const participant of all) {
    const counts = new Map();
    for (const entry of participant.seen) {
      if (!entry.messageId) continue;
      const key = `${entry.kind}:${entry.messageId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) duplicates.push({ participant: participant.name, key, count });
    }
  }
  check(`no duplicate delivery by messageId (${label})`, duplicates.length === 0, {
    entries: all.reduce((sum, p) => sum + p.seen.length, 0),
    duplicates: duplicates.slice(0, 5),
    duplicateCount: duplicates.length,
  });
}

async function expectConflict(name) {
  const relay = new AgentRelay({ workspaceKey: loadState(STATE_PATH).workspaceKey, baseUrl: BASE_URL });
  return relay.workspace.register({ name, type: 'agent' }).then(
    () => 'registered',
    (error) => error?.code ?? `error:${error?.message}`,
  );
}

function runIdentityChild(system, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'identity-child.mjs')], {
      env: { ...process.env, RELAY_BASE_URL: BASE_URL, RELAY_STATE_PATH: STATE_PATH, RELAY_IDENTITY: name },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    const handler = (entry) => {
      if (entry.text.startsWith('child-hello:')) {
        void system.client.reply({ messageId: entry.messageId, text: entry.text.replace('child-hello:', 'child-ack:') });
      }
    };
    system.waiters.add(handler);
    child.once('exit', (code) => {
      system.waiters.delete(handler);
      if (code === 0) resolve(JSON.parse(out.trim().split('\n').pop()));
      else reject(new Error(`child exited ${code}: ${out}`));
    });
  });
}

async function reopen(participant, state) {
  const seen = participant.seen;
  const fresh = await openIdentity({ baseUrl: BASE_URL, statePath: STATE_PATH, state, name: participant.name });
  participant.relay = fresh.relay;
  participant.client = fresh.client;
  attach(participant);
  participant.seen = seen;
}

async function sectionClientRestart(roster, state) {
  const { named, system } = roster;

  // A real restart: the old process is gone before the new one comes up.
  const valve = named('plant-a-LV-101');
  const before = valve.client.id;
  for (const off of valve.unsubscribers) off();
  await valve.relay.events.disconnect();
  await sleep(500);
  const child = await runIdentityChild(system, valve.name);
  check('fresh process: register rejects with name_conflict', child.registerResult === 'name_conflict', child);
  check('fresh process: reconnect keeps the same agent id', child.id === before, { before, after: child.id });
  check('fresh process: can send and receive a reply', child.gotReply === true);
  await reopen(valve, state);
  await waitForStreams(system, [valve, system], 'valve-back', 15_000);

  // The old connection is still alive when the new one joins, as after a hung process.
  const tank = named('plant-a-TK-101');
  const overlap = await runIdentityChild(system, tank.name);
  await sleep(300);
  const parentGotAck = tank.seen.some((entry) => entry.text.startsWith('child-ack:'));
  observe('two live connections on one identity, who got the thread reply', { oldConnection: parentGotAck, newConnection: overlap.gotReply });
}

async function sectionServerRestart(roster, state) {
  const { named, all, system } = roster;
  const historyProbe = `before-restart-${Date.now()}`;
  await system.client.sendMessage({ to: '#company', text: historyProbe });
  await sleep(300);

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const downAt = performance.now();
    const stopped = await stopServer(signal);
    observe(`server ${signal} with 11 live clients`, stopped);
    const bootMs = await startServer();

    const reconnectMs = await waitForStreams(system, all, `after-${signal}`, 60_000).catch((error) => error);
    if (reconnectMs instanceof Error) {
      check(`server ${signal}: live clients recover without action`, false, { error: reconnectMs.message });
      continue;
    }
    check(`server ${signal}: live clients recover without action`, true, {
      serverBootMs: bootMs,
      streamsLiveAfterBootMs: reconnectMs,
      totalOutageMs: Math.round(performance.now() - downAt),
    });

    const conflict = await expectConflict('plant-b-TV-101');
    check(`server ${signal}: register still rejects with name_conflict`, conflict === 'name_conflict', { conflict });

    const fresh = await openIdentity({ baseUrl: BASE_URL, statePath: STATE_PATH, state, name: 'plant-b-TV-101' });
    check(`server ${signal}: reconnect returns the same id`, fresh.client.id === named('plant-b-TV-101').client.id);

    const channels = await system.client.channels.list();
    const company = await system.client.channels.get?.('company').catch(() => null);
    check(`server ${signal}: channels survive`, ['plant-a', 'plant-b', 'company'].every((c) => channels.some((x) => x.name === c)), {
      companyMembers: company?.memberCount ?? company?.members?.length,
    });

    const history = await system.client.messages.list('company', { limit: 500 });
    check(`server ${signal}: pre-restart message history survives`, history.some((m) => m.text === historyProbe));

    const replyProbe = `after-${signal}-q-${Date.now()}`;
    const sent = await named('plant-a-P-100').client.sendMessage({ to: '#plant-a', text: replyProbe });
    const answer = `${replyProbe}-a`;
    await named('plant-a-TK-101').client.reply({ messageId: sent.messageId, text: answer });
    const got = await waitFor(named('plant-a-P-100'), (entry) => entry.text === answer, 5000).catch(() => null);
    check(`server ${signal}: reply reaches sender after restart`, Boolean(got));
  }
}

async function sectionMidflight(roster) {
  const { named, plant, system } = roster;
  const voters = plant['plant-a'];
  const pump = named('plant-a-P-100');
  const TOTAL = 60;
  const KILL_AT = 20;
  const prefix = `mid-${Date.now()}`;
  const outcomes = [];

  const voterHandlers = voters.map((voter) => {
    const handler = (entry) => {
      if (entry.kind !== 'message.created' || !entry.text.startsWith(`${prefix}:p:`)) return;
      const round = entry.text.split(':')[2];
      void postWithRetry(
        () =>
          voter.client.reply({
            messageId: entry.messageId,
            text: `${prefix}:v:${round}:${voter.name}`,
            idempotencyKey: `${prefix}-v-${round}-${voter.name}`,
          }),
        15_000,
      );
    };
    voter.waiters.add(handler);
    return [voter, handler];
  });

  const killEvidence = {};
  const killer = (async () => {
    while (outcomes.length < KILL_AT) await sleep(5);
    killEvidence.killedAfterRound = outcomes.length - 1;
    await stopServer('SIGKILL');
    await sleep(500);
    killEvidence.bootMs = await startServer();
    killEvidence.backUpAtRound = outcomes.length;
  })();

  for (let round = 0; round < TOTAL; round++) {
    const text = `${prefix}:p:${round}`;
    const started = performance.now();
    const posted = await postWithRetry(
      () => system.client.sendMessage({ to: '#plant-a', text, idempotencyKey: `${prefix}-p-${round}` }),
      15_000,
    );
    outcomes.push({ round, attempts: posted.attempts, ok: posted.ok, ms: Math.round(performance.now() - started) });
    await sleep(50);
  }
  await killer;
  await sleep(4000);
  for (const [voter, handler] of voterHandlers) voter.waiters.delete(handler);

  const proposalsLive = voters.map((voter) => ({
    name: voter.name,
    missing: outcomes
      .filter((o) => o.ok && receivedText(voter, `${prefix}:p:${o.round}`).length === 0)
      .map((o) => o.round),
    duplicated: outcomes
      .filter((o) => receivedText(voter, `${prefix}:p:${o.round}`).length > 1)
      .map((o) => o.round),
  }));
  const votesMissing = [];
  for (const outcome of outcomes) {
    for (const voter of voters) {
      if (receivedText(system, `${prefix}:v:${outcome.round}:${voter.name}`).length === 0) {
        votesMissing.push(`${outcome.round}/${voter.name}`);
      }
    }
  }
  const stored = await system.client.messages.list('plant-a', { limit: 500 });
  const storedCounts = new Map();
  for (const message of stored) {
    if (message.text?.startsWith(`${prefix}:p:`)) storedCounts.set(message.text, (storedCounts.get(message.text) ?? 0) + 1);
  }
  const summary = {
    proposals: TOTAL,
    ...killEvidence,
    acknowledged: outcomes.filter((o) => o.ok).length,
    slowestRounds: [...outcomes].sort((a, b) => b.ms - a.ms).slice(0, 3).map((o) => ({ round: o.round, attempts: o.attempts, ms: o.ms })),
    retried: outcomes.filter((o) => o.attempts > 1).map((o) => ({ round: o.round, attempts: o.attempts, ms: o.ms })),
    maxMissingAtAVoter: Math.max(...proposalsLive.map((p) => p.missing.length)),
    missingPerVoter: proposalsLive.map((p) => `${p.name}:${p.missing.length}`),
    missingRounds: proposalsLive[0].missing,
    duplicatedRounds: [...new Set(proposalsLive.flatMap((p) => p.duplicated))],
    votesMissing: votesMissing.length,
    votesMissingSample: votesMissing.slice(0, 8),
    storedProposalsMaxCopies: Math.max(...storedCounts.values()),
    storedProposals: storedCounts.size,
  };
  report.midflight = summary;
  check('mid-conversation SIGKILL: every proposal eventually acknowledged', summary.acknowledged === TOTAL, summary);
  check('mid-conversation SIGKILL: no acknowledged proposal lost at any live voter', summary.maxMissingAtAVoter === 0, {
    missingPerVoter: summary.missingPerVoter,
    missingRounds: summary.missingRounds,
  });
  check('mid-conversation SIGKILL: no voter saw a duplicate proposal', summary.duplicatedRounds.length === 0, {
    duplicatedRounds: summary.duplicatedRounds,
  });
  check('mid-conversation SIGKILL: every vote reached the system identity', summary.votesMissing === 0, {
    votesMissing: summary.votesMissing,
    sample: summary.votesMissingSample,
  });
  void pump;
}

async function postWithRetry(post, budgetMs) {
  const started = performance.now();
  let attempts = 0;
  let lastError = null;
  while (performance.now() - started < budgetMs) {
    attempts += 1;
    try {
      const value = await post();
      return { ok: true, attempts, value };
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  return { ok: false, attempts, error: lastError?.code ?? lastError?.message };
}

async function sectionOffline(state, roster) {
  const { system, named } = roster;
  const name = 'plant-b-E-101';
  const original = named(name);
  for (const off of original.unsubscribers) off();
  await original.relay.events.disconnect?.();
  await sleep(500);

  const prefix = `offline-${Date.now()}`;
  const missed = [];
  for (let i = 0; i < 10; i++) {
    const text = `${prefix}:${i}`;
    missed.push(text);
    await system.client.sendMessage({ to: '#plant-b', text });
  }

  await reopen(original, state);
  const back = original;
  await sleep(4000);
  const replayed = missed.filter((text) => receivedText(back, text).length > 0);
  observe('messages sent while receiver offline: replayed over stream on reconnect', { sent: missed.length, replayed: replayed.length });

  const inbox = await back.client.inbox.list({ limit: 50 }).catch((error) => ({ error: error?.message }));
  observe('inbox.list after reconnect', {
    items: inbox.items?.length,
    error: inbox.error,
    sample: inbox.items?.[0] ? Object.keys(inbox.items[0]) : undefined,
  });
  const history = await back.client.messages.list('plant-b', { limit: 100 });
  const recoverable = missed.filter((text) => history.some((m) => m.text === text));
  check('missed messages are recoverable from channel history', recoverable.length === missed.length, { recoverable: recoverable.length });
  const stream = replayed.length === missed.length;
  check('missed messages are replayed over the stream on reconnect', stream, { replayed: replayed.length, sent: missed.length });
}

async function sectionIdempotency(roster) {
  const { system, all } = roster;
  const key = `idem-${Date.now()}`;
  const text = `${key}:payload`;

  const first = await system.client.sendMessage({ to: '#company', text, idempotencyKey: key });
  const second = await system.client.sendMessage({ to: '#company', text, idempotencyKey: key });
  await sleep(600);
  check('same idempotency key without restart returns the same message', first.messageId === second.messageId, {
    first: first.messageId,
    second: second.messageId,
  });
  check('same idempotency key delivered once', all.filter((p) => p !== system).every((p) => receivedText(p, text).length === 1));

  await stopServer('SIGKILL');
  await startServer();
  await waitForStreams(system, all, 'after-idem', 60_000);

  const third = await system.client.sendMessage({ to: '#company', text, idempotencyKey: key });
  await sleep(800);
  const copies = (await system.client.messages.list('company', { limit: 200 })).filter((m) => m.text === text);
  const distinctIds = new Set(copies.map((m) => m.messageId)).size;
  report.idempotencyAcrossRestart = { sameMessage: third.messageId === first.messageId, storedCopies: copies.length, distinctIds };
  check('same idempotency key after SIGKILL does not create a second message', distinctIds === 1, report.idempotencyAcrossRestart);
}

// --- main ------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const firstBootMs = await startServer();
observe('server boot from Linux filesystem, ms', firstBootMs);

const state = await openWorkspace({ baseUrl: BASE_URL, statePath: STATE_PATH, name: 'actorrelay-proof' });
const participants = await openEveryone(state);
const roster = buildRoster(participants);
await joinChannels(roster);
const firstLive = await waitForStreams(roster.system, roster.all, 'boot');
observe('all 11 streams live after, ms', firstLive);

const sections = [
  ['core', () => sectionCore(roster)],
  ['latency', () => sectionLatency(roster)],
  ['ordering', () => sectionOrdering(roster)],
  ['restart', async () => {
    await sectionClientRestart(roster, state);
    await sectionServerRestart(roster, state);
  }],
  ['midflight', () => sectionMidflight(roster)],
  ['offline', () => sectionOffline(state, roster)],
  ['idempotency', () => sectionIdempotency(roster)],
];

for (const [name, run] of sections) {
  if (!enabled(name)) continue;
  console.log(`\n=== ${name}`);
  try {
    await run();
  } catch (error) {
    check(`section ${name} finished`, false, { error: error?.message, code: error?.code, stack: error?.stack?.split('\n').slice(0, 4) });
  }
}
duplicateAudit(roster.all, 'whole run');

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
report.summary = { passed, failed };
report.checks = results;
const outPath = path.join(RESULTS_DIR, `proof-${report.runtime.split(' ')[0]}-${RUN_ID}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${passed} passed, ${failed} failed. Report: ${outPath}. Data: ${DATA_DIR}`);
await closeEveryone(participants).catch(() => {});
if (server) await stopServer('SIGTERM');
process.exit(failed === 0 ? 0 : 1);
