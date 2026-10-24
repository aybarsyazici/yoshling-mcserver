import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AionBoardNode, AionSnapshot } from "@/lib/aion2-types";
import knowledgeManifest from "@/data/aion2/knowledge.json";
import { aionWhiteBoardIds, validateAionKnowledge } from "@/lib/aion2-knowledge-validation";

const fixture = vi.hoisted(() => ({ manifest: {} as Record<string, unknown>, status: "current" }));
vi.mock("@/lib/aion2-knowledge", () => ({ aionKnowledge: fixture.manifest, aionKnowledgeStatus: () => ({ status: fixture.status }) }));
import { aionBoardPlan } from "@/lib/aion2-board-plan";

const NOW = new Date("2026-10-23T12:00:00Z");
const model = { adjacency: "orthogonal-grid", nodeCosts: { Common: 1, Rare: 2, Legend: 3, Unique: 4 }, startKind: "Start", sourceId: "board-guide" };
function node(id: number, row: number, col: number, name: string, grade = "Common", unlocked = false, kind = "Stat"): AionBoardNode {
  return { id, row, col, name, grade, unlocked, kind, effects: name ? [`${name} +1`] : [], icon: null };
}
const start = () => node(1, 0, 0, "Board Start", "None", false, "Start");
function snapshot(nodes: AionBoardNode[]): AionSnapshot {
  return {
    version: 1, ref: { region: "eu", serverId: 2322, characterId: "character-identifier" }, observedAt: NOW.toISOString(),
    profile: { name: "Example", serverName: "Atiel", className: "Gladiator", level: 45, combatPower: 73881, gearScore: 1638 },
    boards: [{ id: 14, name: "Triniel", openNodes: nodes.filter((value) => value.unlocked).length, totalNodes: nodes.length, nodes }],
    equipment: [], skills: [], stats: [], wing: null, pet: null,
    coverage: { equipment: true, skills: true, boards: true },
  };
}
function baseline(overrides: Record<string, unknown> = {}) {
  fixture.manifest.boardPresets = [{
    id: "gladiator-pve-skills", className: "Gladiator", label: "Gladiator PvE: skills first", sourceIds: ["board-guide"], reviewedAt: "2026-10-23", expiresAt: "2026-11-06", boardIds: [11, 12, 13, 14],
    targets: [{ effect: "Overhead Slam", reason: "Raise the core active skill" }, { effect: "Rending Blow", reason: "Raise the reviewed supporting active" }], pathModel: structuredClone(model), ...overrides,
  }];
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); fixture.status = "current";
  fixture.manifest.regions = ["eu"];
  fixture.manifest.sources = [{ id: "board-guide", url: "https://aion2.gg/builds/gladiator/daevanion", reviewedAt: "2026-10-23", expiresAt: "2026-11-06" }];
  baseline();
});
afterEach(() => vi.useRealTimers());

