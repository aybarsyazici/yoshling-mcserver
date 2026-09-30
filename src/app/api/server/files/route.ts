import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readdir, readFile, writeFile, stat, rm } from "fs/promises";
import path from "path";
import { isPathInside, looksBinary, readTextFile } from "@/lib/file-guard";

const MC_DIR = process.env.MC_SERVER_DIR || "/minecraft";

const BLOCKED_PATTERNS = ["..", "~", "node_modules"];

function isPathSafe(requestedPath: string): boolean {
  // `isPathInside`, not `resolved.startsWith(MC_DIR)`: the old form matched any sibling
  // sharing the prefix (`/minecraft-old/…` passes `startsWith("/minecraft")` and has no
  // `..` for BLOCKED_PATTERNS to catch). Of the three file routes this is the only one
  // where that is currently unreachable -- the web container's mounts are `/minecraft`,
  // `/sevendtd`, `/sevendtd-config`, `/zomboid`, `/zomboid-workshop` (verified
  // 2026-09-29), and the other two routes each have a prefix-sibling among them. Fixed by
  // shape in all three rather than by argument about which mounts exist.
  if (!isPathInside(MC_DIR, path.resolve(MC_DIR, requestedPath))) return false;
  if (BLOCKED_PATTERNS.some((p) => requestedPath.includes(p))) return false;
  return true;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  // Reading these trees is an ADMIN/MOD action, not a browse. The files include
  // `server.properties`, `sdtdserver.xml` and `yoshling.ini`, i.e. the live
  // `rcon.password`, `TelnetPassword` and `RCONPassword` -- the exact keys the
  // settings editors have a locked-key set to hide. Gating only the *editor* and
  // leaving this open meant the password was still one click away under Files.
  //
  // `settings.read` rather than `settings.edit` (same roles, clearer intent): a
  // permission named `…edit` guarding a GET reads like a copy-paste slip and invites
  // the next reader to "fix" it by deleting the check, which is precisely the leak.
  if (!hasPermission(session.user.role, "settings.read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      // A directory read used to reach `readFile` and come back as a 500 with a raw
      // `EISDIR` in it. Say what happened instead.
      if (stats.isDirectory()) {
        return NextResponse.json({ error: "That's a folder, not a file." }, { status: 400 });
      }
      if (stats.size > 512 * 1024) {
        return NextResponse.json(
          { error: "File too large (max 512KB)" },
          { status: 400 }
        );
      }
      // Refuse rather than return mojibake. This route used to read with `"utf-8"`,
      // which maps every non-UTF-8 byte to U+FFFD; the editor then submitted that
      // string back and the PUT below wrote it, destroying the file while reporting
      // success. `world/level.dat` (411-byte gzip NBT) became 752 bytes that way.
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
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Take this world's file lane, for the same reason every *config* endpoint already
  // does: a restore holds it for minutes and would silently overwrite whatever was
  // saved through it, while the page toasted "Saved". The file browser is the sharper
  // case of the two — the config routes guard one curated file each, while this can
  // write *any* file in the same tree, including the very files they guard.
  // Deliberately NOT on GET: browsing during a backup is harmless, and blocking it is
  // worse than allowing it.
  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

  const { path: relativePath, content } = await request.json();

  if (!relativePath || typeof content !== "string") {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  if (!isPathSafe(relativePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(MC_DIR, relativePath);

  try {
    // Never let the text editor write over a file that isn't text. The read side now
    // refuses to hand one out, but this is the half that does the damage, and the two
    // have to be able to fail independently -- a stale tab opened before this shipped
    // still holds the mojibake and its Save button still works. A missing file is a
    // legitimate create, so only an *existing* binary is refused.
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
        // `game` matches the wording 7DTD's and PZ's file routes use. Without it
        // `/api/activity` (which keeps untagged rows visible on purpose) leaked this row
        // to anyone, and `/minecraft`'s own panel — which selects on `contains
        // "minecraft"` — could never show it.
        details: JSON.stringify({ game: "minecraft", path: relativePath }),
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
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  // Deleting a game file has no undo, so it gets its own capability rather than
  // riding on `settings.edit`. Was a bare `role !== "ADMIN"`; naming it is what lets
  // the three file browsers be narrowed together, from `permissions.ts`.
  if (!hasPermission(session.user.role, "files.delete")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

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
        details: JSON.stringify({ game: "minecraft", path: relativePath }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
