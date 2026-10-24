import { aionKnowledge, aionKnowledgeStatus } from "./aion2-knowledge";
import type { AionSnapshot, AionRecommendation } from "./aion2-types";
import { aionActionPlan, aionSkillBoardContribution, aionLoadoutSummary, type AionResourceContext } from "./aion2-action-plan";
import { aionPlanEvidence } from "./aion2-semantic-evidence";

export function aionRecommendations(snapshot: AionSnapshot, resources: AionResourceContext = {}): AionRecommendation[] {
  if (aionKnowledgeStatus().status !== "current" || !aionKnowledge.regions.includes(snapshot.ref.region)) return [];
  const observationAge = Date.now() - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observationAge) || observationAge > 30 * 60_000 || observationAge < -5 * 60_000) return [];
  const recommendations: AionRecommendation[] = [];
  const { profile, equipment } = snapshot;
  for (const rule of aionKnowledge.rules) {
    const classes: readonly string[] = rule.classes;
    if (profile.level < rule.minimumLevel || classes.length && !classes.includes(profile.className)) continue;
    let title = "", evidence = "";
    switch (rule.strategy) {
      case "loadout-review": {
        const reviewedRule = rule as typeof rule & { title?: string; requiredSkillIds?: number[] };
        if (!snapshot.coverage.skills || !reviewedRule.title || !reviewedRule.requiredSkillIds?.length) break;
        title = reviewedRule.title;
        evidence = `${aionLoadoutSummary(snapshot, reviewedRule.requiredSkillIds)}. This is a loadout review, not an unmet acquisition goal. Specialty selections and the full hotbar/rotation must be checked in game.`;
        break;
      }
      case "skill-target": {
        const skill = snapshot.coverage.skills && snapshot.skills.find((value) => value.id === rule.skillId);
        if (skill && skill.acquired && rule.target && skill.level < rule.target) {
          const next = "milestones" in rule && rule.milestones ? rule.milestones.find((level) => level > skill.level) ?? rule.target : rule.target;
          title = "title" in rule && typeof rule.title === "string" ? rule.title.replace(/\{nextLevel\}/g, String(next)).replace(/\{skillName\}/g, skill.name) : `Unlock ${skill.name}'s level ${next} breakpoint`;
          const boards = aionSkillBoardContribution(snapshot, skill.id);
          evidence = `${skill.name} is level ${skill.level}; ${next - skill.level} more levels reach ${next}. ${boards === 4 ? `All four ${skill.name} board bonuses are already owned; this route uses cards or gear instead of sending you back to those nodes.` : "The next steps first check your skill-point and board bonuses."}`;
        }
        break;
      }
      case "arcana-slots": {
        // The Gladiator skill plan already includes its targeted Arcana farm.
        if (profile.className === "Gladiator" && snapshot.skills.some((skill) => skill.id === 11170000 && skill.level < 16)) break;
        if (!snapshot.coverage.equipment || profile.gearScore === null || profile.gearScore < (rule.minimumGearScore ?? Infinity)) break;
        const count = equipment.filter((item) => /^Arcana\d*$/i.test(item.slotName)).length;
        if (rule.target && count < rule.target) { title = "Review your Arcana slots"; evidence = `The armory lists ${count} equipped Arcana cards and ${profile.gearScore} Gear Score. The community guide recommends ${rule.target} usable cards.`; }
        break;
      }
      case "starter-guard": {
        if (!snapshot.coverage.equipment) break;
        const ids: readonly number[] = "itemIds" in rule && Array.isArray(rule.itemIds) ? rule.itemIds : [];
        const item = equipment.find((value) => value.slot === 2 && ids.includes(value.id) && value.details?.randomStats === false);
        if (item) {
          title = item.enchantLevel < 10 ? "Use +10 as a temporary guard stopping point" : "Compare an expedition guard before spending more";
          evidence = `${item.name} is +${item.enchantLevel} with fixed Soul Binding lines. ${item.enchantLevel < 10 ? "The reviewed starter baseline stops at +10; check the full material cost first." : "Additional risky enhancement is deferred while you compare a replacement and your complete transfer budget."} An enhancement cap alone does not establish value.`;
        }
        break;
      }
      case "fixed-weapon": {
        const ids: readonly number[] = "itemIds" in rule && Array.isArray(rule.itemIds) ? rule.itemIds : [];
        const item = snapshot.coverage.equipment && equipment.find((value) => value.slot === 1 && ids.includes(value.id) && value.details?.randomStats === false);
        if (item) { title = "Plan your next weapon's stat lines"; evidence = `The armory marks ${item.name}'s soulbind lines as fixed. It does not support random-line rerolling.`; }
        break;
      }
      case "amulet-scrolls":
      case "belt-scrolls": {
        const kind = rule.strategy === "amulet-scrolls" ? "Amulet" : "Belt";
        const ids: readonly number[] = "itemIds" in rule && Array.isArray(rule.itemIds) ? rule.itemIds : [];
        const item = snapshot.coverage.equipment && equipment.find((value) => value.slotName === kind && ids.includes(value.id));
        if (item && rule.target && item.enchantLevel < rule.target) { title = `Review ${kind.toLowerCase()} progression`; evidence = `${item.name} is currently +${item.enchantLevel}. Scroll inventory and reward completion are not public.`; }
        break;
      }
    }
    if (!title) continue;
    const sources = aionKnowledge.sources.filter((source) => rule.sourceIds.includes(source.id));
    const community = sources.some((source) => source.kind === "community-guide" || source.kind === "client-data");
    const requiredIds = "requiredSkillIds" in rule && Array.isArray(rule.requiredSkillIds) ? rule.requiredSkillIds as number[] : [];
    const skill = snapshot.skills.find((value) => value.id === ("skillId" in rule ? rule.skillId : requiredIds[0]));
    const next = skill && "milestones" in rule && rule.milestones ? rule.milestones.find((level) => level > skill.level) ?? rule.target! : ("target" in rule ? rule.target : 20) ?? 20;
    const action = rule.action.replace(/\{nextLevel\}/g, String(next)).replace(/\{missingLevels\}/g, String(Math.max(0, next - (skill?.level ?? 0)))).replace(/\{skillName\}/g, skill?.name ?? "the reviewed skill").replace(/\{skillLevel\}/g, skill ? String(skill.level) : "unavailable").replace(/\{loadoutSummary\}/g, aionLoadoutSummary(snapshot, requiredIds));
    const plan = aionActionPlan(snapshot, rule.id, resources);
    const focus = "focus" in rule && (rule.focus === "group" || rule.focus === "solo") ? rule.focus : undefined;
    recommendations.push({ id: rule.id, priority: rule.priority as AionRecommendation["priority"], ...(focus ? { focus } : {}), title, evidence: `${evidence} ${community ? "Reviewed build / client-data guidance" : "Official item metadata"}; reviewed ${aionKnowledge.reviewedAt}.`, action, source: sources[0].url, ...plan, ...aionPlanEvidence(rule.id, profile.className, plan.steps?.map((step) => step.id) ?? []) });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return recommendations.sort((a, b) => order[a.priority] - order[b.priority]);
}
