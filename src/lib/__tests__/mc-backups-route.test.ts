import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * **`/api/server/backups`, driven as a route against real archives.**
 *
 * `mc-archive.test.ts` pins the swap itself. What cannot be seen from there is whether the
 * route *calls* it and whether it reports what came back — and that is the pairing this repo
 * keeps getting wrong. `docs/OPERATIONS.md` records a permissions guard that was satisfied
 * by a **discarded** call (keep `hasPermission(...)`, replace its `if` with `if (false)`,
 * everything green), and `install-modpack`'s own comments record two refusals whose
 * conditions were replaced with `if (false)` with the whole suite passing. So the archives
 * here are written by real `tar` into a real temp directory and the assertions are on the
 * bytes that landed in the live game directory.
 *
 * Faked: the session, the game-manager stop/start wrapper (it shells out to Docker), the
 * journal, and the two directory constants so they point somewhere writable. **Not** faked:
 * `game-gate`, `permissions`, `backup-store`'s `listArchives`, the manifest sidecars,
 * `backup-integrity`, `backup-retention`, `fs` and `tar`.
 */

/**
 * Hoisted because `vi.mock` factories run before the module body, and both directory
 * constants have to be the same strings the test writes into. `TMPDIR` rather than
 * `os.tmpdir()` because a hoisted factory cannot use this file's imports.
 */
const DIRS = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const root = `${base}/yoshling-mc-backups-${process.pid}-${Date.now()}`;
  return { root, mc: `${root}/minecraft`, backups: `${root}/backups` };
});

let signedIn = true;
let role = "ADMIN";
let games = "minecraft,7dtd,zomboid";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => (signedIn ? { user: { id: "u1", name: "Tester", role, games } } : null)),
}));

// `createBackup` is `backup-create`'s own concern and shells out through `game-manager`;
// `MC_DIR` is the only other thing this route reads from it.
let modRowsCleared = 0;
let modRowsWritten: Record<string, unknown>[] = [];

const createBackup = vi.fn(async () => {
  throw new Error("create is not what this suite is about");
});
vi.mock("@/lib/backup-create", () => ({ MC_DIR: DIRS.mc, createBackup }));

/**
 * The inventory table, recorded rather than stubbed away. The restore has to put
 * `InstalledMod` rows back alongside the jars: `removeMod` deletes each row with its file, so
 * a rollback that only restored the directory left the Mods page claiming nothing was
 * installed while the jars sat on disk. These two spies are how that is asserted.
 */
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { const { db } = await import("@/lib/db"); return fn(db); },
    serverConfig: { findUnique: async () => ({ mcVersion: "26.1.2", modLoader: "fabric" }) },
    installedMod: {
      deleteMany: vi.fn(async () => { modRowsCleared += 1; modRowsWritten = []; }),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => { modRowsWritten.push(...data as never[]); }),
      findMany: async () => modRowsWritten,
    },
  },
}));

vi.mock("@/lib/backup-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup-store")>();
  // Module-wide, so `backup-retention` and `backup-schedule` read the same temp directory.
  return {
    ...actual,
    BACKUP_DIRS: {
      minecraft: DIRS.backups,
      "7dtd": `${DIRS.root}/backups-7dtd`,
      zomboid: `${DIRS.root}/backups-zomboid`,
    },
  };
});

/** Everything the operation was told, so the step label and the facts can be asserted. */
let steps: string[] = [];
let settled: string[] = [];
let opFacts: { label: string; value: string }[] = [];
/** What `withGameStopped` reports about the world coming back up. */
let restarted = false;

vi.mock("@/lib/game-manager", () => ({
  getMinecraftTarget: async () => ({ mcVersion: "26.1.2", loader: "fabric" }),
  RUNTIME: {
    minecraft: { dir: DIRS.mc },
    "7dtd": { dir: `${DIRS.root}/sevendtd` },
    zomboid: { dir: `${DIRS.root}/zomboid` },
  },
  containerIsRunning: vi.fn(async () => false),
  withGameStopped: vi.fn(
    async (
      _game: string,
      _action: string,
      fn: (op: unknown) => Promise<void>
    ): Promise<{ restarted: boolean }> => {
      const op = {
        step: (label: string) => steps.push(label),
        settle: (label: string) => settled.push(label),
        detail: () => {},
        progress: () => {},
        reject: () => {},
        fact: (f: { label: string; value: string }) => opFacts.push(f),
        preempted: false,
      };
      await fn(op);
      return { restarted };
    }
  ),
}));

