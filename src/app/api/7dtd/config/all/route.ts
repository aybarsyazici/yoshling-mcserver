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
import { assertSdtdXmlValues, parseSdtdXmlProperties, sdtdXmlPropertyRows, setSdtdXmlProperties } from "@/lib/sdtd-xml";
import {
  annotateSdtdHelp,
  LOCKED_SDTD_PROPERTIES,
  normalizeSandboxCode,
  pinnedReason,
  sandboxCodeIssue,
} from "@/lib/sdtd-settings";

// The full sdtdserver.xml, exposed generically: read every <property>, keep its
// trailing comment as help text, and write back any subset the UI sends. This
// adapts automatically to whatever properties the server file actually has,
// rather than hardcoding the ~69 keys.
//
// The fallback is `/sevendtd-config`, matching the five other readers of this variable.
// It used to fall back to `RUNTIME["7dtd"].dir`, which is `/sevendtd` — the **saves**
// volume, where there is no `sdtdserver.xml` at all (verified on the box 2026-09-29).
// Latent only because SDTD_CONFIG_DIR is set in production.
const CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config";

export interface SdtdProperty {
  name: string;
  value: string;
  help: string;
}

/**
 * For months the round trip only did half of its work: the PUT escaped on the way in,
 * and the GET handed the raw
 * attribute text back out. So a value containing `& < > "` came back as `&amp;`/`&lt;`
 * and the next Save escaped it again -- entities doubling on every edit, measured on
 * disk. The shared XML parser now decodes attribute values, excludes commented-out
 * properties and refuses malformed documents and duplicate keys.
 *
 * `help` is deliberately *not* unescaped: it is comment text, not attribute text, so it
 * was never escaped on the way in and is never written back.
 */
function parseProperties(xml: string): SdtdProperty[] {
  return sdtdXmlPropertyRows(xml);
}

// Sensitive keys the UI must not expose/allow-edit through the generic editor
// (telnet password is app-managed; changing it here would break control).
//
// `LOCKED` *hides*. `PINNED_BY_DEPLOYMENT` (in `lib/sdtd-settings.ts`) refuses the write
// but leaves the value on screen, which is the right treatment for `ServerPort` and
// `WebDashboardPort`: the number is a fact worth reading, it is simply fixed by the
// container's published port map. `TelnetPort` stays in `LOCKED` because it travels with
// the password nobody may see anyway.
const LOCKED = new Set<string>(LOCKED_SDTD_PROPERTIES);

/**
 * Properties whose values become filesystem path segments elsewhere.
 *
 * `GameWorld` and `GameName` are joined into `Saves/<world>/<name>` and handed to
 * `tar` and `rm -rf` by `/api/7dtd/{reset,backups}`. Those routes now validate
 * defensively too, but this is the writer -- the one place that can stop a bad
 * value existing in the first place.
 */
