import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import {
  INFRA_KEYS,
  iniPath,
  parseIni,
  serverName,
  setIniValues,
  splitList,
  bareModId,
} from "@/lib/zomboid";

/**
 * Bring an existing Project Zomboid server config in wholesale.
 *
 * The uploaded .ini replaces ours — settings *and* both mod lists, which is
 * usually the point: it's how you move a server you already had. The one thing
 * that does NOT come across is INFRA_KEYS (RCON + the published ports), which
 * stay at this box's values so control and connectivity survive the import.
 *
 * POST { content }              → a preview of what would change
 * POST { content, apply: true } → writes it, after backing up the current file
 */

/** A file this small that parses to this many PZ keys is an .ini, not a mistake. */
const MIN_KEYS = 20;
const MAX_BYTES = 512 * 1024;
const MARKER_KEYS = ["PVP", "MaxPlayers", "Public", "PublicName", "Mods", "DefaultPort"];

export async function POST(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const content = typeof body?.content === "string" ? body.content : "";
  const apply = body?.apply === true;

  if (!content.trim()) {
    return NextResponse.json({ error: "Pick a .ini file to import" }, { status: 400 });
  }
  if (content.length > MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is too big to be a server .ini (max 512KB)" },
      { status: 400 }
    );
  }

  const incoming = parseIni(content);
  const incomingByName = new Map(incoming.map((p) => [p.name, p.value]));
  if (incoming.length < MIN_KEYS || !MARKER_KEYS.some((k) => incomingByName.has(k))) {
    return NextResponse.json(
      {
        error:
          "That doesn't look like a Project Zomboid server .ini — it should have lines like PVP=true and MaxPlayers=16.",
      },
      { status: 400 }
    );
  }

  const file = await iniPath();
  const name = await serverName();

  let currentText = "";
  try {
    currentText = await readFile(file, "utf-8");
  } catch {
    // No config yet (server never started). Importing is then how it gets one.
  }
  const current = parseIni(currentText);
  const currentByName = new Map(current.map((p) => [p.name, p.value]));

  // Infra keys keep this box's values. Where we have none yet (fresh install),
  // whatever the upload says is as good a starting point as any.
  const preserved: { name: string; value: string }[] = [];
  for (const key of INFRA_KEYS) {
    const mine = currentByName.get(key);
    if (mine !== undefined) preserved.push({ name: key, value: mine });
  }
  const preservedByName = new Map(preserved.map((p) => [p.name, p.value]));

  /** What the file will actually say once the infra keys are put back. */
  const effective = (key: string): string | undefined =>
    preservedByName.get(key) ?? incomingByName.get(key);

  const changed: { name: string; from: string; to: string }[] = [];
  const added: string[] = [];
  for (const [key, incomingValue] of incomingByName) {
    const to = effective(key)!;
    if (!currentByName.has(key)) {
      added.push(key);
      continue;
    }
    const from = currentByName.get(key)!;
    if (from !== to) changed.push({ name: key, from, to });
  }
  // Keys we have that the upload doesn't: replacing the file drops them, and the
  // game fills them back in with its defaults on the next boot.
  const dropped = current.map((p) => p.name).filter((n) => !incomingByName.has(n));

  const mods = {
    workshopIds: splitList(incomingByName.get("WorkshopItems") ?? ""),
    modIds: splitList(incomingByName.get("Mods") ?? "").map(bareModId),
  };

  if (!apply) {
    return NextResponse.json({
      preview: true,
      serverName: name,
      hadConfig: currentText !== "",
      totalKeys: incoming.length,
      changed,
      added,
      dropped,
      preserved,
      mods,
    });
  }

  // Put this box's infra values back into the uploaded text, so the file keeps
  // the uploader's comments and layout but our control channel and ports.
  const { text } = setIniValues(
    content,
    Object.fromEntries(preserved.map((p) => [p.name, p.value]))
  );

  try {
    await mkdir(path.dirname(file), { recursive: true });
    if (currentText) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      await writeFile(`${file}.bak-${stamp}`, currentText, "utf-8");
    }
    await writeFile(file, text, "utf-8");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Drop cached Workshop titles for items no longer listed; the mods page
  // re-fetches whatever it doesn't recognise.
  try {
    const keep = mods.workshopIds;
    await db.zomboidMod.deleteMany({ where: { id: { notIn: keep.length > 0 ? keep : [""] } } });
  } catch {}

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "import_config",
        details: JSON.stringify({
          game: "zomboid",
          file: `${name}.ini`,
          changed: changed.length,
          mods: mods.workshopIds.length,
        }),
      },
    });
  } catch {}

  return NextResponse.json({
    success: true,
    changed: changed.length,
    added: added.length,
    dropped: dropped.length,
    mods: mods.workshopIds.length,
  });
}
