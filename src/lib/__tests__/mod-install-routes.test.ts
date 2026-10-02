import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverSideVerdict } from "@/lib/mod-admission";
import type { ModrinthVersion } from "@/lib/modrinth";

/**
 * **The two mod installers, driven as routes.**
 *
 * ## Why this file exists
 *
 * `/api/mods/install-modpack` is the most destructive endpoint in this app — it tars the
 * world, `removeMod`s **every** installed jar and then downloads up to 166 replacements —
 * and it had **no behavioural test at all**. `mod-plan.test.ts`, `mod-admission.test.ts` and
 * `mod-download.test.ts` cover the modules it delegates to, and `docs/OPERATIONS.md` records
 * exactly what that is worth on its own: *a shared helper existing is not evidence a caller
 * calls it.* An adversarial recheck turned that gap into eleven surviving mutants, and the
 * ones this file closes are all of the shape "the route computes the right answer and then
 * drops it on the floor":
 *
 * - `skipped.push(...plan.skipped)` deleted — the client-only skips are worked out and then
 *   never reach the response, the report dialog or the ledger, voiding the "named, never
 *   silent" guarantee the whole filter was built around.
 * - `errors.push(...plan.errors)` deleted — mods that failed to resolve vanish from
 *   `errors` and from the `Failed` fact while still counting against the denominator, so
 *   the apply reports a shortfall with nothing named as its cause.
 * - `{ status: complete ? 200 : 500 }` hardcoded to 200 — a partial apply answers success,
 *   which is this repo's named defect class ("reports success after doing nothing or the
 *   wrong thing") on the route with the largest blast radius.
 * - the unmapped-`environment` warning suppressed, so Modrinth extending the enum again
 *   goes unnoticed — which is the silence that warning was added for.
 * - the "installed but unverified" report suppressed, so a jar with nothing to check it
 *   against is presented as a checked one.
 * - the no-download-source refusal removed.
 * - and, in `/api/mods/install`, the client-only refusal replaced with `if (false)` so a
 *   client-only jar installs with a 200.
 *
 * ## What is faked, and what is deliberately not
 *
 * Only the edges: the session, Prisma, Modrinth, `mod-manager`'s three I/O functions,
 * `fs/promises`, `child_process` and `getModsDir`. Everything that makes a *decision* is
 * the real thing — `mod-plan`, `mod-admission`, `serverSideVerdict`, and the **operation
 * registry**, which is left unmocked on purpose: mutants 3 and 4 are about facts going
 * missing from the ledger, and a mocked registry cannot notice that. `ledger()` below reads
 * the record `runOperation` actually concluded.
 *
 * **The gates are real.** `auth` is mocked to a session whose `role` and `games` each test
 * varies, and `@/lib/game-gate` plus `@/lib/permissions` run for real — the way
 * `mc-gamerules-route.test.ts` does it. Stubbing them to `denyGame: () => null` and
 * `hasPermission: () => true` (which `tests/mc-bans-route.test.ts` does, and which a
 * recheck flagged) means the real calls could be deleted outright with the suite green,
 * which is the opposite of testing them.
 */

// ── the fake box ─────────────────────────────────────────────────────────────

/**
 * One row of the pack under test, plus everything the fakes need in order to answer about
 * it. A test names the shapes it cares about and the fixtures fall out of that.
 */
interface ModSpec {
  name: string;
  /** Modrinth's `environment` on the version this mod resolves to. */
  environment?: string;
  /** The version lookup comes back empty: no build for this loader / MC version. */
  unresolvable?: boolean;
  /** The version lookup throws — Modrinth having a bad minute. */
  lookupError?: string;
  /** A Technic/Solder direct download: no Modrinth id, a URL instead. */
  url?: string;
  /** Neither a Modrinth id nor a URL — the shape of the 224 dead `ModpackMod` rows. */
  orphan?: boolean;
  /** `installMod` throws for this one. */
  installError?: string;
  /** `installMod` answers `checked: null`: on disk, nothing published to check it against. */
  unverified?: boolean;
}

let signedIn = true;
let role = "ADMIN";
// Varied like `role`, because the two gates are independent axes and a route can hold a
// correct `denyGame` call with nothing noticing when it is deleted.
let games = "minecraft,7dtd,zomboid";

let specs: ModSpec[] = [];
let packName = "Test Pack";
let packTarget: { mcVersion: string | null; loader: string | null } = {
  mcVersion: null,
  loader: null,
};
let config: { mcVersion: string; modLoader: string } | null = {
  mcVersion: "26.1.2",
  modLoader: "fabric",
};
/** `InstalledMod` rows the apply is about to delete. */
let installedRows: { id: string; name: string; fileName: string }[] = [];
/** Ids whose `removeMod` throws — a jar that survives the wipe has to be said out loud. */
let removeFailures = new Set<string>();
/** What `/api/mods/install` finds when it checks for a duplicate. */
let existingInstalled: { id: string; name: string } | null = null;

