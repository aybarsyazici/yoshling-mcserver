import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";

const f = vi.hoisted(() => ({ root: `${process.env.TMPDIR || "/tmp"}/yoshling-workshop-lookup-${process.pid}-${Date.now()}`,
  rows: [{ publishedfileid: "123456", result: 1, time_updated: 100, title: "Fixture" }] }));
vi.mock("@/lib/zomboid", () => ({ PZ_APP_ID: "108600", PZ_WORKSHOP_DIR: f.root,
  readModState: async () => ({ workshopIds: ["123456"] }), pzConsole: vi.fn() }));
vi.mock("@/lib/game-manager", () => ({ COMPOSE_PROJECT: "fixture", containerImage: vi.fn(), getGameStatus: vi.fn(), withGameStopped: vi.fn() }));
const { findStaleMods } = await import("@/lib/zomboid-updates");
const manifest = path.join(f.root, "appworkshop_108600.acf");
beforeEach(async () => {
  await mkdir(f.root, { recursive: true });
  await writeFile(manifest, '"AppWorkshop" { "WorkshopItemsInstalled" { "123456" { "timeupdated" "100" } } }');
  f.rows = [{ publishedfileid: "123456", result: 1, time_updated: 100, title: "Fixture" }];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ response: { publishedfiledetails: f.rows } }) })));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(f.root, { recursive: true, force: true }); });
describe("Workshop comparison requires complete upstream/installed evidence", () => {
  it("returns a checked empty update list for equal known versions", async () => { expect(await findStaleMods()).toEqual([]); });
  it("refuses a partial successful upstream response", async () => {
    f.rows = [];
    await expect(findStaleMods()).rejects.toThrow("did not report published versions");
  });
  it("refuses a failed item result even if stale timestamp fields were returned", async () => {
    f.rows[0].result = 9;
    await expect(findStaleMods()).rejects.toThrow("did not report published versions");
  });
  it("refuses a missing installed manifest instead of claiming current versions", async () => {
    await rm(manifest);
    await expect(findStaleMods()).rejects.toThrow("Installed Workshop versions are unavailable");
  });
});
