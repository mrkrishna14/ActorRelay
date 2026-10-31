// Live proof page: shows recorded end-to-end tables and streams a real run of the demo scenario.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const e2eDir = join(root, "actor", "tests", "e2e");
const wslScript = "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/e2e/run-terse.sh";
const port = Number(process.env.LIVE_PORT ?? 3100);

function lastRuns() {
  return readdirSync(e2eDir)
    .filter((f) => f.startsWith("last-run-") && f.endsWith(".md"))
    .map((name) => {
      const path = join(e2eDir, name);
      return { name, at: statSync(path).mtime.toTimeString().slice(0, 8), text: readFileSync(path, "utf8") };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

function runStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const send = (line: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      const proc = Bun.spawn(
        ["wsl.exe", "-d", "Ubuntu", "--cd", "/tmp", "--", "env", "E2E_ACTORS=shim", "E2E_AGENTS=runtime", "E2E_TAKES=1", "bash", wslScript, "demo"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        let tail = "";
        for await (const chunk of stream) {
          tail += decoder.decode(chunk);
          const lines = tail.split(/\r?\n/);
          tail = lines.pop() ?? "";
          lines.forEach(send);
        }
        if (tail) send(tail);
      };
      Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(async () => {
        send(`[run finished, exit ${await proc.exited}]`);
        controller.close();
      });
    },
  });
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ActorRelay live proof</title><style>
:root{color-scheme:dark;--bg:#0b0f14;--panel:#121923;--line:#253243;--text:#e6edf5;--dim:#94a3b8;--go:#3fb950;--no:#f85149;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:18px/1.45 ui-sans-serif,system-ui,sans-serif}
header{display:flex;gap:20px;align-items:center;padding:16px 24px;border-bottom:1px solid var(--line)}h1{font-size:24px;margin:0}
.tag{color:var(--warn);border:1px solid var(--warn);padding:2px 10px;border-radius:6px}button{font:inherit;font-weight:700;background:var(--go);color:#04210c;border:0;padding:10px 20px;border-radius:8px;cursor:pointer;margin-left:auto}button:disabled{opacity:.5}
main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 24px;height:calc(100vh - 74px)}section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;min-width:0}
h2{margin:0 0 10px;font-size:20px}pre{margin:0;white-space:pre-wrap;word-break:break-word;font:15px/1.5 ui-monospace,monospace}.pass{color:var(--go)}.fail{color:var(--no)}.gap{color:var(--warn)}select{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px;max-width:100%}
</style></head><body><header><h1>ActorRelay</h1><span class="tag">Simulated plant · test rig, stand-in glue and plant</span><button id="run">Run the real demo now</button></header>
<main><section><h2>Live run: real actor code on an in-process stand-in for Terse, real GPT votes</h2><pre id="live">Press the button to start. First build takes about a minute.</pre></section>
<section><h2>Recorded runs</h2><select id="pick"></select><pre id="table"></pre></section></main>
<script>
const live=document.getElementById("live"),table=document.getElementById("table"),pick=document.getElementById("pick"),run=document.getElementById("run");
const paint=t=>t.split("\\n").map(l=>{const e=l.replace(/&/g,"&amp;").replace(/</g,"&lt;");const c=/FAIL/.test(l)?"fail":/GAP/.test(l)?"gap":/PASS/.test(l)?"pass":"";return c?'<span class="'+c+'">'+e+'</span>':e}).join("\\n");
let runs=[];const show=()=>{const r=runs[pick.value];if(r)table.innerHTML=paint(r.text)};pick.onchange=show;
const load=()=>fetch("/runs").then(r=>r.json()).then(d=>{runs=d;const v=pick.value||0;pick.innerHTML=d.map((r,i)=>'<option value="'+i+'">'+r.name+" · "+r.at+"</option>").join("");pick.value=v;show()});load();
run.onclick=()=>{run.disabled=true;live.textContent="";const s=new EventSource("/run");s.onmessage=e=>{const l=JSON.parse(e.data);live.innerHTML+=paint(l)+"\\n";live.parentElement.scrollTop=1e9;if(l.startsWith("[run finished")){s.close();run.disabled=false;load()}}};
</script></body></html>`;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/runs") return Response.json(lastRuns());
    if (pathname === "/run") return new Response(runStream(), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`Live proof page on http://127.0.0.1:${port}`);