let worldOnDisk = true;
let tarOutcome: "ok" | Error = "ok";
let archiveBytes = 173_283_913;

/** What a direct download serves. `null` Content-Length = the header is absent. */
let directLength: number | null = null;
let directBody = Buffer.from("PK\u0003\u0004 pretend this is a jar");
let directOk = true;

// Everything the route did to the world, in order.
let removedIds: string[] = [];
let installedNames: string[] = [];
let directWrites: { path: string; bytes: number }[] = [];
let dbRows: string[] = [];
let tarRuns: string[][] = [];
let tarTimeouts: (number | undefined)[] = [];
let rmRuns: string[] = [];
let mkdirRuns: string[] = [];
let lookups: string[] = [];
let fetched: string[] = [];

function spec(name: string): ModSpec | undefined {
  return specs.find((s) => s.name === name);
}

/** The `ModpackMod` rows Prisma would hand back for `specs`. */
function rows() {
  return specs.map((s, i) => ({
    id: `row-${i}`,
    name: s.name,
    slug: s.name.toLowerCase().replace(/\W+/g, "-"),
    modrinthId: s.orphan || s.url ? null : `id-${s.name}`,
    versionId: null,
    downloadUrl: s.url ?? null,
  }));
}

function version(s: ModSpec): ModrinthVersion {
  return {
    id: `v-${s.name}`,
    project_id: `id-${s.name}`,
    name: s.name,
    version_number: "1.0.0",
    game_versions: ["26.1.2"],
    loaders: ["fabric"],
    date_published: "2026-10-01T00:00:00Z",
    downloads: 1,
    files: [
      {
        hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) },
        url: `https://cdn.modrinth.test/${s.name}.jar`,
        filename: `${s.name}.jar`,
        size: 1024,
        primary: true,
      },
    ],
    dependencies: [],
    environment: s.environment,
  } as ModrinthVersion;
}

const getProjectVersions = vi.fn(async (modrinthId: string) => {
  lookups.push(modrinthId);
  const s = spec(modrinthId.replace(/^id-/, ""));
  if (!s) throw new Error(`the test asked Modrinth about ${modrinthId}, which has no spec`);
  if (s.lookupError) throw new Error(s.lookupError);
  if (s.unresolvable) return [];
  return [version(s)];
});

/**
 * The real side decision, with the project fallback left out.
 *
 * `serverSideVerdict` is the module under test here as much as the route is: a wrong enum
 * row reddens this file too, rather than only `mod-admission.test.ts`. The conditional
 * project fetch and its fail-open catch are `serverSideFor`'s own and are driven directly
 * by `mod-download.test.ts`.
 */
const serverSideFor = vi.fn(async (v: { environment?: string }) =>
  serverSideVerdict({ environment: v.environment })
);

const installMod = vi.fn(async ({ name }: { name: string }) => {
  const s = spec(name);
  if (s?.installError) throw new Error(s.installError);
  installedNames.push(name);
  return s?.unverified
    ? { ok: true, checked: null, reason: "no checksum or size was published for this file" }
    : { ok: true, checked: "sha512", reason: "" };
});

const removeMod = vi.fn(async (id: string) => {
  if (removeFailures.has(id)) throw new Error("permission denied");
  removedIds.push(id);
});

vi.mock("@/lib/mod-manager", () => ({ installMod, removeMod, serverSideFor }));
vi.mock("@/lib/modrinth", () => ({ getProjectVersions }));

const mkdir = vi.fn(async (dir: string) => {
  mkdirRuns.push(String(dir));
});
const rm = vi.fn(async (target: string) => {
  rmRuns.push(String(target));
});
const stat = vi.fn(async (target: string) => {
  // Two different questions reach this one function: "is there a world to back up" and
  // "how big did the archive come out". Keyed on the path, because the second one is the
  // read-back that makes "we took a backup" evidence rather than an assumption.
  if (String(target).endsWith("/world")) {
    if (!worldOnDisk) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { size: 4096 };
  }
  return { size: archiveBytes };
});
const writeFile = vi.fn(async (target: string, bytes: Buffer) => {
  directWrites.push({ path: String(target), bytes: bytes.byteLength });
});
vi.mock("fs/promises", () => ({ mkdir, rm, stat, writeFile }));

/**
 * Callback-shaped on purpose: the route wraps this in `promisify`, so a promise-returning
 * fake would hang forever waiting for a callback that is never called.
 */
