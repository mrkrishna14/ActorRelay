// HARNESS SELF-TEST ON A STUB. This proves the harness kills and restarts processes correctly.
// It says nothing about Terse: the "server" here is a Bun script with a file-backed counter.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeGlue } from "./fakeGlue";
import { DevServer, groupMembers, portListening, sleep } from "./server";

const root = join(homedir(), "ar-chaos", "selftest");
mkdirSync(root, { recursive: true });
const stub = join(root, "stub.ts");
const childScript = join(root, "child.ts");
writeFileSync(childScript, `process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1000);\n`);
writeFileSync(
  stub,
  `const child = Bun.spawn(["bun", ${JSON.stringify(childScript)}], { stdin: "pipe" });
Bun.serve({ port: Number(process.env.TERSE_ACTOR_PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") });
void child;
`,
);

let failures = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
};

const server = new DevServer({
  projectDir: root,
  dataDir: join(root, "data"),
  port: 7181,
  logFile: join(root, "stub.log"),
  command: ["bun", stub],
});

try {
  new DevServer({ projectDir: root, dataDir: root, port: 7100, logFile: join(root, "x") });
  check("refuses port 7100", false);
} catch {
  check("refuses port 7100", true);
}

const first = await server.start();
check("stub starts and answers healthz", first.readyMs > 0, first);
const members = groupMembers(server.pgid);
check("group holds the server and its child", members.length >= 2, members);

const runtimeKill = await server.kill9("runtime");
check("runtime kill closes the port", !portListening(7181), runtimeKill);
check("child exits when its parent pipe closes", runtimeKill.survivors.length === 0, runtimeKill.survivors);

await server.start();
const groupKill = await server.kill9("group");
check("group kill leaves nothing", groupKill.survivors.length === 0 && groupMembers(server.pgid).length === 0, groupKill);

const glue = new FakeGlue(7182);
glue.start();
glue.on("/hold", { kind: "hold" });
glue.on("/fail", { kind: "status", status: 503 });
const held = fetch(`${glue.url}/hold`, { method: "POST", body: JSON.stringify({ a: 1 }) });
check("waitFor sees the held call", await glue.waitFor("/hold", 1, 2000));
const racing = await Promise.race([held.then(() => "answered"), sleep(150).then(() => "pending")]);
check("hold keeps the response pending", racing === "pending", racing);
glue.releaseAll(Response.json({ released: true }));
check("release answers it", ((await (await held).json()) as any).released === true);
check("status behaviour", (await fetch(`${glue.url}/fail`, { method: "POST" })).status === 503);
check("call log parses JSON bodies", (glue.of("/hold")[0].body as any).a === 1);

const aborter = new AbortController();
const abortable = fetch(`${glue.url}/hold`, { method: "POST", signal: aborter.signal }).catch(() => "aborted");
await glue.waitFor("/hold", 2, 2000);
aborter.abort();
await abortable;
await sleep(100);
check("client abort is recorded on a held call", glue.of("/hold")[1].clientAborted === true);

await glue.stop();
const refused = await fetch(`${glue.url}/x`, { signal: AbortSignal.timeout(1000) }).then(
  () => "answered",
  (error) => String(error?.code ?? error),
);
check("stopped glue refuses connections", refused !== "answered", refused);

console.log(failures === 0 ? "SELFTEST OK (stub only, not Terse)" : `SELFTEST FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
