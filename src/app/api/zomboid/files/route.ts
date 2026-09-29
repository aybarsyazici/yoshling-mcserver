import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readdir, readFile, writeFile, stat, rm } from "fs/promises";
import path from "path";
import { PZ_DIR } from "@/lib/zomboid";
import { isPathInside, looksBinary, readTextFile } from "@/lib/file-guard";

// Project Zomboid keeps everything under one data dir, so the roots are just
// shortcuts into it: the config files, the saves, and the whole tree (Logs, db,
// Lua…) for anything else.
const ROOTS: Record<string, string> = {
  config: path.join(PZ_DIR, "Server"),
  saves: path.join(PZ_DIR, "Saves"),
  all: PZ_DIR,
};

const BLOCKED_PATTERNS = ["..", "~", "node_modules"];

function resolveRoot(root: string | null): string | null {
  if (!root) return ROOTS.config;
  return ROOTS[root] ?? null;
}

function isPathSafe(baseDir: string, requestedPath: string): boolean {
  // `isPathInside`, not `resolved.startsWith(baseDir)`: the old form matched any path that
  // merely shared the prefix. That was **reachable here**, not latent -- the web container
  // mounts `/zomboid` and `/zomboid-workshop` side by side (verified 2026-09-29), so
  // `?root=all&path=/zomboid-workshop` resolved outside the root it claimed to be under,
  // with no `..` for BLOCKED_PATTERNS to catch. Same predicate, same bug, in 7DTD's
  // `/sevendtd` vs `/sevendtd-config`, where a saves-root request listed the config tree.
  if (!isPathInside(baseDir, path.resolve(baseDir, requestedPath))) return false;
  if (BLOCKED_PATTERNS.some((p) => requestedPath.includes(p))) return false;
  return true;
}

export async function GET(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  // Same gate as the editor: these trees hold the live `TelnetPassword` /
  // `RCONPassword`, which the settings pages have a locked-key set to hide. An
  // open GET here made that set decorative.
  if (!hasPermission(gate.session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      // A directory read used to reach `readFile` and come back as a 500 carrying a raw
      // `EISDIR`. Say what happened instead.
      if (stats.isDirectory()) {
        return NextResponse.json({ error: "That's a folder, not a file." }, { status: 400 });
      }
      if (stats.size > 512 * 1024) {
        return NextResponse.json({ error: "File too large (max 512KB)" }, { status: 400 });
      }
      // Refuse rather than hand back mojibake: a `"utf-8"` read maps every non-UTF-8 byte
      // to U+FFFD, and the editor submits that string straight back to the PUT below,
      // which writes it over the original and reports success. See `looksBinary`. The
      // `saves` root here is the live world: `Saves/Multiplayer/yoshling` is mostly `.bin`
      // (`map_animals.bin`, `entity_data.bin`, `WorldDictionary.bin`, …), all listed and
      // all one click from the editor.
      const text = await readTextFile(fullPath);
      if (!text.ok) {
        return NextResponse.json(
          {
            error:
              "This file isn't text, so it can't be shown or edited here — editing it would corrupt it.",
            binary: true,
          },
          { status: 415 }
        );
      }
      return NextResponse.json({ content: text.content, path: relativePath });
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
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Take this world's file lane, for the same reason every *config* endpoint already
  // does: a restore holds it for minutes and would silently overwrite whatever was saved
  // through it, while the page toasted "Saved". Sharpest of the three here —
  // `/api/zomboid/config` guards `yoshling.ini` while this route can rewrite the very
  // same file under any of its three roots. Never on GET: browsing during a backup is
  // harmless, and refusing it would be worse than allowing it.
  const laneBusy = fileLaneBusy("zomboid");
  if (laneBusy) return laneBusy;

  const { path: relativePath, content, root } = await request.json();
  const baseDir = resolveRoot(root);
  if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

  if (!relativePath || typeof content !== "string") {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }
  if (!isPathSafe(baseDir, relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(baseDir, relativePath);

  try {
    // Never let the text editor write over a file that isn't text. The read side now
    // refuses to hand one out, but this is the half that does the damage and the two have
    // to fail independently -- a tab opened before this shipped still holds the mojibake
    // and its Save button still works. A missing file is a legitimate create, so only an
    // *existing* binary is refused.
    const existing = await readFile(fullPath).catch(() => null);
    if (existing && looksBinary(existing)) {
      return NextResponse.json(
        {
          error: `${path.basename(relativePath)} isn't a text file. Saving it through the editor would corrupt it, so nothing was written.`,
        },
        { status: 415 }
      );
    }

    await writeFile(fullPath, content, "utf-8");
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "zomboid", path: relativePath }),
      },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const laneBusy = fileLaneBusy("zomboid");
  if (laneBusy) return laneBusy;

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
        details: JSON.stringify({ game: "zomboid", path: relativePath }),
      },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