describe("reviewed board comparison", () => {
  it("uses only exact reviewed Cleric whiteboards for a Cleric preset and crystal route", () => {
    baseline({ id: "cleric-support", className: "Cleric", focus: "group", label: "Cleric group healing", boardIds: [71,72,73,74], targets: [{ effect: "Radiant Recovery", reason: "Reviewed group healing skill" }] });
    const value = snapshot([start(), node(2, 0, 1, "HP"), node(3, 0, 2, "Radiant Recovery", "Rare")]);
    value.profile.className = "Cleric"; value.boards[0].id = 74;
    expect(aionBoardPlan(value)[0]).toMatchObject({ boardId: 74, focus: "group", label: "Cleric group healing", pathNodeIds: [2,3], cost: 3 });
    value.boards[0].id = 14; expect(aionBoardPlan(value)).toEqual([]);
    value.boards[0].id = 76; expect(aionBoardPlan(value)).toEqual([]);
    baseline({ className: "Cleric", boardIds: [11,12,13,14], targets: [{ effect: "Radiant Recovery", reason: "Reviewed group healing skill" }] }); value.boards[0].id = 14;
    expect(aionBoardPlan(value)).toEqual([]);
  });

  it("withholds an unrecognized preset focus instead of assigning a playstyle", () => {
    baseline({ focus: "healer" });
    expect(aionBoardPlan(snapshot([start(),node(2,0,1,"Overhead Slam")]))).toEqual([]);
  });

  it("does not infer whiteboard IDs from unknown class names", () => {
    expect(aionWhiteBoardIds("Cleric")).toEqual([71,72,73,74]);
    expect(aionWhiteBoardIds("Gladiator")).toEqual([11,12,13,14]);
    expect(aionWhiteBoardIds("Templar")).toEqual([]); expect(aionWhiteBoardIds("cleric")).toEqual([]);
  });
  it("compares actual owned targets instead of treating summary completion percent as missing skills", () => {
    const value = snapshot([start(), node(2, 0, 1, "Overhead Slam", "Legend", true), node(3, 0, 2, "Rending Blow", "Legend", true)]);
    value.boards[0].openNodes = 2; value.boards[0].totalNodes = 116;
    const plan = aionBoardPlan(value)[0];
    expect(plan.targets.map((target) => target.nodeId)).toEqual([2, 3]);
    expect(plan.missingNodeIds).toEqual([]);
    expect(plan.pathNodeIds).toEqual([]);
    expect(plan.cost).toBe(0);
  });

  it("uses the free Start root even though its public open flag is false", () => {
    const plan = aionBoardPlan(snapshot([start(), node(2, 0, 1, "HP"), node(3, 0, 2, "Overhead Slam", "Rare")]))[0];
    expect(plan.missingNodeIds).toEqual([3]);
    expect(plan.pathNodeIds).toEqual([2, 3]);
    expect(plan.cost).toBe(3);
  });

  it("chooses lower crystal cost over a shorter hop count", () => {
    const value = snapshot([start(), node(2, 0, 1, "Expensive connector", "Unique"), node(3, 0, 2, "Overhead Slam", "Unique"), node(4, 1, 0, "HP"), node(5, 1, 1, "MP"), node(6, 1, 2, "Attack")]);
    const plan = aionBoardPlan(value)[0];
    expect(plan.pathNodeIds).toEqual([4, 5, 6, 3]);
    expect(plan.cost).toBe(7);
  });

  it("reuses already selected connecting nodes without double charging them", () => {
    const value = snapshot([start(), node(2, 0, 1, "HP"), node(3, 0, 2, "Overhead Slam", "Rare"), node(4, 1, 1, "Rending Blow", "Rare")]);
    const plan = aionBoardPlan(value)[0];
    expect(plan.pathNodeIds).toEqual([2, 3, 4]);
    expect(plan.cost).toBe(5);
    expect(plan.notices.join(" ")).toContain("not guaranteed globally optimal");
  });

  it("uses all currently owned nodes as free roots and never proposes removing one", () => {
    const value = snapshot([start(), node(2, 8, 8, "Previously acquired node", "Unique", true), node(3, 8, 9, "Overhead Slam", "Legend")]);
    const original = JSON.stringify(value);
    const plan = aionBoardPlan(value)[0];
    expect(plan.pathNodeIds).toEqual([3]); expect(plan.cost).toBe(3);
    expect(JSON.stringify(value)).toBe(original);
  });

  it("matches exact node names or effect prefixes without confusing similarly named effects", () => {
    const target = node(3, 0, 2, "Skill Level Up - Overhead Slam", "Legend", true, "SkillLevel"); target.effects = ["Overhead Slam +1"];
    const value = snapshot([start(), node(2, 0, 1, "Overhead Slam Resist", "Common", true), target, node(4, 1, 0, "Not Overhead Slam", "Common", true)]);
    expect(aionBoardPlan(value)[0].targets.map((target) => target.nodeId)).toEqual([3]);
  });

  it("keeps reviewed target identity when the link/cost model is absent", () => {
    baseline({ pathModel: undefined });
    const plan = aionBoardPlan(snapshot([start(), node(2, 0, 1, "Overhead Slam", "Legend")]))[0];
    expect(plan.missingNodeIds).toEqual([2]); expect(plan.pathNodeIds).toEqual([]); expect(plan.cost).toBeNull();
    expect(plan.notices.join(" ")).toContain("unverified");
  });

  it.each([
    { ...model, adjacency: "diagonal-grid" }, { ...model, sourceId: "unreviewed-source" }, { ...model, nodeCosts: { Common: 1 } },
  ])("does not infer paths from an unsupported or incomplete model: %j", (pathModel) => {
    baseline({ pathModel });
    const plan = aionBoardPlan(snapshot([start(), node(2, 0, 1, "Overhead Slam", "Legend")]))[0];
    expect(plan.cost).toBeNull(); expect(plan.pathNodeIds).toEqual([]);
  });

  it("does not turn diagonal proximity into a connection", () => {
    const plan = aionBoardPlan(snapshot([start(), node(2, 1, 1, "Overhead Slam", "Rare")]))[0];
    expect(plan.cost).toBeNull(); expect(plan.pathNodeIds).toEqual([]);
    expect(plan.notices.join(" ")).toContain("could not be connected");
  });

  it("treats unknown locked grades as unknown cost instead of silently using a cheap default", () => {
    const plan = aionBoardPlan(snapshot([start(), node(2, 0, 1, "Overhead Slam", "FutureGrade")]))[0];
    expect(plan.cost).toBeNull(); expect(plan.pathNodeIds).toEqual([]);
  });

  it("does not construct a path without the reviewed free root or with ambiguous coordinates", () => {
    expect(aionBoardPlan(snapshot([node(2, 0, 1, "Overhead Slam", "Rare")]))[0].cost).toBeNull();
    expect(aionBoardPlan(snapshot([start(), node(2, 0, 1, "Overhead Slam", "Rare"), node(3, 0, 1, "Duplicate position")]))[0].cost).toBeNull();
  });

  it("does not compare boards with ambiguous duplicate IDs or unavailable node details", () => {
    expect(aionBoardPlan(snapshot([start(), node(2, 0, 1, "Overhead Slam"), node(2, 1, 0, "Other")]))).toEqual([]);
    const value = snapshot([]); value.boards[0].nodes = undefined;
    expect(aionBoardPlan(value)).toEqual([]);
  });

  it.each(["unverified", "expired", "review-required"])("withholds guidance while knowledge is %s", (status) => {
    fixture.status = status;
    expect(aionBoardPlan(snapshot([start(), node(2, 0, 1, "Overhead Slam")]))).toEqual([]);
  });

  it("withholds expired/future presets and unreviewed source references", () => {
    const value = snapshot([start(), node(2, 0, 1, "Overhead Slam")]);
    baseline({ expiresAt: "2026-10-22" }); expect(aionBoardPlan(value)).toEqual([]);
    baseline({ reviewedAt: "2026-10-24" }); expect(aionBoardPlan(value)).toEqual([]);
    baseline({ sourceIds: ["missing"] }); expect(aionBoardPlan(value)).toEqual([]);
  });

  it("never applies Gladiator guidance to another class or unknown board coverage", () => {
    const value = snapshot([start(), node(2, 0, 1, "Overhead Slam")]);
    value.profile.className = "Templar"; expect(aionBoardPlan(value)).toEqual([]);
    value.profile.className = "Gladiator"; value.coverage.boards = false; expect(aionBoardPlan(value)).toEqual([]);
  });

  it("never applies the whiteboard crystal model to an Azphel board with matching effect names", () => {
    const value = snapshot([start(), node(2, 0, 1, "Overhead Slam")]);
    value.boards[0].id = 16; value.boards[0].name = "Azphel";
    expect(aionBoardPlan(value)).toEqual([]);
    baseline({ boardIds: undefined }); value.boards[0].id = 14;
    expect(aionBoardPlan(value)).toEqual([]);
  });

  it.each([31 * 60_000, -6 * 60_000])("withholds guidance for stale or future observations (%dms)", (age) => {
    const value = snapshot([start(), node(2, 0, 1, "Overhead Slam")]);
    value.observedAt = new Date(NOW.getTime() - age).toISOString();
    expect(aionBoardPlan(value)).toEqual([]);
  });

  it("compares the captured official Triniel board and includes every connecting node's cost", () => {
    baseline({ targets: [
      "Overhead Slam", "Rending Blow", "Ruinous Blow", "Crushing Wave", "Experienced Counterstrike", "Attack Preparation", "Murderous Burst", "Identify Weakness", "Impact Hit", "Combat Speed", "Cooldown Reduction", "Damage Boost", "Critical Damage Boost", "Multi-hit Chance",
    ].map((effect) => ({ effect, reason: "Reviewed Gladiator PvE priority" })) });
    const plan = aionBoardPlan(snapshot(capturedTrinielNodes()))[0];
    expect(plan.missingNodeIds).toEqual([140187, 140197]);
    expect(plan.pathNodeIds).toEqual([140184, 140185, 140186, 140187, 140182, 140197]);
    expect(plan.cost).toBe(12);
    expect(plan.notices.join(" ")).toContain("available Daevanion Crystals");
  });
});

