import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, rm, readdir, mkdir } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { RUNTIME, restartGame, ControlBusyError } from "@/lib/game-manager";

export const maxDuration = 120;

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
const XML_PATH = path.join(process.env.SDTD_CONFIG_DIR || "/sevendtd-config", "sdtdserver.xml");

function getProp(xml: string, name: string): string {
  return xml.match(new RegExp(`<property\\s+name="${name}"\\s+value="([^"]*)"`, "i"))?.[1] ?? "";
}
function setProp(xml: string, name: string, value: string): string {
  const re = new RegExp(`(<property\\s+name="${name}"\\s+value=")[^"]*(")`, "i");
  return xml.replace(re, `$1${value}$2`);
}

// GET: what a reset would do (current world + game name + next name), for the UI.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  let xml = "";
  try { xml = await readFile(XML_PATH, "utf-8"); } catch {}
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

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Admin only" }, { status: 403 });

  try {
    let xml = await readFile(XML_PATH, "utf-8").catch(() => "");
    if (!xml) return NextResponse.json({ error: "Config not found" }, { status: 400 });

    const world = getProp(xml, "GameWorld");
    // Step 3 rm -rf's Saves/<world>, so GameWorld has to be one plain directory
    // name: empty collapses that path to Saves/ itself and would delete *every*
    // world's save, and ".." would climb out of it. All settings will write
    // either value into the XML without complaint, so check it here.
    if (!world || world === "." || world === ".." || /[/\\]/.test(world)) {
      return NextResponse.json(
        {
          error: `sdtdserver.xml has no usable GameWorld (currently "${world}"), so there's nothing safe to reset. Set Game World in All settings first.`,
        },
        { status: 400 }
      );
    }
    const oldName = getProp(xml, "GameName");
    const newName = bumpName(oldName);

    // 1) Back up the current save first (safety), if it exists.
    const savePath = path.join(SAVES_DIR, "Saves", world);
    // Deliberately NOT the backups dir: this tar has no manifest.json and its
    // members are rooted at "<world>/", but the backups page lists every
    // *.tar.gz in that folder as a restorable row — and restoring this one wipes
    // Saves/ and then finds no Saves/ inside the tar to put back, losing every
    // save. Keep it out of that listing; it's a recovery artefact, not a backup.
    const backupDir = "/app/data/backups-7dtd/presreset";
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Probe and archive separately. They used to share one catch commented "no
    // existing save to back up — fine", so a *failed* tar was indistinguishable
    // from "there was nothing to save": the wipe below went ahead anyway and the
    // response still claimed a backup had been made. The server is still running
    // at this point, so tar can fail for real reasons — GNU tar exits 1 on "file
    // changed as we read it" when an autosave lands mid-archive.
    const hadSave = await readdir(savePath).then(() => true).catch(() => false);
    if (hadSave) {
      const archive = path.join(backupDir, `presreset-${world}-${stamp}.tar.gz`);
      try {
        await execFileAsync(
          "tar",
          ["-czf", archive, "-C", path.join(SAVES_DIR, "Saves"), world],
          { timeout: 120000 }
        );
      } catch (e) {
        // Drop the partial archive so nothing later mistakes it for a backup.
        await rm(archive, { force: true }).catch(() => {});
        return NextResponse.json(
          {
            error: `The safety backup failed, so the reset was cancelled and the save is untouched: ${(e as Error).message.trim()}. The server may have been mid-autosave — try again in a moment.`,
          },
          { status: 500 }
        );
      }
    }

    // 2) Stop the server (graceful), keeping the world map in GeneratedWorlds.
    try {
      const { powerOff } = await import("@/lib/game-manager");
      await powerOff("7dtd");
    } catch (e) {
      if (e instanceof ControlBusyError) return NextResponse.json({ error: e.message, busy: e.lock }, { status: 409 });
      // if it wasn't running, continue
    }

    // 3) Wipe the save for this world + the cross-play profile cache. Keep the
    //    world MAP (GeneratedWorlds) so we don't lose the custom map.
    await rm(savePath, { recursive: true, force: true });
    await rm(path.join(SAVES_DIR, "Saves", "sdcs_profiles.sdf"), { force: true }).catch(() => {});

    // 4) Bump GameName so the fresh save has a new identity.
    xml = setProp(xml, "GameName", newName);
    await writeFile(XML_PATH, xml, "utf-8");

    // 5) Restart onto the fresh save.
    await restartGame("7dtd");

    // keep the curated DB row's notion of nothing here; log it.
    await db.activity
      .create({ data: { userId: session.user.id, action: "server_reset", details: JSON.stringify({ game: "7dtd", world, oldName, newName }) } })
      .catch(() => {});

    return NextResponse.json({
      success: true,
      world,
      newGameName: newName,
      message: `World "${world}" reset to a fresh save (${newName}). The map was kept${
        hadSave ? "; the old save was backed up first" : " (there was no existing save to back up)"
      }. The server is restarting.`,
    });
  } catch (e) {
    if (e instanceof ControlBusyError) return NextResponse.json({ error: e.message, busy: e.lock }, { status: 409 });
    return NextResponse.json({ error: (e as Error).message || "Reset failed" }, { status: 500 });
  }
}
