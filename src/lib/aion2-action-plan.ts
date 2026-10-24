import { aionKnowledge } from "./aion2-knowledge";
import type { AionActionStep, AionRecommendation, AionSnapshot } from "./aion2-types";
import { aionWhiteBoardIds } from "./aion2-knowledge-validation";

export type AionResourceContext = { odyleEnergy?: number | null; resourcesUpdatedAt?: string | null };
type RecipeStep = { id: string; title: string; instruction: string; reason?: string; sourceId: string; when?: string; activityId?: string; checklistActivityIds?: string[]; cost?: { resource: "odyle"; amount: number } };

const ARCANA_FAMILIES = ["Chalice", "Parchment", "Compass", "Bell", "Mirror"] as const;
/** The five fixed families were checked against official equipped samples and the client guide. */
export function aionMissingArcana(snapshot: AionSnapshot): string[] | null {
  if (!snapshot.coverage.equipment) return null;
  const cards = snapshot.equipment.filter(item => /^Arcana/i.test(item.slotName) || item.slot >= 41 && item.slot <= 45);
  const equipped = new Set<string>();
  for (const card of cards) {
    const index = card.slot - 41, family = ARCANA_FAMILIES[index];
    if (!family || card.slotName !== `Arcana${index + 1}` || !new RegExp(`\\b${family}\\b`, "i").test(card.name) || equipped.has(family)) return null;
    equipped.add(family);
  }
  return ARCANA_FAMILIES.filter(family => !equipped.has(family));
}

/** Public acquired/equipped flags describe the armory observation. They do not
 * establish selected Specialties, a complete hotbar or a working rotation. */
export function aionLoadoutSummary(snapshot: AionSnapshot, skillIds: readonly number[]): string {
  if (!snapshot.coverage.skills) return "Skill observations are unavailable; check the loadout in game.";
  return skillIds.map(id => {
    const skill = snapshot.skills.find(value => value.id === id);
    return skill ? `${skill.name}: ${skill.acquired ? `level ${skill.level}` : "not acquired in the armory"}, ${skill.equipped ? "marked equipped" : "not marked equipped"}` : `Skill ${id}: not returned; check in game`;
  }).join("; ");
}

