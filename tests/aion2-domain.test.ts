import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import originalManifest from "@/data/aion2/knowledge.json";
import originalTimers from "@/data/aion2/timers.json";
import originalChecklist from "@/data/aion2/checklist.json";
import originalGear from "@/data/aion2/gear-priorities.json";
import type { AionCharacterRef, AionSnapshot } from "@/lib/aion2-types";

const NOW = new Date("2026-10-23T12:00:00Z");
const REF: AionCharacterRef = { region: "eu", serverId: 2322, characterId: "fixturecharacteridentifier=" };
const fetchMock = vi.fn<typeof fetch>();
const GUIDE_BYTES = Buffer.from("\uFEFFReviewed fixture guide\r\n", "utf8");
let testManifest: typeof originalManifest;
let testTimers: typeof originalTimers;
let testChecklist: typeof originalChecklist;
let testGear: typeof originalGear;
const patchBody = (id: string) => `<p>Reviewed fixture patch ${id}</p>`;
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

type PatchFeed = { contentList: { id: string; timestamps: { updatedAt: string } }[] };
function knowledgeReply(input: string, feed: PatchFeed): Response {
  if (input === testManifest.patchFeed) return reply(feed);
  const patch = testManifest.patches.find((value) => input.endsWith(`/article/${value.id}`));
  if (patch) return reply({ article: { content: { content: patchBody(patch.id) } } });
  const source = [...testManifest.sources, ...testTimers.sources, ...testChecklist.sources, ...testGear.sources].find((value) => "fetchUrl" in value && value.fetchUrl === input);
  if (source) return new Response(new Uint8Array(GUIDE_BYTES), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  throw new Error(`Unexpected knowledge request: ${input}`);
}

// Keep the verified upstream shape, without storing a player's full armory response.
function upstream() {
  return {
    info: {
      profile: { characterId: REF.characterId, serverId: 2322, characterName: "Example", serverName: "Atiel", className: "Gladiator", characterLevel: 45, combatPower: 73881, profileImage: "https://profileimg.plaync.com/game_profile_images/aion2global/images?gameServerKey=2322&charKey=fixture" },
      stat: { statList: [{ type: "STR", name: "Might", value: 25 }, { type: "ItemLevel", name: "아이템레벨", value: 1638 }] },
      daevanion: { boardList: [
        { id: 11, name: "Nezekan", openNodeCount: 62, totalNodeCount: 88 },
        { id: 12, name: "Zikel", openNodeCount: 50, totalNodeCount: 88 },
        { id: 13, name: "Vaizel", openNodeCount: 55, totalNodeCount: 88 },
        { id: 14, name: "Triniel", openNodeCount: 60, totalNodeCount: 116 },
      ] },
    },
    equipment: {
      equipment: { equipmentList: [
        { id: 110130048, slotPos: 1, slotPosName: "MainHand", name: "Spiritforged Greatsword", grade: "Unique", enchantLevel: 15, exceedLevel: 0 },
        { id: 115030041, slotPos: 2, slotPosName: "SubHand", name: "Spiritforged Guard", grade: "Unique", enchantLevel: 10, exceedLevel: 0 },
        { id: 310330052, slotPos: 13, slotPosName: "Ring1", name: "Aulamus Ring", grade: "Unique", enchantLevel: 9, exceedLevel: 0 },
        { id: 310330052, slotPos: 14, slotPosName: "Ring2", name: "Aulamus Ring", grade: "Unique", enchantLevel: 10, exceedLevel: 0 },
        { id: 215240001, slotPos: 17, slotPosName: "Belt", name: "Noble Belt", grade: "Legend", enchantLevel: 3, exceedLevel: 0 },
        { id: 311030001, slotPos: 22, slotPosName: "Amulet", name: "Revelation Amulet", grade: "Unique", enchantLevel: 1, exceedLevel: 0 },
      ] },
      skill: { skillList: [
        { id: 11170000, name: "Overhead Slam", category: "Active", skillLevel: 14, equip: 1, acquired: 1, icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/ICON_GL_SKILL_017.png" },
        { id: 11800000, name: "Murderous Burst", category: "Passive", skillLevel: 16, equip: 0, acquired: 1 },
        { id: 11400000, name: "Lunge Stance", category: "Dp", skillLevel: 12, equip: 1, acquired: 1 },
      ] },
      petwing: { wing: { name: "Lesser Daeva Wings", grade: "Common", enchantLevel: 0 }, pet: { name: "Papis", level: 1 } },
    },
  };
}

function reply(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function detail(id: number) {
  return id === 310330052
    ? { id, maxEnchantLevel: 15, maxExceedEnchantLevel: 3, subStatRandom: true, soulBindRate: "36.7", subStats: [{ name: "Flight Power", value: "198" }, { name: "Attack", value: "16" }], subSkills: [{ id: 11010000, name: "Rending Blow", level: 1 }] }
    : { id, maxEnchantLevel: 15, subStatRandom: false, soulBindRate: "100", subStats: [{ name: "Might", value: "15" }] };
}

function boardDetail(boardId: number) {
  const positions: Record<number, { id: number; row: number; col: number }> = {
    11: { id: 110050, row: 4, col: 5 }, 12: { id: 120185, row: 13, col: 5 },
    13: { id: 130101, row: 7, col: 11 }, 14: { id: 140130, row: 9, col: 10 },
  };
  const observed = positions[boardId];
  if (!observed) throw new Error(`Unexpected board ${boardId}`);
  return {
    nodeList: [
      { boardId, nodeId: boardId * 10000 + 113, row: 8, col: 8, name: "Start", type: "Start", grade: "None", open: 0, effectList: [{ desc: "" }], icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/UT_FWindow_Daevanion_Node_Start_Sprite.png" },
      { boardId, nodeId: observed.id, row: observed.row, col: observed.col, name: "Skill Level Up - Overhead Slam", type: "SkillLevel", grade: "Legend", open: 1, effectList: [{ desc: "Overhead Slam +1" }], icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/UT_FWindow_Daevanion_Node_Legend_Sprite.png" },
    ],
    openSkillEffectList: [{ desc: "Overhead Slam +1" }], openStatEffectList: [],
  };
}

function markOverheadBoardsOwned(snapshot: AionSnapshot): AionSnapshot {
  for (const board of snapshot.boards) board.skillBonuses = [{ id: 11170000, name: "Overhead Slam", levels: 1 }];
  return snapshot;
}

function mockArmory(options: { failedBoards?: boolean } = {}) {
  const raw = upstream();
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/info")) return reply(raw.info);
    if (url.pathname.endsWith("/equipment")) return reply(raw.equipment);
    if (url.pathname.endsWith("/daevanion/detail")) return options.failedBoards ? reply({}, 503) : reply(boardDetail(Number(url.searchParams.get("boardId"))));
    if (url.pathname.endsWith("/equipment/item")) return reply(detail(Number(url.searchParams.get("id"))));
    throw new Error(`Unexpected armory request: ${url.href}`);
  });
}

async function normalized(): Promise<AionSnapshot> {
  const api = await import("@/lib/aion2-api");
  const raw = upstream();
  return api.normalizeAionSnapshot(REF, raw.info, raw.equipment, NOW);
}

async function primeKnowledge() {
  const knowledge = await import("@/lib/aion2-knowledge");
  const feed = { contentList: knowledge.aionKnowledge.patches.map((patch) => ({ id: patch.id, timestamps: { updatedAt: patch.updatedAt } })) };
  fetchMock.mockImplementation(async (input) => knowledgeReply(String(input), feed));
  expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("current");
  return { ...knowledge, feed };
}

beforeEach(() => {
  vi.resetModules();
  const globals = globalThis as typeof globalThis & { __aionHttp?: unknown; __aionKnowledge?: unknown };
  delete globals.__aionHttp;
  delete globals.__aionKnowledge;
  fetchMock.mockReset();
  testManifest = structuredClone(originalManifest);
  testTimers = structuredClone(originalTimers);
  testChecklist = structuredClone(originalChecklist);
  testGear = structuredClone(originalGear);
  for (const patch of testManifest.patches) patch.bodySha256 = sha256(patchBody(patch.id));
  for (const source of testManifest.sources) if ("fetchUrl" in source) source.sha256 = sha256(GUIDE_BYTES);
  for (const source of testTimers.sources) if ("fetchUrl" in source) source.sha256 = sha256(GUIDE_BYTES);
  for (const source of testChecklist.sources) if ("fetchUrl" in source) source.sha256 = sha256(GUIDE_BYTES);
  for (const source of testGear.sources) if ("fetchUrl" in source) source.sha256 = sha256(GUIDE_BYTES);
  vi.doMock("@/data/aion2/knowledge.json", () => ({ default: testManifest }));
  vi.doMock("@/data/aion2/timers.json", () => ({ default: testTimers }));
  vi.doMock("@/data/aion2/checklist.json", () => ({ default: testChecklist }));
  vi.doMock("@/data/aion2/gear-priorities.json", () => ({ default: testGear }));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock("@/data/aion2/knowledge.json"); vi.doUnmock("@/data/aion2/timers.json"); vi.doUnmock("@/data/aion2/checklist.json"); vi.doUnmock("@/data/aion2/gear-priorities.json"); });

describe("Aion2 public data normalization", () => {
  it("preserves distinct Gear Score, Combat Power, skill categories and missing optional data", async () => {
    const snapshot = await normalized();
    expect(snapshot.profile).toMatchObject({ level: 45, combatPower: 73881, gearScore: 1638, className: "Gladiator" });
    expect(snapshot.skills.find((skill) => skill.category === "Passive")).toMatchObject({ acquired: true, equipped: false, level: 16 });
    expect(snapshot.skills.find((skill) => skill.category === "Dp")).toMatchObject({ equipped: true, level: 12 });
    expect(snapshot.equipment[0].details).toBeUndefined();
    expect(snapshot.coverage).toEqual({ equipment: true, skills: true, boards: true });
  });

  it.each(["character", "server"])("rejects a different upstream %s before publishing its data", async (field) => {
    const { normalizeAionSnapshot } = await import("@/lib/aion2-api");
    const raw = upstream();
    if (field === "character") raw.info.profile.characterId = "differentcharacteridentifier=";
    else raw.info.profile.serverId = 2321;
    expect(() => normalizeAionSnapshot(REF, raw.info, raw.equipment, NOW)).toThrow(/different character/);
  });

  it("does not replace unavailable metrics or boards with fabricated zero values", async () => {
    const { normalizeAionSnapshot, parseAionSnapshot } = await import("@/lib/aion2-api");
    const raw = upstream();
    const info = { ...raw.info, profile: { ...raw.info.profile, combatPower: null }, stat: { statList: [] }, daevanion: {} };
    const snapshot = normalizeAionSnapshot(REF, info, raw.equipment, NOW);
    expect(snapshot.profile.combatPower).toBeNull();
    expect(snapshot.profile.gearScore).toBeNull();
    expect(snapshot.coverage.boards).toBe(false);
    expect(parseAionSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("refuses an incomplete equipment payload rather than declaring all slots empty", async () => {
    const { normalizeAionSnapshot } = await import("@/lib/aion2-api");
    const raw = upstream();
    expect(() => normalizeAionSnapshot(REF, raw.info, { ...raw.equipment, equipment: {} }, NOW)).toThrow(/incomplete/);
  });

  it("round trips optional item capabilities without turning unknown amplification into zero", async () => {
    const { parseAionSnapshot } = await import("@/lib/aion2-api");
    const snapshot = await normalized();
    snapshot.equipment[0].details = { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: false, bindRate: 100, stats: [{ name: "Might", value: "15" }], skills: [] };
    snapshot.equipment[2].details = { maxEnchantLevel: 15, maxAmpLevel: 3, randomStats: true, bindRate: 36.7, stats: [], skills: [{ id: 11010000, name: "Rending Blow", level: 1 }] };
    expect(parseAionSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("round trips live board nodes, owned skill bonuses, portrait and skill icons", async () => {
    const { aionSnapshot, parseAionSnapshot } = await import("@/lib/aion2-api");
    mockArmory();
    const snapshot = await aionSnapshot(REF);
    expect(snapshot.profile.portrait).toContain("https://profileimg.plaync.com/");
    expect(snapshot.skills.find((skill) => skill.id === 11170000)?.icon).toContain("ICON_GL_SKILL_017.png");
    expect(snapshot.boards).toHaveLength(4);
    for (const board of snapshot.boards) {
      expect(board.nodes?.find((node) => node.kind === "Start")).toMatchObject({ unlocked: false, row: 8, col: 8 });
      expect(board.nodes?.find((node) => node.kind === "SkillLevel")).toMatchObject({ unlocked: true, effects: ["Overhead Slam +1"] });
      expect(board.skillBonuses).toEqual([{ id: 11170000, name: "Overhead Slam", levels: 1 }]);
    }
    expect(parseAionSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it.each(["date", "metric", "coverage"])("refuses malformed persisted %s", async (field) => {
    const { parseAionSnapshot } = await import("@/lib/aion2-api");
    const snapshot = await normalized();
    const saved = JSON.parse(JSON.stringify(snapshot));
    if (field === "date") saved.observedAt = "not-a-date";
    else if (field === "metric") delete saved.profile.gearScore;
    else delete saved.coverage.skills;
    expect(() => parseAionSnapshot(saved)).toThrow();
  });
});

describe("Aion2 HTTP boundary", () => {
  it("decodes imported IDs once and sends correctly encoded official detail requests", async () => {
    const { aionCharacterId, aionSnapshot } = await import("@/lib/aion2-api");
    mockArmory();
    expect(aionCharacterId("fixturecharacteridentifier%253D")).toBe(REF.characterId);
    const snapshot = await aionSnapshot({ ...REF, characterId: "fixturecharacteridentifier%253D" });
    expect(snapshot.equipment[0].details).toMatchObject({ maxEnchantLevel: 15, randomStats: false, maxAmpLevel: null });
    expect(snapshot.equipment[2].details).toMatchObject({ maxAmpLevel: 3, randomStats: true, bindRate: 36.7, skills: [{ name: "Rending Blow", level: 1 }] });
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    for (const url of urls) {
      expect(url.origin).toBe("https://aion2.plaync.com");
      expect(url.searchParams.get("region")).toBe("eu");
      expect(url.searchParams.get("characterId")).toBe(REF.characterId);
      expect(url.href).not.toContain("%253D");
    }
    expect(urls.filter((url) => url.pathname.endsWith("/equipment/item")).map((url) => Number(url.searchParams.get("slotPos")))).toEqual(expect.arrayContaining([1, 2, 13, 14]));
    expect(urls.filter((url) => url.pathname.endsWith("/daevanion/detail")).map((url) => Number(url.searchParams.get("boardId")))).toEqual([11, 12, 13, 14]);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain("fixturecharacteridentifier%253D");
      expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    }
  });

  it("keeps a verified base profile when optional item details fail", async () => {
    const { aionSnapshot } = await import("@/lib/aion2-api");
    const raw = upstream();
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/info")) return reply(raw.info);
      if (url.pathname.endsWith("/equipment")) return reply(raw.equipment);
      return reply({ error: "unavailable" }, 503);
    });
    const snapshot = await aionSnapshot(REF);
    expect(snapshot.profile.combatPower).toBe(73881);
    expect(snapshot.equipment.every((item) => item.details === undefined)).toBe(true);
  });

  it("keeps the base profile and item details when optional board detail requests fail", async () => {
    const { aionSnapshot } = await import("@/lib/aion2-api");
    const { aionSkillBoardContribution } = await import("@/lib/aion2-action-plan");
    mockArmory({ failedBoards: true });
    const snapshot = await aionSnapshot(REF);
    expect(snapshot.profile).toMatchObject({ combatPower: 73881, gearScore: 1638 });
    expect(snapshot.equipment[0].details).toMatchObject({ randomStats: false, maxEnchantLevel: 15 });
    expect(snapshot.boards).toHaveLength(4);
    expect(snapshot.boards.every((board) => board.nodes === undefined && board.skillBonuses === undefined)).toBe(true);
    expect(aionSkillBoardContribution(snapshot, 11170000)).toBeNull();
  });

  it.each(["html", "invalid-json", "missing-list"])("rejects %s search responses", async (kind) => {
    const { aionSearch } = await import("@/lib/aion2-api");
    fetchMock.mockResolvedValueOnce(kind === "html"
      ? new Response("<html>Maintenance</html>", { headers: { "Content-Type": "text/html" } })
      : kind === "invalid-json"
        ? new Response("{broken", { headers: { "Content-Type": "application/json" } })
        : reply({}));
    await expect(aionSearch("eu", "Example", 2322)).rejects.toThrow(/official/);
  });

  it("propagates rate limiting with a bounded retry delay", async () => {
    const { aionSearch } = await import("@/lib/aion2-api");
    fetchMock.mockResolvedValueOnce(reply({}, 429, { "Retry-After": "120" }));
    await expect(aionSearch("eu", "Example", 2322)).rejects.toMatchObject({ status: 429, retryAfter: 120 });
  });

  it("omits an unfiltered server and strips name highlights", async () => {
    const { aionSearch } = await import("@/lib/aion2-api");
    fetchMock.mockResolvedValueOnce(reply({ list: [{ characterId: "fixturecharacteridentifier%3D", name: "<strong>Example</strong>", race: 2, pcId: 8, level: 45, serverId: 2322, serverName: "Atiel", region: "eu" }] }));
    const result = await aionSearch("eu", "Example");
    expect(result[0]).toMatchObject({ name: "Example", serverId: 2322, characterId: REF.characterId });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.has("serverId")).toBe(false);
  });
});

describe("Aion2 knowledge freshness", () => {
  it("refreshes alert sources before their thirty-minute trust window and clamps request frequency", async () => {
    const knowledge = await primeKnowledge();
    const calls = fetchMock.mock.calls.length;
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000));
    await knowledge.refreshAionKnowledgeStatus();
    expect(fetchMock.mock.calls).toHaveLength(calls);
    expect((await knowledge.refreshAionKnowledgeStatus({ maximumCheckAgeMs: 15 * 60_000 })).checkedAt).toBe(new Date(NOW.getTime() + 16 * 60_000).toISOString());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    const refreshedCalls = fetchMock.mock.calls.length;
    vi.setSystemTime(new Date(NOW.getTime() + 17 * 60_000));
    await knowledge.refreshAionKnowledgeStatus({ maximumCheckAgeMs: 0 });
    expect(fetchMock.mock.calls).toHaveLength(refreshedCalls);
  });

  it("withholds guidance until the reviewed patch baseline is verified", async () => {
    const knowledge = await import("@/lib/aion2-knowledge");
    expect(knowledge.aionKnowledgeStatus().status).toBe("unverified");
    expect((await primeKnowledge()).aionKnowledgeStatus().status).toBe("current");
  });

  it.each(["new", "revised"])("withholds guidance for %s official patch notes", async (change) => {
    const knowledge = await import("@/lib/aion2-knowledge");
    const contentList = knowledge.aionKnowledge.patches.map((patch) => ({ id: patch.id, timestamps: { updatedAt: patch.updatedAt } }));
    if (change === "new") contentList.unshift({ id: "new-unreviewed-patch", timestamps: { updatedAt: "2026-10-23T11:00:00Z" } });
    else contentList[contentList.length - 1].timestamps.updatedAt = "2026-10-23T11:00:00Z";
    fetchMock.mockImplementation(async (input) => knowledgeReply(String(input), { contentList }));
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("review-required");
  });

  it("requires a knowledge review after a detected change even if upstream later serves the old baseline", async () => {
    const knowledge = await import("@/lib/aion2-knowledge");
    const original = { contentList: knowledge.aionKnowledge.patches.map((patch) => ({ id: patch.id, timestamps: { updatedAt: patch.updatedAt } })) };
    const changed = { contentList: [{ id: "new-unreviewed-patch", timestamps: { updatedAt: "2026-10-23T11:00:00Z" } }, ...original.contentList] };
    fetchMock.mockImplementation(async (input) => knowledgeReply(String(input), changed));
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("review-required");
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    fetchMock.mockImplementation(async (input) => knowledgeReply(String(input), original));
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("review-required");
  });

  it("deduplicates simultaneous patch checks", async () => {
    const knowledge = await import("@/lib/aion2-knowledge");
    let complete!: (response: Response) => void;
    const feed = { contentList: knowledge.aionKnowledge.patches.map((patch) => ({ id: patch.id, timestamps: { updatedAt: patch.updatedAt } })) };
    fetchMock.mockImplementation(async (input) => knowledgeReply(String(input), feed));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const first = knowledge.refreshAionKnowledgeStatus();
    const second = knowledge.refreshAionKnowledgeStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    complete(reply(feed));
    expect((await first).status).toBe("current");
    expect((await second).status).toBe("current");
  });

  it("stops trusting a failed patch check after the one-hour grace period", async () => {
    const knowledge = await primeKnowledge();
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    fetchMock.mockResolvedValueOnce(reply({}, 503));
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("current");
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    expect(knowledge.aionKnowledgeStatus().status).toBe("unverified");
  });

  it("withholds expired curated guidance", async () => {
    const knowledge = await primeKnowledge();
    const expiry = Date.parse(`${knowledge.aionKnowledge.expiresAt}T00:00:00Z`);
    expect(knowledge.aionKnowledgeStatus(new Date(expiry)).status).toBe("expired");
  });

  it("verifies pinned guide bytes including a UTF-8 BOM", async () => {
    const knowledge = await primeKnowledge();
    expect(GUIDE_BYTES.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(knowledge.aionKnowledgeStatus().status).toBe("current");
    for (const source of [...testManifest.sources, ...testTimers.sources, ...testChecklist.sources, ...testGear.sources]) {
      if ("fetchUrl" in source) expect(fetchMock.mock.calls.some(([input]) => String(input) === source.fetchUrl)).toBe(true);
    }
  });

  it.each(["patch-body", "guide-bytes", "timer-bytes", "checklist-bytes", "gear-bytes"])("detects changed %s even if the patch feed timestamp is unchanged", async (kind) => {
    const knowledge = await import("@/lib/aion2-knowledge");
    const feed = { contentList: knowledge.aionKnowledge.patches.map((patch) => ({ id: patch.id, timestamps: { updatedAt: patch.updatedAt } })) };
    const urls = (sources: { fetchUrl?: string }[]) => sources.flatMap((source) => source.fetchUrl ? [source.fetchUrl] : []);
    const groups = { "guide-bytes": urls(testManifest.sources), "timer-bytes": urls(testTimers.sources), "checklist-bytes": urls(testChecklist.sources), "gear-bytes": urls(testGear.sources) };
    const group = kind === "patch-body" ? undefined : kind as keyof typeof groups;
    // A shared URL would let another catalog's fetch conceal an omitted group.
    const changedUrl = group && groups[group].find((url) => Object.entries(groups).every(([name, candidates]) => name === group || !candidates.includes(url)));
    if (group) expect(changedUrl, `${group} needs its own independently checked source`).toBeTruthy();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (kind === "patch-body" && url.endsWith(`/article/${testManifest.patches[0].id}`)) return reply({ article: { content: { content: "Changed patch body" } } });
      if (url === changedUrl) return new Response(new Uint8Array(Buffer.concat([GUIDE_BYTES, Buffer.from(`${kind} correction`)])));
      return knowledgeReply(url, feed);
    });
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("review-required");
    if (changedUrl) expect(fetchMock.mock.calls.some(([input]) => String(input) === changedUrl)).toBe(true);
  });

  it("fetches each shared source URL once within one knowledge check", async () => {
    await primeKnowledge();
    const requested = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested).toHaveLength(new Set(requested).size);
  });

  it("withholds all guidance when a gear source review expires", async () => {
    await primeKnowledge();
    testGear.sources[0].reviewedAt = "2026-10-22";
    testGear.sources[0].expiresAt = "2026-10-23";
    const knowledge = await import("@/lib/aion2-knowledge");
    expect(knowledge.aionKnowledgeStatus().status).toBe("expired");
  });

  it("a reviewed gear version resets the shared drift latch and requires a fresh check", async () => {
    const knowledge = await primeKnowledge();
    const globals = globalThis as typeof globalThis & { __aionKnowledge?: { changed: boolean } };
    globals.__aionKnowledge!.changed = true;
    expect(knowledge.aionKnowledgeStatus().status).toBe("review-required");
    testGear.version += ".reviewed";
    vi.resetModules();
    const updated = await import("@/lib/aion2-knowledge");
    expect(updated.aionKnowledgeStatus().status).toBe("unverified");
    expect((await updated.refreshAionKnowledgeStatus()).status).toBe("current");
  });

  it("withholds guidance when a timer review expires independently of the main knowledge review", async () => {
    await primeKnowledge();
    testTimers.expiresAt = "2026-10-23";
    const knowledge = await import("@/lib/aion2-knowledge");
    expect(knowledge.aionKnowledgeStatus().status).toBe("expired");
  });

  it("honors full ISO checklist source expiry timestamps", async () => {
    const knowledge = await primeKnowledge();
    testChecklist.sources[0].expiresAt = NOW.toISOString();
    expect(knowledge.aionKnowledgeStatus().status).toBe("expired");
  });
});

describe("Aion2 knowledge configuration validation", () => {
  it.each(["invalid-dates", "missing-source", "invalid-target", "region-and-url"])("fails closed for %s", async (kind) => {
    const { validateAionKnowledge } = await import("@/lib/aion2-knowledge-validation");
    if (kind === "invalid-dates") testManifest.expiresAt = "2026-02-30";
    else if (kind === "missing-source") testManifest.rules[0].sourceIds = ["missing-guide"];
    else if (kind === "invalid-target") testManifest.rules[0].target = 0;
    else { testManifest.regions = ["kr"]; testManifest.sources[0].url = "http://untrusted.example/guide"; }
    expect(validateAionKnowledge(testManifest).length).toBeGreaterThan(0);
    const knowledge = await import("@/lib/aion2-knowledge");
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("review-required");
    expect(fetchMock).not.toHaveBeenCalled();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    expect(aionRecommendations(await normalized())).toEqual([]);
  });

  it.each(["missing-activity", "unknown-activity", "invalid-activity-cost"])("rejects %s before exposing a plan", async (kind) => {
    const { validateAionKnowledge } = await import("@/lib/aion2-knowledge-validation");
    if (kind === "missing-activity") testManifest.activities = testManifest.activities.filter((activity) => activity.id !== "shattered-stage1");
    else if (kind === "invalid-activity-cost") testManifest.activities.find((activity) => activity.id === "shattered-stage1")!.odylePerClaim = 0;
    else {
      const step = testManifest.rules.find((rule) => rule.id === "gladiator-overhead")!.steps.find((entry) => entry.id === "shattered")!;
      (step as { activityId?: string }).activityId = "unreviewed-activity";
    }
    expect(validateAionKnowledge(testManifest).some((error) => /activity|activities/i.test(error))).toBe(true);
    const knowledge = await import("@/lib/aion2-knowledge");
    expect((await knowledge.refreshAionKnowledgeStatus()).status).toBe("review-required");
    expect(fetchMock).not.toHaveBeenCalled();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    expect(aionRecommendations(await normalized())).toEqual([]);
  });
});

describe("Aion2 evidence-based recommendations", () => {
  it("uses the Gladiator skill gap and actual item capabilities", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized();
    snapshot.equipment[0].details = { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: false, bindRate: 100, stats: [], skills: [] };
    snapshot.equipment[1].details = { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: false, bindRate: 100, stats: [], skills: [] };
    const recommendations = aionRecommendations(snapshot);
    expect(recommendations.find((rule) => rule.id === "gladiator-overhead")).toMatchObject({ title: "Unlock Overhead Slam's level 16 breakpoint", priority: "high" });
    expect(recommendations.find((rule) => rule.id === "starter-guard")?.evidence).toContain("Spiritforged Guard");
    expect(recommendations.find((rule) => rule.id === "starter-guard")?.action).toContain("A +15 cap alone does not make it the next investment");
    expect(recommendations.map(rule => rule.id)).not.toContain("offensive-enhancement");
    expect(recommendations.find((rule) => rule.id === "fixed-weapon")?.action).toMatch(/do not spend Sync/);
  });

  it("does not apply the Gladiator target to another class", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized();
    snapshot.profile.className = "Templar";
    expect(aionRecommendations(snapshot).map((rule) => rule.id)).not.toContain("gladiator-overhead");
  });

  it("does not guess enhancement or reroll capabilities when optional details are absent", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const ids = aionRecommendations(await normalized()).map((rule) => rule.id);
    expect(ids).not.toContain("starter-guard");
    expect(ids).not.toContain("fixed-weapon");
  });

  it("does not infer missing cards or skill gaps without corresponding coverage", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized();
    snapshot.coverage = { equipment: false, skills: false, boards: false };
    expect(aionRecommendations(snapshot)).toEqual([]);
  });

  it.each(["stale", "future"])("withholds recommendations based on %s observations", async (kind) => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized();
    snapshot.observedAt = new Date(NOW.getTime() + (kind === "stale" ? -31 : 6) * 60_000).toISOString();
    expect(aionRecommendations(snapshot)).toEqual([]);
  });

  it("withholds recommendations when the current patch baseline is unknown", async () => {
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    expect(aionRecommendations(await normalized())).toEqual([]);
  });
});

