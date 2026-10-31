export type PlantId = "plant-a" | "plant-b";
export type PlantScope = PlantId | "company";
export type ComponentTag = "P-100" | "TK-101" | "LV-101" | "E-101" | "TV-101";
export type ViewMode = "2d" | "3d";
export type Vendor = "codex" | "claude";
export type ComponentStatus = "ok" | "warning" | "critical" | "offline";
export interface Equipment {
  id: string; plantId: PlantId; tag: ComponentTag; name: string; role: string; vendor: Vendor;
  metrics: Record<string, number>; status: ComponentStatus; marginPct: number;
  limits?: Record<string, { min: number; max: number; critical: number }>;
}
export type AgentActivityState = "monitoring" | "thinking" | "reviewing" | "waiting" | "blocked" | "ready" | "observing";
export interface AgentActivity {
  id: string; plantId: PlantId; tag: ComponentTag; vendor: Vendor; role: string;
  equipmentName: string; location: string; state: AgentActivityState;
  task: string; summary: string; latestAction: string; updatedAt: number;
  evidence: string[]; progress: number;
}
export interface PlantViewProps {
  components: Equipment[];
  selected: ComponentTag;
  onSelect: (tag: ComponentTag) => void;
  forecast?: { predicted: number; threshold: number } | null;
  theme?: "light" | "dark";
  activities?: AgentActivity[];
  /** Equipment the operator is pointing at from chat or the harness (hover/focus). */
  highlighted?: ComponentTag | null;
}
export interface TrendPoint { time: number; value: number }
export interface TrendChartProps {
  points: TrendPoint[]; threshold?: number; label: string; unit?: string;
  paused?: boolean; eventLabel?: string; eventAt?: number; onTogglePause?: () => void;
}
export type ProposalStatus = "voting" | "blocked" | "veto_window" | "vetoed" | "executed" | "expired";
export interface ProposalVote { tag: ComponentTag; plantId: PlantId; vote: "yes" | "no"; predicted: number; reason: string; evidence: string[]; predictedMetric?: string }
export interface Proposal {
  id: string; plantId: PlantId; from: number; to: number; status: ProposalStatus;
  proposerTag?: ComponentTag; metric?: string;
  votes: ProposalVote[]; vetoDeadline?: number; parentId?: string; createdAt: number;
}
export interface ChatMessage {
  id: string; channel: string; sender: string; text: string; at: number; vendor?: string;
  plantId?: PlantId; tag?: ComponentTag; kind?: "operator" | "agent" | "system";
  evidence?: string[]; proposalId?: string;
}
export interface HarnessSession {
  id: string; name: string; tag?: ComponentTag; plantId?: PlantId; vendor?: string;
  status: "starting" | "busy" | "idle" | "waiting" | "offline" | "error";
  fidelity?: "exact" | "inferred"; updatedAt?: number;
}
export interface RelayConnection {
  state: "demo" | "connecting" | "connected" | "disconnected" | "error";
  url?: string; error?: string; agentName?: string;
}
export interface RelayConfig { url: string; token: string; agentName?: string; observerToken?: string }
export interface RelayEvent { id: string; type: string; text: string; at: number; agent?: string }
export interface RelaySnapshot {
  connection: RelayConnection; sessions: HarnessSession[]; messages: ChatMessage[]; events: RelayEvent[]; channels: string[];
}
export interface EvidenceItem {
  id: string; kind: "event" | "rule"; title: string; plantId: PlantId;
  at: string; summary: string; before: number; after: number; predicted?: number;
  observed: number; supportIds?: string[];
}
export interface AgentWorkspaceProps {
  layoutResetVersion?: number;
  activities: AgentActivity[];
  onAgentDetails: (tag: ComponentTag, plantId?: PlantId) => void;
  channel: string; onChannelChange: (channel: string) => void;
  selected: ComponentTag; plantId: PlantId; onSelect: (tag: ComponentTag, plantId?: PlantId) => void;
  messages: ChatMessage[]; proposal: Proposal | null;
  onSend: (text: string, channel: string) => void | Promise<void>;
  onVeto: () => void; onEvidence: (id: string) => void;
  /** Hover/focus on a message, mention chip, or harness row points at equipment; null clears it. */
  onHighlight?: (tag: ComponentTag | null, plantId?: PlantId) => void;
}
