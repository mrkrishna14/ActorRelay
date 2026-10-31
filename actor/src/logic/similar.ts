import type { HistoryEvent, Limit } from "../../../shared/types"

const RELEVANCE_BAND = 0.15
const MAX_RESULTS = 100

function spreadOf(values: number[]): number {
    return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values)
}

function sharedKeys(a: Record<string, number>, b: Record<string, number>): string[] {
    return Object.keys(a).filter(key => Object.hasOwn(b, key))
}

export function similarityDistance(event: HistoryEvent, to: number, upstream: Record<string, number>, range: number, spreads: Record<string, number>): number {
    const keys = sharedKeys(upstream, event.upstreamSnapshot)
    const upstreamDistance = keys.length === 0 ? 0 : keys.reduce((sum, key) => sum + Math.abs(upstream[key] - event.upstreamSnapshot[key]) / (spreads[key] || 1), 0) / keys.length
    return Math.abs(event.after - to) / range + 0.5 * upstreamDistance
}

// Two deliberate additions to plain k-nearest:
// - The newest live event is always returned first. Agents must read the latest observation even when a safe run
//   sits far from an unsafe target; it is evidence of what is true now, not proof about the proposed change.
// - Seeded events outside the relevance band are dropped. Otherwise a plant that has never run near `to` would
//   count distant events as similar and the insufficient-history guard could never fire.
export function rankSimilar(input: {
    history: HistoryEvent[]
    componentId: string
    metric: string
    to: number
    upstreamSnapshot: Record<string, number>
    k: number
    limit?: Limit
    liveEventIds: string[]
}): HistoryEvent[] {
    const { componentId, metric, to, upstreamSnapshot, limit } = input
    const k = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(input.k)))
    const candidates = input.history.filter(event => event.componentId === componentId && event.metric === metric)
    if (candidates.length === 0) return []

    const limitRange = limit === undefined ? 0 : limit.max - limit.min
    const range = limitRange > 0 ? limitRange : spreadOf(candidates.map(event => event.after)) || 1
    const spreads: Record<string, number> = {}
    for (const key of Object.keys(upstreamSnapshot)) {
        spreads[key] = spreadOf([upstreamSnapshot[key], ...candidates.flatMap(event => (Object.hasOwn(event.upstreamSnapshot, key) ? [event.upstreamSnapshot[key]] : []))])
    }

    const newestFirst = (a: HistoryEvent, b: HistoryEvent) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)
    const live = new Set(input.liveEventIds)
    const newestLive = candidates.filter(event => live.has(event.id)).sort(newestFirst)[0]

    const ranked = candidates
        .filter(event => event !== newestLive && Math.abs(event.after - to) / range <= RELEVANCE_BAND)
        .map(event => ({ event, distance: similarityDistance(event, to, upstreamSnapshot, range, spreads) }))
        .sort((a, b) => a.distance - b.distance || newestFirst(a.event, b.event))
        .map(({ event }) => event)

    return (newestLive === undefined ? ranked : [newestLive, ...ranked]).slice(0, k)
}