const execFile = vi.fn(
  (
    file: string,
    args: string[],
    opts: { timeout?: number },
    cb: (e: Error | null, out?: { stdout: string; stderr: string }) => void
  ) => {
    tarRuns.push([file, ...args]);
    tarTimeouts.push(opts?.timeout);
    if (tarOutcome !== "ok") cb(tarOutcome);
    else cb(null, { stdout: "", stderr: "" });
  }
);
vi.mock("child_process", () => ({ execFile }));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () =>
    signedIn ? { user: { id: "u1", name: "Tester", role, games } } : null
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    modpack: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "pack-1"
          ? {
              id: "pack-1",
              name: packName,
              targetMcVersion: packTarget.mcVersion,
              targetLoader: packTarget.loader,
              mods: rows(),
            }
          : null
      ),
    },
    serverConfig: { findUnique: vi.fn(async () => config) },
    installedMod: {
      findMany: vi.fn(async () => installedRows),
      findFirst: vi.fn(async () => existingInstalled),
      create: vi.fn(async ({ data }: { data: { name: string } }) => {
        dbRows.push(data.name);
        return data;
      }),
    },
    activity: { create: vi.fn(async () => ({})) },
  },
}));

// `RUNTIME.minecraft.dir` is the only thing the route reads out of `game-manager`, and
// importing the real one pulls in the Docker CLI layer this suite is forbidden to touch.
vi.mock("@/lib/game-manager", () => ({ RUNTIME: { minecraft: { dir: "/mc" } } }));
vi.mock("@/lib/server-manager", () => ({ getModsDir: () => "/mods" }));

const { POST: applyPack } = await import("@/app/api/mods/install-modpack/route");
const { POST: installOne } = await import("@/app/api/mods/install/route");
const { listFinished } = await import("@/lib/operations");

