// `bun run deploy`: sync the frozen contract, type-check, and deploy without uploading local dev state.
// terse deploy has no ignore file and would upload .durable-actors/ (local `terse actor dev` state).
import { existsSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const run = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { stdio: ["inherit", "inherit", "inherit"] })
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
}
run(["bun", "run", "sync-types"])
run(["bun", "run", "--bun", "check"])
const state = ".durable-actors"
const parked = join(tmpdir(), `actorrelay-durable-actors-${Date.now()}`)
const moved = existsSync(state)
if (moved) renameSync(state, parked)
try {
    run(["terse", "deploy"])
} finally {
    // A running `terse actor dev` recreates the folder while it is parked; keep the new one in that case.
    if (moved && !existsSync(state)) renameSync(parked, state)
    else if (moved) console.log(`local dev state was recreated by a running dev server; previous state parked at ${parked}`)
}