describe("Aion2 conditional action plans", () => {
  it("targets level 16 first and omits already-owned board work", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = markOverheadBoardsOwned(await normalized());
    const recommendation = aionRecommendations(snapshot).find((rule) => rule.id === "gladiator-overhead");
    expect(recommendation?.title).toBe("Unlock Overhead Slam's level 16 breakpoint");
    expect(recommendation?.evidence).toContain("2 more levels reach 16");
    expect(recommendation?.evidence).toContain("All four Overhead Slam board bonuses are already owned");
    expect(recommendation?.steps?.map((step) => step.id)).not.toContain("base-and-board");
    expect(recommendation?.steps?.map((step) => step.id)).toContain("specialty");
    expect(recommendation?.steps?.map((step) => step.id)).not.toContain("later20");
  });

  it("targets the third slot at 20 after the skill reaches 16", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = markOverheadBoardsOwned(await normalized());
    snapshot.skills.find((skill) => skill.id === 11170000)!.level = 16;
    const recommendation = aionRecommendations(snapshot).find((rule) => rule.id === "gladiator-overhead");
    expect(recommendation?.title).toBe("Unlock Overhead Slam's level 20 breakpoint");
    expect(recommendation?.evidence).toContain("4 more levels reach 20");
    expect(recommendation?.steps?.map((step) => step.id)).toContain("later20");
    expect(recommendation?.steps?.map((step) => step.id)).not.toContain("specialty");
  });

  it("checks base and board contributions when optional board detail is unknown", async () => {
    const { aionActionPlan, aionSkillBoardContribution } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    expect(aionSkillBoardContribution(snapshot, 11170000)).toBeNull();
    const check = aionActionPlan(snapshot, "gladiator-overhead").steps?.find((step) => step.id === "base-and-board");
    expect(check?.instruction).toContain("not fully available");
    expect(check?.instruction).toContain("Take only missing nodes along a connected route");
  });

  it("uses the actual random-line ring and preserves its useful skill line", async () => {
    const { aionSnapshot } = await import("@/lib/aion2-api");
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    mockArmory();
    const snapshot = await aionSnapshot(REF);
    const step = aionActionPlan(snapshot, "gladiator-overhead").steps?.find((entry) => entry.id === "sync-ring");
    expect(step?.instruction).toContain("Aulamus Ring +9");
    expect(step?.instruction).toContain("Flight Power");
    expect(step?.instruction).toContain("preserve Rending Blow +1");
    expect(step?.instruction).toContain("Soul Binding → Sync");
    expect(step?.instruction).toContain("current window accepts");
    expect(step?.reason).toContain("does not guarantee the target skill");
  });

  it("does not offer the ring Sync branch without confirmed random-line capability", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    expect(aionActionPlan(snapshot, "gladiator-overhead").steps?.map((step) => step.id)).not.toContain("sync-ring");
  });

  it("names the eligible dungeon, stage and single-cube energy cost", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead");
    const step = plan.steps?.find((entry) => entry.id === "shattered");
    expect(step?.instruction).toContain("Transcendence → Shattered Arkanis → Stage 1");
    expect(step?.instruction).toContain("1,600 Gear Score");
    expect(step?.instruction).toContain("40 Odyle");
    expect(step?.cost).toEqual({ resource: "odyle", amount: 40 });
    expect(step?.instruction).not.toMatch(/\b80\s+Odyle/);
    expect(step?.reason).toContain("not Exploration");
  });

  it("identifies eligible Arcana pools without promising a chosen enhancement roll", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead");
    const step = plan.steps?.find((entry) => entry.id === "open-and-equip");
    expect(step?.instruction).toContain("Parchment or Chalice");
    expect(step?.instruction).toContain("Compass cannot roll Overhead Slam");
    expect(step?.instruction).toContain("Vigor and Magic versions share the skill pool");
    expect(step?.reason).toContain("Card enhance level +2 does not guarantee +2 to Overhead");
    expect(step?.reason).toContain("random");
  });

  it("keeps concrete steps and alternatives when the Odyle balance is unknown", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead");
    expect(plan.budget).toMatchObject({ available: null, costPerRun: 40, affordableRuns: null });
    expect(plan.steps?.find((step) => step.id === "shattered")?.status).toBe("manual-check");
    expect(plan.steps?.find((step) => step.id === "no-energy")?.instruction).toMatch(/Monolith Resonance.*Strongholds.*Nightmare.*Shugo/);
  });

  it("blocks cube claims and offers separate alternatives for a fresh reported zero balance", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead", { odyleEnergy: 0, resourcesUpdatedAt: NOW.toISOString() });
    expect(plan.budget).toMatchObject({ available: 0, costPerRun: 40, affordableRuns: 0 });
    const claims = plan.steps?.filter((step) => step.cost?.resource === "odyle") ?? [];
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((step) => step.status === "blocked")).toBe(true);
    const alternative = plan.steps?.find((step) => step.id === "no-energy");
    expect(alternative?.cost).toBeUndefined();
    expect(alternative?.instruction).toContain("Use already-owned cards or accepted Sync materials first");
    expect(alternative?.reason).toContain("do not spend Odyle");
  });

  it("calculates two affordable single claims from a fresh reported balance of 80", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead", { odyleEnergy: 80, resourcesUpdatedAt: NOW.toISOString() });
    expect(plan.budget).toMatchObject({ available: 80, costPerRun: 40, affordableRuns: 2 });
    expect(plan.steps?.find((step) => step.id === "shattered")?.status).toBe("ready");
    expect(plan.steps?.map((step) => step.id)).not.toContain("no-energy");
  });

  it("takes a reviewed activity cost from the knowledge catalog instead of hardcoding 40", async () => {
    testManifest.activities.find((activity) => activity.id === "shattered-stage1")!.odylePerClaim = 80;
    await primeKnowledge();
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead", { odyleEnergy: 80, resourcesUpdatedAt: NOW.toISOString() });
    expect(plan.budget).toMatchObject({ available: 80, costPerRun: 80, affordableRuns: 1 });
    const claim = plan.steps?.find((step) => step.id === "shattered");
    expect(claim?.cost).toEqual({ resource: "odyle", amount: 80 });
    expect(claim?.instruction).toContain("at least 80 Odyle");
    expect(claim?.status).toBe("ready");
  });

  it("takes the entry gate from the reviewed activity catalog", async () => {
    testManifest.activities.find((activity) => activity.id === "shattered-stage1")!.minimumGearScore = 1700;
    await primeKnowledge();
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    expect(aionActionPlan(await normalized(), "gladiator-overhead").steps?.map((step) => step.id)).not.toContain("shattered");
  });

  it("uses reviewed milestone values for both the goal and conditional steps", async () => {
    const rule = testManifest.rules.find((entry) => entry.id === "gladiator-overhead")!;
    rule.milestones = [18, 20];
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = markOverheadBoardsOwned(await normalized());
    expect(aionRecommendations(snapshot).find((entry) => entry.id === "gladiator-overhead")?.title).toBe("Unlock Overhead Slam's level 18 breakpoint");
    snapshot.skills.find((skill) => skill.id === 11170000)!.level = 16;
    const below = aionActionPlan(snapshot, "gladiator-overhead").steps?.map((step) => step.id);
    expect(below).toContain("specialty");
    expect(below).not.toContain("later20");
    snapshot.skills.find((skill) => skill.id === 11170000)!.level = 18;
    const reached = aionActionPlan(snapshot, "gladiator-overhead").steps?.map((step) => step.id);
    expect(reached).not.toContain("specialty");
    expect(reached).toContain("later20");
  });

  it("treats a manual resource report older than 30 minutes as unknown", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const plan = aionActionPlan(await normalized(), "gladiator-overhead", { odyleEnergy: 80, resourcesUpdatedAt: new Date(NOW.getTime() - 31 * 60_000).toISOString() });
    expect(plan.budget).toMatchObject({ available: null, affordableRuns: null });
    expect(plan.steps?.find((step) => step.id === "shattered")?.status).toBe("manual-check");
    expect(plan.steps?.map((step) => step.id)).toContain("no-energy");
  });

  it("protects destination rolls when previewing the fixed Spiritforged transfer", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized();
    snapshot.equipment[0].details = { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: false, bindRate: 100, stats: [{ name: "Might", value: "15" }], skills: [] };
    const recommendation = aionRecommendations(snapshot).find((rule) => rule.id === "fixed-weapon");
    const transfer = recommendation?.steps?.find((step) => step.id === "growth-transfer");
    expect(transfer?.instruction).toContain("Enhancement → Transfer");
    expect(transfer?.instruction).toContain("preserves the destination lines you want");
    expect(transfer?.instruction).toContain("Confirm only if the preview matches");
    expect(transfer?.instruction).toContain("material item is consumed");
    expect(transfer?.reason).toContain("enhancement only, not its fixed Soul Binding effects");
    expect(transfer?.reason).toContain("Never assume growth levels are added together");
  });
});

