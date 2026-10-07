import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, rm, readdir, mkdir, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { RUNTIME, gameContainerState } from "@/lib/game-manager";
import { claimOperationPower, runOperation, type OpHandle, type OpSuccess } from "@/lib/operations";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { BACKUP_DIRS, listArchives } from "@/lib/backup-store";
import { CoResidencyError, refuseCoResidency } from "@/lib/coresidency";
import { parseSdtdXmlProperties, setSdtdXmlProperties } from "@/lib/sdtd-xml";
import { GAME_LIST } from "@/lib/games";
import { gameDataPath } from "@/lib/game-data-path";
import { copyTreeCounting, countTree } from "@/lib/backup-copy";

// A Vercel-only hint; `node server.js` ignores it. It was also *shorter* than the
// operation it claimed to protect. Kept as a statement of intent only — the registry
// is what actually keeps this coherent when the response is lost.
export const maxDuration = 300;

/**
 * `execFile`, never `exec`.
 *
 * `GameWorld` comes out of `sdtdserver.xml`, which `/api/7dtd/config/all` lets any
 * MOD write, and it ends up in a `tar` argument. Quoting it with
 * `JSON.stringify` looks safe and is not: those are *double* quotes, and `sh`
 * still expands `$(...)` and backticks inside them. The name guard below rejects
 * slashes and dots, so traversal is covered, but `$(...)` sails through it.
 * `execFile` takes an argv array and spawns no shell, so the value cannot be
 * anything but one argument.
 */
const execFileAsync = promisify(execFile);
const SAVES_DIR = RUNTIME["7dtd"].dir; // .local/share/7DaysToDie
const CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config";

function getProp(xml: string, name: string): string {
  return xml ? parseSdtdXmlProperties(xml).get(name) ?? "" : "";
}
function setProp(xml: string, name: string, value: string): string {
  return setSdtdXmlProperties(xml, { [name]: value }).xml;
}

// GET: what a reset would do (current world + game name + next name), for the UI.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  let xml = "";
  try {
    xml = await readFile(await gameDataPath(CONFIG_DIR, "sdtdserver.xml"), "utf-8");
    // Validate before returning a preview; refused aliases and malformed XML are not
    // an empty first-install configuration.
    if (xml) parseSdtdXmlProperties(xml);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return NextResponse.json({ error: "The 7DTD server config could not be read or validated." }, { status: 500 });
    }
  }
  const world = getProp(xml, "GameWorld");
  const gameName = getProp(xml, "GameName");
  return NextResponse.json({ world, gameName, nextGameName: bumpName(gameName) });
}

// Bump "Fresh2" -> "Fresh3", "MyGame" -> "MyGame2", so the new save can't
// collide with a client's cached character for the old game name.
function bumpName(name: string): string {
  const m = name.match(/^(.*?)(\d+)$/);
  if (m) return `${m[1]}${parseInt(m[2], 10) + 1}`;
  return `${name || "Game"}2`;
}

/**
 * Keep the current recovery copy plus the newest older one by mtime. A world name
 * precedes the timestamp, so sorting full names does not sort creation times.
 */
const PRESET_SNAPSHOTS_KEPT = 2;

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  // `world.reset`: deletes the save and starts a fresh world. Was a bare
  // `role !== "ADMIN"`; named so the decision to narrow it back is one line in
  // `permissions.ts` rather than a string compare buried here.
  if (!hasPermission(session.user.role, "world.reset")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    /**
     * ONE operation around the whole reset.
     *
     * It used to take the control lock twice, non-atomically: `powerOff` acquired and
     * released it, then the save wipe and the `GameName` bump ran **unlocked**, then
     * `restartGame` acquired it again. Two windows in the middle of a destructive
     * operation where a Power on could interleave — and the ~14s safety `tar` ran
     * outside the lock too, against a live server.
     *
     * Preflight holds this world's files, then claims power before any changes. The
     * stop and start are open-coded here rather than delegated to `powerOff`/`restartGame`,
     * because those enter operations of their own and would be refused by this one.
     */
    return await runOperation(
      {
        kind: "world.reset",
        game: "7dtd",
        title: "Resetting the world",
        resources: ["files:7dtd"],
        startedBy: session.user.name ? { name: session.user.name } : null,
      },
      (op) => resetWorld(op, session.user.id)
    );
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    if (e instanceof CoResidencyError) {
      return NextResponse.json({ error: e.message, conflict: "coresidency", running: e.running }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message || "Reset failed" }, { status: 500 });
  }
}