beforeEach(() => {
  // **A per-test clear is load-bearing, and the reason is the opposite of what this comment
  // first said.** Several tests assert `expect(installMod).not.toHaveBeenCalled()` on a
  // request that refused. Without a clear those FAIL on the previous test's calls — measured:
  // deleting the line below reddens exactly three. The first version of this said the
  // assertions would *pass* on accumulated history, which is backwards, and it is the kind of
  // plausible inversion that gets copied rather than checked.
  //
  // `clearAllMocks` is chosen over `resetAllMocks` for clarity of intent, not necessity: on
  // the pinned vitest 3, `mockReset()` restores the implementation passed to `vi.fn(impl)`
  // rather than dropping it, so `resetAllMocks()` here also leaves all 36 green — measured.
  // An earlier version of this comment claimed it would leave every fake returning
  // `undefined`, which is vitest 2 behaviour and not what this repo runs.
  vi.clearAllMocks();
  signedIn = true;
  role = "ADMIN";
  games = "minecraft,7dtd,zomboid";
  specs = [];
  packName = "Test Pack";
  packTarget = { mcVersion: null, loader: null };
  config = { mcVersion: "26.1.2", modLoader: "fabric" };
  installedRows = [];
  removeFailures = new Set();
  existingInstalled = null;
  worldOnDisk = true;
  tarOutcome = "ok";
  archiveBytes = 173_283_913;
  directLength = null;
  directBody = Buffer.from("PK\u0003\u0004 pretend this is a jar");
  directOk = true;
  removedIds = [];
  installedNames = [];
  directWrites = [];
  dbRows = [];
  tarRuns = [];
  tarTimeouts = [];
  rmRuns = [];
  mkdirRuns = [];
  lookups = [];
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      const headers = new Headers();
      if (directLength !== null) headers.set("content-length", String(directLength));
      return {
        ok: directOk,
        status: directOk ? 200 : 404,
        headers,
        arrayBuffer: async () =>
          directBody.buffer.slice(
            directBody.byteOffset,
            directBody.byteOffset + directBody.byteLength
          ),
      };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── driving the routes ───────────────────────────────────────────────────────

interface ApplyBody {
  success?: boolean;
  installed?: number;
  total?: number;
  errors?: string[];
  warnings?: string[];
  skipped?: { name: string; reason: string }[];
  error?: string;
  needsVersionChange?: { mcVersion: string; modLoader: string };
}

/**
 * Records already in the registry's finished ring when this request started.
 *
 * `FINISHED` is module state and outlives a test, so `listFinished()` alone would hand a
 * test that refused *before* entering an operation the previous test's record — and every
 * ledger assertion would pass against someone else's apply. Excluding what was already
 * there makes `ledger()` throw instead, which is the failure a reader can act on.
 */
let priorOps = new Set<string>();

async function apply(body: unknown = { modpackId: "pack-1" }) {
  priorOps = new Set(listFinished().map((r) => r.id));
  const res = await applyPack(
    new Request("http://localhost/api/mods/install-modpack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
  return { status: res.status, body: (await res.json()) as ApplyBody };
}

async function installSingle(body: unknown) {
  const res = await installOne(
    new Request("http://localhost/api/mods/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * The record the registry concluded for the apply that just ran.
 *
 * Newest first, so the `find` is this test's operation. Read through the real
 * `listFinished` rather than a mock, because "the fact is missing from the ledger" is one
 * of the mutations under test and only the real conclusion can show it.
 */
function ledger() {
  const rec = listFinished().find((r) => r.kind === "mods.apply" && !priorOps.has(r.id));
  if (!rec) throw new Error("no finished mods.apply record — the route never ran an operation");
  return rec;
}

function fact(label: string) {
  return ledger().facts.find((f) => f.label === label);
}

/** Nothing in the mods directory, the world or Modrinth was touched. */
function nothingHappened() {
  expect({
    lookups,
    removed: removedIds,
    installed: installedNames,
    tars: tarRuns,
    writes: directWrites,
    mkdirs: mkdirRuns,
  }).toEqual({
    lookups: [],
    removed: [],
    installed: [],
    tars: [],
    writes: [],
    mkdirs: [],
  });
}

const SODIUM: ModSpec = { name: "Sodium", environment: "client_only" };
const LITHIUM: ModSpec = { name: "Lithium", environment: "client_and_server" };

// ── the gates ────────────────────────────────────────────────────────────────

describe("who may apply a modpack", () => {
  it("refuses an unauthenticated request with 401 and touches nothing", async () => {
    signedIn = false;
    specs = [LITHIUM];
    const res = await apply();
    expect(res.status).toBe(401);
    nothingHappened();
  });

  /**
   * World access, which is the axis `tests/mc-bans-route.test.ts` mocked away. A MOD has
   * full capability *on the worlds it was granted*; the whole point of `User.games` is
   * that it cannot reach Minecraft's mods directory.
   */
  it("refuses a MOD who has not been granted Minecraft, before anything is read", async () => {
    role = "MOD";
    games = "zomboid";
    specs = [LITHIUM];
    const res = await apply();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/No access/i);
    nothingHappened();
  });

  it("refuses a MEMBER, who may browse but not install", async () => {
    role = "MEMBER";
    games = "minecraft";
    specs = [LITHIUM];
    const res = await apply();
    expect(res.status).toBe(403);
    nothingHappened();
  });

  /** The complement, so the two refusals above are about access rather than about the
   * fixture being broken. */
  it("lets a MOD who HAS Minecraft through", async () => {
    role = "MOD";
    games = "minecraft";
    specs = [LITHIUM];
    const res = await apply();
    expect(res.status).toBe(200);
    expect(installedNames).toEqual(["Lithium"]);
  });

  it("404s an unknown pack and 400s a request with no id", async () => {
    expect((await apply({ modpackId: "nope" })).status).toBe(404);
    expect((await apply({})).status).toBe(400);
    nothingHappened();
  });
});

/**
 * The version guard. Downloading mods for a version the container is not running is the
 * "looks applied and silently isn't" trap, and the refusal has to come before the backup.
 */
describe("a pack that targets another version is refused, not applied", () => {
  it("409s with the pair to change, having read nothing from Modrinth", async () => {
    packTarget = { mcVersion: "1.21.1", loader: "fabric" };
    specs = [LITHIUM];
    const res = await apply();
    expect(res.status).toBe(409);
    expect(res.body.needsVersionChange).toEqual({ mcVersion: "1.21.1", modLoader: "fabric" });
    expect(res.body.error).toMatch(/Change the version and loader on the Minecraft settings page/);
    nothingHappened();
  });
});

// ── mutant 7: the no-download-source refusal ─────────────────────────────────

/**
 * **The mutant: the `installable === 0` refusal removed.**
 *
 * The flow is destroy-then-create, so a pack whose rows carry no download source would
 * wipe every installed jar and put nothing back. Three of the six saved packs on this box
 * are in that state (224 `ModpackMod` rows predate the importer fix), and the refusal is
 * what makes a click on one of them cost nothing.
 *
 * The assertion is on the **sentence and the shape**, not on the status: with the branch
 * gone, `modsDirRefusal` catches the same pack one step later and also answers 409 — but
 * with "could not be installed on a server", which sends the operator looking for a server
 * problem instead of re-importing the pack, and with an `installed`/`total` pair in the body.
 */
describe("a pack with no download source is refused by name", () => {
  beforeEach(() => {
    packName = "Fabulously Optimized";
    specs = [
      { name: "Sodium", orphan: true },
      { name: "Iris", orphan: true },
    ];
  });

  it("names the download source and the re-import, and answers no counts", async () => {
    const res = await apply();
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("None of the 2 mods");
    expect(res.body.error).toContain("has a download source");
    expect(res.body.error).toMatch(/re-import it to repair it/);
    // The refusal body is the sentence alone. A counts-carrying body is what the later,
    // less specific refusal produces, and `modpacks.tsx` branches on exactly that shape.
    expect(res.body.installed).toBeUndefined();
    expect(res.body.total).toBeUndefined();
  });

  it("costs nothing: no tar, no mkdir, no removal, no lookup", async () => {
    installedRows = [{ id: "m1", name: "Old", fileName: "old.jar" }];
    await apply();
    nothingHappened();
    // And the archive directory was never even created, which is the half of this that
    // left an orphaned 173 MB "restore point" for a world nothing had touched.
    expect(rmRuns).toEqual([]);
  });

  it("records it as having changed nothing, rather than as a finished install", async () => {
    await apply();
    expect(ledger().outcome).toBe("nothing");
    expect(ledger().steps.map((s) => s.label)).toEqual([
      "Read the modpack list: 2 mods, none with a download source",
    ]);
  });
});

// ── mutants 1 and 3: the client-only filter, and saying so ───────────────────

/**
 * **The mutants:** `if (false && !side.install)` (the filter itself) and
 * `skipped.push(...plan.skipped)` deleted (the route dropping the filter's output).
 *
 * The first restores the exact pre-change behaviour — every pack mod downloaded into the
 * server's mods directory, where the bad case is Fabric Loader aborting on a jar with no
 * server entrypoint and the symptom is a permanent "Starting…".
 *
 * The second is quieter and is why both halves are asserted here: the filter still works,
 * the skips are still left out of the download, and the user is simply never told. That is
 * the 7DTD config route's documented defect ("Saved" for settings it could not write) in a
 * new place, and it voids the one property that makes filtering defensible — a user who
 * cannot see *which* mods were held back cannot tell a correct filter from a broken one.
 */
describe("a client-only mod is left out, and said out loud", () => {
  beforeEach(() => {
    specs = [SODIUM, LITHIUM];
  });

  it("downloads only the server mod", async () => {
    const res = await apply();
    expect(res.status).toBe(200);
    expect(installedNames).toEqual(["Lithium"]);
    // The decision reached Modrinth for both — the skip is made *from* the version, not by
    // guessing from the name — and the download for one.
    expect(lookups).toEqual(["id-Sodium", "id-Lithium"]);
    expect(installMod).toHaveBeenCalledTimes(1);
  });

  it("names the skip in the response, with the declaration that decided it", async () => {
    const res = await apply();
    expect(res.body.skipped).toEqual([
      { name: "Sodium", reason: expect.stringContaining("client_only") },
    ]);
  });

  it("counts the skip out of the denominator, so a correct apply is a success", async () => {
    const res = await apply();
    // 2 rows, 1 of them client-only, so the server's share is 1 and it is complete.
    // Reporting "1 of 2" here is what would paint every correct apply of every real pack
    // amber — a large pack is 30-50% client mods.
    expect(res.body).toMatchObject({ success: true, installed: 1, total: 1 });
    expect(res.status).toBe(200);
  });

  it("records the skip as a plain ledger fact that outlives the response", async () => {
    await apply();
    const skipped = fact("Skipped as client-only");
    expect(skipped?.value).toContain("Sodium");
    // NO `warn` verdict: declining to put a client mod on a dedicated server is the
    // installer working, and a warn here makes `concludeOperation` return `partial` and
    // paints the whole apply amber.
    expect(skipped?.verdict).toBeUndefined();
    expect(ledger().outcome).toBe("ok");
  });

  it("keeps the skips out of the amber warning channel", async () => {
    // They were in `warnings` *and* in `skipped`, so the same correct decision rendered
    // twice in the report — once in `chart-5`, the warning colour, under a heading saying
    // nothing went wrong. The colour is a claim.
    const res = await apply();
    expect(res.body.warnings).toEqual([]);
  });

  /** The all-client pack: refused before anything is destroyed, and still named. */
  it("refuses an all-client pack with the names, and changes nothing", async () => {
    specs = [SODIUM, { name: "Iris", environment: "singleplayer_only" }];
    installedRows = [{ id: "m1", name: "Old", fileName: "old.jar" }];
    const res = await apply();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/are client-only/);
    expect(res.body.error).toMatch(/use the Export option/);
    expect(res.body.skipped?.map((s) => s.name)).toEqual(["Sodium", "Iris"]);
    expect(removedIds).toEqual([]);
    expect(tarRuns).toEqual([]);
    // `reject`, not a noop settle: 2 client-only mods are not 2 failures.
    expect(ledger().outcome).toBe("failed");
    expect(ledger().summary).toMatch(/No mod in this pack runs on a server/);
  });
});

// ── mutants 4 and 6: a shortfall names its cause, and is not a 200 ───────────

/**
 * **The mutants:** `errors.push(...plan.errors)` deleted, and
 * `{ status: complete ? 200 : 500 }` hardcoded to 200.
 *
 * They are tested together because they are the two halves of one guarantee: a mod that
 * should be on this server and is not has to be **counted** and **named**. Drop the push
 * and the apply reports a shortfall with nothing accounting for it; hardcode the status and
 * the shortfall is reported as a success, which the route's own comment four lines above the
 * line forbids.
 */
describe("a mod that did not land is counted and named", () => {
  it("500s and names a mod with no compatible version", async () => {
    specs = [LITHIUM, { name: "Gone", unresolvable: true }];
    const res = await apply();
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body).toMatchObject({ installed: 1, total: 2 });
    expect(res.body.errors).toEqual(["Gone: no compatible version"]);
    expect(res.body.error).toBe("Only 1 of 2 mods were installed.");
  });

  it("500s and names a mod whose download threw", async () => {
    specs = [LITHIUM, { name: "Broken", installError: "sha512 mismatch" }];
    const res = await apply();
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toEqual(["Broken: sha512 mismatch"]);
  });

  it("names a mod whose lookup threw, as a failure rather than a skip", async () => {
    // A Modrinth timeout treated as "client-only" would quietly shrink the pack every time
    // the API had a bad minute, and a skip is not in the denominator.
    specs = [LITHIUM, { name: "Flaky", lookupError: "Modrinth returned 502" }];
    const res = await apply();
    expect(res.status).toBe(500);
    expect(res.body.errors).toEqual(["Flaky: Modrinth returned 502"]);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.total).toBe(2);
  });

  /**
   * The ledger half. The HTTP body is assembled in the browser from this response, and a
   * 166-mod apply routinely outlives the ~100 s origin timeout — at which point
   * `modpacks.tsx` replaces it with `{installed: 0, total: 0}`. The fact is recorded
   * server-side and survives that, which is the whole reason it stopped being a bare count.
   */
  it("records the failures as a warn fact that NAMES them", async () => {
    specs = [LITHIUM, { name: "Gone", unresolvable: true }];
    await apply();
    const failed = fact("Failed");
    expect(failed?.value).toContain("Gone");
    expect(failed?.verdict).toBe("warn");
    expect(fact("Installed")?.value).toBe("1 of 2");
    expect(fact("Installed")?.verdict).toBe("warn");
    expect(ledger().outcome).toBe("partial");
  });

  it("answers 200 and a clean ledger when every server mod landed", async () => {
    // The complement. Without it, a mutant that answers 500 unconditionally also passes
    // every test above.
    specs = [LITHIUM, { name: "Create", environment: "server_only" }];
    const res = await apply();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, installed: 2, total: 2, errors: [] });
    expect(res.body.error).toBeUndefined();
    expect(ledger().outcome).toBe("ok");
    expect(fact("Installed")?.verdict).toBeUndefined();
  });

  /**
   * A jar that survives the wipe loads alongside the new pack, so a failed removal has to
   * be said out loud.
   *
   * Pinned as it behaves today, including the part that is arguable: the HTTP response is
   * **200 `success: true`**, because every mod that belongs on this server is on it and the
   * leftover is reported in `errors` rather than counted. The ledger does not round it off —
   * the removal step settles `noop` and the operation concludes `partial` — so the two
   * readers of this apply disagree by design, and the honest one is the one that outlives
   * the response.
   */
  it("names a jar it could not delete, and the ledger calls the apply partial", async () => {
    specs = [LITHIUM];
    installedRows = [
      { id: "m1", name: "Stuck", fileName: "stuck.jar" },
      { id: "m2", name: "Fine", fileName: "fine.jar" },
    ];
    removeFailures = new Set(["m1"]);
    const res = await apply();
    expect(removedIds).toEqual(["m2"]);
    expect(res.body.errors?.[0]).toMatch(/^Stuck: could not be removed/);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ledger().outcome).toBe("partial");
    expect(fact("Failed")?.value).toContain("Stuck");
  });
});

