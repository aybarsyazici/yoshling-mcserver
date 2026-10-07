import { recordFileRevision, assertFileRevision, withFileRevision } from "@/lib/file-revision";
import { assertFileWriteActive } from "@/lib/operations";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { withGameFileWrite, revisionRead } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { lstat, readdir, readFile, writeFile, stat, rm } from "fs/promises";
import path from "path";
import { resolveSafeFilePath, looksBinary, readTextFile } from "@/lib/file-guard";

// 7DTD exposes two useful trees, both mounted into the web container:
//   config → serverfiles (sdtdserver.xml, serverconfig.xml, Mods, Data)
//   saves  → the saves/worlds volume
const ROOTS: Record<string, string> = {
  config: process.env.SDTD_CONFIG_DIR || "/sevendtd-config",
  saves: process.env.SDTD_SERVER_DIR || "/sevendtd",
};

function resolveRoot(root: unknown): string | null {
  if (root == null || root === "") return ROOTS.config;
  if (typeof root !== "string" || !Object.hasOwn(ROOTS, root)) return null;
  return ROOTS[root];
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;

  // Same gate as the editor: these trees hold the live `TelnetPassword` /
  // `RCONPassword`, which the settings pages have a locked-key set to hide. An
  // open GET here made that set decorative.
  //
  // `settings.read` rather than `settings.edit` (same roles, clearer intent) — see
  // `/api/server/files`: an `…edit` key on a GET invites someone to drop the check.
  if (!hasPermission(session.user.role, "settings.read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const baseDir = resolveRoot(searchParams.get("root"));
  if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

  const relativePath = searchParams.get("path") || "";
  const action = searchParams.get("action") || "list";

  try {
    const fullPath = await resolveSafeFilePath(baseDir, relativePath);
    if (!fullPath) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

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
      // to U+FFFD, and the editor then submits that string back to the PUT below, which
      // writes it over the original and reports success. See `looksBinary`. The saves tree
      // here is nearly all binary -- `Saves/Reveo Valley/Fresh2` holds `main.ttw`,
      // `decoration.7dt`, `drones.dat`, `Region/`, all listed and all one click away.
return revisionRead(async () => fullPath, async () => {
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
      });
}

    const entries = await readdir(fullPath, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith("."))
        .map(async (entry) => {
          const entryPath = path.join(fullPath, entry.name);
          let size = 0;
          try {
            size = (await lstat(entryPath)).size;
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
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Take this world's file lane, for the same reason every *config* endpoint already
  // does: a restore holds it for minutes and would silently overwrite whatever was saved
  // through it, while the page toasted "Saved". Sharper here than in the config routes —
  // they guard one curated file each, this can write any file in the same tree,
  // including `sdtdserver.xml` itself. Never on GET: browsing during a backup is
  // harmless, and refusing it would be worse than allowing it.
  return withGameFileWrite("7dtd", async () => {

    const { path: relativePath, content, root } = await request.json();
    const baseDir = resolveRoot(root);
    if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

    if (typeof relativePath !== "string" || !relativePath || typeof content !== "string") {
      return NextResponse.json({ error: "path and content required" }, { status: 400 });
    }
    try {
      const fullPath = await resolveSafeFilePath(baseDir, relativePath, {
        allowMissing: true,
        allowRoot: false,
      });
      if (!fullPath) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

      // Never let the text editor write over a file that isn't text. The read side now
      // refuses to hand one out, but this is the half that does the damage and the two have
      // to fail independently -- a tab opened before this shipped still holds the mojibake
      // and its Save button still works. A missing file is a legitimate create, so only an
      // *existing* binary is refused.
return withFileRevision(request, async () => fullPath, async () => {
        const existing = await readFile(fullPath).catch(() => null);
        if (existing && looksBinary(existing)) {
          return NextResponse.json(
            {
              error: `${path.basename(relativePath)} isn't a text file. Saving it through the editor would corrupt it, so nothing was written.`,
            },
            { status: 415 }
          );
        }

        await assertFileRevision(fullPath);

        assertFileWriteActive();

        await writeFile(fullPath, content, "utf-8");

        recordFileRevision(fullPath, content);
        if (await readFile(fullPath, "utf-8") !== content) throw new Error("The saved file contents could not be verified");
        await db.activity.create({
          data: {
            userId: session.user.id,
            action: "edit_file",
            details: JSON.stringify({ game: "7dtd", path: relativePath }),
          },
        });
        return NextResponse.json({ success: true });
      });
} catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }

  });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  // Deleting a game file has no undo, so it gets its own capability instead of
  // riding on `settings.edit`. Was a bare `role !== "ADMIN"` — see `permissions.ts`
  // for why the three file browsers now narrow from one line.
  if (!hasPermission(session.user.role, "files.delete")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return withGameFileWrite("7dtd", async () => {

    const { searchParams } = new URL(request.url);
    const baseDir = resolveRoot(searchParams.get("root"));
    if (!baseDir) return NextResponse.json({ error: "Invalid root" }, { status: 400 });

    const relativePath = searchParams.get("path") || "";
    if (!relativePath) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    try {
      const fullPath = await resolveSafeFilePath(baseDir, relativePath, {
        allowRoot: false,
        followFinalSymlink: false,
      });
      if (!fullPath) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

return withFileRevision(request, async () => fullPath, async () => {
        assertFileWriteActive();

        await rm(fullPath, { recursive: true });

        recordFileRevision(fullPath, null);
        await db.activity.create({
          data: {
            userId: session.user.id,
            action: "delete_file",
            details: JSON.stringify({ game: "7dtd", path: relativePath }),
          },
        });
        return NextResponse.json({ success: true });
      });
} catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }

  });
}
