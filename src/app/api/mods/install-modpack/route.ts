import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { installMod, removeMod } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, rm, stat } from "fs/promises";
import path from "path";
import { RUNTIME } from "@/lib/game-manager";
import { formatBytes } from "@/lib/format";
import { runOperation, type OpHandle, type OpSuccess } from "@/lib/operations";
import { conflictResponse, isConflict } from "@/lib/operation-response";

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
 * Was 60_000 here while the sibling `/api/server/backups` had already raised the very
 * same `tar -czf … -C MC_DIR world` to 300_000, with the comment "was 60s, which is a
 * coin-toss for a 170 MB world on a busy box". So the one backup taken immediately
 * before every jar on the server is deleted had the short timeout, and the one you take
 * by hand had the long one.
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

  try {
    return await runOperation(
      {
        kind: "mods.apply",
        game: "minecraft",
        title: "Installing a modpack",
        startedBy: session.user.name ? { name: session.user.name } : null,
      },
      (op) => applyModpack(op, { modpack, serverConfig, userId: session.user.id, errors, warnings })
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
    errors,
    warnings,
  }: {
    modpack: { name: string; mods: any[] };
    serverConfig: { mcVersion: string; modLoader: string };
    userId: string;
    errors: string[];
    warnings: string[];
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
  const installable = modpack.mods.filter(
    (m: { downloadUrl?: string | null; modrinthId?: string | null }) =>
      m.downloadUrl || m.modrinthId
  ).length;
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
  op.step("Backing the world up first");
  const MC_DIR = RUNTIME.minecraft.dir;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archive = path.join(BACKUP_DIR, `auto-before-modpack-${stamp}.tar.gz`);
  const hasWorld = await stat(path.join(MC_DIR, "world")).then(() => true).catch(() => false);

  if (!hasWorld) {
    // Settled `done`, NOT `noop`, and that distinction is load-bearing:
    // `concludeOperation` turns any `noop` step into a `partial` outcome, so marking
    // this one would have painted a flawless 166-mod apply amber on every server that
    // has no world yet — inventing trouble, which is the thing this pass is cleaning up.
    // Nothing went wrong here; there was simply nothing to do. `/api/7dtd/reset` settles
    // its equivalent branch ("No existing save to back up") exactly this way.
    //
    // The fact still records it, so the outcome is `ok` rather than `unverified` and a
    // reader can tell "no backup was needed" from "a backup was taken".
    op.settle("Nothing to back up — there is no world on disk yet");
    op.fact({ label: "Rollback point", value: "no world on disk yet, so none was needed" });
  } else {
    try {
      await mkdir(BACKUP_DIR, { recursive: true });
      await execFileAsync("tar", ["-czf", archive, "-C", MC_DIR, "world"], {
        timeout: TAR_TIMEOUT_MS,
      });
      // Read the size back off disk, so "we took one" is evidence rather than an
      // assumption — the same reason `/api/server/backups` does it.
      const { size } = await stat(archive);
      op.settle(`Backed the world up — ${formatBytes(size)}`);
      op.fact({ label: "Rollback point", value: `${path.basename(archive)} (${formatBytes(size)})` });
    } catch (e) {
      // Drop the partial FIRST, so nothing can list it as a restore point even if the
      // response below is never read.
      await rm(archive, { force: true }).catch(() => {});
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

  // Install modpack mods
  let installed = 0;
  op.step("Downloading mods");
  for (const mod of modpack.mods) {
    // Real counts only: the loop genuinely handles one mod at a time, so this is
    // observed rather than interpolated. A count that only jumps 0 → n would be a fake.
    op.progress({ kind: "count", done: installed, total: modpack.mods.length, noun: "mods" });
    op.detail(mod.name);
    try {
      if ((mod as any).downloadUrl) {
        // Direct download (e.g. Technic/Solder)
        const { writeFile } = await import("fs/promises");
        const path = await import("path");
        const { getModsDir } = await import("@/lib/server-manager");

        const response = await fetch((mod as any).downloadUrl);
        if (!response.ok) {
          errors.push(`${mod.name}: download failed`);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
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
      } else if (mod.modrinthId) {
        // Modrinth-based mod
        const versions = await getProjectVersions(mod.modrinthId, {
          loaders: [serverConfig.modLoader],
          game_versions: [serverConfig.mcVersion],
        });

        const version = mod.versionId
          ? versions.find((v: any) => v.id === mod.versionId)
          : versions[0];

        if (!version) {
          errors.push(`${mod.name}: no compatible version`);
          continue;
        }

        await installMod({
          modrinthId: mod.modrinthId,
          slug: mod.slug,
          name: mod.name,
          version,
          userId,
        });
        installed++;
      } else {
        // Modpacks imported before f2018a4 stored no modrinthId (the Modrinth
        // project endpoint returns `id`, not `project_id`), so whole packs are
        // unusable until they are imported again.
        errors.push(`${mod.name}: no download source recorded — re-import this modpack`);
      }
    } catch (e: any) {
      errors.push(`${mod.name}: ${e.message || "failed"}`);
    }
  }

  // Anything short of every mod is an error, not a success. This used to answer
  // 200 {success:true} whatever happened, so a pack whose rows all lack a download
  // source reported "Installed 0/166 mods" in a green toast.
  const total = modpack.mods.length;
  const complete = installed === total;

  // The count IS the verdict. `concludeOperation` reads this step: 0-of-a-real-total
  // is `nothing`, short-of-total is `partial`, and neither can render green however
  // the response below is worded.
  op.settle(
    installed === 0
      ? `Installed 0 of ${total} mods — no download source recorded`
      : complete
      ? `Installed ${installed} of ${total} mods`
      : `Installed ${installed} of ${total} mods — ${total - installed} failed`,
    {
      kind: complete ? "done" : "noop",
      count: { done: installed, total, noun: "mods" },
    }
  );
  op.progress({ kind: "count", done: installed, total, noun: "mods" });

  return {
    facts: [
      { label: "Installed", value: `${installed} of ${total}`, verdict: complete ? undefined : "warn" },
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
        errors,
        warnings,
        ...(complete
          ? {}
          : {
              error:
                installed === 0
                  ? `No mods were installed (0 of ${total}). The server's mods are now empty.`
                  : `Only ${installed} of ${total} mods were installed.`,
            }),
      },
      { status: complete ? 200 : 500 }
    ),
  };
}
