import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AionSnapshot } from "@/lib/aion2-types";
import knowledgeManifest from "@/data/aion2/knowledge.json";
import { validateAionKnowledge } from "@/lib/aion2-knowledge-validation";

const fixture = vi.hoisted(() => {
  const source = { id: "official-armory", title: "Reviewed fixture source", url: "https://aion2.plaync.com/characters", kind: "official-data", reviewedAt: "2026-10-24", expiresAt: "2026-10-28" };
  const priority = (id: string, label: string, focus?: "group" | "solo") => ({ id, label, kind: "skill", rank: 1, reason: "Reviewed class-specific fixture preference", ...(focus ? { focus } : {}) });
  return {
    status: "current",
    catalog: {
      schemaVersion: 1, version: "fixture-cleric", reviewedAt: "2026-10-24", expiresAt: "2026-10-28", regions: ["eu"], classes: ["Gladiator", "Cleric"], sources: [source],
      slotRules: [
        { id: "gladiator-weapon", className: "Gladiator", slots: [1], basis: "Reviewed Gladiator fixture", mechanic: "soulbinding", sourceIds: [source.id], priorities: [priority("11170000", "Overhead Slam")] },
        { id: "cleric-weapon", className: "Cleric", slots: [1], basis: "Cleric group-healing comparison; no role inferred", mechanic: "soulbinding", sourceIds: [source.id], priorities: [priority("17120000", "Reviewed Heal", "group")] },
        { id: "cleric-arcana", className: "Cleric", slots: [41], basis: "Cleric group-healing card comparison", mechanic: "arcana", sourceIds: [source.id], priorities: [priority("17120000", "Reviewed Heal", "group")] },
      ],
      itemPools: [
        { itemId: 500, slots: [1], mechanic: "soulbinding", capability: "random", known: true, stats: [], skills: [{ id: 11170000, label: "Overhead Slam" }], sourceIds: [source.id] },
        { itemId: 500, slots: [1], classes: ["Cleric"], mechanic: "soulbinding", capability: "random", known: true, stats: [], skills: [{ id: 17120000, label: "Reviewed Heal" }], sourceIds: [source.id] },
        { itemId: 600, slots: [41], classes: ["Cleric"], mechanic: "arcana", capability: "random", known: true, stats: [], skills: [{ id: 17120000, label: "Reviewed Heal" }], sourceIds: [source.id] },
      ],
    },
    knowledge: { regions: ["eu"], reviewedAt: "2026-10-24", activities: [], sources: [source], rules: [
      { id: "cleric-support", strategy: "loadout-review", classes: ["Cleric"], focus: "group", title: "Group healing: check your skill loadout", requiredSkillIds: [17120000,17350000], minimumLevel: 45, priority: "high", action: "Review the observed support loadout.", evidence: "Reviewed support baseline", sourceIds: [source.id], steps: [{ id: "support-review", title: "Inspect support Specialties", instruction: "{skillName} level {skillLevel}; {loadoutSummary}", sourceId: source.id }] },
      { id: "cleric-old-breakpoint", strategy: "skill-target", classes: ["Cleric"], focus: "solo", title: "Optional damage: {skillName} to {nextLevel}", skillId: 17350000, target: 12, minimumLevel: 45, priority: "low", action: "Check the reviewed breakpoint.", evidence: "Reviewed fixture breakpoint", sourceIds: [source.id] },
      { id: "gladiator-overhead", strategy: "skill-target", classes: ["Gladiator"], skillId: 11170000, target: 16, minimumLevel: 45, priority: "high", action: "Review Overhead Slam.", evidence: "Gladiator only", sourceIds: [source.id], steps: [{ id: "gladiator-only", title: "Gladiator route", instruction: "Overhead Slam and Rage Burst", sourceId: source.id }] },
    ] },
  };
});
vi.mock("@/lib/aion2-knowledge", () => ({ aionKnowledge: fixture.knowledge, aionKnowledgeStatus: () => ({ status: fixture.status }) }));
vi.mock("@/data/aion2/gear-priorities.json", () => ({ default: fixture.catalog }));
vi.mock("@/lib/aion2-semantic-evidence", () => ({ aionPlanEvidence: () => ({}) }));
import { aionGearPriorities } from "@/lib/aion2-gear-priorities";
import { isAionGearPriorityReport, validateAionGearPriorities } from "@/lib/aion2-gear-validation";
import { aionRecommendations } from "@/lib/aion2-recommendations";
import { aionActionPlan, aionSkillBoardContribution } from "@/lib/aion2-action-plan";

