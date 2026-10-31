/** Run with `bun run glue/e2e.ts --smoke` or `bun run glue/e2e.ts --live`. */
export {};
const base = (process.env.GLUE_URL ?? 'http://127.0.0.1:7200').replace(/\/$/, '');
const live = process.argv.includes('--live');
const mockJourney = process.argv.includes('--mock-journey');
const rows: { check: string; result: 'PASS' | 'FAIL' | 'NOT READY' | 'SKIP'; detail: string }[] = [];
let mode = 'unknown';
const record = (check: string, result: typeof rows[number]['result'], detail: string) => {
  rows.push({ check, result, detail }); console.log(`${result.padEnd(10)} ${check}: ${detail}`);
};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function request(path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const text = await response.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { status: response.status, ok: response.ok, data };
}
async function api(path: string, body?: unknown) {
  const r = await request(path, body);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 240)}`);
  return r.data;
}
async function check(name: string, fn: () => Promise<string>) {
  try { record(name, 'PASS', await fn()); return true; }
  catch (error) { record(name, 'FAIL', error instanceof Error ? error.message : String(error)); return false; }
}
const state = (plant = 'plant-a') => api(`/state?plantId=${plant}`);
const proposals = (s: any): any[] => s.plant?.proposals ?? [];
const proposalFrom = (r: any): any => r.proposal ?? r;
async function waitFor<T>(read: () => Promise<T>, matches: (item: T) => boolean, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (matches(value)) return value;
    await Bun.sleep(300);
  } while (Date.now() < end);
  throw new Error(`Timed out after ${ms}ms: ${label}`);
}
async function main() {
  const health = await request('/health').catch((e) => ({ ok: false, status: 0, data: { error: String(e) } }));
  if (!health.ok) { record('API reachable', 'NOT READY', `${base}: ${health.data.error ?? health.status}`); return; }
  mode = health.data.mode ?? 'unknown';
  let initial: any;
  if (!await check('State contract', async () => {
    initial = await state(); mode = initial.mode ?? mode;
    assert(initial.plant && Array.isArray(initial.components) && initial.company, 'Expected {plant,components,company,mode}');
    assert(['mock', 'live'].includes(mode), 'State must identify mock or live');
    return `${mode} mode; ${initial.components.length} components returned for plant-a query`;
  })) return;
  if (live && mode !== 'live') { record('Live acceptance', 'NOT READY', `API reports ${mode}; mock results cannot certify agents or simulation`); return; }
  if (!live && mode === 'live') { record('Mock smoke mutations', 'SKIP', 'Live API detected; use --live explicitly to reset and run the acceptance journey'); return; }
  console.log(`\n${live ? 'LIVE ACCEPTANCE: resets simulated demo state' : 'MOCK SMOKE ONLY: does not verify real agents, persistence, or process dynamics'}\n`);
  await check('Request validation', async () => {
    const r = await request('/propose', { plantId: 'plant-a', to: 'invalid' });
    assert(r.status === 400 || r.status === 422, `Malformed proposal returned ${r.status}, expected 400/422`);
    return `Malformed proposal rejected (${r.status})`;
  });
  if (!await check('Reset and ten components', async () => {
    await api('/reset', {});
    const states = await waitFor(() => Promise.all([state('plant-a'), state('plant-b')]), ss => {
      const ids = new Set(ss.flatMap(s => s.components?.map((c: any) => c.id) ?? []));
      return ids.size === 10;
    }, 3000, 'ten mirrored components');
    for (const s of states) {
      assert(s.components.filter((c: any) => c.plantId === s.plant.id).length === 5, `${s.plant.id}: expected five components`);
      assert(proposals(s).length === 0, 'Reset must clear proposals');
    }
    return 'Both plants expose five unique components and no proposals';
  })) return;
  if (!live) {
    let mockBad: any;
    await check('Operator proposal route', async () => {
      const result = await api('/propose', { plantId: 'plant-a', proposerComponentId: 'plant-a/P-100', metric: 'speedPct', to: 85, rationale: 'Mock contract smoke check' });
      const p = proposalFrom(result); mockBad = p;
      assert(p.id || p.proposalId, 'Proposal response must contain an ID');
      const s = await state();
      assert(proposals(s).some(q => q.id === (p.id ?? p.proposalId)), 'Created proposal absent from state');
      return 'Proposal appears in mock state; no live reasoning claimed';
    });
    if (mockBad?.id) {
      await check('Unapproved execution rejected', async () => {
        const r = await request('/execute-callback', {proposalId: mockBad.id});
        assert(r.status === 409 || r.status === 403, `Unapproved execution returned ${r.status}`);
        return `Callback rejected (${r.status})`;
      });
      await check('Duplicate vote rejected', async () => {
        const s = await waitFor(state, x => proposals(x).some(p => p.id === mockBad.id && p.votes.length > 0), 4000, 'fixture votes');
        const vote = proposals(s).find(p => p.id === mockBad.id).votes[0];
        const r = await request('/vote', {vote});
        assert(r.status === 409, `Duplicate vote returned ${r.status}`);
        return 'Repeated component vote rejected (409)';
      });
    }
    if (mockJourney && mockBad?.id) {
      await check('Mock unsafe block fixture', async () => {
        const s = await waitFor(state, x => proposals(x).some(p => p.id === mockBad.id && p.status === 'blocked'), 4000, 'fixture block');
        const p = proposals(s).find(p => p.id === mockBad.id);
        assert(p.crossPlant && p.requiredVoters.includes('plant-b/TV-101'), 'Fixture missing shared-header voter');
        assert(p.votes.some((v: any) => v.vote === 'no' && v.evidenceEventIds?.length >= 3), 'Fixture missing evidence-backed no');
        return 'Synthetic block scenario validated; no real agent claim';
      });
      await check('Mock counter and veto window fixture', async () => {
        const result = await api('/counter', {parentProposalId: mockBad.id, proposal: {plantId: 'plant-a', proposerComponentId: 'plant-a/P-100', metric: 'speedPct', to: 65, rationale: 'Mock safer counter'}});
        const counter = proposalFrom(result);
        await waitFor(state, x => proposals(x).some(p => p.id === counter.id && p.status === 'veto_window'), 4000, 'fixture veto window');
        const s = await waitFor(state, x => proposals(x).some(p => p.id === counter.id && p.status === 'executed'), 14000, 'fixture execution');
        assert(s.components.find((c: any) => c.id === 'plant-a/P-100')?.metrics.speedPct === 65, 'Fixture target not reflected');
        return 'Synthetic counter waited for veto deadline and updated mock state';
      });
    }
    record('Live agent and execution journey', 'SKIP', 'Requires --live plus actors, Relay agents, and running simulation');
    return;
  }
  let bad: any, safe: any, observed: any;
  if (!await check('Unsafe proposal and cross-plant evidence', async () => {
    bad = proposalFrom(await api('/propose', { plantId: 'plant-a', proposerComponentId: 'plant-a/P-100', metric: 'speedPct', to: 85, rationale: 'E2E throughput request' }));
    assert(bad.id, 'Missing proposal ID');
    const s = await waitFor(state, x => proposals(x).some(p => p.id === bad.id && p.status === 'blocked'), 25000, 'unsafe proposal blocked by agents');
    bad = proposals(s).find(p => p.id === bad.id);
    assert(bad.crossPlant === true && bad.requiredVoters.includes('plant-b/TV-101'), 'Missing shared-header voter');
    const v = bad.votes.find((v: any) => v.componentId === 'plant-a/LV-101');
    assert(v?.vote === 'no' && v.predicted?.positionPct >= 81 && v.evidenceEventIds?.length >= 3, 'LV-101 must reject with threshold prediction and three cited events');
    const known = new Set((s.plant.history ?? []).map((e: any) => e.id));
    assert(v.evidenceEventIds.every((id: string) => known.has(id)), 'Vote cites unknown history IDs');
    return 'Blocked with LV-101 evidence and other-plant steam review';
  })) return;
  if (!await check('Agent counterproposal and veto window', async () => {
    const s = await waitFor(state, x => proposals(x).some(p => p.parentProposalId === bad.id && p.to >= 60 && p.to <= 70 && p.status === 'veto_window'), 25000, 'agent-generated safer counterproposal in veto window');
    safe = proposals(s).find(p => p.parentProposalId === bad.id && p.status === 'veto_window');
    assert(safe.requiredVoters.every((id: string) => safe.votes.some((v: any) => v.componentId === id && v.vote === 'yes')), 'Missing unanimous yes');
    assert(Date.parse(safe.vetoDeadline) > Date.now(), 'Invalid or elapsed veto deadline');
    return `Counterproposal ${safe.to}% has unanimous review and active veto window`;
  })) return;
  if (!await check('Measured outcome and calibration', async () => {
    const s = await waitFor(state, x => {
      const p = proposals(x).find(p => p.id === safe.id);
      const c = x.components.find((c: any) => c.id === 'plant-a/LV-101');
      return p?.status === 'executed' && c?.metrics.positionPct >= 60 && c?.metrics.positionPct <= 72 && x.plant.history?.some((e: any) => e.proposalId === safe.id);
    }, 30000, 'execution with measured valve response and history');
    observed = s.plant.history.find((e: any) => e.proposalId === safe.id);
    const allComponents = [...s.components, ...(await state('plant-b')).components];
    assert(safe.requiredVoters.every((id: string) => allComponents.find((c: any) => c.id === id)?.calibration?.some((e: any) => e.proposalId === safe.id)), 'Missing per-voter calibration');
    assert(s.plant.audit?.some((e: any) => e.refId === safe.id && ['execute', 'calibration'].includes(e.kind)), 'Missing execution audit');
    return `Observed event ${observed.id}; valve settled and all voters calibrated`;
  })) return;
  await check('Repeat request uses recent evidence', async () => {
    const p = proposalFrom(await api('/propose', { plantId: 'plant-a', proposerComponentId: 'plant-a/P-100', metric: 'speedPct', to: 85, rationale: 'E2E repeated request' }));
    const s = await waitFor(state, x => proposals(x).some(q => q.id === p.id && q.status === 'blocked'), 10000, 'repeat block');
    const v = proposals(s).find(q => q.id === p.id).votes.find((v: any) => v.componentId === 'plant-a/LV-101');
    assert(v?.evidenceEventIds?.[0] === observed.id, 'Latest execution must be cited first alongside unsafe-event evidence');
    assert(v.evidenceEventIds.length >= 3, 'Safe run alone cannot justify an unsafe-outcome claim');
    return 'Blocked with newest observation first and supporting unsafe evidence';
  });
  await check('Plant B shared learning', async () => {
    const p = proposalFrom(await api('/propose', { plantId: 'plant-b', proposerComponentId: 'plant-b/P-100', metric: 'speedPct', to: 85, rationale: 'E2E cross-plant learning' }));
    const s = await waitFor(() => state('plant-b'), x => proposals(x).some(q => q.id === p.id && q.status === 'blocked'), 25000, 'plant-b block');
    const v = proposals(s).find(q => q.id === p.id).votes.find((v: any) => v.componentId === 'plant-b/LV-101');
    assert(v?.vote === 'no', 'Plant B LV-101 must reject');
    const rules = new Set((s.company.rules ?? []).map((r: any) => r.id));
    const cited = v.evidenceRuleIds?.some((id: string) => rules.has(id));
    assert(cited || /insufficient history/i.test(v.reason), 'Expected cited company rule or explicit insufficient history');
    return cited ? 'Blocked citing company rule' : 'Blocked due to insufficient history; company-rule transfer is NOT YET PROVEN';
  });
  record('Relay delivery, restart, duplicate commands', 'SKIP', 'Require transport delivery evidence and owner-provided restart/command-journal probes; HTTP state alone cannot certify these');
}
await main().catch(e => record('Runner', 'FAIL', e instanceof Error ? e.message : String(e)));
console.log(`\nResult mode: ${mode}. ${mode === 'mock' ? 'Mock checks are not live acceptance.' : 'Review skipped capabilities before demo.'}`);
console.table(rows);
process.exitCode = rows.some(r => r.result === 'FAIL') ? 1 : rows.some(r => r.result === 'NOT READY') || (live && rows.some(r => r.result === 'SKIP')) ? 2 : 0;
