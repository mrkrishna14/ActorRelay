// Every read goes through the actor's mailbox, so a wedge shows up as a slow or timed-out call, not as an inference.
import type { Ctx } from "./scenario";
import { sleep } from "./server";

export const MAILBOX_BOUND_MS = 2_000; // Glue fetches are fire-and-forget, so a healthy mailbox never waits on them.
export const ACTOR_CALL_BOUND_MS = 9_000; // A Plant may hold its mailbox for one 8s actor call (ACTOR_CALL_TIMEOUT_MS).

/** Sample mailbox latency for `ms`, one read at a time, and fail on any read over the bound. */
export async function probeMailbox(ctx: Ctx, label: string, ms: number, boundMs = MAILBOX_BOUND_MS, plantId = "plant-a"): Promise<void> {
  const samples: number[] = [];
  const failures: unknown[] = [];
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const outcome = await ctx.client.invoke("Plant", plantId, "getState", [], 10_000);
    samples.push(outcome.ms);
    if (outcome.kind !== "completed") failures.push(outcome);
    await sleep(100);
  }
  samples.sort((a, b) => a - b);
  ctx.metric(`${label}.mailboxP50Ms`, samples[Math.floor(samples.length / 2)] ?? -1);
  ctx.metric(`${label}.mailboxMaxMs`, samples.at(-1) ?? -1);
  ctx.equal(`${label}: every mailbox read succeeded`, failures.length, 0);
  ctx.check(`${label}: mailbox stays under ${boundMs}ms`, (samples.at(-1) ?? Infinity) < boundMs, { max: samples.at(-1), n: samples.length });
}
