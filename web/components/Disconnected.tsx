import { ageText } from "@/lib/format";
import { GLUE_URL } from "@/lib/glue";
import type { Snapshot } from "@/lib/store";
import { Stamp } from "./ui";

/** Shown instead of the plant. With glue gone there is nothing true to draw, so nothing is drawn. */
export function Disconnected({ glue, now }: { glue: Snapshot; now: number }) {
  const contract = glue.contractError !== null;
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-10">
      <div className="panel w-[900px] border border-rule p-10">
        <Stamp tone={glue.conn === "connecting" ? "off" : "warn"}>{glue.conn === "connecting" ? "connecting" : contract ? "contract mismatch" : "disconnected"}</Stamp>
        <h2 className="mb-3 mt-5 text-3xl font-semibold">{glue.conn === "connecting" ? "Reaching glue" : contract ? "Glue answered with the wrong shape" : "No plant data"}</h2>
        <p className="m-0 text-xl text-ink-2">
          {contract ? "The /state body does not match shared/types.ts, so nothing from it is shown." : "This dashboard shows only what glue serves. Without it, no value on this screen would be real, so none are shown."}
        </p>
        <dl className="mt-6 grid grid-cols-[180px_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-3">Polling</dt>
          <dd className="num m-0 break-all">{GLUE_URL}/state</dd>
          <dt className="text-ink-3">Last error</dt>
          <dd className="num m-0 break-words">{glue.lastError ?? "none yet"}</dd>
          <dt className="text-ink-3">Failed polls</dt>
          <dd className="num m-0">{glue.failures}</dd>
          <dt className="text-ink-3">Last good read</dt>
          <dd className="num m-0">{glue.lastOkAt === null ? "never" : ageText(glue.lastOkAt, now)}</dd>
          <dt className="text-ink-3">Retrying</dt>
          <dd className="m-0">every second, reconnects on its own</dd>
        </dl>
      </div>
    </main>
  );
}
