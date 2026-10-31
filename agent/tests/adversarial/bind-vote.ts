// Runs the real castVote through the real HttpGlue against a throwaway local HTTP server, so schema validation and
// JSON encoding are exercised exactly as in production. Only the model and the glue service's answers are scripted.
import { castVote } from "../../vote";
import { HttpGlue } from "../../glue";
import { RetrievalCache } from "../../retrieval";
import type { Llm, LlmRequest } from "../../llm";
import { component } from "./fixtures";
import type { Pipeline, VoteCase } from "./harness";

type Stage = keyof NonNullable<VoteCase["fail"]>;

function serve(c: VoteCase) {
  const answer = (stage: Stage, body: unknown) => {
    const fault = c.fail?.[stage];
    if (fault === "http500") return new Response("boom", { status: 500 });
    if (fault === "throw") return new Response("<html>not json</html>", { status: 200 });
    if (fault) return Response.json(fault.junk);
    return Response.json(body);
  };
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/component/")) {
        const id = decodeURIComponent(url.pathname.slice("/component/".length));
        if (id === c.own.id) return answer("component", c.own);
        if (id === c.proposal.proposerComponentId) return answer("proposer", component(id));
        return Response.json(component(id));
      }
      if (url.pathname === "/similar") return answer("similar", c.events);
      if (url.pathname === "/rules") return answer("rules", c.rules ?? []);
      if (url.pathname === "/state") {
        const plantId = url.searchParams.get("plantId");
        return answer("plant", { plant: { id: plantId, name: plantId, components: [], proposals: [c.proposal], history: c.events, rules: c.rules ?? [], audit: [], tick: 0, connected: true } });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// vote.ts caches shared context per proposal id for the process, so each case needs its own id.
let nextCase = 0;

export function bindVote(): Pipeline {
  return async (input) => {
    const c = { ...input, proposal: { ...input.proposal, id: `${input.proposal.id}-${++nextCase}` } };
    const prompts: string[] = [];
    const logs: string[] = [];
    let attempt = 0;
    const llm: Llm = {
      complete: async (request: LlmRequest) => {
        prompts.push(`${request.system}\n${request.user}`);
        return { text: await c.llm(request.user, attempt++), provider: "openai", model: "scripted-hostile", fallback: false };
      },
    };
    const server = serve(c);
    try {
      const glue = new HttpGlue(`http://127.0.0.1:${server.port}`);
      const vote = await castVote({ glue, llm, cache: new RetrievalCache(), fastNoMs: 5000, log: (line) => logs.push(line) }, c.proposal, c.own.id);
      return { vote, prompts, logs, threw: undefined };
    } catch (threw) {
      return { vote: null, prompts, logs, threw };
    } finally {
      server.stop(true);
    }
  };
}