// ── mutant 2: the unmapped `environment` value ───────────────────────────────

/**
 * **The mutant:** the `plan.unrecognised` warning never pushed.
 *
 * `singleplayer_only` sat unmapped in the live API through this feature's first draft, so
 * every mod carrying it fell through to a project field that says the server is *required*
 * and was installed — silently, by the feature whose entire job is to keep exactly that jar
 * off the server. Falling through is the safe half and stays; the warning is the loud half,
 * and without it the enum goes stale again because nobody learns it drifted.
 */
describe("an environment value this app cannot read is reported", () => {
  it("warns, names the value and the mod, and still installs it", async () => {
    specs = [{ name: "FromTheFuture", environment: "client_or_server_prefers_server" }, LITHIUM];
    const res = await apply();
    expect(res.status).toBe(200);
    const warning = res.body.warnings?.find((w) => /does not recognise/.test(w));
    expect(warning).toBeDefined();
    expect(warning).toContain("client_or_server_prefers_server");
    expect(warning).toContain("FromTheFuture");
    expect(warning).toMatch(/src\/lib\/mod-admission\.ts/);
    // Fail-safe: installed, not skipped. A wrong skip is the expensive direction.
    expect(installedNames).toEqual(["FromTheFuture", "Lithium"]);
    expect(res.body.skipped).toEqual([]);
  });

  it("says nothing when every value was one the table knows", async () => {
    // Including the literal `"unknown"`, which is a *mapped* value meaning "this build says
    // nothing" — a different fact from "we cannot read what this build said".
    specs = [{ name: "Quiet", environment: "unknown" }, LITHIUM];
    const res = await apply();
    expect(res.body.warnings).toEqual([]);
  });
});

