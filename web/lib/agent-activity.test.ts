import { describe, expect, test } from "bun:test";
import { demoAgentActivities } from "./agent-activity";
import { createDemoState, DEMO_EPOCH, DEMO_REVIEW_MS, demoReducer } from "./demo";

describe("linked demo agent activity", () => {
  test("every equipment agent has a unique location, role, task, and public summary", () => {
    const activities = demoAgentActivities(createDemoState());
    expect(activities).toHaveLength(10);
    expect(new Set(activities.map((activity) => activity.id)).size).toBe(10);
    for (const activity of activities) {
      expect(activity.equipmentName.length).toBeGreaterThan(0);
      expect(activity.location).toContain(activity.plantId === "plant-a" ? "Plant A" : "Plant B");
      expect(activity.role.length).toBeGreaterThan(0);
      expect(activity.task.length).toBeGreaterThan(0);
      expect(activity.summary.length).toBeGreaterThan(0);
    }
    expect(activities.find((a) => a.id === "plant-a/LV-101")?.state).toBe("blocked");
    expect(activities.find((a) => a.id === "plant-a/P-100")?.state).toBe("ready");
    expect(activities.find((a) => a.id === "plant-b/LV-101")?.state).toBe("monitoring");
  });

  test("only involved agents review a change, with sequential votes and a real veto phase", () => {
    let state = demoReducer(createDemoState(), { type: "propose", plantId: "plant-a", to: 65, now: DEMO_EPOCH });
    let activities = demoAgentActivities(state);
    expect(activities.find((a) => a.id === "plant-a/P-100")?.state).toBe("thinking");
    expect(activities.find((a) => a.id === "plant-b/TV-101")?.state).toBe("thinking");
    expect(activities.find((a) => a.id === "plant-b/P-100")?.state).toBe("monitoring");
    state = demoReducer(state, { type: "tick", now: DEMO_EPOCH + 1800 });
    expect(state.proposals.at(-1)?.votes).toHaveLength(1);
    expect(state.proposals.at(-1)?.status).toBe("voting");
    activities = demoAgentActivities(state);
    expect(activities.find((a) => a.id === "plant-a/TK-101")?.state).toBe("ready");
    expect(activities.find((a) => a.id === "plant-a/LV-101")?.state).toBe("reviewing");
    expect(activities.find((a) => a.id === "plant-a/P-100")?.state).toBe("waiting");
    state = demoReducer(state, { type: "tick", now: DEMO_EPOCH + DEMO_REVIEW_MS });
    expect(state.proposals.at(-1)?.status).toBe("veto_window");
    expect(state.proposals.at(-1)?.votes).toHaveLength(5);
    expect(state.messages.filter((message) => message.id.includes(`${state.proposals.at(-1)!.id}-vote-`))).toHaveLength(5);
    expect(demoAgentActivities(state).filter((activity) => activity.state === "waiting")).toHaveLength(6);
    const deadline = state.proposals.at(-1)!.vetoDeadline!;
    state = demoReducer(state, { type: "tick", now: deadline });
    expect(demoAgentActivities(state).filter((activity) => activity.state === "observing")).toHaveLength(6);
    state = demoReducer(state, { type: "tick", now: deadline + 5000 });
    expect(demoAgentActivities(state).every((activity) => activity.state === "monitoring")).toBe(true);
    expect(demoAgentActivities(state).find((activity) => activity.id === "plant-a/LV-101")?.updatedAt).toBe(deadline + 5000);
  });

  test("a refused vote stops review and does not imply work on unrelated equipment", () => {
    let state = demoReducer(createDemoState(), { type: "propose", plantId: "plant-b", to: 85, now: DEMO_EPOCH });
    state = demoReducer(state, { type: "tick", now: DEMO_EPOCH + 2800 });
    const proposal = state.proposals.at(-1)!;
    expect(proposal.status).toBe("blocked");
    expect(proposal.votes).toHaveLength(2);
    expect(proposal.vetoDeadline).toBeUndefined();
    const activities = demoAgentActivities(state);
    expect(activities.find((a) => a.id === "plant-b/LV-101")?.state).toBe("blocked");
    expect(activities.find((a) => a.id === "plant-a/TK-101")?.state).toBe("monitoring");
    const again = demoReducer(state, { type: "tick", now: DEMO_EPOCH + 4000 });
    expect(again.messages.length).toBe(state.messages.length);
    expect(again.components.find((equipment) => equipment.id === "plant-b/P-100")?.metrics.speedPct).toBe(50);
  });
});
