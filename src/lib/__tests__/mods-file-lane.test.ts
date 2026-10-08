import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModrinthVersion } from "@/lib/modrinth";

/**
 * **The two single-mod writers against the `files:minecraft` lane.**
 *
 * `POST /api/mods/install` and `DELETE /api/mods/[id]` are the only writers into the
 * Minecraft mods directory that took **no** resource at all, while 23 handlers across 18
 * other route files already take this exact lane through `fileLaneBusy` (counted, not
 * estimated — `grep -rl fileLaneBusy src/app/api`). `mods.apply` holds it for
 * the whole of a 166-mod install — a window that begins by deleting *every* installed jar —
 * so the two interleavings were:
 *
 * - **An install during the apply.** The jar is not in the apply's plan, so it is not in the
 *   set the apply re-downloads, and it survives the wipe: the pack loads with a stranger in
 *   it. `install-modpack` already names the symmetric case ("a jar that survives this loads
 *   alongside the new pack") and says out loud that it has to be reported — this is the same
 *   state reached from a direction nothing was watching.
 * - **A remove during the apply.** Both call `removeMod` on the same row, and the loser
 *   throws (`removeMod` reads the row first and throws `Mod not found` when it is gone), so
 *   the apply pushes `"<name>: could not be removed"` into `errors` and the operator is shown
 *   a named failure for a jar that was in fact deleted. A reported fault that did not happen
 *   costs the same to chase as a real one.
 *
 * ## What is faked, and what is not
 *
 * Edges only: `auth`, Prisma, Modrinth and `mod-manager`'s two I/O functions. The **operation
 * registry and `fileLaneBusy` are real** — the lane is held here by entering a real
 * `backup.create` operation and parking it, which is the only way to tell "the route calls
 * `assertResourceFree`" from "a mock said 409". `src/lib/__tests__/mc-gamerules-route.test.ts`
 * stubs `fileLaneBusy` to a boolean, which cannot distinguish those two.
 *
 * **The gates are real too.** `role` and `games` vary on a mocked session and
 * `@/lib/game-gate` plus `@/lib/permissions` run unmocked, so deleting either call from
 * either route reddens this file.
 */

let signedIn = true;
let role = "ADMIN";
let games = "minecraft,7dtd,zomboid";

/** Everything the routes managed to do, in order. Empty is the assertion that matters most. */
let installedNames: string[] = [];
let removedIds: string[] = [];
let lookups: string[] = [];

const LITHIUM: ModrinthVersion = {
  id: "v-lithium",
  project_id: "id-Lithium",
  name: "Lithium",
  version_number: "1.0.0",
  game_versions: ["26.1.2"],
  loaders: ["fabric"],
  date_published: "2026-10-01T00:00:00Z",
  downloads: 1,
  files: [
    {
      hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) },
      url: "https://cdn.modrinth.test/lithium.jar",
      filename: "lithium.jar",
      size: 1024,
      primary: true,
    },
  ],
  dependencies: [],
  environment: "client_and_server",
} as ModrinthVersion;

const getProjectVersions = vi.fn(async (modrinthId: string) => {
  lookups.push(modrinthId);
  return [LITHIUM];
});

const installMod = vi.fn(async ({ name }: { name: string }) => {
  installedNames.push(name);
  return { ok: true, checked: "sha512", reason: "" };
});

const removeMod = vi.fn(async (id: string) => {
  removedIds.push(id);
});

// `serverSideFor` is the real decision in `mod-install-routes.test.ts`; here the mod under
// test is a plain server mod, so the verdict is fixed and the subject is the lane.
const serverSideFor = vi.fn(async () => ({
  install: true,
  basis: "version-environment" as const,
  declared: "required" as const,
  reason: "",
}));

