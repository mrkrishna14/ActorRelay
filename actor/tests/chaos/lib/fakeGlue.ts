// FAKE glue. It lives in the harness process so its call log survives the server kill, which is what
// lets a scenario count simulation commands across a crash. Real glue semantics it copies from
// glue/server.ts at f4384ab: JSON POST routes, and /execute-callback forwarded into the actor adapter
// with an 8s timeout, which is the re-entrant path the deadlock scenarios need.

export type GlueCall = {
  seq: number;
  atEpochMs: number;
  method: string;
  path: string;
  body: unknown;
  respondedAtEpochMs: number | null;
  responseStatus: number | null;
  clientAborted: boolean;
};

export type Behaviour =
  | { kind: "ok"; body?: unknown | ((call: GlueCall) => unknown) }
  | { kind: "delay"; ms: number; body?: unknown | ((call: GlueCall) => unknown) }
  | { kind: "status"; status: number; body?: unknown }
  | { kind: "hold" }
  | { kind: "hang" }
  | { kind: "fn"; fn: (call: GlueCall) => Promise<Response> | Response };

type Held = { call: GlueCall; release: (response?: Response) => void };

export class FakeGlue {
  calls: GlueCall[] = [];
  private behaviours = new Map<string, Behaviour>();
  private held: Held[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private waiters: { path: string; count: number; resolve: () => void }[] = [];
  private seq = 0;

  constructor(readonly port: number) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  on(path: string, behaviour: Behaviour): void {
    this.behaviours.set(path, behaviour);
  }

  reset(): void {
    this.calls = [];
    this.behaviours.clear();
    this.releaseAll();
  }

  count(path: string): number {
    return this.calls.filter((call) => call.path === path).length;
  }

  of(path: string): GlueCall[] {
    return this.calls.filter((call) => call.path === path);
  }

  /** Resolves when `path` has been called at least `count` times; used to kill at an exact point. */
  async waitFor(path: string, count = 1, timeoutMs = 30_000): Promise<boolean> {
    if (this.count(path) >= count) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push({
        path,
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      });
    });
  }

  releaseAll(response?: Response): void {
    const held = this.held;
    this.held = [];
    for (const item of held) item.release(response?.clone());
  }

  private evaluate(body: unknown, call: GlueCall): unknown {
    return typeof body === "function" ? (body as (c: GlueCall) => unknown)(call) : (body ?? { ok: true });
  }

  private async respond(call: GlueCall, signal: AbortSignal): Promise<Response> {
    const behaviour = this.behaviours.get(call.path) ?? this.behaviours.get("*") ?? { kind: "ok" as const };
    switch (behaviour.kind) {
      case "ok":
        return Response.json(this.evaluate(behaviour.body, call));
      case "delay":
        await Bun.sleep(behaviour.ms);
        return Response.json(this.evaluate(behaviour.body, call));
      case "status":
        return Response.json(behaviour.body ?? { error: "fake glue failure" }, { status: behaviour.status });
      case "fn":
        return await behaviour.fn(call);
      case "hold":
      case "hang":
        return await new Promise<Response>((resolve) => {
          const release = (response?: Response) => resolve(response ?? Response.json({ ok: true }));
          signal.addEventListener("abort", () => {
            call.clientAborted = true;
            release();
          });
          this.held.push({ call, release });
        });
    }
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const text = await request.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {}
        const call: GlueCall = {
          seq: ++this.seq,
          atEpochMs: Date.now(),
          method: request.method,
          path: url.pathname,
          body,
          respondedAtEpochMs: null,
          responseStatus: null,
          clientAborted: false,
        };
        this.calls.push(call);
        for (const waiter of [...this.waiters]) {
          if (waiter.path === call.path && this.count(call.path) >= waiter.count) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        const response = await this.respond(call, request.signal);
        call.respondedAtEpochMs = Date.now();
        call.responseStatus = response.status;
        return response;
      },
    });
  }

  /** Connection refused from now on. Held requests are dropped. */
  async stop(): Promise<void> {
    this.releaseAll();
    await this.server?.stop(true);
    this.server = null;
  }
}