// ── mutant 8: installed, and not verified ────────────────────────────────────

/**
 * **The mutant:** `if (check.checked === null) unverified.push(mod.name)` removed.
 *
 * There are two writers into the mods directory and both can land a jar with nothing
 * published to check it against, so both are driven here. Suppressing the report does not
 * make the apply fail — it makes it *imply it checked*, which is the house defect class in
 * its quietest form.
 */
describe("a jar with nothing to verify it against is reported as unverified", () => {
  it("reports it on the Modrinth path", async () => {
    specs = [{ ...LITHIUM, unverified: true }];
    const res = await apply();
    expect(res.status).toBe(200);
    const warning = res.body.warnings?.find((w) => /without a checksum to verify against/.test(w));
    expect(warning).toContain("Lithium");
    expect(warning).toMatch(/direct download source/);
  });

  it("reports it on the direct-download path, where no header was sent", async () => {
    specs = [{ name: "TechnicThing", url: "https://technic.test/thing.jar" }];
    directLength = null;
    const res = await apply();
    expect(res.status).toBe(200);
    expect(res.body.warnings?.some((w) => /without a checksum/.test(w) && /TechnicThing/.test(w)))
      .toBe(true);
    expect(directWrites).toEqual([{ path: "/mods/technicthing.jar", bytes: directBody.byteLength }]);
    expect(dbRows).toEqual(["TechnicThing"]);
  });

  it("says nothing when the response declared a length that matched", async () => {
    specs = [{ name: "TechnicThing", url: "https://technic.test/thing.jar" }];
    directLength = directBody.byteLength;
    const res = await apply();
    expect(res.body.warnings).toEqual([]);
    expect(directWrites).toHaveLength(1);
  });

  /**
   * And the refusal above the write, from the route's side. `declaredFromHeaders` used to
   * be a literal `{}`, which `checkIntegrity` can only answer `ok: true` to — so the guard
   * was unreachable code on the one path with no registry hashes at all.
   */
  it("discards a truncated direct download instead of writing it", async () => {
    specs = [{ name: "TechnicThing", url: "https://technic.test/thing.jar" }];
    directLength = directBody.byteLength + 500;
    const res = await apply();
    expect(res.status).toBe(500);
    expect(directWrites).toEqual([]);
    expect(dbRows).toEqual([]);
    expect(res.body.errors?.[0]).toMatch(/^TechnicThing: /);
    expect(res.body.errors?.[0]).toMatch(/truncated/);
  });

  it("names a direct download the server refused, and writes nothing", async () => {
    specs = [{ name: "TechnicThing", url: "https://technic.test/thing.jar" }];
    directOk = false;
    const res = await apply();
    expect(res.body.errors).toEqual(["TechnicThing: download failed"]);
    expect(directWrites).toEqual([]);
    expect(fetched).toEqual(["https://technic.test/thing.jar"]);
  });
});