vi.mock("@/lib/mod-manager", () => ({ installMod, removeMod, serverSideFor }));
vi.mock("@/lib/modrinth", () => ({ getProjectVersions }));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () =>
    signedIn ? { user: { id: "u1", name: "Tester", role, games } } : null
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    serverConfig: {
      findUnique: vi.fn(async () => ({ mcVersion: "26.1.2", modLoader: "fabric" })),
    },
    installedMod: { findFirst: vi.fn(async () => null) },
  },
}));

const { POST: installOne } = await import("@/app/api/mods/install/route");
const { DELETE: removeOne } = await import("@/app/api/mods/[id]/route");
const { runOperation } = await import("@/lib/operations");

// ── holding the lane for real ────────────────────────────────────────────────

/**
 * A live operation parked mid-flight, holding one world's file lane.
 *
 * `backup.create` is used because `DEFAULT_RESOURCES` gives it exactly `[files:<game>]` and
 * no `power` — so a 409 from either route under test can only be about the file lane, and the
 * body's `busy` field stays `null` (a power conflict is the thing that sets it).
 *
 * `ready` resolves from *inside* the callback, so the request is only issued once the
 * operation is genuinely admitted rather than after a hopeful tick.
 */
function holdFiles(game: "minecraft" | "zomboid") {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r) => (started = r));
  const done = runOperation(
    { kind: "backup.create", game, title: "Creating a backup" },
    async () => {
      started();
      await gate;
      return { value: null };
    }
  );
  return { ready, release, done };
}

let held: { ready: Promise<void>; release: () => void; done: Promise<unknown> } | null = null;

async function lockedBy(game: "minecraft" | "zomboid") {
  held = holdFiles(game);
  await held.ready;
}

beforeEach(() => {
  // Load-bearing: several tests below assert `not.toHaveBeenCalled()` on a request that
  // refused, and those read the *previous* test's calls without this.
  vi.clearAllMocks();
  signedIn = true;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
  installedNames = [];
  removedIds = [];
  lookups = [];
  held = null;
});

afterEach(async () => {
  // A parked operation is module state. Leaving one live would hold the lane for every
  // later test in this file and turn one failure into a cascade that names the wrong cause.
  if (held) {
    held.release();
    await held.done;
    held = null;
  }
});

// ── driving the routes ───────────────────────────────────────────────────────

interface Body {
  error?: string;
  resource?: string;
  busy?: unknown;
  success?: boolean;
}