const PATH_SEGMENT_KEYS = new Set(["GameWorld", "GameName"]);

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  // `LOCKED` hides `TelnetPassword` but deliberately leaves `ServerPassword`
  // editable, so this GET hands it out — and on production it is a real 5-character
  // value, not blank (checked 2026-09-30). World access alone was the whole gate,
  // which made the permission check `/api/7dtd/files` already had pointless: the same
  // secret was one panel away. Verified with the live XML: the only two
  // `*Password|*Token|*Secret` properties in it are `ServerPassword` and
  // `TelnetPassword`.
  if (!hasPermission(session.user.role, "settings.read")) {
    // `config-panel.tsx` toasts `data.error` verbatim, so say why rather than
    // "Forbidden" — an unexplained 403 is how the power-button gate got reported.
    return NextResponse.json(
      { error: "These settings include the server password, so reading them needs the admin or moderator role." },
      { status: 403 }
    );
  }
  return revisionRead(() => gameDataPath(CONFIG_DIR, "sdtdserver.xml"), async () => {
    try {
      const file = await gameDataPath(CONFIG_DIR, "sdtdserver.xml");
      const xml = await readFileSnapshot(file, "utf-8");
      // `annotateSdtdHelp` folds in what the *deployment* does to a setting — the two ports
      // the compose port map pins, and the four keys the host firewall makes inert. The
      // game's XML documents itself with a comment per property, which is why one generic
      // panel serves both 7DTD and PZ; these notes are the only thing the file cannot know,
      // so they are attached here rather than in a per-key UI table that would rot.
      const properties = annotateSdtdHelp(parseProperties(xml).filter((p) => !LOCKED.has(p.name)));
      return NextResponse.json({ properties });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return NextResponse.json({ error: "The 7DTD server config could not be read or validated." }, { status: 500 });
      }
      return NextResponse.json(
        { properties: [], warning: "The 7DTD config file isn't present yet — start the server once to generate it." },
        { status: 200 }
      );
    }
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
    const updates: Record<string, string> = body?.updates ?? {};
    // A locked key used to be dropped with no mention in the response: `PUT
    // {"TelnetPassword":"x","ServerDescription":"y"}` answered
    // `{"success":true,"applied":["ServerDescription"]}`. That is the same silent-drop the
    // `ignored` array below was added to fix, so name them the same way. Not reachable from
    // the UI (locked keys are never rendered), but this endpoint is the API too.
    const locked = Object.keys(updates).filter((n) => LOCKED.has(n));
    const names = Object.keys(updates).filter((n) => !LOCKED.has(n));
    if (names.length === 0) {
      return NextResponse.json(
        { error: "No editable settings provided", locked },
        { status: 400 }
      );
    }

    let xml: string;
    let file: string;
    let currentProperties: Map<string, string>;
    try {
      file = await gameDataPath(CONFIG_DIR, "sdtdserver.xml");
      xml = await readFile(file, "utf-8");
      currentProperties = parseSdtdXmlProperties(xml);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return NextResponse.json({ error: "The 7DTD server config could not be read or validated." }, { status: 500 });
      }
      return NextResponse.json({ error: "Config file not found yet — start the server once first." }, { status: 400 });
    }

    // Reject bad values before writing, not after something downstream trips over
    // them. This editor is the *only* way `GameWorld` and `GameName` get set, and
    // they are consumed as filesystem path segments (`Saves/<world>/<name>`) and as
    // `tar`/`rm` arguments by the reset and backup routes. An empty `GameWorld`
    // collapses `Saves/<world>` to `Saves/` and a `..` climbs out of it, so the
    // damage lands two routes away from the mistake — which is exactly why it has to
    // be caught at the writer.
    const rejected: { name: string; why: string }[] = [];
    for (const name of names) {
      const value = String(updates[name]);
      // Pinned by the deployment: saving a new `ServerPort` here wrote cleanly, toasted
      // success, and moved the listener off the one port compose publishes — i.e. nobody
      // could connect, with no indication why. Refused before any write, so the editor
      // cannot report a save it did not make.
      const pinned = pinnedReason(name);
      if (pinned && value !== currentProperties.get(name)) {
        rejected.push({ name, why: pinned });
        continue;
      }
      // The sandbox code's character class, checked here as well as in the quick settings,
      // because this editor is the file's other writer and a code is a code wherever it is
      // pasted. Shape (the length rule) is only a warning and this endpoint has no warning
      // channel for a single key, so the length is left to the quick settings card.
      if (name === "SandboxCode") {
        const issue = sandboxCodeIssue(normalizeSandboxCode(value));
        if (issue.error) {
          rejected.push({ name, why: issue.error });
          continue;
        }
      }
      if (PATH_SEGMENT_KEYS.has(name)) {
        const bad =
          value.trim() === ""
            ? "cannot be empty"
            : value === "." || value === ".."
            ? "cannot be a relative path"
            : /[/\\]/.test(value)
            ? "cannot contain a path separator"
            : /^\s|\s$/.test(value)
            ? "cannot start or end with a space"
            : null;
        if (bad) rejected.push({ name, why: `${name} ${bad}` });
      }
    }
    if (rejected.length > 0) {
      return NextResponse.json(
        { error: rejected.map((r) => r.why).join("; "), rejected: rejected.map((r) => r.name) },
        { status: 400 }
      );
    }

    const normalized = Object.fromEntries(names.map((name) => {
      // Whitespace and case are the only things normalisation can change in a sandbox code
      // (its alphabet is A-Z, and anything else was refused above), so a wrapped paste is
      // cleaned rather than written as a value the game will not read. Known cosmetic edge:
      // this generic panel redisplays the draft for an applied key, so a lowercase paste
      // keeps showing lowercase until the panel is reloaded, even though the file has the
      // uppercase form. The quick settings card uppercases as you type and has no such gap.
      return [name, name === "SandboxCode" ? normalizeSandboxCode(updates[name]) : String(updates[name])];
    }));

    let applied: string[];
    let ignored: string[];
    try {
      ({ xml, applied, ignored } = setSdtdXmlProperties(xml, normalized));
      await assertFileRevision(file);
      assertFileWriteActive();
      await writeFile(file, xml, "utf-8");
      recordFileRevision(file, xml);
      const storedXml = await readFile(file, "utf-8");
      if (storedXml !== xml) throw new Error("The server config did not match the completed write");
      assertSdtdXmlValues(storedXml, Object.fromEntries(applied.map((name) => [name, normalized[name]])));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }

    // Keep the curated DB row in sync for the fields it mirrors.
    //
    // **`SandboxCode` was missing from this map and that was the bug.** The quick settings
    // card used to *read* its sandbox code out of this row, so an edit made here left the row
    // stale and the next quick save wrote the stale code back over the file: set a
    // difficulty, rename the server later, difficulty silently reverts, green toast both
    // times. The quick GET now reads the file instead — that is the fix — and this mirror is
    // here so the row, which is the only config that survives a fresh SteamCMD install, does
    // not quietly become a wrong recovery copy. Nothing reads the mirror; it only has to be
    // true.
    const map: Record<string, string> = {
      ServerName: "serverName",
      ServerPassword: "password",
      ServerMaxPlayerCount: "maxPlayers",
      SandboxCode: "sandboxCode",
    };
    const dbData: Record<string, string | number> = {};
    for (const [xmlKey, col] of Object.entries(map)) {
      // `applied`, not merely "present in the request": a key the file does not have is
      // reported as `ignored` and must not be mirrored, or the recovery row would record a
      // value that was never written anywhere.
      if (applied.includes(xmlKey)) {
        dbData[col] =
          col === "maxPlayers"
            ? parseInt(updates[xmlKey], 10) || 8
            : col === "sandboxCode"
            ? normalizeSandboxCode(updates[xmlKey])
            : updates[xmlKey];
      }
    }
    if (Object.keys(dbData).length > 0) {
      try {
        await db.sevenDaysConfig.upsert({ where: { id: "main" }, update: dbData, create: { id: "main", ...dbData } });
      } catch {}
    }

    try {
      await db.activity.create({
        data: {
          userId: session.user.id,
          action: "edit_file",
          details: JSON.stringify({ game: "7dtd", file: "sdtdserver.xml", count: applied.length }),
        },
      });
    } catch {}

    return NextResponse.json({ success: true, applied, ignored, locked });

  }, { request, file: () => gameDataPath(CONFIG_DIR, "sdtdserver.xml") });
}
