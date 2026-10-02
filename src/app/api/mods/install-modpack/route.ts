import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { installMod, removeMod, serverSideFor } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import {
  applyReport,
  checkIntegrity,
  declaredFromHeaders,
  digestsOf,
  skippedSentence,
  unrecognisedEnvironmentSentence,
  type SkippedMod,
} from "@/lib/mod-admission";
import { modsDirRefusal, planModpackInstall, type PackMod } from "@/lib/mod-plan";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, rm } from "fs/promises";
import path from "path";
import { RUNTIME } from "@/lib/game-manager";
import { formatBytes } from "@/lib/format";
import { runOperation, type OpHandle, type OpSuccess } from "@/lib/operations";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { sealArchive, type McManifest } from "@/lib/backup-create";
import { recordBackupEvent } from "@/lib/backup-log";
import { removeManifestSidecar } from "@/lib/backup-archive";
import { archiveMembersPresent, describeMembers } from "@/lib/mc-archive";

/**
 * `execFile` with an argv array, never `exec` with a template string.
 *
 * This route used `exec` for its tar, which is the same shape as the Minecraft backup
 * shell-injection fixed on 2026-09-28 — the sibling `/api/server/backups` deliberately
 * moved to `execFile` and says so. Nothing user-controlled reaches this particular
 * command line (the only interpolations are a generated timestamp and a container path),
 * so this was not itself exploitable; it was the wrong pattern sitting one edit away from
 * being exploitable, in the route with the largest blast radius in the app.
 */
const execFileAsync = promisify(execFile);

/**
 * Same directory `/api/server/backups` lists and restores from, so the archive written
 * here really is offerable as a restore point. (Still two definitions of the constant —
 * the shared `src/lib/backups.ts` extraction is deliberately out of scope for this pass.)
 */
const BACKUP_DIR = "/app/data/backups";

/**
 * Was 60_000 here while the sibling backup path had already raised its near-identical
 * `tar -czf … -C MC_DIR world` to 300_000, with the comment "was 60s, which is a
 * coin-toss for a 170 MB world on a busy box". So the one backup taken immediately
 * before every jar on the server is deleted had the short timeout, and the one you take
 * by hand had the long one. (Near-identical rather than identical since 2026-10-02: this
 * archive also carries `mods`, which is small next to a world and does not change the
 * argument.)
 */
const TAR_TIMEOUT_MS = 300_000;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { modpackId, mcVersion, modLoader } = await request.json();

  if (!modpackId) {
    return NextResponse.json({ error: "modpackId required" }, { status: 400 });
  }

  const modpack = await db.modpack.findUnique({
    where: { id: modpackId },
    include: { mods: true },
  });

  if (!modpack) {
    return NextResponse.json({ error: "Modpack not found" }, { status: 404 });
  }

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  if (!serverConfig) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  // Use modpack's target version/loader, or explicit overrides, or current config
  const finalMcVersion = mcVersion || modpack.targetMcVersion || serverConfig.mcVersion;
  const finalLoader = modLoader || modpack.targetLoader || serverConfig.modLoader;

  // A modpack that targets a different version/loader is refused, not applied.
  // This branch used to regenerate docker-compose.yml from a two-service template
  // and start Minecraft: that silently deleted the sevendtd and zomboid services
  // plus the volumes the web container mounts, reverted MEMORY to ServerConfig's
  // never-updated maxMemory, and started a world without evicting whichever one
  // held the box or taking the control lock. Switching version/loader belongs to
  // /api/settings, which patches only the minecraft block and RECREATES the
  // container -- the only way a new VERSION/TYPE ever takes effect. Doing half of
  // it here (write compose, don't recreate) would just be the "looks applied and
  // silently isn't" trap again, with mods downloaded for a version that is not
  // running.
  if (finalMcVersion !== serverConfig.mcVersion || finalLoader !== serverConfig.modLoader) {
    return NextResponse.json(
      {
        error:
          `This modpack targets Minecraft ${finalMcVersion} (${finalLoader}) but the server is ` +
          `set to ${serverConfig.mcVersion} (${serverConfig.modLoader}). Change the version and ` +
          `loader on the Minecraft settings page first, then install the modpack.`,
        needsVersionChange: { mcVersion: finalMcVersion, modLoader: finalLoader },
      },
      { status: 409 }
    );
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const skipped: SkippedMod[] = [];

  try {
    return await runOperation(
      {
        kind: "mods.apply",
        game: "minecraft",
        title: "Installing a modpack",
        startedBy: session.user.name ? { name: session.user.name } : null,
      },
      (op) =>
        applyModpack(op, {
          modpack,
          serverConfig,
          userId: session.user.id,
          // The pre-apply archive's journal line and manifest attribution. `?? ""` matches
          // what every backup route builds its actor from; `recordBackupEvent` collapses an
          // empty name to `null` rather than journalling `actor: ""`, which the backups page
          // renders as "the scheduler".
          actorName: session.user.name ?? "",
          errors,
          warnings,
          skipped,
        })
    );
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Modpack install failed" },
      { status: 500 }
    );
  }
}

