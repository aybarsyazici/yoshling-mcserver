export const AION_REGIONS = [
  { id: "eu", name: "Europe" },
  { id: "nae", name: "North America East" },
  { id: "naw", name: "North America West" },
  { id: "la", name: "Latin America" },
  { id: "as", name: "Asia" },
] as const;

export type AionRegion = (typeof AION_REGIONS)[number]["id"];
export type AionServer = { id: number; name: string; race: number | null };
export type AionCharacterRef = { region: AionRegion; serverId: number; characterId: string };
export type AionSearchCharacter = AionCharacterRef & {
  name: string; serverName: string; className: string | null; level: number | null;
};
export type AionEquipment = {
  id: number; slot: number; slotName: string; name: string; grade: string;
  enchantLevel: number; ampLevel: number; icon: string | null;
  details?: {
    maxEnchantLevel: number | null; maxAmpLevel: number | null;
    randomStats: boolean | null; bindRate: number | null;
    stats: { id?: string; name: string; value: string }[];
    skills: { id: number; name: string; level: number }[];
  };
};
export type AionSkill = {
  id: number; name: string; category: string; level: number; equipped: boolean; acquired: boolean;
  icon?: string | null;
};
export type AionBoardNode = {
  id: number; row: number; col: number; name: string; kind: string; grade: string;
  unlocked: boolean; effects: string[]; icon: string | null;
};
export type AionBoard = {
  id: number; name: string; openNodes: number; totalNodes: number;
  skillBonuses?: { id: number; name: string; levels: number }[];
  nodes?: AionBoardNode[];
};
export type AionBoardComparison = {
  boardId: number; label: string; source: string;
  targets: { nodeId: number; reason: string }[];
  pathNodeIds: number[]; missingNodeIds: number[]; cost: number | null; notices: string[];
  nodeCosts?: { nodeId: number; cost: number }[];
};
export type AionSnapshot = {
  version: 1;
  ref: AionCharacterRef;
  observedAt: string;
  profile: {
    name: string; serverName: string; className: string; level: number;
    combatPower: number | null; gearScore: number | null;
    portrait?: string | null;
  };
  equipment: AionEquipment[];
  skills: AionSkill[];
  boards: AionBoard[];
  stats: { type: string; name: string; value: number }[];
  wing: { name: string; grade: string; level: number } | null;
  pet: { name: string; level: number } | null;
  // Public armory observations cannot establish quest, currency or reset progress.
  coverage: { equipment: boolean; skills: boolean; boards: boolean };
};
export type AionRecommendation = {
  id: string; priority: "high" | "medium" | "low";
  title: string; evidence: string; action: string; source: string;
  steps?: AionActionStep[];
  budget?: { available: number | null; costPerRun: number | null; affordableRuns: number | null; updatedAt: string | null };
  evidenceSources?: AionEvidenceSource[];
  relatedEvidence?: { id: string; title: string; text: string; sources: AionEvidenceSource[] }[];
};
export type AionEvidenceSource = { title: string; url: string; kind: string; reviewedAt: string };
export type AionActionStep = {
  id: string; title: string; instruction: string; reason?: string; source?: string;
  cost?: { resource: "odyle"; amount: number };
  status?: "ready" | "blocked" | "manual-check";
  checklistActivityIds?: string[];
  reportedDone?: boolean;
  progressNote?: string;
};
export type AionChecklistItem = {
  id: string; name: string; cadence: "daily" | "weekly"; scope: "character" | "server";
  instruction: string; rewardTags: string[]; source: string;
  completed: boolean; completedAt: string | null; periodKey: string; nextResetAt: string | null;
};
export type AionChecklist = {
  status: "current" | "review-required" | "unverified"; notice: string;
  items: AionChecklistItem[]; revision: string;
};
export type AionHistoryPoint = { observedAt: string; combatPower: number | null; gearScore: number | null };
export type AionGearPriority = { id: string; label: string; kind: "stat" | "skill"; rank: number; reason: string };
export type AionGearPriorityItem = {
  slot: number; slotName: string; itemId: number; itemName: string; basis: string;
  status: "fixed" | "item-pool-verified" | "item-pool-reference" | "slot-reference" | "unverified" | "unsupported";
  priorities: AionGearPriority[];
  currentLines: { label: string; value: string; kind: "stat" | "skill"; priorityRank: number | null }[];
  notices: string[]; sources: AionEvidenceSource[];
};
export type AionGearPriorityReport = {
  version: string; status: "current" | "review-required" | "stale" | "unsupported" | "unverified";
  notice: string; items: AionGearPriorityItem[];
};
export type AionTrackedCharacter = AionCharacterRef & {
  id: string; name: string; serverName: string; tracking: boolean;
  lastAttemptAt: string | null; lastSuccessAt: string | null; nextRefreshAt: string;
  lastError: string | null; snapshot: AionSnapshot | null;
  history: AionHistoryPoint[]; recommendations: AionRecommendation[];
  resources?: { odyleEnergy: number | null; updatedAt: string | null };
  boardPlans?: AionBoardComparison[];
  checklist?: AionChecklist;
  gearPriorities?: AionGearPriorityReport;
};
export type AionKnowledgeStatus = {
  version: string; reviewedAt: string; expiresAt: string;
  checkedAt?: string | null;
  status: "current" | "expired" | "review-required" | "unverified"; supportedClasses: string[]; notices: string[];
};
export type AionCharacterList = { characters: AionTrackedCharacter[]; pollIntervalMs: number; checkedAt: string; knowledge?: AionKnowledgeStatus };

export function isAionRegion(value: unknown): value is AionRegion {
  return AION_REGIONS.some((region) => region.id === value);
}

export const AION_GUIDE_SOURCES = {
  bible: "https://docs.google.com/document/d/11u4wLCG1WfL-xSka2Aze0rI9vYRa7mq3N3Gp1bt0AWY/edit",
  content: "https://docs.google.com/spreadsheets/d/1bNxC1wd0S_ILGYAyWnO0aTo_G_AOrjkv7bTcOj_NRz8/edit#gid=0",
  stats: "https://docs.google.com/spreadsheets/d/1bNxC1wd0S_ILGYAyWnO0aTo_G_AOrjkv7bTcOj_NRz8/edit#gid=1252281452",
};
