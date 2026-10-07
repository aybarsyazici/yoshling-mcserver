// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { ZomboidMods } from "@/components/zomboid-mods";
import { gamesState, installBrowserStubs } from "./helpers/dom";
vi.mock("@/lib/use-games", () => ({ useGames: () => gamesState(), CAPABILITY_POLL_MS: 30000 }));
vi.mock("@/lib/game-gate", () => ({ gameGate: async () => ({ ok: true, session: { user: { id: "fixture-user", role: "ADMIN" } } }) }));
vi.mock("@/lib/db", () => ({ db: { zomboidMod: {
  findUnique: async () => ({ modIds: "RootB41;B42;Alternate" }), upsert: async () => ({}),
} } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeAll(installBrowserStubs); afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("an unchanged editor Save through the actual PATCH preserves enabled tokens and disabled variants on disk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yoshling-pz-editor-"));
  try {
    vi.stubEnv("PZ_SERVER_DIR", root); vi.stubEnv("PZ_WORKSHOP_DIR", path.join(root, "workshop")); vi.stubEnv("PZ_SERVER_NAME", "fixture");
    await mkdir(path.join(root, "Server"));
    const ini = path.join(root, "Server", "fixture.ini");
    const original = "PublicName=Fixture\nWorkshopItems=123456;777777\nMods=\\B42;\\Unrelated\nMap=Muldraugh, KY\n";
    await writeFile(ini, original);
    for (const id of ["RootB41", "B42", "Alternate"]) {
      const dir = path.join(root, "workshop", "content", "108600", "123456", "mods", id);
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "mod.info"), `id=${id}\nname=Fixture\n`);
    }
    const { PATCH } = await import("@/app/api/zomboid/mods/route");
    const { readModState } = await import("@/lib/zomboid");
    const receipts: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PATCH") {
        const res = await PATCH(new NextRequest("http://localhost/api/zomboid/mods", init)); receipts.push(res.status); return res;
      }
      const saved = await readModState();
      return new Response(JSON.stringify({ mods: [{ workshopId: "123456", title: "Fixture variants", previewUrl: null, provides: ["RootB41", "B42", "Alternate"], enabled: saved.modIds.filter((id) => id !== "Unrelated"), downloaded: true }], orphanModIds: ["Unrelated"] }));
    }));
    render(<ZomboidMods tint="var(--pz)" />); fireEvent.click(await screen.findByTitle("Edit mod ids"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(receipts).toEqual([200]));
    expect(await readFile(ini, "utf8")).toBe(original);
    expect((await readModState()).modIds).toEqual(["B42", "Unrelated"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
