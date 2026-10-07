/**
 * `/api/games/status` — the `can` projection, for the two mods capabilities.
 *
 * The other half of `tests/mods-surfaces.test.tsx`. That file stubs `useGames`, so it proves
 * the four components gate on `can.modsInstall` / `can.modsRemove` and nothing more: a route
 * that stopped sending the two fields would leave all 29 of its tests green while
 * `useGames`' `?? false` hid Install to Server, Delete and Remove from an **admin**. Which is
 * the mirror image of the bug being fixed and just as invisible from the other file.
 *
 * `@/lib/permissions` is deliberately **not** mocked. The whole value here is that the flags
 * are derived from the real table, so flipping `mods.install` to `["ADMIN"]` turns this red
 * rather than silently changing what a MOD is offered. `tests/mc-bans-route.test.ts` is the
 * cautionary precedent `docs/OPERATIONS.md` names: it stubs `hasPermission: () => true`,
 * which means deleting the real call from the route changes nothing.
 *
 * Only the edges are faked — the session and the three `game-manager` probes, every one of
 * which shells out to Docker or reads `/proc/meminfo`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_LIST, type GameId } from "@/lib/games";
import type { Role } from "@/lib/permissions";

let role: Role = "ADMIN";
// Varied alongside `role` because the two gates are independent axes. A MOD's world access
// must not change what `can` says: these are capabilities, not worlds, and `access` is the
// separate field that carries the worlds.
let games = "minecraft,7dtd,zomboid";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", name: "Tester", role, games } })),
}));

vi.mock("@/lib/game-manager", () => ({
  cachedAllStatus: vi.fn(async () =>
    Object.fromEntries(
      GAME_LIST.map((g) => [
        g.id,
        {
          game: g.id,
          status: "offline",
          players: { online: 0, max: 0, players: [] },
          containerRunning: false,
        },
      ])
    )
  ),
  currentControlLock: vi.fn(() => null),
  configuredMemoryGb: vi.fn(async () => ({ minecraft: 4, "7dtd": null, zomboid: 10 })),
  hostTotalGb: vi.fn(async () => 15.6),
  maxGameGb: vi.fn(async () => 13),
  liveSettings: vi.fn(async () => ({
    game: "minecraft" as GameId,
    available: false,
    values: {},
    readAt: 0,
  })),
}));

import { GET } from "@/app/api/games/status/route";

/** The `can` object the route actually puts on the wire for the current role. */
async function can(): Promise<Record<string, boolean>> {
  const res = await GET(new Request("http://localhost/api/games/status"));
  const body = await res.json();
  return body.can;
}

beforeEach(() => {
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
});

describe("the two mods flags are on the wire", () => {
  it("grants both to an ADMIN", async () => {
    expect(await can()).toMatchObject({ modsInstall: true, modsRemove: true });
  });

  it("grants both to a MOD", async () => {
    /**
     * MOD differs from ADMIN in *scope*, not capability — `permissions.ts` says so and the
     * 2026-09-14 change that made power MOD-usable exists because a trusted mod could not
     * restart after a Workshop update locked players out. Asserted here rather than inferred,
     * because if these two keys were quietly fenced to ADMIN the mods page would go read-only
     * for every mod with nothing saying why.
     */
    role = "MOD";
    expect(await can()).toMatchObject({ modsInstall: true, modsRemove: true });
  });

  it("grants neither to a MEMBER", async () => {
    // The defect this increment fixes, stated at the source: MEMBER holds neither, so the
    // page must offer neither.
    role = "MEMBER";
    expect(await can()).toMatchObject({ modsInstall: false, modsRemove: false });
  });

  it("does not let a MOD's world access decide a capability", async () => {
    // World access scopes *which* worlds, never *what* may be done. A MOD granted only
    // Project Zomboid still holds `mods.install`; whether they ever see the Minecraft mods
    // page is the layout's and `access`'s business, and conflating the two axes here would
    // hide a deletion of either.
    role = "MOD";
    games = "zomboid";
    expect(await can()).toMatchObject({ modsInstall: true, modsRemove: true });
  });

  it("keeps the fields it already had", async () => {
    // Added alongside `settings` and the three power booleans on one object, so the shape
    // every existing reader depends on has to come back unchanged.
    role = "MOD";
    expect(Object.keys(await can()).sort()).toEqual(
      ["modsInstall", "modsRemove", "restart", "settings", "start", "stop", "settingsEdit", "consoleExecute", "filesDelete", "usersManage"].sort()
    );
  });
});

describe("privileged frontend capabilities", () => {
  it.each(["ADMIN", "MOD", "MEMBER"] as Role[])("projects %s from the actual policy table", async (r) => {
    role = r;
    expect(await can()).toMatchObject({ settingsEdit: r !== "MEMBER", consoleExecute: r !== "MEMBER", filesDelete: r !== "MEMBER", usersManage: r === "ADMIN" });
  });
});
