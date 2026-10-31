import type { ComponentId, PlantId } from "../../shared/types"

// Terse actor ids allow only [A-Za-z0-9._-], so a ComponentId cannot be an actor id as it stands.
export const COMPANY_ACTOR_ID = "company"

export function componentActorId(componentId: ComponentId): string {
    return componentId.replaceAll("/", ".")
}

export function plantOfComponent(componentId: ComponentId): PlantId {
    return componentId.split("/")[0] as PlantId
}

export function proposalIdFor(plantId: PlantId, sequence: number, nonce: string): string {
    return `${plantId}-p${String(sequence).padStart(5, "0")}-${nonce}`
}

// Cross-plant votes carry the voter's plant in componentId, so routing must use the proposal id.
export function plantOfProposal(proposalId: string): PlantId {
    const match = /^(plant-[a-z0-9]+)-p\d+-/.exec(proposalId)
    if (match === null) throw new Error(`invalid_proposal_id: ${proposalId}`)
    return match[1] as PlantId
}

export function agentIdFor(componentId: ComponentId): string {
    return `agent:${componentId}`
}
