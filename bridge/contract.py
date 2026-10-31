"""Pydantic v2 mirror of the frozen ActorRelay data contract."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


PlantId = Literal["plant-a", "plant-b"]
Role = Literal["mechanic", "process_engineer", "chemical_engineer", "safety"]
Vendor = Literal["claude", "codex", "gemini"]
Status = Literal["ok", "warning", "critical", "offline"]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Limit(ContractModel):
    min: float
    max: float
    critical: float


class ComponentState(ContractModel):
    id: str
    plantId: PlantId
    tag: str
    name: str
    model: str
    role: Role
    vendor: Vendor
    metrics: dict[str, float]
    limits: dict[str, Limit]
    upstream: list[str]
    downstream: list[str]
    sharedResources: list[str]
    status: Status
    marginPct: float
    lastTick: str


class HistoryEffect(ContractModel):
    componentId: str
    metric: str
    before: float
    after: float
    ticksToSettle: int


class HistoryEvent(ContractModel):
    id: str
    at: str
    plantId: PlantId
    componentId: str
    metric: str
    before: float
    after: float
    upstreamSnapshot: dict[str, float]
    effects: list[HistoryEffect]
    incident: str | None
    approvedBy: list[str]
    operator: str | None
    proposalId: str | None


class CalibrationEntry(ContractModel):
    at: str
    proposalId: str
    metric: str
    predicted: float
    observed: float
    absError: float


class RuleCondition(ContractModel):
    componentId: str | None
    metric: str
    op: Literal[">=", "<="]
    value: float


class RuleConsequence(ContractModel):
    componentId: str | None
    metric: str
    op: Literal[">=", "<="]
    value: float
    withinTicks: int


class LearnedRule(ContractModel):
    id: str
    scope: Literal["component", "plant", "company"]
    model: str | None
    text: str
    condition: RuleCondition
    consequence: RuleConsequence
    supportEventIds: list[str]
    timesSeen: int
    createdAt: str
    lastSeenAt: str


class Vote(ContractModel):
    proposalId: str
    componentId: str
    agentId: str
    vote: Literal["yes", "no"]
    reason: str
    predicted: dict[str, float]
    marginPct: float
    evidenceEventIds: list[str]
    evidenceRuleIds: list[str]
    similarCount: int


class Proposal(ContractModel):
    id: str
    at: str
    plantId: PlantId
    proposerComponentId: str
    proposerAgentId: str
    metric: str
    from_: float = Field(alias="from")
    to: float
    rationale: str
    requiredVoters: list[str]
    votes: list[Vote]
    status: Literal["voting", "blocked", "veto_window", "vetoed", "executed", "expired"]
    vetoDeadline: str | None
    parentProposalId: str | None
    crossPlant: bool


class AuditEntry(ContractModel):
    at: str
    plantId: PlantId | Literal["company"]
    kind: Literal["proposal", "vote", "veto", "execute", "block", "incident", "rule_learned", "calibration"]
    refId: str
    summary: str
    by: str


class PlantState(ContractModel):
    id: PlantId
    name: str
    components: list[str]
    proposals: list[Proposal]
    history: list[HistoryEvent]
    rules: list[LearnedRule]
    audit: list[AuditEntry]
    tick: int
    connected: bool


class SharedResource(ContractModel):
    id: str
    name: str
    components: list[str]


class CompanyState(ContractModel):
    plants: list[PlantId]
    sharedResources: list[SharedResource]
    rules: list[LearnedRule]
    crossPlantProposals: list[str]
    audit: list[AuditEntry]


class PlantSeed(ContractModel):
    id: PlantId
    name: str
    components: list[str]


class PlantsSeed(ContractModel):
    plants: list[PlantSeed]
    components: list[ComponentState]
    sharedResources: list[SharedResource]
