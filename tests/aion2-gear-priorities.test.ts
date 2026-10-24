import { beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "@/data/aion2/gear-priorities.json";
import type { AionEquipment, AionGearPriorityReport, AionSnapshot } from "@/lib/aion2-types";
const fixture = vi.hoisted(() => ({ status: "current" }));
vi.mock("@/lib/aion2-knowledge", () => ({ aionKnowledgeStatus: () => ({ status: fixture.status }) }));
import { aionGearPriorities } from "@/lib/aion2-gear-priorities";
import { isAionGearPriorityReport, validateAionGearPriorities } from "@/lib/aion2-gear-validation";

const NOW = new Date("2026-10-24T12:00:00Z");
function item(id = 110130050, slot = 1, random: boolean | null = true): AionEquipment {
  return { id, slot, slotName: `Slot${slot}`, name: `Observed item ${id}`, grade: "Legend", enchantLevel: 10, ampLevel: 0, icon: null, details: { maxEnchantLevel: 15, maxAmpLevel: 3, randomStats: random, bindRate: 30, stats: [{ name: "Weapon Damage Boost", value: "3.0%" }, { name: "Damage Boost", value: "2%" }, { name: "Critical Attack", value: "+100" }], skills: [{ id: 11170000, name: "Overhead Slam", level: 1 }] } };
}
function snapshot(equipment = [item()]): AionSnapshot {
  return { version: 1, ref: { region: "eu", serverId: 2322, characterId: "fixture-gear-character" }, observedAt: NOW.toISOString(), profile: { name: "Fixture", serverName: "Fixture server", className: "Gladiator", level: 45, gearScore: 1600, combatPower: 70000 }, equipment, skills: [{ id: 11170000, name: "Overhead Slam", category: "Active", level: 14, acquired: true, equipped: true }], boards: [], stats: [], wing: null, pet: null, coverage: { equipment: true, skills: true, boards: true } };
}
function project(character = snapshot()) { return aionGearPriorities(character, NOW); }
beforeEach(() => { fixture.status = "current"; });

describe("reviewed per-item gear comparisons", () => {
  it("validates the curated catalog and produces a client-verifiable exact item projection", () => {
    expect(validateAionGearPriorities(catalog)).toEqual([]);
    const character = snapshot(), result = project(character);
    expect(result.status).toBe("current"); expect(result.items[0].status).toBe("item-pool-verified");
    expect(isAionGearPriorityReport(result, character.equipment)).toBe(true);
    expect(result.items[0].basis).toMatch(/rarity|not.*DPS|not.*damage/i);
    expect(result.items[0].priorities.find((priority) => priority.id === "11170000")).toMatchObject({ kind: "skill", rank: 1 });
  });

  it("filters the generic cloak preference through the exact current item's allowed pool", () => {
    const generic = catalog.slotRules.find((rule) => rule.slots.includes(19))!;
    expect(generic.priorities.some((priority) => priority.id === "perfect-chance")).toBe(true);
    const cloak = project(snapshot([item(210740043, 19)])).items[0];
    expect(cloak.status).toBe("item-pool-verified");
    expect(cloak.priorities.some((priority) => priority.id === "perfect-chance")).toBe(false);
    expect(cloak.notices.join(" ")).toMatch(/line counts.*in game|not.*all.*coexist/i);
  });

  it.each([false, null] as const)("never assigns randomized priorities to the fixed Spiritforged Guard with capability %s", (capability) => {
    const guard = item(115030041, 2, capability);
    if (capability === null) delete guard.details;
    expect(catalog.slotRules.find((rule) => rule.slots.includes(2))!.priorities.some((priority) => priority.kind === "skill")).toBe(true);
    const result = project(snapshot([guard])).items[0];
    expect(result.status).toBe("fixed"); expect(result.priorities).toEqual([]);
    expect(result.currentLines.every((line) => line.priorityRank === null)).toBe(true);
    expect(result.notices.join(" ")).toMatch(/Do not Sync, Reset or reroll/);
  });

  it.each([[215240001,17],[310430047,15],[310440018,16],[310900001,23],[311030001,22]])("keeps fixed special item %s outside generic random-line rules", (id, slot) => {
    const result = project(snapshot([item(id, slot, false)])).items[0];
    expect(result.status).toBe("fixed"); expect(result.priorities).toEqual([]);
  });

  it("fails closed on a fixed-item capability conflict", () => {
    const result = project(snapshot([item(115030041, 2, true)])).items[0];
    expect(result.status).toBe("unverified"); expect(result.priorities).toEqual([]);
    expect(result.notices.join(" ")).toMatch(/conflicts/);
  });

  it("lets an observed fixed flag override a generic random pool", () => {
    const result = project(snapshot([item(110130050, 1, false)])).items[0];
    expect(result.status).toBe("fixed"); expect(result.priorities).toEqual([]);
  });

  it.each(["unknown-item", "wrong-slot", "missing-capability"])("keeps %s as a qualified reference without observed priority badges", (kind) => {
    const piece = item(kind === "unknown-item" ? 999999 : 110130050, kind === "wrong-slot" ? 3 : 1, null);
    if (kind !== "missing-capability") piece.details!.randomStats = true;
    const result = project(snapshot([piece])).items[0];
    expect(result.status).toBe(kind === "missing-capability" ? "item-pool-reference" : "slot-reference"); expect(result.currentLines.every((line) => line.priorityRank === null)).toBe(true);
    expect(result.notices.join(" ")).toMatch(/no reroll|Do not reroll|Compare only/i);
  });

  it("filters reference cloak comparisons through the exact pool even without observed details", () => {
    const cloak = item(210740043, 19); delete cloak.details;
    const character = snapshot([cloak]), result = project(character);
    expect(result.items[0].status).toBe("item-pool-reference"); expect(result.items[0].priorities.length).toBeGreaterThan(0);
    expect(result.items[0].priorities.some((priority) => priority.id === "perfect-chance")).toBe(false);
    expect(result.items[0].currentLines).toEqual([]); expect(result.items[0].notices.join(" ")).toMatch(/Compare only; confirm/);
    expect(isAionGearPriorityReport(result, character.equipment)).toBe(true);
  });

  it("keeps reference Arcana separate from Sync while preserving only actually observed lines", () => {
    const card = item(810160001, 41, null); card.details!.stats = []; card.details!.skills = [{ id: 11750000, name: "Attack Preparation", level: 1 }];
    const result = project(snapshot([card])).items[0];
    expect(result.status).toBe("item-pool-reference"); expect(result.priorities.every((priority) => priority.kind === "skill")).toBe(true);
    expect(result.currentLines).toEqual([{ label: "Attack Preparation", value: "+1", kind: "skill", priorityRank: null }]);
    expect(result.notices.join(" ")).toMatch(/not evidence of Sync\/Reset capability/);
  });

  it("rejects an observed-line badge on a reference comparison", () => {
    const character = snapshot([item(110130050,1,null)]), result = project(character);
    result.items[0].currentLines[0].priorityRank = result.items[0].priorities[0].rank;
    expect(isAionGearPriorityReport(result, character.equipment)).toBe(false);
  });

  it("does not substitute a slot strategy for unreviewed equipment kinds", () => {
    const result = project(snapshot([item(999999, 999)])).items[0];
    expect(result.status).toBe("unsupported"); expect(result.priorities).toEqual([]);
  });

  it("keeps Arcana skill pools separate from Soul Binding actions", () => {
    const card = item(810160001, 41);
    card.details!.stats = []; card.details!.skills = [{ id: 11750000, name: "Attack Preparation", level: 1 }];
    const result = project(snapshot([card])).items[0];
    expect(result.status).toBe("item-pool-verified"); expect(result.priorities.every((priority) => priority.kind === "skill")).toBe(true);
    expect(result.notices.join(" ")).toMatch(/does not establish Sync\/Reset capability/);
    expect(result.notices.join(" ")).toMatch(/Enhancement does not guarantee/);
  });

  it("does not recommend another Overhead level after the reviewed milestone or when skill coverage is unknown", () => {
    const capped = snapshot(); capped.skills[0].level = 20;
    expect(project(capped).items[0].priorities.some((priority) => priority.id === "11170000")).toBe(false);
    const unknown = snapshot(); unknown.coverage.skills = false;
    expect(project(unknown).items[0].priorities.some((priority) => priority.id === "11170000")).toBe(false);
  });

  it("matches exact reported stat lines and preserves values without substring collisions", () => {
    const result = project().items[0], ranks = Object.fromEntries(result.priorities.map((priority) => [priority.id,priority.rank]));
    expect(result.currentLines).toContainEqual({ label: "Weapon Damage Boost", value: "3.0%", kind: "stat", priorityRank: ranks["weapon-damage-boost"] });
    expect(result.currentLines).toContainEqual({ label: "Damage Boost", value: "2%", kind: "stat", priorityRank: ranks["damage-boost"] });
    expect(result.currentLines.find((line) => line.label === "Critical Attack")?.priorityRank).toBeNull();
    expect(result.currentLines.find((line) => line.kind === "skill")).toMatchObject({ label: "Overhead Slam", value: "+1", priorityRank: 1 });
  });

  it("does not attach a rank when a known stat ID contradicts its reported label", () => {
    const piece = item(); piece.details!.stats = [{ id: "damage-boost", name: "Weapon Damage Boost", value: "3%" }];
    expect(project(snapshot([piece])).items[0].currentLines[0].priorityRank).toBeNull();
  });

  it.each(["review-required", "expired", "unverified"])("withholds all ranks under source state %s while preserving observed lines", (status) => {
    fixture.status = status; const result = project();
    expect(result.status).toBe("review-required"); expect(result.items[0].priorities).toEqual([]);
    expect(result.items[0].currentLines[0]).toMatchObject({ label: "Weapon Damage Boost", value: "3.0%", priorityRank: null });
  });

  it("enforces its own review/source dates, even when the shared status is current", () => {
    expect(aionGearPriorities(snapshot(), new Date("2026-10-28T00:00:00Z")).status).toBe("review-required");
    expect(aionGearPriorities(snapshot(), new Date("2026-10-23T23:59:59Z")).status).toBe("review-required");
    const expiry = catalog.sources[0].expiresAt;
    try { catalog.sources[0].expiresAt = "2026-10-24"; expect(project().status).toBe("review-required"); }
    finally { catalog.sources[0].expiresAt = expiry; }
  });

  it.each(["old", "future", "malformed"])("withholds priorities for a %s observation", (kind) => {
    const character = snapshot(); character.observedAt = kind === "old" ? "2026-10-24T11:29:59Z" : kind === "future" ? "2026-10-24T12:05:01Z" : "invalid";
    const result = project(character); expect(result.status).toBe("stale"); expect(result.items[0].priorities).toEqual([]);
  });

  it.each(["Templar", "Ranger"])("does not apply the Gladiator matrix to %s", (className) => {
    const character = snapshot(); character.profile.className = className;
    expect(project(character)).toMatchObject({ status: "unsupported", items: [{ priorities: [] }] });
  });

  it("never substitutes a Gladiator item skill pool for the reviewed Cleric matrix", () => {
    const character = snapshot(); character.profile.className = "Cleric";
    const result = project(character);
    expect(result.status).toBe("current");
    expect(result.items[0].priorities.some(priority => priority.id === "11170000")).toBe(false);
    expect(result.items[0].currentLines.find(line => line.label === "Overhead Slam")?.priorityRank).toBeNull();
  });

  it("requires reviewed region and equipment coverage", () => {
    const character = snapshot(); character.ref.region = "nae";
    expect(project(character).status).toBe("unsupported"); character.ref.region = "eu"; character.coverage.equipment = false;
    expect(project(character).status).toBe("unverified"); expect(aionGearPriorities(null, NOW).items).toEqual([]);
  });
});

describe("gear catalog and client projection validation", () => {
  it.each(["class", "source", "credentialed-url", "pin", "duplicate-slot", "duplicate-item", "mechanic", "negative-rank", "skill-id", "condition", "pool-shape"])("rejects invalid catalog %s", (kind) => {
    const input = structuredClone(catalog);
    if (kind === "class") input.classes = ["Cleric"];
    if (kind === "source") input.slotRules[0].sourceIds = ["unknown"];
    if (kind === "credentialed-url") input.sources[0].url = "https://secret@aion2.gg/";
    if (kind === "pin") input.sources[1].sha256 = "invalid";
    if (kind === "duplicate-slot") input.slotRules.push(input.slotRules[0]);
    if (kind === "duplicate-item") input.itemPools.push(input.itemPools[0]);
    if (kind === "mechanic") input.itemPools[0].mechanic = "fixed";
    if (kind === "negative-rank") input.slotRules[0].priorities[0].rank = -1;
    if (kind === "skill-id") input.slotRules[0].priorities[0].id = "skill name";
    if (kind === "condition") {
      const priority = input.slotRules[0].priorities[0];
      if ("when" in priority && priority.when) priority.when.belowLevel = -1;
      else throw new Error("The reviewed fixture must contain the skill milestone condition");
    }
    if (kind === "pool-shape") input.itemPools[0].stats = "unknown" as unknown as typeof input.itemPools[0]["stats"];
    expect(validateAionGearPriorities(input).length).toBeGreaterThan(0);
  });

  it.each(["wrong-item", "wrong-slot", "duplicate-row", "held-ranks", "fixed-ranks", "bad-line-rank", "bad-source", "bad-basis"])("rejects malformed projection %s", (kind) => {
    const character = snapshot(), result: AionGearPriorityReport = project(character);
    if (kind === "wrong-item") result.items[0].itemId++;
    if (kind === "wrong-slot") result.items[0].slot++;
    if (kind === "duplicate-row") result.items.push(result.items[0]);
    if (kind === "held-ranks") result.status = "review-required";
    if (kind === "fixed-ranks") result.items[0].status = "fixed";
    if (kind === "bad-line-rank") result.items[0].currentLines[0].priorityRank = 999;
    if (kind === "bad-source") result.items[0].sources[0].url = "https://unapproved.invalid/";
    if (kind === "bad-basis") result.items[0].basis = "";
    expect(isAionGearPriorityReport(result, character.equipment)).toBe(false);
  });
});
