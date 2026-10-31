// PURE-FUNCTION TESTS. These run under `bun test` with no Terse runtime, so a pass here proves the decision
// logic only. tests/runtime/runtime.test.ts holds the same list against a real `terse actor dev`.
import { describe, expect, test } from "bun:test"
import type { ComponentState, HistoryEvent, LearnedRule, PlantId, Proposal, Vote } from "../../../shared/types"
import plants from "../../../shared/plants.json"
import history from "../fixtures/history.json"
import { applyCalibration, computeStatus } from "../../src/logic/component"
import { assertCounterAllowed, assertExecutable, assertVoteAllowed, enforceVoteSafety, planSweep, reachableVoters, unanimousYes, type Setpoints } from "../../src/logic/proposals"
import { counterexampleId, crossPlantVoters, deriveRules, mergeCompanyRule, mergeDerivedRules, mergeSubmittedRule, toCompanyRule, unsupportedEventId, type Topology } from "../../src/logic/rules"
import { rankSimilar } from "../../src/logic/similar"
import { normalizeCalibration, normalizeVote } from "../../src/logic/validate"
import { componentActorId, plantOfProposal, proposalIdFor } from "../../src/ids"

const events = history as HistoryEvent[]
const seeded = plants.plants as unknown as { id: PlantId; components: ComponentState[] }[]
const plantA = seeded[0]
const topologyA: Topology = Object.fromEntries(plantA.components.map(component => [component.id, component]))
const order = plantA.components.map(component => component.id)
const setpointsA: Setpoints = Object.fromEntries(plantA.components.map(component => [component.id, { ...component.metrics }]))
const lv101 = plantA.components.find(component => component.tag === "LV-101")!

const voters = ["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101", "plant-b/TV-101"]

function proposal(overrides: Partial<Proposal> = {}): Proposal {
    return {
        id: proposalIdFor("plant-a", 1, "aaaaaaaa"),
        at: new Date(1_000_000).toISOString(),
        plantId: "plant-a",
        proposerComponentId: "plant-a/P-100",
        proposerAgentId: "agent:plant-a/P-100",
        metric: "speedPct",
        from: 50,
        to: 65,
        rationale: "more throughput",
        requiredVoters: voters,
        votes: [],
        status: "voting",
        vetoDeadline: null,
        parentProposalId: null,
        crossPlant: true,
        ...overrides
    }
}

function vote(componentId: string, overrides: Partial<Vote> = {}): Vote {
    return {
        proposalId: proposal().id,
        componentId,
        agentId: `agent:${componentId}`,
        vote: "yes",
        reason: "history is safe",
        predicted: {},
        marginPct: 10,
        evidenceEventIds: [],
        evidenceRuleIds: [],
        similarCount: 3,
        ...overrides
    }
}

function event(id: string, after: number, lvAfter: number, overrides: Partial<HistoryEvent> = {}): HistoryEvent {
    return {
        id,
        at: `2026-01-0${(Number(id.replace(/\D/g, "")) % 9) + 1}T00:00:00.000Z`,
        plantId: "plant-a",
        componentId: "plant-a/P-100",
        metric: "speedPct",
        before: 50,
        after,
        upstreamSnapshot: { feedM3h: 15 },
        effects: [{ componentId: "plant-a/LV-101", metric: "positionPct", before: 50, after: lvAfter, ticksToSettle: 3 }],
        incident: null,
        approvedBy: [],
        operator: null,
        proposalId: null,
        ...overrides
    }
}