/**
 * The apply itself, wrapped in an operation.
 *
 * Up to 166 sequential Modrinth fetches, and it *deletes every installed jar first* —
 * so the window where the mods directory is empty used to be open to a Power on, a
 * restore, or a second apply, with nothing refusing any of them. It holds
 * `files:minecraft` now, and `count` progress is genuine: the loop already iterates
 * one mod at a time, so the number is observed rather than interpolated.
 */
async function applyModpack(
  op: OpHandle,
  {
    modpack,
    serverConfig,
    userId,
    actorName,
    errors,
    warnings,
    skipped,
  }: {
    modpack: { name: string; mods: PackMod[] };
    serverConfig: { mcVersion: string; modLoader: string };
    userId: string;
    actorName: string;
    errors: string[];
    warnings: string[];
    skipped: SkippedMod[];
  }
): Promise<OpSuccess<NextResponse>> {
  // Refuse before taking a backup, and before deleting anything, if this pack cannot
  // actually be installed.
  //
  // The order below is destroy-then-create, so a pack whose rows carry no download
  // source wipes every installed jar and puts nothing back. That is not
  // hypothetical: 224 `ModpackMod` rows predate the importer fix in f2018a4
  // (2026-05-27, Modrinth returns `id` not `project_id`), and one saved pack —
  // Fabulously Optimized, 45 mods — has a source for *none* of them. Reporting the
  // 0/45 honestly was only half the fix; the other half is not starting.
  //
  // This check used to sit *after* the backup block, so a refusal still tarred the whole
  // world first — and since nothing prunes `/app/data/backups`, the archive stayed, and
  // `/api/server/backups` GET offered it as a restore point for a world that was never
  // touched. A live run on 2026-09-29 recorded one such orphan at 173,283,913 bytes;
  // three of the six saved packs have 0 installable mods, so that was the cost of every
  // click on any of them.
  //
  // Verified by measurement when this was moved: built at the old ordering, applying a
  // 45-mod pack with no download sources reached the backup step and failed there
  // (`mkdir '/app'`) *before* ever counting the mods; built at the new ordering the same
  // request answers 409 without touching the backup directory, while a pack that does
  // have a source still flows straight through to the backup step. A refusal that
  // changes nothing must also cost nothing.
  const installable = modpack.mods.filter((m) => m.downloadUrl || m.modrinthId).length;
  op.step("Reading the modpack list");
  if (installable === 0) {
    op.settle(
      `Read the modpack list: ${modpack.mods.length} mods, none with a download source`,
      { kind: "noop", count: { done: 0, total: modpack.mods.length, noun: "installable mods" } }
    );
    return {
      value: NextResponse.json(
        {
          error:
            `None of the ${modpack.mods.length} mods in "${modpack.name}" has a download source, ` +
            `so installing it would remove every current mod and add nothing. ` +
            `This pack was imported before a fix to the importer — re-import it to repair it.`,
        },
        { status: 409 }
      ),
    };
  }
  op.settle(`Read the modpack list: ${modpack.mods.length} mods`, {
    count: { done: installable, total: modpack.mods.length, noun: "installable" },
  });
  if (installable < modpack.mods.length) {
    warnings.push(
      `${modpack.mods.length - installable} of ${modpack.mods.length} mods in this pack have no ` +
        `download source and will be skipped — re-import the pack to repair it.`
    );
  }

  // ---------------------------------------------------------------------------
  // Work out WHAT will be installed before anything is destroyed.
  // ---------------------------------------------------------------------------
  //
  // This pass is new, and it exists for two reasons that both come down to the same
  // thing: the decisions have to be made while they can still be acted on.
  //
  // 1. **Client-only mods must be filtered out, and that is only knowable from the
  //    version.** A modpack is a client-side artefact: a large pack is 30-50% mods that
  //    cannot run on a dedicated server at all (Sodium, Iris, every HUD and shader
  //    bridge). This route used to download all of them into the server's mods
  //    directory, where the good case is wasted disk and the bad case is Fabric Loader
  //    aborting on a jar with no server entrypoint — which on this box shows up as a
  //    permanent "Starting…" with no explanation. `serverSideFor` decides it; see
  //    `src/lib/mod-admission.ts` for the measured enum and for why a skip only ever
  //    happens on a positive `unsupported`.
  // 2. **It moves the only refusal that matters ahead of the backup and the deletion.**
  //    The existing no-download-source check already works this way and its comment
  //    explains what it cost to learn. The same argument applies one step further in: a
  //    pack whose every mod is client-only would otherwise tar a 215 MiB world, delete
  //    every installed jar, and put nothing back.
  //
  // It costs no extra network. The Modrinth version lookup used to happen inside the
  // download loop; it happens here instead and the resolved version is carried forward
  // on the plan, so the number of API calls is unchanged — only the order is. The one
  // addition is a per-project fetch for the ~13% of versions whose `environment` is
  // `unknown`, which `serverSideFor` makes conditionally for exactly that reason.
  //
  // The decisions themselves live in `src/lib/mod-plan.ts`, with the two Modrinth calls
  // injected. They were inline here and were therefore untestable — this route needs
  // `auth()`, Prisma, a mods directory, `tar` and the network — and an adversarial review
  // showed what that costs: deleting the client-only filter outright
  // (`if (false && !side.install)`) restored the exact pre-change behaviour and the whole
  // suite stayed green. `src/lib/__tests__/mod-plan.test.ts` drives it directly now.
  op.step("Checking which mods run on a server");
  const plan = await planModpackInstall({
    mods: modpack.mods,
    resolveVersions: (modrinthId) =>
      getProjectVersions(modrinthId, {
        loaders: [serverConfig.modLoader],
        game_versions: [serverConfig.mcVersion],
      }),
    sideFor: serverSideFor,
    onExamine: (mod, index) => {
      // Observed, one mod per iteration, same as the download loop below.
      op.progress({ kind: "count", done: index, total: modpack.mods.length, noun: "mods" });
      op.detail(mod.name);
    },
  });
  errors.push(...plan.errors);
  skipped.push(...plan.skipped);
  op.progress({
    kind: "count",
    done: modpack.mods.length,
    total: modpack.mods.length,
    noun: "mods",
  });
  op.detail(undefined);

  // An `environment` value Modrinth published and this app has no row for. A real warning:
  // the mod was installed (falling through is the safe direction) but our table is stale,
  // and `singleplayer_only` sat unmapped in the live API through this feature's first draft
  // — silently installing on the server the one kind of mod it was written to keep off.
  if (plan.unrecognised.length > 0) {
    warnings.push(unrecognisedEnvironmentSentence(plan.unrecognised));
  }

  // THE DENOMINATOR, and the one deliberate decision in this change: every row in the
  // pack minus the mods positively declared client-only, i.e. "the mods that belong on
  // this server". Why neither the pack's row count nor the plan's length works — one makes
  // every honest apply amber, the other hides failures — is written out on `ModPlan.total`
  // and `serverModTotal`, which is where the rule lives so that the unit tests pin the
  // number this route reports rather than a copy of the arithmetic.
  const total = plan.total;

  // ONE settle per path, and the branch is decided before it rather than after it.
  //
  // Two traps here, and the second was only found by running the registry rather than
  // reading the call site, which looks completely correct either way.
  //
  // **A second `settle` on an already-settled step records nothing.** `op.settle` opens
  // `const s = current(entry); if (!s) return;`. The first draft settled this step `done`
  // and then, on the empty-plan path, settled again with `kind: "noop"` to mark the
  // refusal — and that second call was silently discarded. Measured through the registry
  // with the route's real step sequence: outcome `unverified`, summary *"Installing the
  // modpack finished in 0s, but nothing could be read back to confirm it. Check the
  // installed mods list before relying on it."* for a request that refused and changed
  // nothing. A false report, produced by the change that was fixing two other false
  // reports.
  //
  // **`reject`, not a `noop` settle, because the preceding step already made progress.**
  // `concludeOperation` reaches outcome `nothing` only via `zeroOfSomething`, which is
  // guarded by `!madeProgress` — and "Read the modpack list" has already settled with a
  // non-zero count by the time we get here, so `madeProgress` is true and a `noop` lands
  // on the `partial` rule instead. Measured, same harness: *"Installed 0 of 45 server
  // mods; 45 failed. Expand this record to see which ones."* — which calls 45 client-only
  // mods failures when not one of them was attempted. `op.reject` gives outcome `failed`
  // and *"Installing the modpack failed after 2 steps: No mod in this pack runs on a
  // server."*, which is the true sentence; the route keeps its own 409, which is exactly
  // what `reject` is documented for.
  // `modsDirRefusal`, not an inline `if`. A recheck replaced this condition with
  // `if (false)` and all 835 tests passed — and with it gone the route goes straight on to
  // tar the world, `removeMod` every installed jar, download nothing, and answer 200
  // `{success:true}`. The decision lives in `mod-plan.ts` so that it is asserted rather than
  // trusted; see `src/lib/__tests__/mod-plan.test.ts`.
  const refusal = modsDirRefusal(plan, modpack.mods.length);
  if (refusal) {
    // Nothing has been backed up or deleted yet — same ordering argument as the
    // no-download-source branch above — so this refusal costs nothing.
    op.reject(refusal);
    return {
      value: NextResponse.json(
        {
          installed: 0,
          // The real denominator, not a literal 0. An all-client-only pack gives 0 and
          // reads "Installed 0 of 0 mods", which is correct — nothing belonged here. But
          // the plan can also be empty because every mod FAILED to resolve: 10 rows, 5
          // client-only, 5 unreachable gives `total: 5`, and hardcoding 0 would have hidden
          // those five from the headline count while listing them underneath as errors.
          total,
          errors,
          warnings,
          skipped,
          error:
            skipped.length === modpack.mods.length
              ? `All ${modpack.mods.length} mods in "${modpack.name}" are client-only, so there is ` +
                `nothing to install on a server. Nothing was changed. This is a client-side pack — ` +
                `use the Export option to install it in your own launcher.`
              : `None of the ${modpack.mods.length} mods in "${modpack.name}" could be installed on ` +
                `a server. Nothing was changed.`,
        },
        { status: 409 }
      ),
    };
  }

  op.settle(
    skipped.length > 0
      ? `Checked which mods run on a server — ${skipped.length} are client-only`
      : `Checked which mods run on a server`,
    {
      // `done`, not `noop`, even when the plan is smaller than the pack: correctly
      // declining to put a client mod on a server is this step working. `noop` here would
      // make `concludeOperation` return `partial` and paint every correct apply of every
      // real pack amber — a large pack is 30-50% client mods.
      count: { done: plan.items.length, total: modpack.mods.length, noun: "to install" },
    }
  );

  // The skips are NOT pushed into `warnings` here, and that omission is the fix for a real
  // defect rather than an oversight. They used to be — and they were also returned in
  // `skipped`, which `modpacks.tsx` renders in the world's accent under a heading saying
  // nothing went wrong. `warnings` renders in `chart-5`, the amber warning colour. So one
  // correct decision appeared twice in the same dialog in two colours that contradicted
  // each other, on every apply of every real pack (30–50% client mods). The colour is a
  // claim; see `ApplyReport.warnings`. They are recorded as an operation fact below, which
  // is plain-toned and outlives the HTTP response.

  // Auto-backup the world before touching mods.
  //
  // Four things were wrong with this block, and they compounded into the worst
  // possible outcome. It used `exec` with a template string; it timed out at 60s while
  // the identical command in `/api/server/backups` had been raised to 300s; it did NOT
  // delete the partial archive on failure; and it was **non-fatal**. So a tar that
  // timed out at 60 seconds left a truncated `auto-before-modpack-*.tar.gz` sitting in
  // `/app/data/backups` — which `/api/server/backups` GET lists, which passes
  // `safeBackupName`, and which is therefore offered in the UI as a restore point — and
  // then this route went on to delete every installed jar anyway. A backup that cannot
  // be restored, presented as the thing you would restore from, in front of the most
  // destructive operation in the app. That is this codebase's documented defect class
  // ("reports success after doing nothing or the wrong thing") at its sharpest.
  //
  // So: probe for the world FIRST and distinguish the two failures. No world on disk is
  // legitimate (a fresh install) and stays non-fatal. A tar that was asked to run and
  // did not is fatal, the partial is deleted, and nothing is deleted from the mods
  // directory. `/api/7dtd/reset` already does exactly this and says why.
  //
  // **And it archives `mods` as well as `world`, which until 2026-10-02 it did not.** The
  // archive preserved the one directory this route never touches and nothing of the one it
  // empties two steps below, while the ledger called it a "Rollback point" — so a modpack
  // apply was irreversible for the mod set, and `removeMod` deletes the `InstalledMod` row
  // with the jar, so the names went too. It had not hurt yet only because production has 3
  // mods totalling 5.8 MB. See `src/lib/mc-archive.ts` for why the restore side of this is
  // in the same commit: a two-member archive restored through the old route would have
  // renamed only `world` into place and deleted the rest with the staging dir.
  const MC_DIR = RUNTIME.minecraft.dir;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `auto-before-modpack-${stamp}.tar.gz`;
  const archive = path.join(BACKUP_DIR, filename);
  const members = await archiveMembersPresent(MC_DIR);

  // The probe runs before the step so the label can name what is actually about to be
  // archived. It said "Backing the world up first" while tarring both, which is the size of
  // untruth this ledger exists not to tell — and `mods` is the half that matters here.
  op.step(
    members.length > 0
      ? `Backing up ${describeMembers(members)} first`
      : "Checking what there is to back up"
  );

  if (members.length === 0) {
    // Settled `done`, NOT `noop`, and that distinction is load-bearing:
    // `concludeOperation` turns any `noop` step into a `partial` outcome, so marking
    // this one would have painted a flawless 166-mod apply amber on every server that
    // has no world yet — inventing trouble, which is the thing this pass is cleaning up.
    // Nothing went wrong here; there was simply nothing to do. `/api/7dtd/reset` settles
    // its equivalent branch ("No existing save to back up") exactly this way.
    //
    // The fact still records it, so the outcome is `ok` rather than `unverified` and a
    // reader can tell "no backup was needed" from "a backup was taken".
    op.settle("Nothing to back up — there is no world or mods directory on disk yet");
    op.fact({
      label: "Rollback point",
      value: "no world or mods directory on disk yet, so none was needed",
    });
  } else {
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      await execFileAsync("tar", ["-czf", archive, "-C", MC_DIR, ...members], {
        timeout: TAR_TIMEOUT_MS,
      });
      // Sealed exactly the way `createBackup` seals a real one, rather than left as a raw
      // `.tar.gz`. Raw, it read back as `verifiable: false` in the listing (no checksum for
      // a restore to check), never reached the durable journal, and sat outside the
      // retention policy while `listArchives` counted it anyway — consuming a `keep` slot
      // that protects a genuine restore point and standing as a prune candidate itself.
      // `sealArchive` settles the step above with the size read back off disk, so "we took
      // one" is still evidence rather than an assumption.
      const sealed = await sealArchive(op, {
        game: "minecraft",
        target: archive,
        filename,
        manifest: {
          createdAt: new Date().toISOString(),
          // Recorded so the listing can say which archives a restore would bring the jars
          // back from — `GET /api/server/backups` reads this, it does not open the tar.
          members,
          ...(actorName ? { startedBy: actorName } : {}),
          // No `flushed`. This route does not ask Minecraft to save first, and
          // `BaseManifest` documents `false` as the specific claim "the server was stopped,
          // so its files were already at rest" — which is not something checked here.
          // Absent reads as unknown, which is what it is.
        } satisfies McManifest,
      });
      op.fact({
        label: "Rollback point",
        value:
          `${filename}${sealed.size != null ? ` (${formatBytes(sealed.size)})` : ""} — ` +
          describeMembers(members),
      });
      // The journal, not `Activity`: this archive is a side effect of a modpack apply and
      // the apply writes its own rows. What the journal answers is "where did this file in
      // /app/data/backups come from", which is the question a prune or a restore raises
      // long after the operation record has aged out of memory.
      await recordBackupEvent("minecraft", "create", { userId, name: actorName }, {
        outcome: "ok",
        name: filename,
        sizeBytes: sealed.size ?? undefined,
        detail: `before applying a modpack — ${describeMembers(members)}`,
      });
    } catch (e) {
      // Drop the partial FIRST, so nothing can list it as a restore point even if the
      // response below is never read. The sidecar goes with it: `sealArchive` may have
      // written one before a later step threw, and a manifest that outlives its archive is
      // adopted by the next file to land on the same name.
      await rm(archive, { force: true }).catch(() => {});
      await removeManifestSidecar(archive);
      const why = (e instanceof Error ? e.message : "unknown error").trim();
      op.reject("The world backup failed — the modpack was not applied");
      return {
        value: NextResponse.json(
          {
            error:
              `The pre-install world backup failed, so the modpack was not applied and your ` +
              `current mods are untouched: ${why}. The partial archive has been deleted. ` +
              `Applying a modpack removes every installed jar, so it is not run without a ` +
              `rollback point.`,
          },
          { status: 500 }
        ),
      };
    }
  }

  // Remove all currently installed mods. A jar that survives this loads alongside
  // the new pack, so a failed removal has to be said out loud.
  const installedMods = await db.installedMod.findMany();
  op.step("Removing the current mods");
  let removed = 0;
  for (const mod of installedMods) {
    try {
      await removeMod(mod.id, userId);
      removed++;
    } catch (e: any) {
      errors.push(`${mod.name}: could not be removed (${e.message || "failed"})`);
    }
  }
  op.settle(`Removed the current mods`, {
    kind: removed === installedMods.length ? "done" : "noop",
    count: { done: removed, total: installedMods.length, noun: "mods" },
  });

  // Install the planned mods. Version resolution and the client/server decision already
  // happened above, so this loop only downloads, verifies and writes.
  let installed = 0;
  /** Mods that are now on disk with nothing published to check them against. Named so
   * the report can say "installed but not verified" instead of implying it checked. */
  const unverified: string[] = [];
  op.step("Downloading mods");
  for (const item of plan.items) {
    const mod = item.mod;
    // Real counts only: the loop genuinely handles one mod at a time, so this is
    // observed rather than interpolated. A count that only jumps 0 → n would be a fake.
    // `total` excludes the client-only skips and includes the mods that failed to
    // resolve — see the comment on its definition.
    op.progress({ kind: "count", done: installed, total, noun: "mods" });
    op.detail(mod.name);
    try {
      if (item.kind === "direct") {
        // Direct download (e.g. Technic/Solder). No registry publishes a hash for this
        // path, so the declaration comes off the response itself: `declaredFromHeaders`
        // reads `Content-Length`, which catches the truncated transfer a dropped
        // connection produces.
        //
        // It used to pass a literal `{}` here, which `checkIntegrity` can only ever answer
        // `{ok: true}` to — so the guard below was unreachable code carrying a comment that
        // said it was "unreachable today, live tomorrow". It was unreachable permanently,
        // on the one path with no hashes at all. `Content-Length` is the real declaration
        // that was available the whole time.
        const { writeFile } = await import("fs/promises");
        const path = await import("path");
        const { getModsDir } = await import("@/lib/server-manager");

        const response = await fetch(item.url);
        if (!response.ok) {
          errors.push(`${mod.name}: download failed`);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const check = checkIntegrity(declaredFromHeaders(response.headers), digestsOf(buffer));
        if (!check.ok) {
          // The bytes are short of what the server said it was sending. Refused, not
          // written — the order is the guarantee: this is above the `writeFile`.
          errors.push(`${mod.name}: ${check.reason}`);
          continue;
        }
        // No `Content-Length` (or a compressed transfer, where it describes the encoded
        // bytes and cannot be compared) means nothing was checked, and the report says so
        // rather than implying it verified.
        if (check.checked === null) unverified.push(mod.name);

        const fileName = `${mod.slug}.jar`;
        await writeFile(path.join(getModsDir(), fileName), buffer);

        await db.installedMod.create({
          data: {
            modrinthId: mod.modrinthId || mod.slug,
            slug: mod.slug,
            name: mod.name,
            version: "technic",
            fileName,
            mcVersion: serverConfig.mcVersion,
            loader: serverConfig.modLoader,
            installedBy: userId,
          },
        });
        installed++;
      } else {
        // `installMod` hashes the download and compares it to the sha512 Modrinth
        // published *before* it writes anything, and throws `ModIntegrityError` if they
        // disagree — so a corrupt jar is never in the mods directory, and the throw
        // lands in the catch below as this mod's named failure.
        const check = await installMod({
          modrinthId: item.modrinthId,
          slug: mod.slug,
          name: mod.name,
          version: item.version,
          userId,
        });
        if (check.checked === null) unverified.push(mod.name);
        installed++;
      }
    } catch (e: any) {
      errors.push(`${mod.name}: ${e.message || "failed"}`);
    }
  }

  // Anything short of every mod that belongs on this server is an error, not a success.
  // This used to answer 200 {success:true} whatever happened, so a pack whose rows all
  // lack a download source reported "Installed 0/166 mods" in a green toast.
  //
  // Every sentence and every count below comes out of this one call — see `applyReport`.
  // The HTTP status, the response `error`, the operation's final step and the per-mod
  // progress bar were four readers of the same arithmetic with nothing stopping them
  // disagreeing.
  const report = applyReport({
    packSize: modpack.mods.length,
    installed,
    skipped,
    errors,
    warnings,
    unverified,
  });
  const { complete } = report;

  // The count IS the verdict. `concludeOperation` reads this step: 0-of-a-real-total
  // is `nothing`, short-of-total is `partial`, and neither can render green however
  // the response below is worded.
  op.settle(report.stepLabel, {
    kind: complete ? "done" : "noop",
    count: { done: installed, total, noun: "mods" },
  });
  op.progress({ kind: "count", done: installed, total, noun: "mods" });

  return {
    facts: [
      { label: "Installed", value: `${installed} of ${total}`, verdict: complete ? undefined : "warn" },
      // Recorded as a plain fact, with NO `verdict: "warn"`.
      //
      // Deliberate: a `warn` verdict makes `concludeOperation` return `partial`, which
      // paints the whole apply amber and summarises it as something having gone wrong.
      // Declining to put a client-only mod on a dedicated server is the installer working
      // correctly — and a large pack is 30-50% client mods, so a warn here would mean
      // every single correct apply of every real pack renders as a problem. That is the
      // exact failure the suite already pins for backups ("part of it is missing. This is
      // not a restore point." on a flawless archive). The names are still recorded, so
      // the decision is auditable from the ledger long after the HTTP response is gone.
      //
      // `skippedSentence` writes it, which is also the only remaining caller of that
      // helper now that the amber duplicate in `warnings` is gone — one definition of the
      // sentence, in the module that knows what a skip means.
      ...(skipped.length
        ? [{ label: "Skipped as client-only", value: skippedSentence(skipped, 5) }]
        : []),
      // NAMES, not just a count. This fact used to read "3 mods reported a problem",
      // and the summary `concludeOperation` builds from it said "Open the report for
      // which ones" — but "the report" is assembled in the browser from this route's
      // HTTP response body, and a 166-mod apply routinely outlives the ~100s origin
      // timeout, at which point `modpacks.tsx`'s own catch replaces it with
      // `{installed: 0, total: 0}`. So the one sentence directing the user to the
      // failure list pointed, for the long runs where it mattered most, at a list that
      // no longer existed. A fact survives that: it is recorded server-side and rendered
      // from the registry, and `redact()` strips it for viewers without the world.
      //
      // Sliced at 5 because the facts row is a single wrapping line; `split(":")[0]`
      // takes the mod name off the "Name: reason" strings every `errors.push` here
      // builds.
      ...(errors.length
        ? [
            {
              label: "Failed",
              value:
                `${errors.length} mod${errors.length === 1 ? "" : "s"} — ` +
                errors
                  .slice(0, 5)
                  .map((e) => e.split(":")[0])
                  .join(", ") +
                (errors.length > 5 ? `, +${errors.length - 5} more` : ""),
              verdict: "warn" as const,
            },
          ]
        : []),
    ],
    value: NextResponse.json(
      {
        success: complete,
        installed,
        total,
        errors: report.errors,
        // The amber channel, and the client-only skips are deliberately not in it — see
        // `ApplyReport.warnings` and the note next to the plan step above.
        warnings: report.warnings,
        // `[{name, reason}]`, not a count: the report dialog names them, because a user
        // who cannot see *which* mods were held back cannot tell a correct filter from a
        // broken one — and the reason string says which signal decided.
        skipped: report.skipped,
        ...(report.error ? { error: report.error } : {}),
      },
      { status: complete ? 200 : 500 }
    ),
  };
}
