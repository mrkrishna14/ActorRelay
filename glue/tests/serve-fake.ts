// TEST FAKE. The real Glue routes over fake actors, a fake simulator and fake Relay, on a port, so the contract suite can
// check route validation and response shapes without a live stack. It proves nothing about real actors.
//   bun run tests/serve-fake.ts
//   CONTRACT_GLUE_URL=http://127.0.0.1:7299 bun test --timeout 60000 glue-live   (from actor/tests/contract)
import { build } from "./fakes";

const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.GLUE_PORT ?? 7299), fetch: build().glue.handle });
console.log(`FAKE actors, simulator and Relay behind real glue routes on http://127.0.0.1:${server.port}`);