describe("reviewed investment and efficient farm routes", () => {
  it("does not turn an arbitrary guard's unused cap into a spend recommendation", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized();
    snapshot.equipment[1] = { ...snapshot.equipment[1], id: 115030052, name: "Vakron Guard", details: { maxEnchantLevel: 15, maxAmpLevel: 3, randomStats: true, bindRate: 10, stats: [], skills: [] } };
    expect(aionRecommendations(snapshot).some(rule => /enhance.*guard|guard.*enhance/i.test(rule.title))).toBe(false);
    expect(aionRecommendations(snapshot).map(rule => rule.id)).not.toContain("starter-guard");
  });

  it.each(["Cleric", "Ranger", "Templar"])("never gives the Gladiator greatsword recipe to %s", async className => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized(); snapshot.profile.className = className;
    snapshot.equipment[0].details = { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: false, bindRate: 100, stats: [], skills: [] };
    expect(aionRecommendations(snapshot).map(rule => rule.id)).not.toContain("fixed-weapon");
  });

  it("does not treat another fixed weapon as the named story donor", async () => {
    await primeKnowledge();
    const { aionRecommendations } = await import("@/lib/aion2-recommendations");
    const snapshot = await normalized(); snapshot.equipment[0].id = 9999;
    snapshot.equipment[0].details = { maxEnchantLevel: 15, maxAmpLevel: null, randomStats: false, bindRate: 100, stats: [], skills: [] };
    expect(aionRecommendations(snapshot).map(rule => rule.id)).not.toContain("fixed-weapon");
  });

  it("keeps cheap bought-rank and owned-card checks ahead of farming even with all board levels", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = markOverheadBoardsOwned(await normalized());
    const steps = aionActionPlan(snapshot, "gladiator-overhead").steps!;
    expect(steps[0].id).toBe("base-rank");
    expect(steps.findIndex(step => step.id === "owned-cards")).toBeLessThan(steps.findIndex(step => step.id === "shattered"));
    expect(steps[0].instruction).toContain("rank bought with Skill Points");
    expect(steps.find(step => step.id === "owned-cards")?.instruction).toContain("Empty equipped slots do not prove");
  });

  it("chooses Deus for only missing Compass and Bell and includes its claim cost", async () => {
    const { aionActionPlan, aionMissingArcana } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    for (const [index, name] of [[0,"Chalice"],[1,"Parchment"],[4,"Mirror"]] as const) snapshot.equipment.push({ id: 90000 + index, slot: 41 + index, slotName: `Arcana${index + 1}`, name: `Vigor ${name}`, grade: "Rare", enchantLevel: 0, ampLevel: 0, icon: null });
    expect(aionMissingArcana(snapshot)).toEqual(["Compass", "Bell"]);
    const steps = aionActionPlan(snapshot, "arcana").steps!;
    expect(steps[0].id).toBe("inspect-owned");
    expect(steps.map(step => step.id)).not.toContain("first-cards");
    expect(steps.find(step => step.id === "other-slots")?.cost).toEqual({ resource: "odyle", amount: 40 });
  });

  it("refuses to infer missing card families from conflicting slot and item names", async () => {
    const { aionMissingArcana } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    snapshot.equipment.push({ id: 90000, slot: 41, slotName: "Arcana1", name: "Vigor Compass", grade: "Rare", enchantLevel: 0, ampLevel: 0, icon: null });
    expect(aionMissingArcana(snapshot)).toBeNull();
  });

  it("blocks a dungeon's level or Gear Score gate even with enough reported energy", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized(); snapshot.profile.gearScore = 1399;
    const candidate = aionActionPlan(snapshot, "fixed-weapon", { odyleEnergy: 100, resourcesUpdatedAt: NOW.toISOString() }).steps!.find(step => step.id === "candidate")!;
    expect(candidate.status).toBe("blocked"); expect(candidate.instruction).toContain("Entry is not confirmed");
    snapshot.profile.gearScore = 1638; snapshot.profile.level = 44;
    expect(aionActionPlan(snapshot, "fixed-weapon", { odyleEnergy: 100, resourcesUpdatedAt: NOW.toISOString() }).steps!.find(step => step.id === "candidate")?.status).toBe("blocked");
  });

  it("quotes the complete amulet and belt material categories", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    for (const id of ["amulet", "belt"]) {
      const menu = aionActionPlan(snapshot, id).steps!.find(step => step.id.endsWith("-menu"))!;
      expect(menu.instruction).toContain("Enhance Stones and Kina alongside the special scroll");
      expect(menu.reason).not.toContain("not ordinary Enhance Stones");
    }
  });

  it("separates the optional cheap donor +15 plan from holding the temporary guard", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const steps = aionActionPlan(await normalized(), "starter-guard").steps!;
    expect(steps[0].instruction).toContain("Keep it until a replacement");
    expect(steps.find(step => step.id === "guard-candidate")?.cost?.amount).toBe(40);
    expect(steps.find(step => step.id === "guard-voucher")?.instruction).toContain("not a direct Guard");
    expect(steps.find(step => step.id === "guard-preview")?.instruction).toContain("zero prior transfers");
    expect(steps.find(step => step.id === "guard-later15")?.reason).toContain("not automatically wasted");
  });

  it("uses the observed enhancement in the story transfer preview, rather than assuming +15", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized(); snapshot.equipment[0].enchantLevel = 10;
    const transfer = aionActionPlan(snapshot, "fixed-weapon").steps!.find(step => step.id === "growth-transfer")!;
    expect(transfer.title).toContain("+10"); expect(transfer.instruction).toContain("intended +10");
    expect(transfer.instruction).toContain("remove it from presets");
  });

  it("refuses cap-only spend rules and weapon recipes without an item/class scope", async () => {
    const { validateAionKnowledge } = await import("@/lib/aion2-knowledge-validation");
    const rule = testManifest.rules.find(rule => rule.id === "fixed-weapon")!;
    rule.classes = []; (rule as { itemIds?: number[] }).itemIds = [];
    expect(validateAionKnowledge(testManifest).join(" ")).toContain("explicit class scope");
    expect(validateAionKnowledge(testManifest).join(" ")).toContain("verified source item IDs");
    rule.strategy = "item-cap";
    expect(validateAionKnowledge(testManifest).join(" ")).toContain("strategy");
  });
});

