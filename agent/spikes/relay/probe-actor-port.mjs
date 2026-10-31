// STAND-IN for glue's actor port, used only by probe-glue.mjs. Terse is not involved.
// It accepts proposals and records every call, so the probe can prove what real glue dispatched.
import fs from 'node:fs';

const logPath = process.env.PROBE_ACTOR_LOG;
const proposals = [];
const record = (entry) => fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

export default {
  async read(kind, id) {
    if (kind === 'Plant') return { id, proposals: proposals.filter((proposal) => proposal.plantId === id) };
    return { id, metrics: {}, limits: {} };
  },
  async call(kind, id, method, args) {
    record({ kind, id, method, args });
    if (method !== 'propose') return { ok: true };
    const [input] = args;
    const proposal = { ...input, id: `probe-${proposals.length + 1}`, status: 'voting', crossPlant: true, votes: [], at: new Date().toISOString() };
    proposals.push(proposal);
    return { proposal };
  },
};
