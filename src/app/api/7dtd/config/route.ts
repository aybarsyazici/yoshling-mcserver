import { readFileSnapshot, recordFileRevision, assertFileRevision } from "@/lib/file-revision";
import { assertFileWriteActive } from "@/lib/operations";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { withGameFileWrite, revisionRead } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import { gameDataPath } from "@/lib/game-data-path";
import { assertSdtdXmlValues, parseSdtdXmlProperties, setSdtdXmlProperties } from "@/lib/sdtd-xml";
import {
  SANDBOX_SCOPE_WARNING,
  clampPlayerCount,
  normalizeSandboxCode,
  sandboxCodeIssue,
} from "@/lib/sdtd-settings";

// sdtdserver.xml lives in the ServerFiles mount. The docker image reads it on
// boot; we edit the curated subset of <property name=".." value=".."/> lines.
//
// The fallback is `/sevendtd-config`, matching the five other readers of this variable
// (`7dtd/reset`, `7dtd/world` ×2, `7dtd/files`, `7dtd/backups`). It used to fall back to
// `RUNTIME["7dtd"].dir`, which is `/sevendtd` — the **saves** volume, where there is no
// `sdtdserver.xml` at all (verified on the box 2026-09-29: `/sevendtd/sdtdserver.xml`
// does not exist, `/sevendtd-config/sdtdserver.xml` does). Latent only because
// SDTD_CONFIG_DIR happens to be set in production; without it every read here would
// ENOENT and the route would report "the server config file isn't present yet".
const CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config";

// Maps our friendly config keys → the sdtdserver.xml property names.
//
// **`gameDifficulty` → `GameDifficulty` and `dayLength` → `DayNightLength` used to be
// here and are gone.** Neither property exists in this server's `sdtdserver.xml`
// (69 properties, counted on the box; modern 7DTD folds both into the sandbox preset), so
// the only thing the mapping could still do was write a frozen DB value into the file if
// a future game version re-introduced the property — a number nobody has been able to
// choose since the controls were deleted. Writing an unchosen value because a key happens
// to exist again is the same defect as writing a key that does not.
const XML_KEYS: Record<string, string> = {
  serverName: "ServerName",
  password: "ServerPassword",
  maxPlayers: "ServerMaxPlayerCount",
  sandboxCode: "SandboxCode",
};

// Field labels as the Settings page shows them, so a message about a setting
// that didn't land can name it the way the person reading it saw it.
const LABELS: Record<string, string> = {
  serverName: "Server name",
  password: "Password",
  maxPlayers: "Max players",
  sandboxCode: "Sandbox code",
};

