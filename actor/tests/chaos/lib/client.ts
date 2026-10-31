// Raw HTTP client for POST /v1/projects/{project}/actors/{name}/{id}/invoke. It needs no generated code and
// keeps the wire outcome visible: a crash test must tell "failed" from "outcome_unknown" from "refused".

export type InvokeOutcome =
  | { kind: "completed"; result: any; ms: number }
  | { kind: "failed"; code: string; message: string; ms: number }
  | { kind: "not_executed"; reason: string; ms: number }
  | { kind: "http"; status: number; body: string; ms: number }
  | { kind: "refused"; ms: number }
  | { kind: "timeout"; ms: number }
  | { kind: "transport"; message: string; ms: number };

export class ActorError extends Error {
  constructor(
    message: string,
    readonly outcome: InvokeOutcome,
  ) {
    super(message);
  }
}

export class ActorClient {
  constructor(
    public base: string,
    readonly projectId = "local",
    readonly apiKey?: string,
  ) {}

  async invoke(actor: string, id: string, method: string, args: unknown[] = [], timeoutMs = 15_000): Promise<InvokeOutcome> {
    const url = `${this.base}/v1/projects/${this.projectId}/actors/${actor}/${encodeURIComponent(id)}/invoke`;
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const ms = () => performance.now() - started;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": requestId,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ requestId, method, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: any) {
      if (error?.name === "TimeoutError") return { kind: "timeout", ms: ms() };
      const text = String(error?.code ?? error?.message ?? error);
      if (/ConnectionRefused|ECONNREFUSED|Unable to connect/i.test(text)) return { kind: "refused", ms: ms() };
      return { kind: "transport", message: text, ms: ms() };
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) return { kind: "http", status: response.status, body: text.slice(0, 500), ms: ms() };
    let reply: any;
    try {
      reply = JSON.parse(text);
    } catch {
      return { kind: "http", status: response.status, body: text.slice(0, 500), ms: ms() };
    }
    const outcome = reply.outcome ?? reply;
    if (outcome.type === "completed") return { kind: "completed", result: outcome.result, ms: ms() };
    if (outcome.type === "failed") return { kind: "failed", code: outcome.code, message: outcome.message, ms: ms() };
    if (outcome.type === "not_executed") return { kind: "not_executed", reason: outcome.reason, ms: ms() };
    return { kind: "http", status: response.status, body: text.slice(0, 500), ms: ms() };
  }

  /** Invoke and return the result, throwing on anything but completed. */
  async call(actor: string, id: string, method: string, args: unknown[] = [], timeoutMs = 15_000): Promise<any> {
    const outcome = await this.invoke(actor, id, method, args, timeoutMs);
    if (outcome.kind === "completed") return outcome.result;
    throw new ActorError(`${actor}(${id}).${method}: ${JSON.stringify(outcome)}`, outcome);
  }
}