describe("reviewed board preset configuration", () => {
  it("validates Cleric board scopes and rejects another class's boards or Azphel", () => {
    const value = structuredClone(knowledgeManifest);
    const entry = { ...structuredClone(value.boardPresets[0]), id: "cleric-reviewed-test", className: "Cleric", boardIds: [71,72,73,74] };
    value.boardPresets.push(entry);
    expect(validateAionKnowledge(value)).toEqual([]);
    entry.boardIds = [11,12,13,14]; expect(validateAionKnowledge(value).join(" ")).toMatch(/whiteboards/);
    entry.boardIds = [76]; expect(validateAionKnowledge(value).join(" ")).toMatch(/whiteboards/);
  });
  it("accepts the checked-in reviewed board preset", () => {
    expect(validateAionKnowledge(knowledgeManifest)).toEqual([]);
  });

  it.each(["missing-board-scope", "wrong-currency-board", "duplicate-board", "unknown-source", "empty-target", "duplicate-target", "invalid-period", "wrong-cost", "unknown-grade", "wrong-adjacency", "wrong-start", "unknown-model-source", "duplicate-preset", "empty-class"])("fails closed for %s", (kind) => {
    const value = structuredClone(knowledgeManifest);
    const preset = value.boardPresets[0];
    if (kind === "missing-board-scope") delete (preset as Record<string, unknown>).boardIds;
    else if (kind === "wrong-currency-board") preset.boardIds = [16];
    else if (kind === "duplicate-board") preset.boardIds = [14, 14];
    else if (kind === "unknown-source") preset.sourceIds = ["missing"];
    else if (kind === "empty-target") preset.targets[0].effect = "";
    else if (kind === "duplicate-target") preset.targets.push(structuredClone(preset.targets[0]));
    else if (kind === "invalid-period") preset.expiresAt = "2026-02-30";
    else if (kind === "wrong-cost") preset.pathModel.nodeCosts.Common = 0;
    else if (kind === "unknown-grade") (preset.pathModel.nodeCosts as Record<string, number>).Unknown = 1;
    else if (kind === "wrong-adjacency") preset.pathModel.adjacency = "diagonal-grid";
    else if (kind === "wrong-start") preset.pathModel.startKind = "Other";
    else if (kind === "unknown-model-source") preset.pathModel.sourceId = "missing";
    else if (kind === "duplicate-preset") value.boardPresets.push(structuredClone(preset));
    else preset.className = "";
    expect(validateAionKnowledge(value).some((error) => /Board preset|board preset/.test(error))).toBe(true);
  });
});

