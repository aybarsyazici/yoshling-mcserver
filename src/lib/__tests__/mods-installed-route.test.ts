import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstalledReading } from "@/lib/mod-inventory";

/**
 * **`GET /api/mods/installed`, driven as a route over a real mods directory.**
 *
 * The route half of the reconcile. `mod-inventory.test.ts` proves the helper is right;
 * this proves the route *calls* it and hands the answer back — which is the mutation that
 * matters, because the endpoint it replaced was a bare `db.installedMod.findMany()` and
 * the easiest regression in the world is going back to one.
 *
 * `reconcileMods` is **not** mocked and the files are real: only `auth`, Prisma and
 * `getModsDir` are faked. A fake reconcile would leave "the route lists rows and calls
 * them installed" green.
 */

const ROOT = path.join(
  (process.env.TMPDIR || "/tmp").replace(/\/+$/, ""),
  `yoshling-installed-route-${process.pid}-${Date.now()}`
);
const MODS = path.join(ROOT, "mods");

let signedIn = true;
let role = "ADMIN";
/** Varied beside `role`: the two gates are independent axes. */
let games = "minecraft,7dtd,zomboid";

interface Row {
  id: string;
  modrinthId: string;
  slug: string;
  name: string;
  version: string;
  fileName: string;
  mcVersion: string;
  loader: string;
  installedBy: string;
  installedAt: Date;
  source: string | null;
  versionId: string | null;
}

let rows: Row[] = [];
let users: { id: string; username: string }[] = [];
/** Every `orderBy` the route asked Prisma for, so "newest first" stays pinned. */
const modQueries: unknown[] = [];
/** Every `user.findMany` the route ran — one for the whole page, not one per row. */
const userQueries: unknown[] = [];
/**
 * The `Activity` row the route finds, if any, plus the query it used to find it.
 *
 * The row is how "which pack is on the server" is answered, and the *query* matters as
 * much: `Activity` grows by one row per installed mod, so a 166-mod apply adds 332 of them
 * and this lookup has to be a `findFirst` on the newest `apply_modpack` rather than a scan.
 */
let appliedRow: {
  action: string;
  details: string;
  createdAt: Date;
  user?: { username: string | null } | null;
} | null = null;
const activityQueries: unknown[] = [];
/** `null` models a fresh install with no `ServerConfig` row. */
let serverConfig: { mcVersion: string; modLoader: string } | null = {
  mcVersion: "26.1.2",
  modLoader: "fabric",
};

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () =>
    signedIn ? { user: { id: "u1", name: "Tester", role, games } } : null
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    installedMod: {
      findMany: vi.fn(async (args: unknown) => {
        modQueries.push(args);
        return rows;
      }),
    },
    user: {
      findMany: vi.fn(async (args: unknown) => {
        userQueries.push(args);
        const where = args as { where: { id: { in: string[] } } };
        return users.filter((u) => where.where.id.in.includes(u.id));
      }),
    },
    activity: {
      findFirst: vi.fn(async (args: unknown) => {
        activityQueries.push(args);
        return appliedRow;
      }),
    },
    serverConfig: {
      findUnique: vi.fn(async () => serverConfig),
    },
  },
}));

vi.mock("@/lib/server-manager", () => ({ getModsDir: () => MODS }));

const { GET } = await import("@/app/api/mods/installed/route");

function row(over: Partial<Row> & { fileName: string }): Row {
  return {
    id: `row-${over.fileName}`,
    modrinthId: "P7dR8mSH",
    slug: "fabric-api",
    name: "Fabric API",
    version: "0.149.1+26.1.2",
    mcVersion: "26.1.2",
    loader: "fabric",
    installedBy: "u1",
    installedAt: new Date("2026-10-01T00:00:00Z"),
    source: "manual",
    versionId: null,
    ...over,
  };
}

async function get(
  qs = ""
): Promise<{ status: number; body: InstalledReading & { error?: string } }> {
  const res = await GET(new Request(`http://localhost/api/mods/installed${qs}`) as never);
  return { status: res.status, body: (await res.json()) as InstalledReading & { error?: string } };
}

