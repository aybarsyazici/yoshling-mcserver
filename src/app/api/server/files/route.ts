import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { readdir, readFile, writeFile, stat, rm } from "fs/promises";
import path from "path";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";

const BLOCKED_PATTERNS = ["..", "~", "node_modules"];

function isPathSafe(requestedPath: string): boolean {
  const resolved = path.resolve(MC_DIR, requestedPath);
  if (!resolved.startsWith(MC_DIR)) return false;
  if (BLOCKED_PATTERNS.some((p) => requestedPath.includes(p))) return false;
  return true;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const relativePath = searchParams.get("path") || "";
  const action = searchParams.get("action") || "list";

  if (!isPathSafe(relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(MC_DIR, relativePath);

  try {
    if (action === "read") {
      const stats = await stat(fullPath);
      if (stats.size > 512 * 1024) {
        return NextResponse.json(
          { error: "File too large (max 512KB)" },
          { status: 400 }
        );
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
            const s = await stat(entryPath);
            size = s.size;
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
  } catch (e: any) {
    if (e.code === "ENOENT") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
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

  const { path: relativePath, content } = await request.json();

  if (!relativePath || typeof content !== "string") {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  if (!isPathSafe(relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(MC_DIR, relativePath);

  try {
    await writeFile(fullPath, content, "utf-8");

    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ path: relativePath }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
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
  const relativePath = searchParams.get("path") || "";

  if (!relativePath || !isPathSafe(relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(MC_DIR, relativePath);

  try {
    await rm(fullPath, { recursive: true });

    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "delete_file",
        details: JSON.stringify({ path: relativePath }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
