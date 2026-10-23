import { createHash } from "node:crypto";
import manifest from "@/data/aion2/checklist.json";
import { validateAionChecklistManifest } from "@/lib/aion2-checklist-validation";
import type { AionCharacterRef, AionChecklist, AionRecommendation } from "@/lib/aion2-types";

export type AionChecklistReport = { scopeKey: string; activityId: string; periodKey: string; revision: number; completedAt: Date | null };
export type AionChecklistChange = { activityId: string; completed: boolean; periodKey: string; revision: string };

export function aionChecklistScope(ref: AionCharacterRef, scope: "server" | "character"): string {
  const identity = scope === "server" ? [ref.region, ref.serverId] : [ref.region, ref.serverId, ref.characterId];
  return `${scope}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** The reviewed EU reset is fixed UTC, independent of Berlin daylight saving. */
export function aionChecklistPeriod(cadence: "daily" | "weekly", now: Date): { periodKey: string; nextResetAt: string } {
  const start = new Date(now);
  start.setUTCHours(7, 0, 0, 0);
  if (start.getTime() > now.getTime()) start.setUTCDate(start.getUTCDate() - 1);
  if (cadence === "weekly") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() - 3 + 7) % 7);
  return { periodKey: `${cadence}:${start.toISOString()}`, nextResetAt: new Date(start.getTime() + (cadence === "daily" ? 1 : 7) * 86_400_000).toISOString() };
}

export function aionChecklist(ref: AionCharacterRef, reports: AionChecklistReport[], now: Date, knowledgeCurrent: boolean, profile?: { level: number }): AionChecklist {
  const valid = validateAionChecklistManifest(manifest).length === 0 && Number.isFinite(now.getTime());
  const reviewed = valid && Date.parse(manifest.reviewedAt) <= now.getTime() && Date.parse(manifest.expiresAt) > now.getTime()
    && manifest.sources.every((source) => Date.parse(source.reviewedAt) <= now.getTime() && Date.parse(source.expiresAt) > now.getTime());
  const supported = ref.region === "eu";
  const status = !supported ? "unverified" : !reviewed || !knowledgeCurrent ? "review-required" : "current";
  if (!valid || !supported) return { status, notice: supported ? "The activity catalog needs review before it can be used." : "Reset activities are not yet reviewed for this region; no EU reset is inferred.", items: [], revision: "unavailable" };
  const items = manifest.activities.filter((activity) => activity.regions.includes(ref.region) && profile && activity.minimumLevel <= profile.level).map((activity) => {
    const cadence = activity.cadence as "daily" | "weekly", scope = activity.scope as "server" | "character";
    const period = aionChecklistPeriod(cadence, now);
    const report = reports.find((row) => row.scopeKey === aionChecklistScope(ref, scope) && row.activityId === activity.id && row.periodKey === period.periodKey);
    return {
      id: activity.id, name: activity.name, cadence, scope, instruction: activity.instruction,
      rewardTags: activity.rewardTags, source: manifest.sources.find((source) => source.id === activity.sourceIds[0])!.url,
      completed: !!report?.completedAt, completedAt: report?.completedAt?.toISOString() ?? null,
      periodKey: period.periodKey, nextResetAt: reviewed ? period.nextResetAt : null,
    };
  });
  const currentRows = items.map((item) => {
    const scopeKey = aionChecklistScope(ref, item.scope);
    const report = reports.find((row) => row.scopeKey === scopeKey && row.activityId === item.id && row.periodKey === item.periodKey);
    return [scopeKey, item.id, item.periodKey, report?.revision ?? 0, item.completedAt];
  });
  const revision = createHash("sha256").update(JSON.stringify([manifest.version, status, currentRows])).digest("hex");
  return {
    status, notice: status === "current" ? "Your reports for this reset. Server activities are shared only with your own characters on this server. Check remaining charges and rewards in game."
      : "Activity sources need a current review. Saved reports remain visible; changes and reset countdowns are withheld.",
    items: items.map((item) => ({ ...item, nextResetAt: status === "current" ? item.nextResetAt : null })), revision,
  };
}

/** Reports annotate repeatable work, never infer that its reward or upgrade happened. */
export function aionChecklistProgress(recommendations: AionRecommendation[], checklist: AionChecklist): AionRecommendation[] {
  return recommendations.map((recommendation) => ({ ...recommendation, steps: recommendation.steps?.map((step) => {
    const linked = step.checklistActivityIds;
    if (checklist.status !== "current" || !linked?.length) return step;
    const reportedDone = linked.every((id) => checklist.items.some((item) => item.id === id && item.completed));
    return { ...step, reportedDone, progressNote: reportedDone ? "Activity reported complete for this reset. Check its actual rewards and the remaining upgrade steps in game." : undefined };
  }) }));
}