/** Public API capture, 2026-10-23: non-empty nodes from boardId 14.
 * Includes all owned/locked nodes, coordinates, grades and effects; no edges are
 * invented by this fixture. Connections come only from the explicit test model.
 */
function capturedTrinielNodes(): AionBoardNode[] {
  const values: [number, number, number, string, string, number, string, string[]][] = [
    [140018, 2, 3, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140019, 2, 4, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140017, 2, 2, "Stat", "Unique", 0, "Multi-Hit Resist", ["Multi-hit Resist +1.5%"]],
    [140022, 2, 7, "Stat", "Common", 1, "Attack", ["Attack Bonus +3"]],
    [140023, 2, 8, "Stat", "Unique", 1, "Multi-Hit Chance", ["Multi-hit Chance +1.5%"]],
    [140027, 2, 12, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140024, 2, 9, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140028, 2, 13, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140029, 2, 14, "Stat", "Unique", 0, "Multi-Hit Resist", ["Multi-hit Resist +1.5%"]],
    [140034, 3, 4, "SkillLevel", "Legend", 1, "Skill Level Up - Mocking Blade", ["Mocking Blade +1"]],
    [140035, 3, 5, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140032, 3, 2, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140039, 3, 9, "SkillLevel", "Rare", 1, "Skill Level Up - Impact Hit", ["Impact Hit +1"]],
    [140036, 3, 6, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140037, 3, 7, "SkillLevel", "Rare", 1, "Skill Level Up - Murderous Burst", ["Murderous Burst +1"]],
    [140042, 3, 12, "SkillLevel", "Legend", 1, "Skill Level Up - Rending Blow", ["Rending Blow +1"]],
    [140040, 3, 10, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140041, 3, 11, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140047, 4, 2, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140044, 3, 14, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140049, 4, 4, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140054, 4, 9, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140052, 4, 7, "Stat", "Common", 1, "Defense", ["Defense Bonus +30"]],
    [140053, 4, 8, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140059, 4, 14, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140057, 4, 12, "Stat", "Common", 1, "Attack", ["Attack Bonus +3"]],
    [140062, 5, 2, "SkillLevel", "Legend", 1, "Skill Level Up - Sword Aura Rampage", ["Sword Aura Rampage +1"]],
    [140063, 5, 3, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140066, 5, 6, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140067, 5, 7, "Stat", "Common", 1, "Attack", ["Attack Bonus +3"]],
    [140064, 5, 4, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140065, 5, 5, "SkillLevel", "Rare", 1, "Skill Level Up - Protection Armor", ["Protection Armor +1"]],
    [140070, 5, 10, "SkillLevel", "Legend", 1, "Skill Level Up - Rush Strike", ["Rush Strike +1"]],
    [140071, 5, 11, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140069, 5, 9, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140074, 5, 14, "SkillLevel", "Rare", 1, "Skill Level Up - Identify Weakness", ["Identify Weakness +1"]],
    [140072, 5, 12, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140073, 5, 13, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140079, 6, 4, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140081, 6, 6, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140085, 6, 10, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140088, 6, 13, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140094, 7, 4, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140095, 7, 5, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140092, 7, 2, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140093, 7, 3, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140098, 7, 8, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140099, 7, 9, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140096, 7, 6, "SkillLevel", "Legend", 1, "Skill Level Up - Crushing Wave", ["Crushing Wave +1"]],
    [140097, 7, 7, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140102, 7, 12, "SkillLevel", "Rare", 1, "Skill Level Up - Destructive Impulse", ["Destructive Impulse +1"]],
    [140103, 7, 13, "Stat", "Common", 1, "Defense", ["Defense Bonus +30"]],
    [140100, 7, 10, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140101, 7, 11, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140107, 8, 2, "SkillLevel", "Legend", 1, "Skill Level Up - Aerial Snare", ["Aerial Snare +1"]],
    [140104, 7, 14, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140111, 8, 6, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140109, 8, 4, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140115, 8, 10, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140113, 8, 8, "Start", "None", 0, "Triniel - Start", [""]],
    [140119, 8, 14, "SkillLevel", "Legend", 1, "Skill Level Up - Ruinous Blow", ["Ruinous Blow +1"]],
    [140117, 8, 12, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140122, 9, 2, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140123, 9, 3, "Stat", "Common", 1, "Attack", ["Attack Bonus +3"]],
    [140126, 9, 6, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140127, 9, 7, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140124, 9, 4, "SkillLevel", "Rare", 1, "Skill Level Up - Attack Preparation", ["Attack Preparation +1"]],
    [140125, 9, 5, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140130, 9, 10, "SkillLevel", "Legend", 1, "Skill Level Up - Overhead Slam", ["Overhead Slam +1"]],
    [140131, 9, 11, "Stat", "Common", 1, "Defense", ["Defense Bonus +30"]],
    [140128, 9, 8, "Stat", "Common", 1, "Attack", ["Attack Bonus +3"]],
    [140129, 9, 9, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140134, 9, 14, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140132, 9, 12, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140133, 9, 13, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140138, 10, 3, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140141, 10, 6, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140147, 10, 12, "Stat", "Common", 1, "Attack", ["Attack Bonus +3"]],
    [140145, 10, 10, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140154, 11, 4, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140155, 11, 5, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140152, 11, 2, "SkillLevel", "Rare", 1, "Skill Level Up - Blood Absorption", ["Blood Absorption +1"]],
    [140153, 11, 3, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140159, 11, 9, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140156, 11, 6, "SkillLevel", "Legend", 0, "Skill Level Up - Ankle Slice", ["Ankle Slice +1"]],
    [140157, 11, 7, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140162, 11, 12, "Stat", "Common", 1, "Max HP", ["HP +100"]],
    [140163, 11, 13, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140160, 11, 10, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140161, 11, 11, "SkillLevel", "Rare", 0, "Skill Level Up - Survival Stance", ["Survival Stance +1"]],
    [140167, 12, 2, "Stat", "Common", 1, "Critical Hit", ["Critical Hit +5"]],
    [140164, 11, 14, "SkillLevel", "Legend", 1, "Skill Level Up - Defiance", ["Defiance +1"]],
    [140169, 12, 4, "Stat", "Common", 1, "Defense", ["Defense Bonus +30"]],
    [140174, 12, 9, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140172, 12, 7, "Stat", "Common", 0, "Critical Hit", ["Critical Hit +5"]],
    [140173, 12, 8, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140179, 12, 14, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140177, 12, 12, "Stat", "Common", 1, "Max MP", ["MP +50"]],
    [140182, 13, 2, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140186, 13, 6, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140187, 13, 7, "SkillLevel", "Rare", 0, "Skill Level Up - Experienced Counterstrike", ["Experienced Counterstrike +1"]],
    [140184, 13, 4, "SkillLevel", "Legend", 0, "Skill Level Up - Leaping Slam", ["Leaping Slam +1"]],
    [140185, 13, 5, "Stat", "Common", 0, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140190, 13, 10, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140191, 13, 11, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140189, 13, 9, "SkillLevel", "Rare", 0, "Skill Level Up - Survival Willpower", ["Survival Willpower +1"]],
    [140194, 13, 14, "Stat", "Common", 0, "Max HP", ["HP +100"]],
    [140192, 13, 12, "SkillLevel", "Legend", 1, "Skill Level Up - Keen Strike", ["Keen Strike +1"]],
    [140198, 14, 3, "Stat", "Common", 0, "Max MP", ["MP +50"]],
    [140199, 14, 4, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140197, 14, 2, "Stat", "Unique", 0, "Multi-Hit Chance", ["Multi-hit Chance +1.5%"]],
    [140202, 14, 7, "Stat", "Common", 0, "Attack", ["Attack Bonus +3"]],
    [140203, 14, 8, "Stat", "Unique", 0, "Multi-Hit Resist", ["Multi-hit Resist +1.5%"]],
    [140207, 14, 12, "Stat", "Common", 1, "Critical Hit Resist", ["Critical Hit Resist +5"]],
    [140204, 14, 9, "Stat", "Common", 0, "Defense", ["Defense Bonus +30"]],
    [140208, 14, 13, "Stat", "Common", 1, "Defense", ["Defense Bonus +30"]],
    [140209, 14, 14, "Stat", "Unique", 1, "Multi-Hit Chance", ["Multi-hit Chance +1.5%"]]
  ];
  return values.map(([id, row, col, kind, grade, open, name, effects]) => ({ id, row, col, kind, grade, unlocked: open === 1, name, effects, icon: null }));
}