describe("TASK1 list (pure)", () => {
    test("second vote from the same component is rejected", () => {
        const first = vote("plant-a/LV-101")
        const open = proposal()
        assertVoteAllowed(first, open, 1_000_500)
        expect(() => assertVoteAllowed(first, { ...open, votes: [first] }, 1_000_600)).toThrow("duplicate_vote")
    })

    test("two proposals on one component: only one reaches veto_window, the other waits in voting", () => {
        const unanimous = voters.map(voter => vote(voter))
        const first = proposal({ votes: unanimous })
        const second = proposal({ id: proposalIdFor("plant-a", 2, "bbbbbbbb"), to: 70, votes: unanimous })
        const swept = planSweep([first, second], setpointsA, 1_000_500).proposals
        expect(swept.map(item => item.status)).toEqual(["veto_window", "voting"])
        const resweep = planSweep(swept, setpointsA, 1_002_500).proposals
        expect(resweep.map(item => item.status)).toEqual(["veto_window", "voting"])
    })

    test("similar returns the seeded >=80% events and their effects show LV-101 >= 85", () => {
        const found = rankSimilar({
            history: events,
            componentId: "plant-a/P-100",
            metric: "speedPct",
            to: 85,
            upstreamSnapshot: { feedM3h: 15, headerBarg: 6, feedTempC: 25 },
            k: 5,
            limit: plantA.components[0].limits.speedPct,
            liveEventIds: []
        })
        expect(found.length).toBe(5)
        for (const item of found) {
            expect(item.after).toBeGreaterThanOrEqual(80)
            const effect = item.effects.find(row => row.componentId === "plant-a/LV-101" && row.metric === "positionPct")
            expect(effect?.after ?? 0).toBeGreaterThanOrEqual(85)
        }
    })

    test("P-100 voters are the four local components plus plant-b/TV-101", () => {
        const local = reachableVoters("plant-a/P-100", topologyA, order)
        expect(local).toEqual(["plant-a/TK-101", "plant-a/LV-101", "plant-a/E-101", "plant-a/TV-101"])
        const remote = crossPlantVoters({ plantId: "plant-a", proposerComponentId: "plant-a/P-100", requiredVoters: local, sharedResources: plants.company.sharedResources })
        expect(remote).toEqual(["plant-b/TV-101"])
    })

    test("five large errors raise marginPct from 10 to exactly 15", () => {
        let state = { calibration: [] as ReturnType<typeof normalizeCalibration>[], marginPct: 10, sinceAdjustment: 0 }
        for (let index = 0; index < 5; index++) {
            const entry = normalizeCalibration({ at: "t", proposalId: `p${index}`, metric: "positionPct", predicted: 60, observed: 80 })
            state = applyCalibration({ ...state, entry, limits: lv101.limits })
        }
        expect(state.marginPct).toBe(15)
    })

    test("rule fires on the third matching event and dedupes on the fourth", () => {
        const now = "2026-10-31T00:00:00.000Z"
        const two = [event("e1", 82, 86), event("e2", 84, 87)]
        expect(deriveRules(two, topologyA, now)).toEqual([])

        const three = [...two, event("e3", 86, 89)]
        const first = mergeDerivedRules([], deriveRules(three, topologyA, now))
        expect(first.changed.length).toBe(1)
        const rule = first.rules[0]
        expect(rule.timesSeen).toBe(3)
        expect(rule.condition).toEqual({ componentId: "plant-a/P-100", metric: "speedPct", op: ">=", value: 80 })
        expect(rule.consequence).toMatchObject({ componentId: "plant-a/LV-101", metric: "positionPct", op: ">=", value: 85 })

        const fourth = mergeDerivedRules(first.rules, deriveRules([...three, event("e4", 85, 88)], topologyA, now))
        expect(fourth.rules.length).toBe(1)
        expect(fourth.rules[0].id).toBe(rule.id)
        expect(fourth.rules[0].timesSeen).toBe(4)
        expect(fourth.rules[0].text).toContain("seen 4 times")
    })
})