export function aionActionPlan(snapshot: AionSnapshot, ruleId: string, resources: AionResourceContext = {}): Pick<AionRecommendation, "steps" | "budget"> {
  const rule = aionKnowledge.rules.find((value) => value.id === ruleId);
  if (!rule || !("steps" in rule) || !Array.isArray(rule.steps)) return {};
  if (rule.classes.length && !(rule.classes as readonly string[]).includes(snapshot.profile.className)) return {};
  const recipe = rule.steps as unknown as RecipeStep[];
  const activity = (id?: string) => aionKnowledge.activities.find((value) => value.id === id);
  const primaryCost = activity(recipe.find((step) => step.activityId)?.activityId)?.odylePerClaim ?? null;
  const eligible = (id: string) => { const content = activity(id); return !!content && snapshot.profile.level >= content.minimumLevel && snapshot.profile.gearScore !== null && snapshot.profile.gearScore >= content.minimumGearScore; };
  const loadoutSkillIds = "requiredSkillIds" in rule && Array.isArray(rule.requiredSkillIds) ? rule.requiredSkillIds as number[] : [];
  const primary = "skillId" in rule ? rule : rule.strategy === "loadout-review" ? undefined : aionKnowledge.rules.find((value) => value.strategy === "skill-target" && (value.classes as string[]).includes(snapshot.profile.className));
  const skillId = primary && "skillId" in primary ? primary.skillId : loadoutSkillIds[0];
  const skill = snapshot.skills.find((value) => value.id === skillId);
  const milestones = primary && "milestones" in primary && Array.isArray(primary.milestones) ? primary.milestones : [];
  const firstMilestone = milestones[0] ?? (primary && "target" in primary ? primary.target : 20) ?? 20;
  const nextMilestone = milestones.find((level) => level > (skill?.level ?? 0)) ?? (primary && "target" in primary ? primary.target : 20) ?? 20;
  const white = snapshot.boards.filter((board) => aionWhiteBoardIds(snapshot.profile.className).includes(board.id));
  const boardsKnown = snapshot.coverage.boards && white.length === 4 && white.every((board) => Array.isArray(board.skillBonuses));
  const boardBonus = boardsKnown ? white.reduce((sum, board) => sum + (board.skillBonuses?.find((value) => value.id === skillId)?.levels ?? 0), 0) : null;
  const rings = snapshot.profile.className === "Gladiator" ? snapshot.equipment.filter((item) => [13, 14].includes(item.slot) && item.details?.randomStats === true && !item.details.skills.some(value => value.id === skillId && value.level > 0)) : [];
  const ringPlan = rings.map(ring => {
    const line = ring.details?.stats.find(stat => /flight power|^mp$/i.test(stat.name))?.name ?? "an unwanted non-skill line actually shown on this ring";
    const keepers = ring.details?.skills.map(value => `${value.name} +${value.level}`).join(", ") || "any useful existing skill lines";
    return `${ring.slotName}: ${ring.name} +${ring.enchantLevel} — replace ${line}; preserve ${keepers}.`;
  }).join("\n");
  const missingArcana = aionMissingArcana(snapshot);
  const guard = snapshot.equipment.find(item => item.slot === 2 && item.id === 115030041);
  const weapon = snapshot.equipment.find(item => item.slot === 1);
  const rage = snapshot.skills.find(value => value.id === 11390000);
  const stamp = resources.resourcesUpdatedAt ? Date.parse(resources.resourcesUpdatedAt) : NaN;
  const fresh = Number.isFinite(stamp) && Date.now() - stamp <= 30 * 60_000 && Date.now() >= stamp - 60_000;
  const energy = fresh && Number.isInteger(resources.odyleEnergy) && resources.odyleEnergy! >= 0 && resources.odyleEnergy! <= 10000 ? resources.odyleEnergy! : null;
  const vars: Record<string, string> = {
    skillName: skill?.name ?? "the reviewed skill", skillLevel: skill ? String(skill.level) : "unavailable",
    loadoutSummary: aionLoadoutSummary(snapshot, loadoutSkillIds),
    nextLevel: String(nextMilestone), missingLevels: String(Math.max(0, nextMilestone - (skill?.level ?? 0))),
    gearScore: snapshot.profile.gearScore === null ? "unavailable Gear Score" : snapshot.profile.gearScore.toLocaleString(),
    boardBonus: boardBonus === null ? "not fully available" : `+${boardBonus} levels`,
    ringPlan,
    guardName: guard?.name ?? "verified starter guard", guardUpgrade: String(guard?.enchantLevel ?? "unknown"), weaponUpgrade: String(weapon?.enchantLevel ?? "unknown"),
    missingArcana: missingArcana === null ? "not fully identifiable; inspect the five slots in game" : missingArcana.length ? missingArcana.join(", ") : "none; inspect their actual skill rolls instead",
    rageState: rage?.acquired && rage.equipped ? `Your armory shows Rage Burst equipped at level ${rage.level}` : "Check Rage Burst acquisition and equipment in game",
  };
  const fill = (value: string, content?: (typeof aionKnowledge.activities)[number]) => value.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => name === "activityGearScore" ? content?.minimumGearScore.toLocaleString() ?? "check in game" : name === "activityLevel" ? String(content?.minimumLevel ?? "check in game") : name === "activityCost" ? String(content?.odylePerClaim ?? "check in game") : vars[name] ?? "not available");
  const include = (when?: string) => {
    switch (when) {
      case "boards-incomplete": return !boardsKnown || boardBonus! < 4;
      case "transcendence-eligible": return eligible("shattered-stage1");
      case "urugugu-eligible": return eligible("urugugu-conquest");
      case "random-ring": return rings.length > 0;
      case "ring-materials-needed": return rings.length > 0 && eligible("urugugu-conquest");
      case "below-first-milestone": return !!skill && skill.level < firstMilestone;
      case "at-least-first-milestone": return !!skill && skill.level >= firstMilestone;
      case "energy-not-confirmed": return energy === null || primaryCost === null || energy < primaryCost;
      case "rage-burst-missing": return snapshot.profile.className === "Gladiator" && (!rage?.acquired || !rage.equipped);
      case "shattered-pool-missing": return missingArcana === null || missingArcana.some(family => ["Parchment", "Mirror"].includes(family)) || missingArcana.includes("Chalice") && !missingArcana.some(family => ["Compass", "Bell"].includes(family));
      case "deus-pool-missing": return missingArcana === null || missingArcana.some(family => ["Compass", "Bell"].includes(family));
      case "starter-guard-below-target": return !!guard && guard.enchantLevel < 10;
      case "starter-guard-below-cap": return !!guard && guard.enchantLevel < 15;
      default: return when === undefined;
    }
  };
  const steps: AionActionStep[] = recipe.filter((step) => include(step.when)).map((step) => {
    const source = aionKnowledge.sources.find((source) => source.id === step.sourceId);
    const content = activity(step.activityId);
    const cost = content ? { resource: "odyle" as const, amount: content.odylePerClaim } : step.cost;
    const entryMet = !content || eligible(content.id);
    const entryNotice = entryMet ? "" : `Entry is not confirmed: this activity needs level ${content!.minimumLevel} and ${content!.minimumGearScore.toLocaleString()} Gear Score; the snapshot shows level ${snapshot.profile.level} and ${vars.gearScore}. Complete eligible progression first.\n`;
    return {
      id: step.id, title: fill(step.title, content), instruction: entryNotice + fill(step.instruction, content), reason: "reason" in step ? step.reason : undefined,
      source: source?.url, cost, ...(step.checklistActivityIds ? { checklistActivityIds: step.checklistActivityIds } : {}),
      status: !entryMet ? "blocked" : cost ? energy === null ? "manual-check" : energy >= cost.amount ? "ready" : "blocked" : "manual-check",
    };
  });
  const cubeCost = steps.find((step) => step.cost?.resource === "odyle")?.cost?.amount ?? null;
  return { steps, ...(cubeCost ? { budget: { available: energy, costPerRun: cubeCost, affordableRuns: energy === null ? null : Math.floor(energy / cubeCost), updatedAt: resources.resourcesUpdatedAt ?? null } } : {}) };
}

export function aionSkillBoardContribution(snapshot: AionSnapshot, skillId: number): number | null {
  const white = snapshot.boards.filter((board) => aionWhiteBoardIds(snapshot.profile.className).includes(board.id));
  return snapshot.coverage.boards && white.length === 4 && white.every((board) => board.skillBonuses !== undefined)
    ? white.reduce((sum, board) => sum + (board.skillBonuses?.find((skill) => skill.id === skillId)?.levels ?? 0), 0) : null;
}
