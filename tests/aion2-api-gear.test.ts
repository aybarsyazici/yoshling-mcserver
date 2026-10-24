import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aionSnapshot, parseAionSnapshot } from "@/lib/aion2-api";

const ref = { region: "eu" as const, serverId: 2322, characterId: "fixture-gear-character" };
const slots = [1, 2, 13, 14, 3, 17, 22, 23, 24, 41, 99];
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const info = {
  profile: { characterId: ref.characterId, serverId: ref.serverId, characterName: "Fixture", serverName: "Atiel", className: "Gladiator", characterLevel: 45, combatPower: 80000 },
  stat: { statList: [{ type: "ItemLevel", name: "Gear Score", value: 1800 }] },
  daevanion: { boardList: [{ id: 11, name: "Nezekan", openNodeCount: 1, totalNodeCount: 88 }] },
};
const equipment = { equipment: { equipmentList: slots.map(slot => ({ id: 100000 + slot, slotPos: slot, slotPosName: `Slot${slot}`, name: `Item ${slot}`, grade: "Unique", enchantLevel: 10, exceedLevel: 0 })) }, skill: { skillList: [] }, petwing: {} };

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function transport(options: { failExtra?: boolean; abortExtra?: AbortController; cleric?: boolean; mismatchedBoard?: boolean } = {}) {
  const calls: { path: string; slot: number; board: number; signal: AbortSignal | null | undefined }[] = [];
  let active = 0, maximum = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: URL, init?: RequestInit) => {
    const url = new URL(String(input)), slot = Number(url.searchParams.get("slotPos"));
    calls.push({ path: url.pathname, slot, board: Number(url.searchParams.get("boardId")), signal: init?.signal });
    active++; maximum = Math.max(maximum, active);
    try {
      await Promise.resolve();
      if (url.pathname.endsWith("/info")) return reply(options.cleric ? { ...info, profile: { ...info.profile, className: "Cleric" }, daevanion: { boardList: [71,72,73,74,76,11].map(id => ({ id, name: `Observed board ${id}`, openNodeCount: 1, totalNodeCount: 88 })) } } : info);
      if (url.pathname.endsWith("/equipment")) return reply(equipment);
      if (url.pathname.endsWith("/daevanion/detail")) return reply({ openSkillEffectList: [{ desc: "Fixture skill +1" }], nodeList: options.mismatchedBoard ? [{ boardId: 11, nodeId: 110001, row: 1, col: 1, name: "Other class node", type: "SkillLevel", grade: "Rare", open: 1, effectList: [] }] : [] });
      if (url.pathname.endsWith("/equipment/item")) {
        if (slot === 3 && options.abortExtra) { options.abortExtra.abort(); throw new Error("Synthetic optional deadline"); }
        if (slot === 3 && options.failExtra) return reply({}, 503);
        return reply({ id: Number(url.searchParams.get("id")), subStatRandom: true, soulBindRate: 10, maxEnchantLevel: 15, subStats: [{ id: "Attack", name: "Attack", value: "16" }, { name: "Legacy label", value: "1" }] });
      }
      throw new Error("Unexpected offline fixture request");
    } finally { active--; }
  }));
  return { calls, maximum: () => maximum };
}

describe("optional equipped gear metadata", () => {
  it("requests Cleric whiteboard details by reviewed class IDs without borrowing Gladiator or Azphel IDs", async () => {
    const net = transport({ cleric: true }), snapshot = await aionSnapshot(ref);
    expect(net.calls.filter(call => call.path.endsWith("/daevanion/detail")).map(call => call.board)).toEqual([71,72,73,74]);
    expect(snapshot.boards.filter(board => [71,72,73,74].includes(board.id)).every(board => Array.isArray(board.nodes) && Array.isArray(board.skillBonuses))).toBe(true);
    expect(snapshot.boards.filter(board => [11,76].includes(board.id)).every(board => board.nodes === undefined && board.skillBonuses === undefined)).toBe(true);
    expect(net.maximum()).toBeLessThanOrEqual(2);
  });

  it("keeps Cleric board details unknown when an upstream payload identifies another board", async () => {
    transport({ cleric: true, mismatchedBoard: true });
    const value = await aionSnapshot(ref);
    expect(value.boards.filter(board => [71,72,73,74].includes(board.id)).every(board => board.nodes === undefined && board.skillBonuses === undefined)).toBe(true);
  });
  it("loads supported gear after critical items and boards with bounded concurrency and one deadline", async () => {
    const control = new AbortController(), deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(control.signal);
    const net = transport(), snapshot = await aionSnapshot(ref);
    expect(net.calls.filter(c => c.path.endsWith("/equipment/item")).map(c => c.slot)).toEqual([1, 2, 13, 14, 3, 17, 22, 23, 24, 41]);
    expect(net.calls.findIndex(c => c.path.endsWith("/daevanion/detail"))).toBeLessThan(net.calls.findIndex(c => c.slot === 3));
    expect(snapshot.equipment.find(item => item.slot === 3)?.details?.stats).toEqual([{ id: "Attack", name: "Attack", value: "16" }, { name: "Legacy label", value: "1" }]);
    expect(snapshot.equipment.find(item => item.slot === 99)?.details).toBeUndefined();
    expect(net.maximum()).toBeLessThanOrEqual(2);
    expect(deadline).toHaveBeenCalledExactlyOnceWith(8000);
    expect(net.calls.every(c => c.signal === control.signal)).toBe(true);
  });

  it("keeps the verified base, critical gear and board reads when another item fails", async () => {
    transport({ failExtra: true });
    const snapshot = await aionSnapshot(ref);
    expect(snapshot.profile.name).toBe("Fixture");
    expect(snapshot.equipment.find(item => item.slot === 1)?.details).toBeDefined();
    expect(snapshot.equipment.find(item => item.slot === 3)?.details).toBeUndefined();
    expect(snapshot.equipment.find(item => item.slot === 17)?.details).toBeDefined();
    expect(snapshot.boards[0].nodes).toEqual([]);
  });

  it("stops additional optional batches after the common deadline aborts", async () => {
    const control = new AbortController(); vi.spyOn(AbortSignal, "timeout").mockReturnValue(control.signal);
    const net = transport({ abortExtra: control }), snapshot = await aionSnapshot(ref);
    expect(snapshot.equipment.find(item => item.slot === 1)?.details).toBeDefined();
    expect(snapshot.boards[0].nodes).toEqual([]);
    expect(net.calls.some(c => c.slot === 22 || c.slot === 41)).toBe(false);
  });

  it("round trips observed stat IDs while leaving old snapshots without IDs valid", async () => {
    transport();
    const snapshot = await aionSnapshot(ref), stored = parseAionSnapshot(snapshot);
    expect(stored.equipment[0].details?.stats).toEqual(snapshot.equipment[0].details?.stats);
    expect(stored.equipment[0].details?.stats[0]).toMatchObject({ id: "Attack" });
    expect(stored.equipment[0].details?.stats[1]).not.toHaveProperty("id");
  });
});