describe("reviewed linked activities and existing target rolls", () => {
  it("does not spend Sync materials on rings already carrying the target skill", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    for (const item of snapshot.equipment.filter(item => [13,14].includes(item.slot))) item.details = { maxEnchantLevel: 15, maxAmpLevel: 3, randomStats: true, bindRate: 30, stats: [{ name: "MP", value: "100" }], skills: [{ id:11170000, name:"Overhead Slam", level:1 }] };
    const ids = aionActionPlan(snapshot,"gladiator-overhead").steps!.map(step => step.id);
    expect(ids).not.toContain("sync-ring"); expect(ids).not.toContain("ring-fodder");
  });

  it("restricts the named ring and its unwanted line to the ring still missing the target", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const snapshot = await normalized();
    for (const item of snapshot.equipment.filter(item => [13,14].includes(item.slot))) item.details = { maxEnchantLevel: 15, maxAmpLevel: 3, randomStats: true, bindRate: 30, stats: [{ name: item.slot===13?"MP":"Flight Power", value: "100" }], skills: [{ id:item.slot===13?11170000:11010000, name:item.slot===13?"Overhead Slam":"Rending Blow", level:1 }] };
    const instruction = aionActionPlan(snapshot,"gladiator-overhead").steps!.find(step => step.id === "sync-ring")!.instruction;
    expect(instruction).not.toContain("Ring1:"); expect(instruction).toContain("Ring2:");
    expect(instruction).toContain("replace Flight Power"); expect(instruction).toContain("preserve Rending Blow +1");
  });

  it("links an actual resource activity without linking gear completion to a checkmark", async () => {
    const { aionActionPlan } = await import("@/lib/aion2-action-plan");
    const steps = aionActionPlan(await normalized(),"amulet").steps!;
    expect(steps.find(step => step.id === "stones-weekly")?.checklistActivityIds).toEqual(["daily-dungeon"]);
    expect(steps.find(step => step.id === "amulet-menu")?.checklistActivityIds).toBeUndefined();
  });

  it("rejects an unknown cross-catalog checklist reference without throwing on invalid shapes", async () => {
    const { validateAionChecklistLinks } = await import("@/lib/aion2-knowledge-validation");
    expect(validateAionChecklistLinks({rules:[{id:"test",steps:[{checklistActivityIds:["missing"]}]}]},originalChecklist)).toHaveLength(1);
    expect(validateAionChecklistLinks(null,{activities:[null]})).toEqual([]);
    expect(validateAionChecklistLinks({rules:[null,{steps:[null]}]},null)).toEqual([]);
  });
});
