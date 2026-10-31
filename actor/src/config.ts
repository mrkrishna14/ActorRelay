export const TICK_MS = 1_000
export const VETO_WINDOW_MS = 10_000
export const VOTE_TIMEOUT_MS = 30_000
export const SWEEP_EVERY_TICKS = 2
export const TICK_CHECKPOINT_EVERY = 30
export const MIRROR_CHECKPOINT_MS = 10_000
export const WAITING_TIMEOUT_MS = 60_000
export const VETO_LAPSE_MS = 6_000
export const LEASE_TTL_MS = 60_000

export const AUDIT_CAP = 300
export const PROPOSAL_CAP = 200
export const CALIBRATION_CAP = 50
export const MAX_COUNTERS_PER_PARENT = 2

export const CALLBACK_RETRY_MS = 4_000
export const CALLBACK_MAX_ATTEMPTS = 3
export const CLAIM_TIMEOUT_MS = 20_000
export const FETCH_TIMEOUT_MS = 1_500
export const ACTOR_CALL_TIMEOUT_MS = 8_000

export const SETPOINT_TOLERANCE = 0.01

declare const process: { env: Record<string, string | undefined> }

// Read on use: actor processes receive their environment after this module loads.
export function glueUrl(): string {
    return (process.env.GLUE_URL ?? "http://127.0.0.1:7200").replace(/\/+$/, "")
}