describe("votes", () => {
    test("stale, non-required and misattributed votes are rejected", () => {
        expect(() => assertVoteAllowed(vote("plant-a/P-100"), proposal(), 1_000_500)).toThrow("not_a_required_voter")
        expect(() => assertVoteAllowed(vote("plant-a/LV-101", { agentId: "agent:other" }), proposal(), 1_000_500)).toThrow("invalid_vote")
        for (const status of ["vetoed", "expired", "executed"] as const) {
            expect(() => assertVoteAllowed(vote("plant-a/LV-101"), proposal({ status }), 1_000_500)).toThrow("stale_proposal")
        }
        expect(() => assertVoteAllowed(vote("plant-a/LV-101"), proposal(), 1_000_000 + 30_000)).toThrow("stale_proposal")
    })

    test("a late voter is still recorded on a blocked proposal, within the voting window", () => {
        const blocked = proposal({ status: "blocked", votes: [vote("plant-a/LV-101", { vote: "no" })] })
        expect(() => assertVoteAllowed(vote("plant-b/TV-101"), blocked, 1_004_000)).not.toThrow()
        expect(() => assertVoteAllowed(vote("plant-a/LV-101"), blocked, 1_004_000)).toThrow("duplicate_vote")
        expect(() => assertVoteAllowed(vote("plant-b/TV-101"), blocked, 1_030_000)).toThrow("stale_proposal")
    })

    test("a yes may become a no during the veto window, never the reverse", () => {
        const yes = vote("plant-a/LV-101")
        const no = vote("plant-a/LV-101", { vote: "no" })
        const windowed = proposal({ status: "veto_window", votes: [yes] })
        expect(() => assertVoteAllowed(no, windowed, 1_000_500)).not.toThrow()
        expect(() => assertVoteAllowed(yes, proposal({ status: "veto_window", votes: [no] }), 1_000_500)).toThrow("duplicate_vote")
    })

    test("normalizeVote rejects malformed values and drops extras", () => {
        expect(() => normalizeVote({ ...vote("plant-a/LV-101"), vote: "YES" })).toThrow("invalid_vote")
        expect(() => normalizeVote({ ...vote("plant-a/LV-101"), predicted: { positionPct: Number.NaN } })).toThrow("invalid_vote")
        expect(() => normalizeVote({ ...vote("plant-a/LV-101"), predicted: { positionPct: Number.POSITIVE_INFINITY } })).toThrow("invalid_vote")
        expect(() => normalizeVote({ ...vote("plant-a/LV-101"), marginPct: 3 })).toThrow("invalid_vote")
        expect(Object.keys(normalizeVote({ ...vote("plant-a/LV-101"), extra: 1 }))).not.toContain("extra")
    })

    test("a yes predicted past the threshold is refused; a healthy 75 C survives a wide margin", () => {
        const tank = plantA.components.find(component => component.tag === "TK-101")!
        expect(() => enforceVoteSafety(vote("plant-a/LV-101", { predicted: { positionPct: 89 } }), lv101)).toThrow("unsafe_yes")
        expect(enforceVoteSafety(vote("plant-a/TK-101", { predicted: { levelPct: 50, tempC: 75 }, marginPct: 25 }), tank).vote).toBe("yes")
    })

    test("a yes must predict every limited metric", () => {
        expect(() => enforceVoteSafety(vote("plant-a/LV-101", { predicted: {} }), lv101)).toThrow("invalid_vote")
        expect(enforceVoteSafety(vote("plant-a/LV-101", { vote: "no", predicted: {} }), lv101).vote).toBe("no")
    })

    test("similarCount 0 within 15% of critical is automatically no", () => {
        const forced = enforceVoteSafety(vote("plant-a/LV-101", { predicted: { positionPct: 78 }, similarCount: 0 }), lv101)
        expect(forced.vote).toBe("no")
        expect(forced.reason).toContain("insufficient history")
    })
})

describe("sweep", () => {
    test("any no blocks, and a no overrides a partial set of yes votes", () => {
        const swept = planSweep([proposal({ votes: [vote("plant-a/TK-101"), vote("plant-a/LV-101", { vote: "no" })] })], setpointsA, 1_000_500)
        expect(swept.proposals[0].status).toBe("blocked")
        expect(swept.audit[0].kind).toBe("block")
    })

    test("empty requiredVoters is never unanimous", () => {
        expect(unanimousYes(proposal({ requiredVoters: [] }))).toBe(false)
        expect(planSweep([proposal({ requiredVoters: [] })], setpointsA, 1_000_500).proposals[0].status).toBe("voting")
    })

    test("missing votes expire after 30s", () => {
        expect(planSweep([proposal()], setpointsA, 1_029_000).proposals[0].status).toBe("voting")
        expect(planSweep([proposal()], setpointsA, 1_030_000).proposals[0].status).toBe("expired")
    })

    test("veto_window proposals are released only after the deadline", () => {
        const windowed = proposal({ status: "veto_window", vetoDeadline: new Date(1_010_000).toISOString() })
        expect(planSweep([windowed], setpointsA, 1_009_999).toExecute).toEqual([])
        expect(planSweep([windowed], setpointsA, 1_010_000).toExecute).toEqual([windowed.id])
    })

    test("a proposal made stale by an earlier execution expires", () => {
        const moved = { ...setpointsA, "plant-a/P-100": { ...setpointsA["plant-a/P-100"], speedPct: 65 } }
        expect(planSweep([proposal({ to: 70 })], moved, 1_000_500).proposals[0].status).toBe("expired")
    })
})

