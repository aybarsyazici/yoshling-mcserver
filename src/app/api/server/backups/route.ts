import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { exec } from "child_process";
import { promisify } from "util";
import { readdir, stat, rm } from "fs/promises";
import path from "path";

const execAsync = promisify(exec);
const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";
const BACKUP_DIR = "/app/data/backups";

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
          const filePath = path.join(BACKUP_DIR, name);
          const s = await stat(filePath);
          return {
            name,
            size: s.size,
            createdAt: s.mtime.toISOString(),
          };
        })
    );

    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json(backups);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
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
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `world-${timestamp}.tar.gz`;

      await execAsync(
        `tar -czf ${BACKUP_DIR}/${filename} -C ${MC_DIR} world`,
        { timeout: 60000 }
      );

      const s = await stat(path.join(BACKUP_DIR, filename));

      return NextResponse.json({
        success: true,
        backup: { name: filename, size: s.size, createdAt: s.mtime.toISOString() },
      });
    } catch (e: any) {
      return NextResponse.json({ error: e.message || "Backup failed" }, { status: 500 });
    }
  }

  if (action === "restore") {
    if (!backupName) {
      return NextResponse.json({ error: "backupName required" }, { status: 400 });
    }

    const backupPath = path.join(BACKUP_DIR, backupName);

    try {
      // Remove current world
      await execAsync(`rm -rf ${MC_DIR}/world`);
      // Extract backup
      await execAsync(`tar -xzf ${backupPath} -C ${MC_DIR}`, { timeout: 60000 });

      return NextResponse.json({ success: true });
    } catch (e: any) {
      return NextResponse.json({ error: e.message || "Restore failed" }, { status: 500 });
    }
  }

  if (action === "delete") {
    if (!backupName) {
      return NextResponse.json({ error: "backupName required" }, { status: 400 });
    }

    try {
      await rm(path.join(BACKUP_DIR, backupName));
      return NextResponse.json({ success: true });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