async function install(body: unknown = { modrinthId: "id-Lithium", slug: "lithium", name: "Lithium" }) {
  const res = await installOne(
    new Request("http://localhost/api/mods/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
  return { status: res.status, body: (await res.json()) as Body };
}

async function remove(id = "m1") {
  const res = await removeOne(
    new Request(`http://localhost/api/mods/${id}`, { method: "DELETE" }) as never,
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: (await res.json()) as Body };
}

/** Nothing reached the mods directory, the database or Modrinth. */
function nothingHappened() {
  expect({ installedNames, removedIds, lookups }).toEqual({
    installedNames: [],
    removedIds: [],
    lookups: [],
  });
  expect(installMod).not.toHaveBeenCalled();
  expect(removeMod).not.toHaveBeenCalled();
}

// ── the lane ─────────────────────────────────────────────────────────────────

describe("POST /api/mods/install joins the files:minecraft lane", () => {
  it("409s and NAMES the lane while an operation holds it, installing nothing", async () => {
    await lockedBy("minecraft");
    const res = await install();
    expect(res.status).toBe(409);
    // The lane by name, which is what distinguishes this refusal from the route's three
    // other 409s (incompatible version, already installed, client-only).
    expect(res.body.resource).toBe("files:minecraft");
    expect(res.body.error).toMatch(/^Minecraft is busy — creating a backup/);
    expect(res.body.error).toMatch(/Try again when it finishes/);
    // `busy` is for power conflicts; a file-lane holder has no `action`, so claiming one
    // here would make `game-controls.tsx` report a power operation that is not running.
    expect(res.body.busy).toBe(null);
    nothingHappened();
  });

  /**
   * The complement, and it is the test that stops "409 unconditionally" passing the one
   * above. Without it the lane guard could be a hardcoded refusal.
   */
  it("installs normally when the lane is free", async () => {
    const res = await install();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(installedNames).toEqual(["Lithium"]);
  });

  /**
   * And the lane is per world. `files:zomboid` held by a Project Zomboid backup says nothing
   * about Minecraft's mods directory, and refusing there would make every PZ backup block
   * Minecraft work — which is the exact over-broad claim `DEFAULT_RESOURCES` was narrowed to
   * stop (a `power start zomboid` used to destroy a 7DTD backup).
   */
  it("is not blocked by another world's file lane", async () => {
    await lockedBy("zomboid");
    const res = await install();
    expect(res.status).toBe(200);
    expect(installedNames).toEqual(["Lithium"]);
  });
});

describe("DELETE /api/mods/[id] joins the files:minecraft lane", () => {
  it("409s and NAMES the lane while an operation holds it, removing nothing", async () => {
    await lockedBy("minecraft");
    const res = await remove();
    expect(res.status).toBe(409);
    expect(res.body.resource).toBe("files:minecraft");
    expect(res.body.error).toMatch(/^Minecraft is busy — creating a backup/);
    expect(res.body.busy).toBe(null);
    nothingHappened();
  });

  it("removes normally when the lane is free", async () => {
    const res = await remove("m1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(removedIds).toEqual(["m1"]);
  });

  it("is not blocked by another world's file lane", async () => {
    await lockedBy("zomboid");
    const res = await remove("m1");
    expect(res.status).toBe(200);
    expect(removedIds).toEqual(["m1"]);
  });
});

// ── the gates, and that they come first ─────────────────────────────────────

/**
 * **Before anything is written**, which is the half of a permission check that a status
 * assertion alone does not cover.
 *
 * A 403 returned *after* `installMod` has written the jar is still a 403, and the audit
 * record for this repo's reachability guard is explicit about the shape: a `hasPermission`
 * call whose result was discarded (`if (false)`) handed a MEMBER the live `ServerPassword`
 * with every test green. So each case asserts the side effects are absent as well as the
 * status.
 */
describe("who may install and remove a single mod", () => {
  it("refuses a MEMBER on install, before anything is written to disk", async () => {
    role = "MEMBER";
    games = "minecraft";
    const res = await install();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
    nothingHappened();
  });

  it("refuses a MEMBER on remove, before anything is written to disk", async () => {
    role = "MEMBER";
    games = "minecraft";
    const res = await remove();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
    nothingHappened();
  });

  /** The other axis. A MOD has full capability on the worlds it was granted and none here. */
  it("refuses a MOD who was never granted Minecraft, on both routes", async () => {
    role = "MOD";
    games = "zomboid";
    expect((await install()).status).toBe(403);
    expect((await remove()).status).toBe(403);
    nothingHappened();
  });

  it("refuses an unauthenticated request on both routes", async () => {
    signedIn = false;
    expect((await install()).status).toBe(401);
    expect((await remove()).status).toBe(401);
    nothingHappened();
  });

  /**
   * The complement for both axes together: a MOD **with** Minecraft gets through. Without
   * it, the four refusals above are also satisfied by a route that refuses everyone.
   */
  it("lets a MOD who has Minecraft install and remove", async () => {
    role = "MOD";
    games = "minecraft";
    expect((await install()).status).toBe(200);
    expect((await remove("m2")).status).toBe(200);
    expect(installedNames).toEqual(["Lithium"]);
    expect(removedIds).toEqual(["m2"]);
  });
});

vi.mock("@/lib/minecraft-active-profile", async () => {
  const { legacyMinecraftContextMock } = await import("./fixtures/legacy-minecraft-context");
  return legacyMinecraftContextMock(() => process.env.MC_SERVER_DIR || "/minecraft");
});