describe("small guards", () => {
    test("a target above the operating max is refused before dispatch", () => {
        const windowed = proposal({ status: "veto_window", vetoDeadline: new Date(1_010_000).toISOString(), votes: voters.map(voter => vote(voter)), to: 91 })
        expect(() => assertExecutable(windowed, topologyA, setpointsA, 1_020_000)).toThrow("out_of_limits")
    })

    test("a negative prediction is malformed", () => {
        expect(() => enforceVoteSafety(vote("plant-a/LV-101", { predicted: { positionPct: -5 } }), lv101)).toThrow("invalid_vote")
    })

    test("counters are capped from the root, so a chain cannot walk past the cap", () => {
        const counterOf = (id: string, parent: string) => proposal({ id, parentProposalId: parent, status: "blocked" })
        const chain = [proposal({ id: "root", status: "blocked" }), counterOf("c1", "root"), counterOf("c2", "c1")]
        const next = { proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 60, rationale: "again", parentProposalId: "c2" }
        expect(() => assertCounterAllowed(next, chain)).toThrow("too_many_counters")
        expect(() => assertCounterAllowed({ ...next, parentProposalId: "c1" }, chain.slice(0, 2))).not.toThrow()
    })

    test("margin ignores a window the cap has thinned below 5", () => {
        const limits = plantA.components.find(component => component.tag === "TV-101")!.limits
        const noise = Array.from({ length: 49 }, (_, index) => normalizeCalibration({ at: "t", proposalId: `n${index}`, metric: "headerBarg", predicted: 6, observed: 5 }))
        const entry = normalizeCalibration({ at: "t", proposalId: "p", metric: "positionPct", predicted: 50, observed: 90 })
        expect(applyCalibration({ calibration: noise, entry, limits, marginPct: 10, sinceAdjustment: 4 }).marginPct).toBe(10)
    })

    test("k below 1 returns nothing", () => {
        expect(rankSimilar({ history: events, componentId: "plant-a/P-100", metric: "speedPct", to: 85, upstreamSnapshot: {}, k: 0, liveEventIds: [] })).toEqual([])
    })

    test("a link recorded on one end still reaches its voter", () => {
        const oneSided: Topology = { ...topologyA, "plant-a/TK-101": { ...topologyA["plant-a/TK-101"], upstream: ["plant-a/E-101"] } }
        expect(reachableVoters("plant-a/P-100", oneSided, order)).toContain("plant-a/LV-101")
    })
})

describe("cross-plant windows and outages", () => {
    const unanimous = voters.map(voter => vote(voter))

    test("a cross-plant proposal waits in voting until it holds the shared-resource lease", () => {
        const waiting = proposal({ votes: unanimous })
        const asked = planSweep([waiting], setpointsA, 1_000_500, [])
        expect(asked.proposals[0].status).toBe("voting")
        expect(asked.needLease).toEqual([waiting.id])
        expect(planSweep([waiting], setpointsA, 1_000_500, [waiting.id]).proposals[0].status).toBe("veto_window")
    })

    test("a unanimous proposal cannot wait for ever on old votes", () => {
        expect(planSweep([proposal({ votes: unanimous })], setpointsA, 1_060_000, []).proposals[0].status).toBe("expired")
    })

    test("a veto window lost to an outage reopens instead of executing unattended", () => {
        const windowed = proposal({ status: "veto_window", vetoDeadline: new Date(1_010_000).toISOString(), votes: unanimous })
        expect(planSweep([windowed], setpointsA, 1_012_000).toExecute).toEqual([windowed.id])
        const lapsed = planSweep([windowed], setpointsA, 1_040_000)
        expect(lapsed.toExecute).toEqual([])
        expect(Date.parse(lapsed.proposals[0].vetoDeadline!)).toBe(1_050_000)
        expect(lapsed.audit[0].kind).toBe("incident")
    })
})

describe("server-side vote checks", () => {
    const pump = plantA.components[0]
    const context = { proposal: { proposerComponentId: "plant-a/P-100", metric: "speedPct", to: 85 }, proposerLimit: pump.limits.speedPct, similarCount: 5, marginPct: 10, rules: [] as LearnedRule[] }

    test("too little real history near critical forces no, whatever similarCount the vote claims", () => {
        const forced = enforceVoteSafety(vote("plant-a/LV-101", { predicted: { positionPct: 60 }, similarCount: 5 }), lv101, { ...context, similarCount: 2 })
        expect(forced.vote).toBe("no")
        expect(forced.reason).toContain("insufficient history")
    })

    test("a vote cannot lower its own margin", () => {
        const claimed = vote("plant-a/LV-101", { predicted: { positionPct: 84 }, marginPct: 5 })
        expect(() => enforceVoteSafety(claimed, lv101, context)).toThrow("unsafe_yes")
    })

    test("an applicable learned rule forces no, even with low predictions", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const rules = deriveRules(rows, topologyA, "2026-10-31T00:00:00.000Z")
        const forced = enforceVoteSafety(vote("plant-a/LV-101", { predicted: { positionPct: 60 } }), lv101, { ...context, rules })
        expect(forced.vote).toBe("no")
        expect(forced.reason).toContain("learned rule")
    })
})

