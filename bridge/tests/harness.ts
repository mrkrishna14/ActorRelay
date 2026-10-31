// Test harness: a FAKE glue that records what the bridge posts, and helpers to drive a real live_sim process over HTTP.
// The simulator is real. Only the glue on the other end of /mirror and /observed is a stand-in.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIVE_SIM = join(HERE, "..", "live_sim.ts");

export type Snapshot = Record<string, Record<string, number>>;
export type Recorded = { at: number; path: string; body: any };

export class FakeGlue {
  received: Recorded[] = [];
  observedStatus: number[] = [];
  private server: ReturnType<typeof Bun.serve>;

  constructor(port: number) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const body = await request.json().catch(() => null);
        this.received.push({ at: performance.now(), path, body });
        const status = path === "/observed" ? (this.observedStatus.shift() ?? 200) : 200;
        return new Response("{}", { status, headers: { "content-type": "application/json" } });
      },
    });
  }

  of(path: string) {
    return this.received.filter((r) => r.path === path);
  }

  observed(proposalId: string) {
    return this.of("/observed").filter((r) => r.body?.proposalId === proposalId);
  }

  clear() {
    this.received = [];
  }

  stop() {
    this.server.stop(true);
  }
}

export class Bridge {
  private process: Subprocess | null = null;
  readonly url: string;

  constructor(
    readonly port: number,
    readonly gluePort: number,
    private readonly env: Record<string, string> = {},
  ) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start() {
    this.process = Bun.spawn([process.execPath, "run", LIVE_SIM], {
      env: { ...process.env, BRIDGE_PORT: String(this.port), GLUE_URL: `http://127.0.0.1:${this.gluePort}`, ...this.env },
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${this.url}/health`)).ok) return;
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error(`live_sim did not come up on ${this.port}`);
  }

  stop() {
    this.process?.kill();
  }

  async snapshot(plantId?: string): Promise<{ tick: number; metrics: Snapshot }> {
    const response = await fetch(`${this.url}/snapshot${plantId ? `?plantId=${plantId}` : ""}`);
    return { tick: Number(response.headers.get("x-bridge-tick")), metrics: (await response.json()) as Snapshot };
  }

  async setpoint(componentId: string, metric: string, value: number, proposalId: string) {
    const response = await fetch(`${this.url}/setpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ componentId, metric, value, proposalId }) });
    return { status: response.status, body: (await response.json()) as any };
  }

  async reset() {
    return (await (await fetch(`${this.url}/reset`, { method: "POST" })).json()) as any;
  }

  async health() {
    return (await (await fetch(`${this.url}/health`)).json()) as any;
  }

  /** Samples one snapshot per tick, starting with the current tick, until `ticks` more have passed. */
  async record(ticks: number): Promise<{ tick: number; metrics: Snapshot }[]> {
    const series = [await this.snapshot()];
    const stopAt = series[0].tick + ticks;
    while (series[series.length - 1].tick < stopAt) {
      await Bun.sleep(40);
      const next = await this.snapshot();
      if (next.tick > series[series.length - 1].tick) series.push(next);
    }
    return series;
  }
}