// ── the backup that stands in front of the deletion ─────────────────────────

/**
 * Not one of the eleven, but the step the eleven are downstream of: every jar on the
 * server is deleted immediately after this, so a backup that silently did not happen is
 * the worst thing on this route. It used to be non-fatal, with a 60 s timeout, and it left
 * the partial archive behind for `/api/server/backups` to offer as a restore point.
 */
describe("the pre-install backup", () => {
  it("tars the world with an argv array and the long timeout, and reads the size back", async () => {
    specs = [LITHIUM];
    await apply();
    expect(tarRuns).toHaveLength(1);
    const [cmd, ...args] = tarRuns[0];
    expect(cmd).toBe("tar");
    // An argv array, never a shell string: the sibling Minecraft backup route's injection
    // was this exact shape.
    expect(args[0]).toBe("-czf");
    expect(args.slice(2)).toEqual(["-C", "/mc", "world"]);
    expect(args[1]).toMatch(/^\/app\/data\/backups\/auto-before-modpack-.*\.tar\.gz$/);
    expect(tarTimeouts).toEqual([300_000]);
    // The size comes off disk, so "we took one" is evidence rather than an assumption.
    // The fixture is 173,283,913 B, the size a live run on 2026-09-29 recorded for one of
    // these archives; `formatBytes` renders that as 165 MiB.
    expect(fact("Rollback point")?.value).toMatch(/^auto-before-modpack-.*\.tar\.gz \(165 MiB\)$/);
  });

  it("is fatal: a failed tar leaves the mods directory alone and deletes the partial", async () => {
    specs = [LITHIUM];
    installedRows = [{ id: "m1", name: "Old", fileName: "old.jar" }];
    tarOutcome = new Error("tar: Error exit delayed from previous errors");
    const res = await apply();
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/current mods are untouched/);
    expect(res.body.error).toMatch(/tar: Error exit delayed/);
    expect(res.body.error).toMatch(/partial archive has been deleted/);
    expect(removedIds).toEqual([]);
    expect(installedNames).toEqual([]);
    // Dropped FIRST, so nothing can list it as a restore point even if nobody reads the
    // response.
    expect(rmRuns).toHaveLength(1);
    expect(rmRuns[0]).toMatch(/auto-before-modpack-.*\.tar\.gz$/);
    expect(ledger().outcome).toBe("failed");
  });

  it("settles done, not noop, when there is no world to back up yet", async () => {
    // `concludeOperation` turns any `noop` step into outcome `partial`, so marking this one
    // would paint a flawless apply amber on every server that has no world yet. Nothing
    // went wrong; there was simply nothing to do.
    specs = [LITHIUM];
    worldOnDisk = false;
    const res = await apply();
    expect(res.status).toBe(200);
    expect(tarRuns).toEqual([]);
    expect(fact("Rollback point")?.value).toMatch(/no world on disk yet/);
    expect(ledger().outcome).toBe("ok");
    expect(installedNames).toEqual(["Lithium"]);
  });
});