describe("execute", () => {
    const approved = proposal({ status: "veto_window", vetoDeadline: new Date(1_010_000).toISOString(), votes: voters.map(voter => vote(voter)) })

    test("runs only from a passed veto window with every yes, a live from and in-limit target", () => {
        expect(() => assertExecutable(proposal(), topologyA, setpointsA, 2_000_000)).toThrow("not_approved")
        expect(() => assertExecutable(approved, topologyA, setpointsA, 1_009_000)).toThrow("veto_window_open")
        expect(() => assertExecutable({ ...approved, votes: approved.votes.slice(1) }, topologyA, setpointsA, 1_020_000)).toThrow("not_approved")
        expect(() => assertExecutable({ ...approved, from: 40 }, topologyA, setpointsA, 1_020_000)).toThrow("stale_proposal")
        expect(() => assertExecutable({ ...approved, to: 96 }, topologyA, setpointsA, 1_020_000)).toThrow("out_of_limits")
        expect(() => assertExecutable(approved, topologyA, setpointsA, 1_020_000)).not.toThrow()
    })
})

describe("similar extras", () => {
    const base = { componentId: "plant-a/P-100", metric: "speedPct", upstreamSnapshot: {}, k: 5, limit: plantA.components[0].limits.speedPct }

    test("the newest live event comes first even when it is far from the target", () => {
        const live = event("live1", 65, 66, { at: "2026-10-31T19:00:00.000Z", proposalId: "plant-a-p00001-x" })
        const found = rankSimilar({ ...base, history: [...events, live], to: 85, liveEventIds: [live.id] })
        expect(found[0].id).toBe(live.id)
        expect(found.slice(1).every(item => item.after >= 80)).toBe(true)
        expect(found.length).toBe(5)
    })

    test("a plant with no history near the target retrieves nothing", () => {
        const plantB = events.filter(item => item.plantId === "plant-b")
        expect(rankSimilar({ ...base, componentId: "plant-b/P-100", history: plantB, to: 85, liveEventIds: [] })).toEqual([])
    })
})

describe("component", () => {
    test("status: warning at max, critical at critical", () => {
        expect(computeStatus({ positionPct: 79.9 }, lv101.limits)).toBe("ok")
        expect(computeStatus({ positionPct: 80 }, lv101.limits)).toBe("warning")
        expect(computeStatus({ positionPct: 90 }, lv101.limits)).toBe("critical")
    })

    test("one error never moves the margin, and unlimited metrics are skipped", () => {
        const limits = plantA.components.find(component => component.tag === "TV-101")!.limits
        const entry = normalizeCalibration({ at: "t", proposalId: "p", metric: "headerBarg", predicted: 6, observed: 5 })
        const once = applyCalibration({ calibration: [], entry, limits, marginPct: 10, sinceAdjustment: 0 })
        expect(once).toMatchObject({ marginPct: 10, sinceAdjustment: 0 })
    })

    test("five tiny errors narrow the margin by 2, floored at 5", () => {
        let state = { calibration: [] as ReturnType<typeof normalizeCalibration>[], marginPct: 6, sinceAdjustment: 0 }
        for (let index = 0; index < 5; index++) {
            state = applyCalibration({ ...state, entry: normalizeCalibration({ at: "t", proposalId: `p${index}`, metric: "positionPct", predicted: 60, observed: 60.1 }), limits: lv101.limits })
        }
        expect(state.marginPct).toBe(5)
    })

    test("a forged absError is recomputed", () => {
        expect(normalizeCalibration({ at: "t", proposalId: "p", metric: "m", predicted: 60, observed: 80, absError: -1000 }).absError).toBe(20)
    })
})

