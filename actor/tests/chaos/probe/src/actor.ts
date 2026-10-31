// Minimal actor for testing the runtime's own crash semantics, with no ActorRelay logic in the way.
import { Actor, Persisted } from "terse-sdk/actor";

export class Probe extends Actor {
  @Persisted count = 0;
  @Persisted marks: string[] = [];
  @Persisted alarmEveryMs = 0;
  @Persisted alarmFires = 0;
  @Persisted lastAlarmAt = 0;
  @Persisted alarmTimes: number[] = [];
  @Persisted armInsideMethod = false;

  async write(mark: string): Promise<number> {
    this.marks = [...this.marks, mark];
    this.count = this.count + 1;
    return this.count;
  }

  async read(): Promise<unknown> {
    return {
      count: this.count,
      marks: this.marks,
      alarmEveryMs: this.alarmEveryMs,
      alarmFires: this.alarmFires,
      lastAlarmAt: this.lastAlarmAt,
      alarm: this.alarm.get(),
      glueUrl: process.env.GLUE_URL ?? null,
      controlPlaneUrl: process.env.DURABLE_ACTORS_CONTROL_PLANE_URL ?? null,
      pid: process.pid,
    };
  }

  /** Actor to actor through the backend reference, which is what Plant and Company rely on. */
  async askOther(id: string): Promise<unknown> {
    return await Probe.get(id).read();
  }

  async arm(everyMs: number): Promise<void> {
    this.alarmEveryMs = everyMs;
    this.alarm.set(Date.now() + everyMs);
  }

  async onAlarm(): Promise<void> {
    this.alarmFires = this.alarmFires + 1;
    this.lastAlarmAt = Date.now();
    this.alarmTimes = [...this.alarmTimes.slice(-40), this.lastAlarmAt];
    if (this.alarmEveryMs > 0) this.alarm.set(Date.now() + this.alarmEveryMs);
    // Same pattern as Plant: re-arm first, then a second check inside the tick when the alarm reads as overdue.
    if (this.armInsideMethod) {
      const scheduled = this.alarm.get();
      if (scheduled === null || scheduled <= Date.now()) this.alarm.set(Date.now() + this.alarmEveryMs);
    }
  }

  async timing(armInsideMethod: boolean): Promise<void> {
    this.armInsideMethod = armInsideMethod;
    this.alarmTimes = [];
  }

  async times(): Promise<number[]> {
    return this.alarmTimes;
  }

  /** Awaits two glue calls in sequence, with a durable mark in between, to catch hosts that outlive the runtime. */
  async twoStep(url: string): Promise<string> {
    await fetch(`${url}/step-one`, { method: "POST", body: "{}" });
    this.marks = [...this.marks, "after-step-one"];
    await fetch(`${url}/step-two`, { method: "POST", body: "{}" });
    this.marks = [...this.marks, "after-step-two"];
    return "done";
  }

  /** Holds the mailbox on a glue call. */
  async heldFetch(url: string): Promise<string> {
    await fetch(`${url}/held`, { method: "POST", body: "{}" });
    return "done";
  }

  async quick(): Promise<string> {
    return "quick";
  }
}