// ── mutant 5: /api/mods/install's client-only refusal ───────────────────────

/**
 * **The mutant:** the client-only refusal and its `allowClientOnly` opt-in replaced with
 * `if (false)`, so a client-only jar installs and answers 200 `{success: true}`.
 *
 * This route has no UI caller today and that is precisely the argument for testing it:
 * leaving the hole open in one of the two installers is how the power control ended up
 * with three copies and two missing fixes.
 */
describe("/api/mods/install refuses a client-only mod", () => {
  const sodium = {
    modrinthId: "id-Sodium",
    slug: "sodium",
    name: "Sodium",
  };

  beforeEach(() => {
    specs = [SODIUM, LITHIUM];
  });

  it("409s without installing anything, naming the declaration and the consequence", async () => {
    const res = await installSingle(sodium);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("client-only");
    expect(res.body.serverSide).toBe("unsupported");
    expect(res.body.decidedBy).toBe("version-environment");
    expect(res.body.message).toMatch(/client_only/);
    expect(res.body.message).toMatch(/can stop the server from starting/);
    expect(res.body.message).toMatch(/Send allowClientOnly to install it anyway/);
    expect(installMod).not.toHaveBeenCalled();
    expect(installedNames).toEqual([]);
  });

  it("installs it when the caller opts in, and still says what it is", async () => {
    // The exit has to exist — a refusal with no way through is a control that is broken in
    // a new way — and the warning has to survive it, because whoever overrode the refusal
    // is the one person who needs to know the next boot may be the symptom.
    const res = await installSingle({ ...sodium, allowClientOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(installedNames).toEqual(["Sodium"]);
    expect(res.body.message).toMatch(/It is client-only/);
    expect(res.body.message).toMatch(/can stop the server from starting/);
  });

  it("installs a server mod with no client-only sentence at all", async () => {
    const res = await installSingle({ modrinthId: "id-Lithium", slug: "lithium", name: "Lithium" });
    expect(res.status).toBe(200);
    expect(installedNames).toEqual(["Lithium"]);
    expect(res.body.verified).toBe("sha512");
    expect(res.body.message).not.toMatch(/client-only/);
  });

  it("says a mod with nothing published was not verified", async () => {
    specs = [{ ...LITHIUM, unverified: true }];
    const res = await installSingle({ modrinthId: "id-Lithium", slug: "lithium", name: "Lithium" });
    expect(res.body.verified).toBe(null);
    expect(res.body.message).toMatch(/no checksum was published, so it could not be verified/);
  });

  it("applies the same two gates as the pack installer", async () => {
    role = "MOD";
    games = "zomboid";
    expect((await installSingle(sodium)).status).toBe(403);
    role = "MEMBER";
    games = "minecraft";
    expect((await installSingle(sodium)).status).toBe(403);
    signedIn = false;
    expect((await installSingle(sodium)).status).toBe(401);
    expect(installMod).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
  });
});