const NOW = new Date("2026-10-24T12:00:00Z");
function snapshot(): AionSnapshot {
  return { version: 1, ref: { region: "eu", serverId: 2322, characterId: "synthetic-cleric" }, observedAt: NOW.toISOString(), profile: { name: "Fixture", serverName: "Fixture", className: "Cleric", level: 45, combatPower: 80000, gearScore: 1697 }, equipment: [{ id: 500, slot: 1, slotName: "MainHand", name: "Reviewed shared fixture item", grade: "Unique", enchantLevel: 10, ampLevel: 0, icon: null, details: { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: true, bindRate: 50, stats: [], skills: [{ id: 17120000, name: "Reviewed Heal", level: 1 }] } }], skills: [{ id: 17120000, name: "Reviewed Heal", category: "Active", level: 12, acquired: true, equipped: false }, { id: 17350000, name: "Condemnation", category: "Active", level: 14, acquired: true, equipped: true }], boards: [71,72,73,74].map(id => ({ id, name: "Observed board", openNodes: 1, totalNodes: 88, skillBonuses: [{ id: 17120000, name: "Reviewed Heal", levels: 1 }] })), stats: [], wing: null, pet: null, coverage: { equipment: true, skills: true, boards: true } };
}
beforeEach(() => { fixture.status = "current"; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe("class-scoped Cleric runtime", () => {
  it("keeps low-priority shared work after higher-priority class guidance", () => {
    const low = { ...fixture.knowledge.rules[0], id: "cleric-low-first", priority: "low" };
    fixture.knowledge.rules.unshift(low);
    try { expect(aionRecommendations(snapshot()).map(rule => rule.id)).toEqual(["cleric-support", "cleric-low-first"]); }
    finally { fixture.knowledge.rules.shift(); }
  });
  it("keeps a support loadout review when skills are already acquired without inventing a Condemnation 12 gap", () => {
    const result = aionRecommendations(snapshot());
    expect(result.map(rule => rule.id)).toEqual(["cleric-support"]);
    expect(result[0].focus).toBe("group");
    expect(result[0].evidence).toContain("Condemnation: level 14, marked equipped");
    expect(result[0].evidence).toContain("Reviewed Heal: level 12, not marked equipped");
    expect(result[0].evidence).toMatch(/not an unmet acquisition goal/);
    expect(result[0].evidence).toMatch(/Specialty selections.*checked in game/);
    expect(result[0].steps?.[0].instruction).toContain("Condemnation: level 14");
    expect(result[0].steps?.[0].instruction).toContain("Reviewed Heal level 12");
    expect(JSON.stringify(result)).not.toMatch(/Overhead Slam|Rage Burst|Unlock Condemnation/);
  });

  it("does not present a support loadout as verified when skill coverage is missing, stale or sources are held", () => {
    const value = snapshot(); value.coverage.skills = false; expect(aionRecommendations(value)).toEqual([]);
    value.coverage.skills = true; value.observedAt = new Date(NOW.getTime() - 31*60_000).toISOString(); expect(aionRecommendations(value)).toEqual([]);
    fixture.status = "review-required"; expect(aionRecommendations(snapshot())).toEqual([]);
  });

  it("keeps class/role titles explicit without changing an existing Gladiator fallback title", () => {
    const value = snapshot(); value.skills[1].level = 11;
    expect(aionRecommendations(value).map(rule => rule.focus)).toEqual(["group","solo"]);
    expect(aionRecommendations(value).find(rule => rule.id === "cleric-old-breakpoint")?.title).toBe("Optional damage: Condemnation to 12");
    value.profile.className = "Gladiator"; value.skills = [{ id: 11170000, name: "Overhead Slam", category: "Active", acquired: true, equipped: true, level: 14 }];
    expect(aionRecommendations(value).find(rule => rule.id === "gladiator-overhead")?.title).toBe("Unlock Overhead Slam's level 16 breakpoint");
  });

  it("reports a missing skill as not returned rather than inventing ownership or a zero level", () => {
    const value = snapshot(); value.skills = [];
    expect(aionRecommendations(value)[0].evidence).toContain("Skill 17120000: not returned; check in game");
    expect(aionRecommendations(value)[0].evidence).not.toContain("level 0");
  });

  it("keeps direct recipe calls class-scoped and counts only the current class's four whiteboards", () => {
    const value = snapshot(); expect(aionActionPlan(value, "gladiator-overhead")).toEqual({});
    expect(aionSkillBoardContribution(value,17120000)).toBe(4);
    value.coverage.boards = false; expect(aionSkillBoardContribution(value,17120000)).toBeNull(); value.coverage.boards = true;
    value.boards[0].id = 11; expect(aionSkillBoardContribution(value,17120000)).toBeNull();
  });

  it("never exposes the legacy MP-discard ring or Rage Burst branches in a Cleric recipe", () => {
    const steps = fixture.knowledge.rules[0].steps! as unknown as Record<string, unknown>[];
    const count = steps.length;
    try {
      steps.push({ id: "wrong-ring", title: "Legacy ring", instruction: "Discard MP: {ringPlan}", sourceId: "official-armory", when: "random-ring" }, { id: "wrong-rage", title: "Legacy Rage", instruction: "Equip Rage Burst", sourceId: "official-armory", when: "rage-burst-missing" });
      const value = snapshot(); value.equipment.push({ ...value.equipment[0], slot: 13, slotName: "Ring1", details: { ...value.equipment[0].details!, stats: [{ name: "MP", value: "100" }], skills: [] } });
      const plan = aionActionPlan(value,"cleric-support");
      expect(plan.steps?.map(step => step.id)).toEqual(["support-review"]);
      expect(JSON.stringify(plan)).not.toMatch(/Discard MP|Rage Burst/);
    } finally { steps.splice(count); }
  });

  it("chooses the Cleric pool for a shared item ID and never substitutes legacy Gladiator skills", () => {
    const value = snapshot(), result = aionGearPriorities(value,NOW);
    expect(validateAionGearPriorities(fixture.catalog)).toEqual([]);
    expect(result.status).toBe("current"); expect(result.items[0].status).toBe("item-pool-verified");
    expect(result.items[0].priorities.map(priority => priority.id)).toEqual(["17120000"]);
    expect(result.items[0].priorities[0].focus).toBe("group");
    expect(result.items[0].currentLines[0].priorityRank).toBe(1);
    expect(isAionGearPriorityReport(result,value.equipment)).toBe(true);
    value.profile.className = "Gladiator";
    expect(aionGearPriorities(value,NOW).items[0].priorities.map(priority => priority.id)).toEqual(["11170000"]);
  });

  it("does not turn a Cleric card reference into a Sync instruction or an observed match", () => {
    const value = snapshot(); value.equipment[0] = { ...value.equipment[0], id: 600, slot: 41, slotName: "Arcana1", details: undefined };
    const row = aionGearPriorities(value,NOW).items[0];
    expect(row.status).toBe("item-pool-reference"); expect(row.currentLines).toEqual([]);
    expect(row.notices.join(" ")).toMatch(/not evidence of Sync\/Reset capability/);
  });

  it("allows disjoint class pools but rejects overlap and undeclared or unsupported classes", () => {
    const overlap = structuredClone(fixture.catalog); overlap.itemPools.push(structuredClone(overlap.itemPools[1]));
    expect(validateAionGearPriorities(overlap).join(" ")).toMatch(/overlap/);
    const unknown = structuredClone(fixture.catalog); unknown.itemPools[1].classes = ["Templar"];
    expect(validateAionGearPriorities(unknown).length).toBeGreaterThan(0);
    const undeclared = structuredClone(fixture.catalog); undeclared.classes = ["Gladiator"];
    expect(validateAionGearPriorities(undeclared).length).toBeGreaterThan(0);
  });

  it("requires scoped unique skill IDs and an explicit title for loadout rules", () => {
    const value = structuredClone(knowledgeManifest) as unknown as { rules: Record<string, unknown>[] };
    const rule = { ...structuredClone(value.rules[0]), id: "cleric-validation-fixture", strategy: "loadout-review", classes: ["Cleric"], title: "Group healing review", requiredSkillIds: [17120000,17350000] };
    value.rules.push(rule); expect(validateAionKnowledge(value)).toEqual([]);
    rule.requiredSkillIds = [17120000,17120000]; expect(validateAionKnowledge(value).join(" ")).toMatch(/loadout review/);
    rule.requiredSkillIds = [17120000]; rule.title = ""; expect(validateAionKnowledge(value).join(" ")).toMatch(/loadout review/);
    const emptyTitle = structuredClone(knowledgeManifest) as unknown as { rules: Record<string, unknown>[] };
    emptyTitle.rules[0].title = ""; expect(validateAionKnowledge(emptyTitle).join(" ")).toMatch(/optional title/);
  });

  it("validates focus metadata without inferring a role or weakening DTO boundaries", () => {
    const input = structuredClone(fixture.catalog);
    (input.slotRules[1].priorities[0] as Record<string, unknown>).focus = "raid";
    expect(validateAionGearPriorities(input).join(" ")).toMatch(/focus/);
    const value = snapshot(), report = aionGearPriorities(value,NOW);
    (report.items[0].priorities[0] as unknown as Record<string, unknown>).focus = "raid";
    expect(isAionGearPriorityReport(report,value.equipment)).toBe(false);
    const manifest = structuredClone(knowledgeManifest) as unknown as { rules: Record<string, unknown>[]; boardPresets: Record<string, unknown>[] };
    manifest.rules[0].focus = "raid"; manifest.boardPresets[0].focus = "healer";
    expect(validateAionKnowledge(manifest).filter(error => /focus/.test(error))).toHaveLength(2);
  });
});
