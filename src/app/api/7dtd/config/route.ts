import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { escapeXml } from "@/lib/sdtd-xml";
import {
  SANDBOX_SCOPE_WARNING,
  clampPlayerCount,
  normalizeSandboxCode,
  readXmlProperty,
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
const XML_PATH = path.join(process.env.SDTD_CONFIG_DIR || "/sevendtd-config", "sdtdserver.xml");

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
  const config = await db.sevenDaysConfig.findUnique({ where: { id: "main" } });
  const row = { id: "main", ...DEFAULTS, ...(config ?? {}) };

  // **`sandboxCode` is read out of `sdtdserver.xml`, not out of this row** — the whole
  // point of this line.
  //
  // The file has two writers: this route and `/api/7dtd/config/all`, whose DB mirror map
  // covers `ServerName`, `ServerPassword` and `ServerMaxPlayerCount` and (before today)
  // **not** `SandboxCode`. So editing the sandbox code in "All settings" wrote the file
  // and left this row holding the old code; the next quick save then wrote that stale code
  // straight back over the file. Set a difficulty, rename the server a week later, and the
  // difficulty silently reverts — with a green toast both times. Reading the file here
  // makes the file the only source of truth for what this page shows, which is the half of
  // the fix that cannot drift. (`config/all` now mirrors `SandboxCode` into the row too,
  // so the fresh-install recovery copy stops rotting, but nothing *reads* the mirror.)
  let sandboxCode = row.sandboxCode;
  let sandboxCodeSource: "file" | "db" = "db";
  try {
    const fromFile = readXmlProperty(await readFile(XML_PATH, "utf-8"), "SandboxCode");
    if (fromFile !== null) {
      sandboxCode = fromFile;
      sandboxCodeSource = "file";
    }
  } catch {
    // Before 7DTD's first install there is no file. Fall through to the stored copy and
    // say which one this is, rather than showing a blank box that looks like "unset".
  }

  // Explicit, not `...row`: the four dead columns (`gameDifficulty`, `dayLength`,
  // `version`, `maxMemory`) were being handed to the page as if the page could use them.
  // Additive — a future column is absent from this response until someone adds it here.
  return NextResponse.json({
    id: row.id,
    serverName: row.serverName,
    password: row.password,
    maxPlayers: row.maxPlayers,
    sandboxCode,
    sandboxCodeSource,
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
  const laneBusy = fileLaneBusy("7dtd");
  if (laneBusy) return laneBusy;

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
  const prev = { ...DEFAULTS, ...(existing ?? {}) };

  // Read the file **before** deciding anything, because for `sandboxCode` the file — not
  // the row — is what is being replaced (see the GET). A client that omits the key must
  // leave the file's code alone; falling back to the row would write a stale code back
  // over an edit made in "All settings", which is the exact revert this change removes.
  let xml: string | null = null;
  let xmlReadError: NodeJS.ErrnoException | null = null;
  try {
    xml = await readFile(XML_PATH, "utf-8");
  } catch (e) {
    xmlReadError = e as NodeJS.ErrnoException;
  }
  const currentSandbox = (xml && readXmlProperty(xml, "SandboxCode")) ?? prev.sandboxCode;

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

  await db.sevenDaysConfig.upsert({
    where: { id: "main" },
    update: data,
    create: { id: "main", ...data },
  });

  // What each key was before this request, so "did this request change it" is answerable.
  // `sandboxCode`'s baseline is the **file**, not the row — the row can be stale.
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
      let next = xml;
      for (const [key, xmlName] of Object.entries(XML_KEYS)) {
        const value = String((data as Record<string, unknown>)[key]);
        const re = new RegExp(
          `(<property\\s+name="${xmlName}"\\s+value=")[^"]*(")`,
          "i"
        );
        if (re.test(next)) {
          next = next.replace(re, `$1${escapeXml(value)}$2`);
        } else if (value !== before[key]) {
          skipped.push(xmlName);
        }
      }
      await writeFile(XML_PATH, next, "utf-8");
      if (skipped.length > 0) {
        const named = skipped.map((x) => `${labelFor(x)} (${x})`).join(" or ");
        xmlWarning =
          `Saved, but the server config has no ${named} property, so ${skipped.length > 1 ? "those settings" : "that setting"} ` +
          `had no effect in-game. Current 7DTD versions fold them into the sandbox preset — set them in Sandbox code instead.`;
      }
    } catch (e) {
      xmlWarning = `Saved here, but writing the server config failed, so nothing changed on the server: ${(e as Error).message}`;
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
}

function labelFor(xmlName: string): string {
  const key = Object.keys(XML_KEYS).find((k) => XML_KEYS[k] === xmlName);
  return (key && LABELS[key]) || xmlName;
}