beforeEach(async () => {
  vi.clearAllMocks();
  signedIn = true;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
  rows = [];
  users = [{ id: "u1", username: "Aybars" }];
  modQueries.length = 0;
  userQueries.length = 0;
  appliedRow = null;
  serverConfig = { mcVersion: "26.1.2", modLoader: "fabric" };
  activityQueries.length = 0;
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(MODS, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("the endpoint answers a reconcile, not a row list", () => {
  it("names the jar on disk that no row claims", async () => {
    await writeFile(path.join(MODS, "fabric-api-0.149.1+26.1.2.jar"), "a", "utf-8");
    await writeFile(path.join(MODS, "nobody-installed-me.jar"), "bb", "utf-8");
    rows = [row({ fileName: "fabric-api-0.149.1+26.1.2.jar" })];

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.untracked).toEqual(["nobody-installed-me.jar"]);
    expect(body.matched).toEqual(["fabric-api-0.149.1+26.1.2.jar"]);
    expect(body.mods.map((m) => [m.fileName, m.state])).toEqual([
      ["fabric-api-0.149.1+26.1.2.jar", "matched"],
      ["nobody-installed-me.jar", "untracked"],
    ]);
  });

  it("names the row whose jar is not there", async () => {
    rows = [row({ fileName: "xaerominimap-fabric-26.1.2-25.3.14.jar", name: "Xaero's Minimap" })];
    const { body } = await get();
    expect(body.missing).toEqual(["xaerominimap-fabric-26.1.2-25.3.14.jar"]);
    expect(body.mods[0].name).toBe("Xaero's Minimap");
    expect(body.mods[0].state).toBe("missing");
  });

  it("reports three matched and nothing else when they agree", async () => {
    const jars = [
      "fabric-api-0.149.1+26.1.2.jar",
      "xaerominimap-fabric-26.1.2-25.3.14.jar",
      "xaeroworldmap-fabric-26.1.2-1.40.18.jar",
    ];
    for (const j of jars) await writeFile(path.join(MODS, j), "x", "utf-8");
    rows = jars.map((fileName) => row({ fileName }));

    const { body } = await get();
    expect(body.matched.sort()).toEqual([...jars].sort());
    expect(body.untracked).toEqual([]);
    expect(body.missing).toEqual([]);
    expect(body.modsDirPresent).toBe(true);
  });

  it("still asks for the newest row first", async () => {
    await get();
    expect(modQueries).toEqual([{ orderBy: { installedAt: "desc" } }]);
  });
});

describe("hashing is opt-in", () => {
  beforeEach(async () => {
    await writeFile(path.join(MODS, "a.jar"), "bytes", "utf-8");
    rows = [row({ fileName: "a.jar" })];
  });

  it("does not hash by default", async () => {
    const { body } = await get();
    expect(body.hashed).toBe(false);
    expect(body.mods[0].sha512).toBe(null);
    // The size is there either way — one `stat`, and a 0-byte jar is worth seeing without
    // having to ask for it.
    expect(body.mods[0].sizeBytes).toBe(5);
  });

  it("hashes when the caller asks", async () => {
    const { body } = await get("?hash=1");
    expect(body.hashed).toBe(true);
    expect(body.mods[0].sha512).toMatch(/^[0-9a-f]{128}$/);
  });

  it("treats any other value as not asking", async () => {
    // `?hash=1` and nothing else, so a stray `?hash=false` cannot turn hashing on.
    expect((await get("?hash=false")).body.hashed).toBe(false);
    expect((await get("?hash=0")).body.hashed).toBe(false);
    expect((await get("?hash")).body.hashed).toBe(false);
  });
});

describe("who installed it", () => {
  it("resolves the name in one query for the whole page", async () => {
    await writeFile(path.join(MODS, "a.jar"), "x", "utf-8");
    await writeFile(path.join(MODS, "b.jar"), "x", "utf-8");
    rows = [
      row({ fileName: "a.jar", installedBy: "u1" }),
      row({ fileName: "b.jar", installedBy: "u1" }),
    ];
    const { body } = await get();
    expect(body.mods.map((m) => m.installedByName)).toEqual(["Aybars", "Aybars"]);
    // One lookup for two rows by the same actor, and the ids de-duplicated.
    expect(userQueries).toEqual([
      { where: { id: { in: ["u1"] } }, select: { id: true, username: true } },
    ]);
  });

  it("says nothing about who when the id does not resolve", async () => {
    // The column holds whatever `session.user.id` was and an account can be gone. A cuid
    // on screen is not an answer, and inventing a reason for its absence is worse.
    await writeFile(path.join(MODS, "a.jar"), "x", "utf-8");
    rows = [row({ fileName: "a.jar", installedBy: "u-deleted" })];
    const { body } = await get();
    expect(body.mods[0].installedByName).toBe(null);
    expect(body.mods[0].installedBy).toBe("u-deleted");
  });

  it("runs no user query at all when there are no rows", async () => {
    const { body } = await get();
    expect(userQueries).toEqual([]);
    expect(body.mods).toEqual([]);
  });
});

describe("an empty server is not an error", () => {
  it("answers 200 with nothing installed when there is no mods directory", async () => {
    await rm(MODS, { recursive: true, force: true });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.modsDirPresent).toBe(false);
    expect(body.mods).toEqual([]);
  });
});

describe("the last recorded modpack apply travels with the reading", () => {
  /**
   * **One request, two readers.** The pack strip at the top of the page and the list under
   * it both come out of this response, so they cannot disagree about the same server —
   * which is what two components each fetching this endpoint would allow, and is the same
   * drift the reconcile's three groups are derived from one list to avoid.
   */
  it("reports the pack a recorded apply names", async () => {
    appliedRow = {
      action: "apply_modpack",
      details: JSON.stringify({
        game: "minecraft",
        packId: "pack-1",
        packName: "Vanilla Perfected",
        installed: 78,
        total: 81,
        mcVersion: "26.1.2",
        loader: "fabric",
      }),
      createdAt: new Date("2026-10-01T12:00:00Z"),
      user: { username: "Aybars" },
    };
    const { body } = await get();
    expect(body.pack).toEqual({
      packId: "pack-1",
      name: "Vanilla Perfected",
      appliedAt: "2026-10-01T12:00:00.000Z",
      appliedByName: "Aybars",
      installed: 78,
      total: 81,
      mcVersion: "26.1.2",
      loader: "fabric",
    });
  });

  it("answers null when no apply has been recorded", async () => {
    // Production's state today: three mods, each installed on its own, no pack ever
    // applied from this dashboard. `null` is what makes the header say so instead of
    // naming a pack nobody applied.
    const { body } = await get();
    expect(body.pack).toBe(null);
  });

  it("asks for the newest apply_modpack row, not for the whole log", async () => {
    // `Activity` gains a row per installed mod, so a 166-mod apply adds 332. A scan here
    // would read the lot on every page load.
    await get();
    expect(activityQueries).toEqual([
      {
        where: { action: "apply_modpack" },
        orderBy: { createdAt: "desc" },
        include: { user: { select: { username: true } } },
      },
    ]);
  });

  it("answers null for a row whose details will not parse", async () => {
    // `Activity.details` is free-text JSON written by several routes over several months.
    // A row this cannot read is not a record to state anything from, and "Unknown pack"
    // would put a pack on the header that nobody applied.
    appliedRow = {
      action: "apply_modpack",
      details: "{not json",
      createdAt: new Date("2026-10-01T12:00:00Z"),
      user: { username: "Aybars" },
    };
    expect((await get()).body.pack).toBe(null);
  });
});

describe("what the server is configured to run travels with it too", () => {
  it("reports the configured version and loader", async () => {
    // So the header can compare the pack's target against it — real drift, because the
    // version dropdown can be changed after a pack is applied and the jars do not move.
    const { body } = await get();
    expect(body.server).toEqual({ mcVersion: "26.1.2", loader: "fabric" });
  });

  it("reports null when there is no ServerConfig row", async () => {
    // A fresh install. It has to stay distinguishable from "configured, and it agrees":
    // an absent reading rendered as a disagreement is the mistake every settings surface
    // in this app is built to avoid.
    serverConfig = null;
    expect((await get()).body.server).toBe(null);
  });
});

describe("the gates", () => {
  it("401s a visitor, and reads nothing", async () => {
    signedIn = false;
    expect((await get()).status).toBe(401);
    expect(modQueries).toEqual([]);
  });

  it("403s a MOD who does not hold Minecraft, and reads nothing", async () => {
    role = "MOD";
    games = "zomboid";
    expect((await get()).status).toBe(403);
    expect(modQueries).toEqual([]);
  });

  it("answers a MEMBER who holds Minecraft — it is a read", async () => {
    // Deliberate, and the same call the route made before: `denyGame` and no
    // `hasPermission`. A read-only account browsing what is installed is the thing this
    // page is for, and `tests/mods-surfaces.test.tsx` pins that it gets no write control.
    role = "MEMBER";
    games = "minecraft";
    expect((await get()).status).toBe(200);
  });
});