async function resetWorld(
  op: OpHandle,
  userId: string
): Promise<OpSuccess<NextResponse>> {
  {
    // Preflight holds this world's files. Check peers now and again after claiming
    // power, before any writes; another world's start can finish during preflight.
    op.step("Checking no other world is running");
    const readStates = async () => new Map(await Promise.all(GAME_LIST.map(async game => {
      const state = await gameContainerState(game.id);
      if (!["running", "paused", "restarting", "exited", "created", "missing"].includes(state)) {
        throw new Error(`Cannot verify ${game.name}'s container state. No save was reset.`);
      }
      return [game.id, state] as const;
    })));
    const states = await readStates();
    await refuseCoResidency("7dtd", async game => ["running", "paused", "restarting"].includes(states.get(game)!), "The reset");
    const initialState = states.get("7dtd");
    if (!["running", "exited", "created"].includes(initialState!)) {
      throw new Error(`Cannot reset 7 Days to Die while its container is ${initialState}. No save was reset.`);
    }
    const wasRunning = initialState === "running";
    op.settle("No other world is running");

    // Both refusals below go through `op.reject` before returning their 4xx.
    //
    // Without it the operation settled zero steps and zero facts, so
    // `concludeOperation`'s "read nothing back" rule turned a *rejected request* into
    // `unverified` — and the ledger said "Resetting the world finished in 0s, but
    // nothing could be read back to confirm it. Check the worlds list before relying
    // on it." beside the route's own 400. The tool was already in use one screen down
    // for the failed-tar case; it just wasn't applied here.
    const xmlPath = await gameDataPath(CONFIG_DIR, "sdtdserver.xml");
    let xml = await readFile(xmlPath, "utf-8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    if (!xml) {
      op.reject("Refused — sdtdserver.xml could not be read");
      return { value: NextResponse.json({ error: "Config not found" }, { status: 400 }) };
    }

    const world = getProp(xml, "GameWorld");
    // Step 3 rm -rf's Saves/<world>, so GameWorld has to be one plain directory
    // name: empty collapses that path to Saves/ itself and would delete *every*
    // world's save, and ".." would climb out of it. All settings will write
    // either value into the XML without complaint, so check it here.
    if (!world || world === "." || world === ".." || /[/\\]/.test(world)) {
      op.reject(`Refused — sdtdserver.xml has no usable GameWorld (currently "${world}")`);
      return {
        value: NextResponse.json(
          {
            error: `sdtdserver.xml has no usable GameWorld (currently "${world}"), so there's nothing safe to reset. Set Game World in All settings first.`,
          },
          { status: 400 }
        ),
      };
    }
    const oldName = getProp(xml, "GameName");
    if (!oldName || oldName === "." || oldName === ".." || /[/\\]/.test(oldName)) {
      op.reject("Refused — sdtdserver.xml has no usable GameName");
      return { value: NextResponse.json({ error: "Set a usable Game Name in All settings before resetting. Nothing was changed." }, { status: 400 }) };
    }
    const newName = bumpName(oldName);

    // 1) Back up the current save first (safety), if it exists.
    const savesRoot = await gameDataPath(SAVES_DIR, "Saves", { allowRoot: false });
    const saveSource = await gameDataPath(SAVES_DIR, path.join("Saves", world), { allowRoot: false });
    const savePath = await gameDataPath(SAVES_DIR, path.join("Saves", world), {
      allowRoot: false, followFinalSymlink: false,
    });
    const profilePath = await gameDataPath(SAVES_DIR, path.join("Saves", "sdcs_profiles.sdf"), {
      allowRoot: false, followFinalSymlink: false,
    });
    const nextXml = setProp(xml, "GameName", newName);
    const hadSave = await readdir(saveSource).then(() => true).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return false;
      throw e;
    });
    if (hadSave) await countTree(saveSource, SAVES_DIR);
    // Preflight holds only this world's files. Power is claimed after every refusal
    // boundary, so an unusable reset cannot invalidate another world's backup.
    claimOperationPower(op);
    const admittedStates = await readStates();
    await refuseCoResidency("7dtd", async game => ["running", "paused", "restarting"].includes(admittedStates.get(game)!), "The reset");
    if (admittedStates.get("7dtd") !== initialState) {
      throw new Error("7 Days to Die changed state during reset preflight. No save was reset.");
    }
    // Deliberately NOT the backups dir: this tar has no manifest.json and its
    // members are rooted at "<world>/", but the backups page lists every
    // *.tar.gz in that folder as a restorable row — and restoring this one wipes
    // Saves/ and then finds no Saves/ inside the tar to put back, losing every
    // save. Keep it out of that listing; it's a recovery artefact, not a backup.
    const backupDir = path.join(BACKUP_DIRS["7dtd"], "presreset");
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Probe and archive separately. They used to share one catch commented "no
    // existing save to back up — fine", so a *failed* tar was indistinguishable
    // from "there was nothing to save": the wipe below went ahead anyway and the
    // response still claimed a backup had been made. The server is still running
    // at this point, so tar can fail for real reasons — GNU tar exits 1 on "file
    // changed as we read it" when an autosave lands mid-archive.
    op.step("Backing the save up first");
    if (hadSave) {
      const archive = path.join(backupDir, `presreset-${world}-${stamp}.tar.gz`);
      const work = path.join(backupDir, `.work-${stamp}`);
      try {
        let archiveRoot = savesRoot;
        if (saveSource !== path.join(savesRoot, world)) {
          await copyTreeCounting(saveSource, path.join(work, world), () => {}, { sourceRoot: SAVES_DIR });
          archiveRoot = work;
        }
        await execFileAsync(
          "tar",
          ["-czf", archive, "-C", archiveRoot, world],
          { timeout: 120000 }
        );
        // Bound this directory. Retention does not reach it and never will: `listArchives`
        // deliberately does not recurse, precisely so these recovery artefacts can never be
        // a prune candidate or reset the automatic-backup clock. That is right, and it left
        // the one place on the box that grows without limit — a 300 MB tar per reset,
        // forever.
        //
        // Kept here rather than in `backup-retention.ts` because the policy is different:
        // these are the "undo" for a destructive action, so the newest ones matter and the
        // count is small. Two, not five: the reason to keep a second is that a reset that
        // went wrong is usually noticed after the next one.
        try {
          const currentName = path.basename(archive);
          const copies = (await listArchives(backupDir)).filter((f) => f.name.startsWith("presreset-"));
          const keep = new Set([
            currentName,
            ...copies.filter(f => f.name !== currentName).slice(0, PRESET_SNAPSHOTS_KEPT - 1).map(f => f.name),
          ]);
          const removed = copies.filter(f => !keep.has(f.name));
          for (const old of removed) {
            await rm(path.join(backupDir, old.name));
          }
          if (removed.length > 0) {
            op.fact({
              label: "Older safety copies",
              value: `deleted ${removed.length}, kept ${copies.length - removed.length}`,
            });
          }
        } catch (e) {
          // Never fatal to the reset: failing to delete an old snapshot is not a reason to
          // abandon one that has just been written successfully.
          console.error("[7dtd/reset] could not prune old pre-reset snapshots:", e);
        }
        // Check after retention, before the wipe: a successful tar is not proof
        // that the recovery copy still exists.
        const copy = await stat(archive);
        if (!copy.isFile() || copy.size === 0) throw new Error("The safety copy is missing or empty");
        op.settle(`Backed the old save up — ${path.basename(archive)} (${copy.size} bytes)`);
        op.fact({ label: "Safety copy", value: path.basename(archive) });
      } catch (e) {
        // Drop the partial archive so nothing later mistakes it for a backup.
        await rm(archive, { force: true }).catch(() => {});
        op.reject("The safety backup failed — the reset was cancelled");
        return {
          value: NextResponse.json(
            {
              error: `The safety backup failed, so the reset was cancelled and the save is untouched: ${(e as Error).message.trim()}. The server may have been mid-autosave — try again in a moment.`,
            },
            { status: 500 }
          ),
        };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      op.settle("No existing save to back up");
    }

    // 2) Stop the server (graceful), keeping the world map in GeneratedWorlds.
    //    Open-coded rather than `powerOff("7dtd")`, because that enters an operation
    //    of its own and this one already holds every resource it would want.
    const { stopGameForOperation, startGameForOperation } = await import(
      "@/lib/game-manager"
    );
    if (wasRunning) await stopGameForOperation(op, "7dtd");
    const stoppedState = await gameContainerState("7dtd");
    if (!["exited", "created", "missing"].includes(stoppedState)) {
      throw new Error("7 Days to Die is not verified stopped. The live save was not reset; the safety copy was retained.");
    }

    // 3) Wipe the save for this world + the cross-play profile cache. Keep the
    //    world MAP (GeneratedWorlds) so we don't lose the custom map.
    op.step("Wiping the save");
    await rm(savePath, { recursive: true, force: true });
    await rm(profilePath, { force: true });
    op.settle(`Wiped the save for "${world}" — the world map was kept`);

    // 4) Bump GameName so the fresh save has a new identity.
    op.step("Naming the new save");
    xml = nextXml;
    await writeFile(xmlPath, xml, "utf-8");
    // Read it back off disk: the whole reset hinges on the server booting onto the
    // NEW name, and "we wrote the file" is not the same claim.
    const readBack = getProp(await readFile(xmlPath, "utf-8").catch(() => ""), "GameName");
    op.settle(`Named the new save "${newName}"`);
    op.fact({
      label: "New game name",
      value: readBack || "could not be read back",
      verdict: readBack === newName ? undefined : "warn",
    });
    if (readBack !== newName) throw new Error("The new game name could not be verified. The server was not restarted; recover the old save from the safety copy.");
    op.fact({ label: "World map", value: `kept — ${world}` });

    // 5) Start onto the fresh save.
    await startGameForOperation(op, "7dtd");
    let finalState: string;
    try {
      finalState = await gameContainerState("7dtd");
    } catch {
      op.fact({ label: "Power", value: "in an unknown state", verdict: "bad" });
      throw new Error("The save was reset, but the final server state could not be verified. Check the container before retrying.");
    }
    op.fact({
      label: "Power", value: finalState === "running" ? "running" : `in state ${finalState}`,
      ...(finalState === "running" ? {} : { verdict: "bad" as const }),
    });
    if (finalState !== "running") {
      throw new Error(`The save was reset, but 7 Days to Die is ${finalState} after the start request. Check the container before retrying.`);
    }
    op.fact({ label: "Server", value: "starting again" });

    // keep the curated DB row's notion of nothing here; log it.
    await db.activity
      .create({ data: { userId, action: "server_reset", details: JSON.stringify({ game: "7dtd", world, oldName, newName }) } })
      .catch(() => {});

    return {
      value: NextResponse.json({
        success: true,
        world,
        newGameName: newName,
        message: `World "${world}" reset to a fresh save (${newName}). The map was kept${
          hadSave ? "; the old save was backed up first" : " (there was no existing save to back up)"
        }. The server is restarting.`,
      }),
    };
  }
}
