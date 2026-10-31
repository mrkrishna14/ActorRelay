// LLM providers for the vote drafts. Outputs are data: every draft is validated with zod; a bad draft
// gets one re-request, then the caller falls back to a safe "no". Vendor per CLAUDE.MD: mechanics on
// Codex (OpenAI), the engineers and safety on Claude.
import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"
import type { Vendor } from "../../shared/types.js"

export const DraftSchema = z.object({
    vote: z.enum(["yes", "no"]),
    reason: z.string().min(1).max(1200),
    predicted: z.array(z.object({ metric: z.string().min(1), value: z.number() })).max(10),
})
export type Draft = z.infer<typeof DraftSchema>

export interface Llm {
    readonly label: string // shown in the vote reason
    draft(system: string, user: string): Promise<unknown>
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5"
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-6.1-sol"

/** Claude via the official SDK: structured output (schema-constrained JSON) and server-side refusal fallback. */
export class ClaudeLlm implements Llm {
    readonly label = `claude:${CLAUDE_MODEL}`
    private client = new Anthropic()
    async draft(system: string, user: string): Promise<unknown> {
        const response = await this.client.beta.messages.parse({
            model: CLAUDE_MODEL,
            max_tokens: 16000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "medium", format: betaZodOutputFormat(DraftSchema) },
            system,
            messages: [{ role: "user", content: user }],
        })
        if (response.stop_reason === "refusal") throw new Error("model declined to vote")
        return response.parsed_output
    }
}

/** Codex/OpenAI via the Responses API (same call shape as scripts/gpt.mjs); JSON parsed from the text. */
export class CodexLlm implements Llm {
    readonly label = `openai:${CODEX_MODEL}`
    constructor(private key: string) {}
    async draft(system: string, user: string): Promise<unknown> {
        const res = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: CODEX_MODEL, instructions: system, input: user, reasoning: { effort: process.env.CODEX_EFFORT || "low" } }),
            signal: AbortSignal.timeout(18_000),
        })
        const body = (await res.json()) as { error?: { message?: string }; output?: { content?: { text?: string }[] }[] }
        if (!res.ok) throw new Error(`openai ${res.status}: ${body.error?.message ?? "error"}`)
        const text = (body.output ?? []).flatMap(o => o.content ?? []).map(c => c.text ?? "").join("")
        const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
        return JSON.parse(json)
    }
}

/** The configured model for a vendor, or null → the labelled baseline (no LLM key on this machine). */
export function llmFor(vendor: Vendor): Llm | null {
    const mode = process.env.AGENT_LLM ?? "auto" // auto | openai | off
    if (mode === "off") return null
    const openai = process.env.OPENAI_API_KEY
    const claude = mode !== "openai" && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE)
    if (vendor === "claude" && claude) return new ClaudeLlm()
    // OpenAI-only setup: every agent (including the Claude-assigned roles) runs on OpenAI; the vote label says so.
    if (openai) return new CodexLlm(openai)
    return null
}

/** One request, one re-request on invalid output; null when both fail (caller votes a safe no). */
export class DeadlineError extends Error {}

/** One request, one re-request on invalid output, all inside `deadlineMs`; null when both fail. Throws DeadlineError on timeout. */
export async function draftWithRetry(llm: Llm, system: string, user: string, log: (msg: string) => void = () => {}, deadlineMs = Infinity): Promise<Draft | null> {
    const end = Date.now() + deadlineMs
    for (let attempt = 1; attempt <= 2; attempt++) {
        const left = end - Date.now()
        if (left <= 0) throw new DeadlineError(`no answer within ${deadlineMs} ms`)
        try {
            const call = llm.draft(system, attempt === 1 ? user : `${user}\n\nYour previous answer was not valid. Return ONLY the JSON object described above.`)
            const answer = await Promise.race([call, new Promise<never>((_, reject) => setTimeout(() => reject(new DeadlineError(`no answer within ${deadlineMs} ms`)), left))])
            const parsed = DraftSchema.safeParse(answer)
            if (parsed.success) return parsed.data
            log(`${llm.label}: invalid draft (attempt ${attempt}): ${parsed.error.issues.slice(0, 2).map(i => i.message).join("; ")}`)
        } catch (error) {
            if (error instanceof DeadlineError) throw error
            log(`${llm.label}: request failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return null
}