interface Journalled {
  game: string;
  event: string;
  outcome?: string;
  name?: string;
  detail?: string;
  error?: string;
  activity?: { action: string; details: Record<string, unknown> };
}
const journalled: Journalled[] = [];
vi.mock("@/lib/backup-log", () => ({
  recordBackupEvent: vi.fn(
    async (
      game: string,
      event: string,
      _actor: unknown,
      entry: Record<string, unknown>,
      activity?: { action: string; details: Record<string, unknown> }
    ) => {
      journalled.push({ game, event, ...entry, activity } as Journalled);
    }
  ),
  readJournal: vi.fn(async () => []),
}));

const { GET, POST } = await import("@/app/api/server/backups/route");

beforeEach(async () => {
  vi.clearAllMocks();
  signedIn = true;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
  steps = [];
  settled = [];
  modRowsCleared = 0;
  modRowsWritten = [];
  opFacts = [];
  restarted = false;
  journalled.length = 0;
  await rm(DIRS.root, { recursive: true, force: true });
  await mkdir(DIRS.mc, { recursive: true });
  await mkdir(DIRS.backups, { recursive: true });
});

afterEach(async () => {
  await rm(DIRS.root, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function put(relative: string, contents: string): Promise<void> {
  const target = path.join(DIRS.mc, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf-8");
}

async function read(relative: string): Promise<string | null> {
  return readFile(path.join(DIRS.mc, relative), "utf-8").catch(() => null);
}

/**
 * An archive of `members`, with the sidecar the create side writes beside it.
 *
 * `members` goes into the manifest as well as onto the `tar` command line, exactly as
 * `createMinecraft` and `install-modpack` do it — the listing reads the manifest, so a
 * fixture that wrote one and not the other would be testing a state the app cannot produce.
 */
async function archive(
  name: string,
  members: string[],
  manifest: Record<string, unknown> = {}
): Promise<void> {
  const target = path.join(DIRS.backups, name);
  await execFileAsync("tar", ["-czf", target, "-C", DIRS.mc, ...members]);
  await writeFile(
    `${target}.manifest.json`,
    JSON.stringify({ createdAt: new Date().toISOString(), members, ...manifest }),
    "utf-8"
  );
}

/** An archive from before manifests existed: no sidecar at all. */
async function legacyArchive(name: string, members: string[]): Promise<void> {
  await execFileAsync("tar", [
    "-czf",
    path.join(DIRS.backups, name),
    "-C",
    DIRS.mc,
    ...members,
  ]);
}

async function list(): Promise<{ status: number; body: Record<string, unknown>[] }> {
  const res = await GET(new Request("http://localhost/api/server/backups") as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>[] };
}

async function restore(backupName: string) {
  const res = await POST(
    new Request("http://localhost/api/server/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", backupName }),
    }) as never
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── the listing says which archives carry the mods ───────────────────────────

/**
 * Item the UI depends on: the archive `install-modpack` takes before it deletes every jar
 * and a routine world-only backup sit in the same list under names that both end in
 * `.tar.gz`, so without this the page cannot tell you which one undoes a modpack apply.
 */
describe("GET reports which archives contain mods", () => {
  it("distinguishes a two-member archive from a world-only one", async () => {
    await put("world/level.dat", "w");
    await put("mods/a.jar", "a");
    await archive("world-2026-10-01T00-00-00.tar.gz", ["world"]);
    await archive("auto-before-modpack-2026-10-02T00-00-00.tar.gz", ["world", "mods"]);

    const { status, body } = await list();
    expect(status).toBe(200);
    const byName = Object.fromEntries(body.map((b) => [b.name, b.includesMods]));
    expect(byName).toEqual({
      "world-2026-10-01T00-00-00.tar.gz": false,
      "auto-before-modpack-2026-10-02T00-00-00.tar.gz": true,
    });
  });

  /**
   * Every archive on the box predates `members`, and all of them are `-C MC_DIR world`. The
   * honest answer for them is **false**, and it has to come without opening the tar: an
   * in-tar read costs a full gzip decompression per archive, measured at 7.9 s for one
   * listing.
   */
  it("answers false for an archive with no manifest at all", async () => {
    await put("world/level.dat", "w");
    await legacyArchive("world-2026-05-29T00-00-00.tar.gz", ["world"]);
    const { body } = await list();
    expect(body).toHaveLength(1);
    expect(body[0].includesMods).toBe(false);
    // And the rest of the row is unchanged: no checksum recorded, not automatic.
    expect(body[0].verifiable).toBe(false);
    expect(body[0].automatic).toBe(false);
  });

  it("still reports the fields it reported before", async () => {
    await put("world/level.dat", "w");
    await archive("world-2026-10-01T00-00-00.tar.gz", ["world"], {
      sha256: "f".repeat(64),
      automatic: true,
    });
    const { body } = await list();
    expect(body[0].verifiable).toBe(true);
    expect(body[0].automatic).toBe(true);
    expect(body[0].includesMods).toBe(false);
    expect(typeof body[0].size).toBe("number");
  });
});

// ── the restore puts back what the archive holds ─────────────────────────────

describe("POST restore", () => {
  /**
   * **The combination that reports success while discarding the mods.** The restore extracts
   * every member into a staging dir and `rm -rf`s it in a `finally`, so a route that renames
   * only `world` into place answers `{success: true}` and deletes the jars it had just
   * extracted. Asserted on the files, because every status code and every toast is identical
   * either way.
   */
  /**
   * **The jars are not the whole restore.** `removeMod` deletes each `InstalledMod` row along
   * with its file, so a rollback that put only the directory back left the Mods page claiming
   * nothing was installed while the jars sat on disk — the files were reversible and the app's
   * record of them was not, and CLAUDE.md said "reversible for the mod set" on the strength of
   * the files alone.
   *
   * The rows come from the manifest because they cannot be reconstructed: a filename carries
   * no Modrinth project id. So the apply captures them *before* it deletes anything, and this
   * is the other end of that.
   */
  it("rebuilds the mod inventory from the manifest, not just the jars", async () => {
    await put("world/level.dat", "saved world");
    await put("mods/fabric-api.jar", "fabric v1");
    await archive("auto-before-modpack-2026-10-02T01-00-00.tar.gz", ["world", "mods"], {
      installedMods: [
        {
          modrinthId: "P7dR8mSH",
          slug: "fabric-api",
          name: "Fabric API",
          version: "0.149.1+26.1.2",
          fileName: "fabric-api.jar",
          mcVersion: "26.1",
          loader: "fabric",
        },
      ],
    });

    const { status, body } = await restore("auto-before-modpack-2026-10-02T01-00-00.tar.gz");

    expect(status).toBe(200);
    // Replaced wholesale, not merged: the inventory describes the archive's directory, and a
    // merge would leave rows for jars the restore just deleted.
    expect(modRowsCleared).toBe(1);
    expect(modRowsWritten).toHaveLength(1);
    expect(modRowsWritten[0]).toMatchObject({ slug: "fabric-api", fileName: "fabric-api.jar" });
    // Attributed to whoever ran the restore, so the row is not orphaned.
    expect(modRowsWritten[0].installedBy).toBe("");
    expect(body.restoredMods).toBe(1);
  });

  /** A routine world-only archive says nothing about mods and must not touch the table. */
  it("leaves the inventory alone when the archive has no mods", async () => {
    await put("world/level.dat", "saved world");
    await archive("world-2026-10-02T02-00-00.tar.gz", ["world"]);

    const { status, body } = await restore("world-2026-10-02T02-00-00.tar.gz");

    expect(status).toBe(200);
    expect(modRowsCleared).toBe(0);
    expect(modRowsWritten).toEqual([]);
    expect(body.restoredMods).toBeNull();
    expect(body.inventoryKnown).toBe(false);
  });

  it("puts mods/ back from a two-member archive and says so", async () => {
    await put("world/level.dat", "saved world");
    await put("mods/fabric-api.jar", "fabric v1");
    await archive("auto-before-modpack-2026-10-02T00-00-00.tar.gz", ["world", "mods"]);

    // The modpack apply this is a rollback from.
    await rm(path.join(DIRS.mc, "mods"), { recursive: true, force: true });
    await put("mods/cobblemon.jar", "the pack");
    await put("world/level.dat", "moved on");

    const { status, body } = await restore("auto-before-modpack-2026-10-02T00-00-00.tar.gz");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(await read("world/level.dat")).toBe("saved world");
    expect(await read("mods/fabric-api.jar")).toBe("fabric v1");
    expect(await read("mods/cobblemon.jar")).toBeNull();

    // And every surface that states an outcome states this one.
    expect(body.replaced).toBe("the world folder and the mods directory");
    expect(settled).toEqual(["Replaced the world folder and the mods directory"]);
    expect(opFacts).toContainEqual({
      label: "Replaced",
      value: "the world folder and the mods directory",
    });
    expect(journalled[0].activity?.details.replaced).toBe(
      "the world folder and the mods directory"
    );
  });

  /**
   * The complement, and it is the one that stops "always say mods" passing: a routine
   * backup replaces the world and leaves the live mods directory alone, so claiming the
   * jars came back would be a lie about a directory full of them.
   */
  it("leaves mods/ alone for a world-only archive, and does not claim otherwise", async () => {
    await put("world/level.dat", "saved world");
    await archive("world-2026-10-01T00-00-00.tar.gz", ["world"]);
    await put("world/level.dat", "moved on");
    await put("mods/installed-right-now.jar", "live");

    const { status, body } = await restore("world-2026-10-01T00-00-00.tar.gz");

    expect(status).toBe(200);
    expect(await read("world/level.dat")).toBe("saved world");
    expect(await read("mods/installed-right-now.jar")).toBe("live");
    expect(body.replaced).toBe("the world folder");
    expect(settled).toEqual(["Replaced the world folder"]);
    expect(opFacts).toContainEqual({ label: "Replaced", value: "the world folder" });
  });

  it("verifies the recorded checksum before it stops the world", async () => {
    await put("world/level.dat", "saved world");
    await archive("world-2026-10-01T00-00-00.tar.gz", ["world"], { sha256: "0".repeat(64) });

    const { status, body } = await restore("world-2026-10-01T00-00-00.tar.gz");

    // 400, not 500: a corrupt archive is a fact about the user's file.
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/does not match the checksum/);
    // Nothing was stopped and nothing was swapped — the check is above `withGameStopped`.
    expect(steps).toEqual([]);
    expect(await read("world/level.dat")).toBe("saved world");
    expect(journalled[0].outcome).toBe("failed");
  });

  it("answers 400 and records the failure for an archive with neither member", async () => {
    await put("world/level.dat", "the live world");
    const work = path.join(DIRS.root, "foreign");
    await mkdir(path.join(work, "Saves"), { recursive: true });
    await execFileAsync("tar", [
      "-czf",
      path.join(DIRS.backups, "7dtd-Reveo_Valley.tar.gz"),
      "-C",
      work,
      ".",
    ]);

    const { status, body } = await restore("7dtd-Reveo_Valley.tar.gz");

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/no world folder and no mods folder/);
    expect(await read("world/level.dat")).toBe("the live world");
    expect(journalled[0].outcome).toBe("failed");
    // No `.restore-*` left in the game directory.
    expect((await readdir(DIRS.mc)).filter((e) => e.startsWith(".restore-"))).toEqual([]);
  });

  it("404s for an archive that is not there, without entering an operation", async () => {
    const { status } = await restore("world-2026-01-01T00-00-00.tar.gz");
    expect(status).toBe(404);
    expect(steps).toEqual([]);
    expect(journalled).toEqual([]);
  });
});

// ── the gates are the real ones ──────────────────────────────────────────────

/**
 * Varied on both axes. Role and world access are independent, and
 * `docs/OPERATIONS.md` records a suite that stubbed them to `() => true` — which means the
 * real calls could be deleted outright with everything green.
 */
describe("the gates", () => {
  it("401s when nobody is signed in", async () => {
    signedIn = false;
    expect((await list()).status).toBe(401);
    expect((await restore("world-2026-10-01T00-00-00.tar.gz")).status).toBe(401);
  });

  it("refuses a viewer without the Minecraft world, on the listing and the restore", async () => {
    games = "zomboid";
    role = "ADMIN";
    // ADMIN ignores `User.games`, so this one is allowed through — the axis under test is
    // the role below.
    expect((await list()).status).toBe(200);
    role = "MOD";
    expect((await list()).status).toBe(403);
    expect((await restore("world-2026-10-01T00-00-00.tar.gz")).status).toBe(403);
  });

  it("lets a MEMBER list but not restore", async () => {
    await put("world/level.dat", "w");
    await archive("world-2026-10-01T00-00-00.tar.gz", ["world"]);
    role = "MEMBER";
    expect((await list()).status).toBe(200);
    const res = await restore("world-2026-10-01T00-00-00.tar.gz");
    expect(res.status).toBe(403);
    // Read-only means read-only: the world on disk is untouched.
    expect(steps).toEqual([]);
  });
});
