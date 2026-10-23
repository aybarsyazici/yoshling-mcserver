import saved from "@/data/aion2/semantic-index.json";
import { aionKnowledge, aionKnowledgeStatus } from "./aion2-knowledge";
import { semanticHash, validSemanticIndex } from "../../scripts/aion2-semantic-core.mjs";
import type { AionEvidenceSource, AionRecommendation } from "./aion2-types";

type Chunk = { id: string; ruleId: string | null; kind: string; text: string; classes: string[]; sourceIds: string[] };
type Query = { ruleId: string; matches: { id: string; score: number }[] };
const index = saved as unknown as { chunks: Chunk[]; queries: Query[] };
const ready = validSemanticIndex(saved, semanticHash(aionKnowledge), aionKnowledge.version);

/** Runtime uses the saved model output and reviewed sources; it never calls AWS. */
export function aionPlanEvidence(ruleId: string, className: string, activeStepIds: string[]): Pick<AionRecommendation, "evidenceSources" | "relatedEvidence"> {
  if (aionKnowledgeStatus().status !== "current") return {};
  const rule = aionKnowledge.rules.find((rule) => rule.id === ruleId);
  if (!rule || rule.classes.length && !(rule.classes as string[]).includes(className)) return {};
  const citation = (id: string): AionEvidenceSource | undefined => {
    const source = aionKnowledge.sources.find((source) => source.id === id);
    return source ? { title: source.title, url: source.url, kind: source.kind, reviewedAt: source.reviewedAt } : undefined;
  };
  const sources = rule.sourceIds.map(citation).filter((source): source is AionEvidenceSource => !!source);
  if (!ready) return { evidenceSources: sources, relatedEvidence: [] };
  const query = index.queries.find((query) => query.ruleId === ruleId);
  const related = (query?.matches ?? []).filter((match) => match.score >= 0.4).flatMap((match) => {
    const chunk = index.chunks.find((chunk) => chunk.id === match.id);
    if (!chunk || chunk.kind !== "step" || chunk.ruleId !== ruleId || chunk.classes.length && !chunk.classes.includes(className)) return [];
    const stepId = chunk.id.slice(`step:${ruleId}:`.length);
    if (!activeStepIds.includes(stepId)) return [];
    const step = rule.steps.find((step) => step.id === stepId);
    if (!step) return [];
    const citations = chunk.sourceIds.map(citation).filter((source): source is AionEvidenceSource => !!source);
    return [{ id: chunk.id, title: step.title, text: step.reason ?? step.title, sources: citations }];
  }).slice(0, 3);
  return { evidenceSources: sources, relatedEvidence: related };
}