describe("rules", () => {
    const now = "2026-10-31T00:00:00.000Z"

    test("a safe run above the threshold raises the threshold rather than keeping a false rule", () => {
        const rows = [event("e1", 80, 85), event("e2", 81, 74), event("e3", 86, 88), event("e4", 87, 89), event("e5", 88, 90)]
        const [rule] = deriveRules(rows, topologyA, now)
        expect(rule.condition.value).toBe(85)
        expect(rule.timesSeen).toBe(3)
    })

    test("the fixture yields the P-100 to LV-101 rule from seed history", () => {
        const rules = deriveRules(events.filter(item => item.plantId === "plant-a"), topologyA, now)
        const rule = rules.find(item => item.condition.metric === "speedPct" && item.consequence.componentId === "plant-a/LV-101")
        expect(rule?.condition.value).toBeLessThanOrEqual(80)
        expect(rule?.model).toBe("outlet-valve-A")
    })

    test("plant-b history crosses nothing, so it learns no rule of its own", () => {
        const topologyB: Topology = Object.fromEntries(seeded[1].components.map(component => [component.id, component]))
        const rules = deriveRules(events.filter(item => item.plantId === "plant-b"), topologyB, now)
        expect(rules.filter(item => item.consequence.componentId === "plant-b/LV-101")).toEqual([])
    })

    test("company rules are plant-agnostic and deduped by condition and consequence", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const company = toCompanyRule(deriveRules(rows, topologyA, now)[0], "plant-a")
        expect(company.scope).toBe("company")
        expect(company.condition.componentId).toBeNull()
        expect(company.consequence.componentId).toBeNull()
        const once = mergeCompanyRule([], company, now)
        const twice = mergeCompanyRule(once.rules, { ...company, supportEventIds: [...company.supportEventIds, "e4"] }, now)
        expect(twice.rules.length).toBe(1)
        expect(twice.rule.timesSeen).toBe(company.timesSeen + 1)
        expect(twice.rule.supportEventIds).toContain("e4")
    })

    test("a submitted rule is rejected when a cited event does not show it", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const rule = deriveRules(rows, topologyA, now)[0]
        expect(unsupportedEventId(rule, rows)).toBeNull()
        expect(unsupportedEventId({ ...rule, supportEventIds: ["e1", "e2", "safe"] }, [...rows, event("safe", 65, 66)])).toBe("safe")
        expect(unsupportedEventId({ ...rule, supportEventIds: ["e1", "e2", "invented"] }, rows)).toBe("invented")
    })

    test("one run that meets the condition without the consequence refutes a rule", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const rule = deriveRules(rows, topologyA, now)[0]
        expect(counterexampleId(rule, rows)).toBeNull()
        const broad = { ...rule, condition: { ...rule.condition, value: 20 } }
        expect(counterexampleId(broad, [...rows, event("safe", 65, 66)])).toBe("safe")
    })

    test("a replayed company rule changes nothing, and new evidence keeps the source plant", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const company = toCompanyRule(deriveRules(rows, topologyA, now)[0], "plant-a")
        const replayed = mergeCompanyRule([company], company, now).rule
        expect(replayed.timesSeen).toBe(company.timesSeen)
        const later = mergeCompanyRule([company], { ...company, supportEventIds: [...company.supportEventIds, "e4"], timesSeen: 4, text: "from plant-b" }, now).rule
        expect(later.timesSeen).toBe(4)
        expect(later.text).toContain("seen 4 times")
        expect(later.text).toContain("first learned in plant-a")
    })

    test("a merge can only tighten a company rule", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const company = toCompanyRule(deriveRules(rows, topologyA, now)[0], "plant-a")
        const weaker = { ...company, condition: { ...company.condition, value: 99 }, consequence: { ...company.consequence, value: 70 } }
        const merged = mergeCompanyRule([company], weaker, now).rule
        expect(merged.condition.value).toBe(company.condition.value)
        expect(merged.consequence.value).toBe(company.consequence.value)
    })

    test("a resubmitted rule merges by condition and consequence", () => {
        const rows = [event("e1", 82, 86), event("e2", 84, 87), event("e3", 86, 89)]
        const rule: LearnedRule = deriveRules(rows, topologyA, now)[0]
        const merged = mergeSubmittedRule([rule], { ...rule, id: "another-id" }, now)
        expect(merged.rules.length).toBe(1)
        expect(merged.rule.id).toBe(rule.id)
    })
})

describe("ids", () => {
    test("component ids become legal actor ids; proposals carry their plant", () => {
        expect(componentActorId("plant-a/LV-101")).toBe("plant-a.LV-101")
        expect(componentActorId("plant-a/LV-101")).toMatch(/^[A-Za-z0-9._-]+$/)
        expect(plantOfProposal(proposalIdFor("plant-b", 12, "abcd1234"))).toBe("plant-b")
        expect(() => plantOfProposal("nope")).toThrow("invalid_proposal_id")
    })
})
