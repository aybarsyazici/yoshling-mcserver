import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, rm, readdir } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { RUNTIME, restartGame, ControlBusyError } from "@/lib/game-manager";

export const maxDuration = 120;

const execAsync = promisify(exec);
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
    const oldName = getProp(xml, "GameName");
    const newName = bumpName(oldName);

    // 1) Back up the current save first (safety), if it exists.
    const savePath = path.join(SAVES_DIR, "Saves", world);
    const backupDir = "/app/data/backups-7dtd";
    await execAsync(`mkdir -p ${backupDir}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      await readdir(savePath);
      await execAsync(
        `tar -czf ${JSON.stringify(path.join(backupDir, `presreset-${world}-${stamp}.tar.gz`))} -C ${JSON.stringify(path.join(SAVES_DIR, "Saves"))} ${JSON.stringify(world)}`,
        { timeout: 120000 }
      );
    } catch {
      // no existing save to back up — fine
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
      message: `World "${world}" reset to a fresh save (${newName}). The map was kept; a backup of the old save was saved. The server is restarting.`,
    });
  } catch (e) {
    if (e instanceof ControlBusyError) return NextResponse.json({ error: e.message, busy: e.lock }, { status: 409 });
    return NextResponse.json({ error: (e as Error).message || "Reset failed" }, { status: 500 });
  }
}