// Only the columns this route still owns.
//
// **`SevenDaysConfig.gameDifficulty`, `.dayLength`, `.version` and `.maxMemory` are dead
// and are no longer written.** Measured 2026-10-01 on the production row: they hold
// `2`, `60`, `latest_experimental` and `6G`, and nothing in `src/` reads any of them —
// `/api/7dtd/update` takes the Steam branch from `readCompose()`'s `VERSION`, and 7DTD is
// a Unity native server with no JVM heap for `maxMemory` to size. They were last
// *writable* when the two nonexistent-XML-property controls existed. Continuing to write
// them made the row look like maintained state, which matters because this row is
// documented as the recovery source after a fresh SteamCMD install wipes the XML: an
// operator restoring "the difficulty from the DB" would be restoring a default nobody
// chose, for a property the file does not have. Dropping the four columns needs a
// hand-applied production migration (see CLAUDE.md), so they stay in the schema, unwritten
// and unread, until someone does that.
const DEFAULTS = {
  serverName: "Yoshling 7DTD",
  password: "",
  maxPlayers: 8,
  sandboxCode: "",
};

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  // This row's `password` column IS `ServerPassword` — the live join password
  // (5 characters, non-empty, read off the production DB and `sdtdserver.xml`
  // 2026-09-30). World access alone used to be enough to GET it, so a read-only
  // MEMBER granted 7DTD could read the server password out of the Settings page
  // while `/api/7dtd/files` refused them the same value from the same file.
  // Same leak, one route over.
  if (!hasPermission(session.user.role, "settings.read")) {
    // The Settings page shows `data.error` verbatim, so say why. A bare "Forbidden" is
    // how the power-button gate got reported as a bug before it explained itself.
    return NextResponse.json(
      { error: "These settings include the server password, so reading them needs the admin or moderator role." },
      { status: 403 }
    );
  }
  return revisionRead(() => gameDataPath(CONFIG_DIR, "sdtdserver.xml"), async () => {
    const config = await db.sevenDaysConfig.findUnique({ where: { id: "main" } });
    const row = { id: "main", ...DEFAULTS, ...(config ?? {}) };

    // All four quick fields follow the file. A backup restore intentionally changes
    // them without replacing the DB; reading the old mirror would revert the restored
    // password and name on the next quick save. The DB remains the first-install fallback.
    let current = row;
    let sandboxCodeSource: "file" | "db" = "db";
    try {
      const properties = parseSdtdXmlProperties(await readFileSnapshot(await gameDataPath(CONFIG_DIR, "sdtdserver.xml"), "utf-8"));
      current = { ...row, ...configFromProperties(properties, row) };
      if (properties.has("SandboxCode")) sandboxCodeSource = "file";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return NextResponse.json({ error: "The 7DTD server config could not be read or validated." }, { status: 500 });
      }
    }

    // Explicit, not `...row`: the four dead columns (`gameDifficulty`, `dayLength`,
    // `version`, `maxMemory`) were being handed to the page as if the page could use them.
    // Additive — a future column is absent from this response until someone adds it here.
    return NextResponse.json({
      id: row.id,
      serverName: current.serverName,
      password: current.password,
      maxPlayers: current.maxPlayers,
      sandboxCode: current.sandboxCode,
      sandboxCodeSource,
    });
  });
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

  // Refuse while an operation holds this world's files. This write is sub-second and
  // needs no record of its own, but it does need the lane: a restore holds it for
  // minutes and would silently overwrite whatever was saved through it, while the page
  // toasted "Saved". Measured on production: this returned 200 in 17 ms mid-backup.
  return withGameFileWrite("7dtd", async () => {

    const body = await request.json();

    // The existing row, so a key the client omits keeps its stored value instead of
    // snapping back to `DEFAULTS`. This row is the only config that survives a fresh
    // SteamCMD install, so it is the copy a recovery reads, and silently rewriting a
    // recovery source is exactly the defect class this page is being cleaned up for.
    //
    // (The four dead columns are a weaker version of the same hazard and are now dealt with
    // by not writing them at all — see `DEFAULTS`. They used to be clamped back to `2` /
    // `60` on any save that omitted them, so renaming the server rewrote a difficulty
    // nobody had set.)
    const existing = await db.sevenDaysConfig.findUnique({ where: { id: "main" } }).catch(() => null);
    let prev = { ...DEFAULTS, ...(existing ?? {}) };

    // A client that omits any quick field must retain the current file value, including
    // settings restored from an archive, rather than overwrite it with a stale DB mirror.
    let xml: string | null = null;
    let file = "";
    let xmlReadError: NodeJS.ErrnoException | null = null;
    try {
      file = await gameDataPath(CONFIG_DIR, "sdtdserver.xml");
      xml = await readFile(file, "utf-8");
    } catch (e) {
      xmlReadError = e as NodeJS.ErrnoException;
      if (xmlReadError.code !== "ENOENT") {
        return NextResponse.json({ error: "The 7DTD server config could not be read or validated; nothing was saved." }, { status: 500 });
      }
    }
    if (xml !== null) {
      try {
        prev = { ...prev, ...configFromProperties(parseSdtdXmlProperties(xml), prev) };
      } catch {
        return NextResponse.json({ error: "The 7DTD server config could not be validated; nothing was saved." }, { status: 500 });
      }
    }
    const currentSandbox = prev.sandboxCode;

    const sandboxCode =
      body.sandboxCode === undefined ? currentSandbox : normalizeSandboxCode(body.sandboxCode);
    const sandboxChanged = sandboxCode !== currentSandbox;

    // Shape-check only what this request actually changes. A value already on disk must not
    // be able to block renaming the server — and `sandboxCodeIssue` is a judgement about a
    // paste, not about history.
    const sandboxIssue = sandboxChanged ? sandboxCodeIssue(sandboxCode) : {};
    if (sandboxIssue.error) {
      // Refused before the DB write, so nothing is stored and nothing is claimed. The page
      // shows `error` verbatim.
      return NextResponse.json({ error: sandboxIssue.error }, { status: 400 });
    }

    const players = clampPlayerCount(body.maxPlayers, prev.maxPlayers);

    const data = {
      serverName: String(body.serverName ?? prev.serverName).slice(0, 80),
      password: String(body.password ?? prev.password),
      maxPlayers: players.value,
      sandboxCode,
    };

    const updates = Object.fromEntries(Object.entries(XML_KEYS).map(([key, name]) => [name, String(data[key as keyof typeof data])]));
    let xmlPlan: ReturnType<typeof setSdtdXmlProperties> | null = null;
    if (xml !== null) {
      try {
        xmlPlan = setSdtdXmlProperties(xml, updates);
      } catch {
        return NextResponse.json({ error: "These settings cannot be written as valid XML; nothing was saved." }, { status: 400 });
      }
    }

    await db.sevenDaysConfig.upsert({
      where: { id: "main" },
      update: data,
      create: { id: "main", ...data },
    });

    // The file baseline distinguishes actual changes from omitted or unchanged values.
    const before: Record<string, string> = {
      serverName: String(prev.serverName),
      password: String(prev.password),
      maxPlayers: String(prev.maxPlayers),
      sandboxCode: currentSandbox,
    };

    // Best-effort sync to the XML on disk (may not exist until first install).
    let xmlWarning: string | undefined;
    // Keys whose property this server's config doesn't have **and whose value this
    // request actually changed**. We store them in the DB regardless (that row is the
    // only thing that survives a fresh install), so without reporting them the page
    // toasts "Settings saved" for a value that changed nothing in-game.
    //
    // All four of the keys left in `XML_KEYS` do exist in the live file (counted on the box
    // 2026-10-01: 69 properties, including `ServerName`, `ServerPassword`,
    // `ServerMaxPlayerCount` and `SandboxCode`), so this array is expected to stay empty —
    // it is the guard for a future game version that drops one of them, which is how
    // `GameDifficulty` and `DayNightLength` became writes to nowhere in the first place.
    //
    // The "actually changed" half matters. This used to report every missing property on
    // every PUT, so renaming the server raised an amber "Difficulty had no effect in-game"
    // warning about a field the user never touched — and this page's warning toast is its
    // *only* honesty channel, so firing it on every save trains people to dismiss it unread.
    const skipped: string[] = [];
    if (xml === null) {
      xmlWarning =
        xmlReadError?.code === "ENOENT"
          ? "Saved. The server config file isn't present yet — settings will apply once 7DTD finishes its first install."
          : `Saved here, but the server config could not be read, so nothing changed on the server: ${xmlReadError?.message}`;
    } else {
      try {
        const { xml: next, applied, ignored } = xmlPlan!;
        for (const name of ignored) {
          const key = Object.keys(XML_KEYS).find((key) => XML_KEYS[key] === name)!;
          if (updates[name] !== before[key]) skipped.push(name);
        }
        await assertFileRevision(file);
        assertFileWriteActive();
        await writeFile(file, next, "utf-8");
        recordFileRevision(file, next);
        const storedXml = await readFile(file, "utf-8");
        if (storedXml !== next) throw new Error("The server config did not match the completed write");
        assertSdtdXmlValues(storedXml, Object.fromEntries(applied.map((name) => [name, updates[name]])));
        if (skipped.length > 0) {
          const named = skipped.map((x) => `${labelFor(x)} (${x})`).join(" or ");
          xmlWarning =
            `Saved, but the server config has no ${named} property, so ${skipped.length > 1 ? "those settings" : "that setting"} ` +
            `had no effect in-game. Current 7DTD versions fold them into the sandbox preset — set them in Sandbox code instead.`;
        }
      } catch (e) {
        return NextResponse.json(
          { success: false, stored: data, error: `Saved here, but the server config write could not be verified: ${(e as Error).message}` },
          { status: 500 }
        );
      }
    }

    try {
      await db.activity.create({
        data: {
          userId: session.user.id,
          action: "edit_file",
          details: JSON.stringify({ game: "7dtd", file: "sdtdserver.xml" }),
        },
      });
    } catch {}

    // Everything this request did that the request did not ask for, in the order that
    // matters: a failed write first (it invalidates the rest), then the clamp, then what a
    // new sandbox code does and does not reach.
    //
    // Each clause only fires when it applies to *this* request — a note on every save is a
    // note nobody reads, which is how the old blanket "Difficulty had no effect" warning
    // trained people to dismiss this page's one honesty channel. `xmlWarning` is the only
    // one that leads with "Saved", because it is the one about the write itself; the rest are
    // clauses, so a toast never contains two separate verdicts.
    const clauses = [
      players.note,
      sandboxIssue.warning,
      sandboxChanged ? SANDBOX_SCOPE_WARNING : undefined,
    ].filter(Boolean) as string[];
    const notes = xmlWarning
      ? [xmlWarning, ...clauses].join(" ")
      : clauses.length > 0
      ? ["Saved.", ...clauses].join(" ")
      : "";

    // `stored` is what is now in the row, so the page can redisplay the saved values rather
    // than keep showing what was typed. Asking for 99 players stored 16 and left "99" in the
    // box — the UI manufacturing a confirmation the server had not given.
    //
    // `skipped` is the honest part of "success": these keys reached the DB but not the
    // server.
    return NextResponse.json({
      success: true,
      warning: notes || undefined,
      skipped,
      clamped: players.note ? ["maxPlayers"] : [],
      stored: data,
    });

  }, { request, file: () => gameDataPath(CONFIG_DIR, "sdtdserver.xml") });
}

function labelFor(xmlName: string): string {
  const key = Object.keys(XML_KEYS).find((k) => XML_KEYS[k] === xmlName);
  return (key && LABELS[key]) || xmlName;
}

function configFromProperties(properties: Map<string, string>, fallback: typeof DEFAULTS): typeof DEFAULTS {
  const rawPlayers = properties.get("ServerMaxPlayerCount");
  const maxPlayers = rawPlayers === undefined ? fallback.maxPlayers : Number(rawPlayers);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1) throw new Error("The current ServerMaxPlayerCount is invalid");
  return {
    serverName: properties.get("ServerName") ?? fallback.serverName,
    password: properties.get("ServerPassword") ?? fallback.password,
    maxPlayers,
    sandboxCode: properties.get("SandboxCode") ?? fallback.sandboxCode,
  };
}
