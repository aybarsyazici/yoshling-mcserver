import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { exec } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm } from "fs/promises";
import path from "path";
import { RUNTIME } from "@/lib/game-manager";

const execAsync = promisify(exec);
const SDTD_DIR = RUNTIME["7dtd"].dir;
const BACKUP_DIR = "/app/data/backups-7dtd";
// 7DTD stores worlds under a "Saves" directory in the game-data mount.
const SAVES_SUBDIR = "Saves";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await execAsync(`mkdir -p ${BACKUP_DIR}`);
    const entries = await readdir(BACKUP_DIR);
    const backups = await Promise.all(
      entries
        .filter((e) => e.endsWith(".tar.gz"))
        .map(async (name) => {
          const s = await stat(path.join(BACKUP_DIR, name));
          return { name, size: s.size, createdAt: s.mtime.toISOString() };
        })
    );
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json(backups);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { action, backupName } = await request.json();

  if (action === "create") {
    try {
      await execAsync(`mkdir -p ${BACKUP_DIR}`);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `saves-${timestamp}.tar.gz`;
      await execAsync(
        `tar -czf ${BACKUP_DIR}/${filename} -C ${SDTD_DIR} ${SAVES_SUBDIR}`,
        { timeout: 120000 }
      );
      const s = await stat(path.join(BACKUP_DIR, filename));
      return NextResponse.json({
        success: true,
        backup: { name: filename, size: s.size, createdAt: s.mtime.toISOString() },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Backup failed";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (action === "restore") {
    if (!backupName) return NextResponse.json({ error: "backupName required" }, { status: 400 });
    try {
      await execAsync(`rm -rf ${SDTD_DIR}/${SAVES_SUBDIR}`);
      await execAsync(`tar -xzf ${path.join(BACKUP_DIR, backupName)} -C ${SDTD_DIR}`, { timeout: 120000 });
      return NextResponse.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Restore failed";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (action === "delete") {
    if (!backupName) return NextResponse.json({ error: "backupName required" }, { status: 400 });
    try {
      await rm(path.join(BACKUP_DIR, backupName));
      return NextResponse.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Delete failed";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
