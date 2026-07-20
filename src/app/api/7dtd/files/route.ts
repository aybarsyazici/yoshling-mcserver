import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { readdir, readFile, writeFile, stat, rm } from "fs/promises";
import path from "path";

// 7DTD exposes two useful trees, both mounted into the web container:
//   config → serverfiles (sdtdserver.xml, serverconfig.xml, Mods, Data)
//   saves  → the saves/worlds volume
const ROOTS: Record<string, string> = {
  config: process.env.SDTD_CONFIG_DIR || "/sevendtd-config",
  saves: process.env.SDTD_SERVER_DIR || "/sevendtd",
};

const BLOCKED_PATTERNS = ["..", "~", "node_modules"];

function resolveRoot(root: string | null): string | null {
  if (!root) return ROOTS.config;
  return ROOTS[root] ?? null;
}

function isPathSafe(baseDir: string, requestedPath: string): boolean {
  const resolved = path.resolve(baseDir, requestedPath);
  if (!resolved.startsWith(baseDir)) return false;
  if (BLOCKED_PATTERNS.some((p) => requestedPath.includes(p))) return false;
  return true;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const baseDir = resolveRoot(searchParams.get("root"));
  if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

  const relativePath = searchParams.get("path") || "";
  const action = searchParams.get("action") || "list";

  if (!isPathSafe(baseDir, relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(baseDir, relativePath);

  try {
    if (action === "read") {
      const stats = await stat(fullPath);
      if (stats.size > 512 * 1024) {
        return NextResponse.json({ error: "File too large (max 512KB)" }, { status: 400 });
      }
      const content = await readFile(fullPath, "utf-8");
      return NextResponse.json({ content, path: relativePath });
    }

    const entries = await readdir(fullPath, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith("."))
        .map(async (entry) => {
          const entryPath = path.join(fullPath, entry.name);
          let size = 0;
          try {
            size = (await stat(entryPath)).size;
          } catch {}
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size,
            path: path.join(relativePath, entry.name),
          };
        })
    );

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ items, path: relativePath });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { path: relativePath, content, root } = await request.json();
  const baseDir = resolveRoot(root);
  if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

  if (!relativePath || typeof content !== "string") {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }
  if (!isPathSafe(baseDir, relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await writeFile(path.resolve(baseDir, relativePath), content, "utf-8");
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "7dtd", path: relativePath }),
      },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const baseDir = resolveRoot(searchParams.get("root"));
  if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

  const relativePath = searchParams.get("path") || "";
  if (!relativePath || !isPathSafe(baseDir, relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await rm(path.resolve(baseDir, relativePath), { recursive: true });
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "delete_file",
        details: JSON.stringify({ game: "7dtd", path: relativePath }),
      },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
