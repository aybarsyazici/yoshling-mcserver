import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { installedModIds, readModState, splitList, writeModState } from "@/lib/zomboid";

/**
 * Project Zomboid mods live in the server .ini, in two lists that have to agree:
 *
 *   WorkshopItems=2169435993;2200148440    ← what the server downloads from Steam
 *   Mods=\AuthenticZ;\Brita                ← what it then loads (folder names)
 *
 * Getting one without the other is the classic "my mods aren't working" trap, so
 * this route always writes both. Steam's public API gives us the item's title
 * and, usually, its mod id (most mod pages spell out "Mod ID: X"); once the
 * server has downloaded an item we read the real mod ids off disk instead.
 */

// Two Steam endpoints, because they return different things:
//  - the keyless one has no dependency data at all
//  - the keyed one adds `children`, i.e. the Workshop's own "Required items"
// So required items can only be resolved when STEAM_API_KEY is set.
const STEAM_DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const STEAM_KEYED_DETAILS_URL =
  "https://api.steampowered.com/IPublishedFileService/GetDetails/v1/";
const PZ_STEAM_APP_ID = 108600;

interface WorkshopDetail {
  id: string;
  title: string;
  previewUrl: string | null;
  /** Mod ids advertised in the item's description. */
  describedModIds: string[];
  /** Workshop ids this item lists as required. Empty without an API key. */
  requires: string[];
  /** True when the item is tagged as a map — those also need a `Map=` entry. */
  isMap: boolean;
  ok: boolean;
  wrongGame: boolean;
}

/** Accepts a Workshop URL or a bare id. */
function parseWorkshopId(input: string): string | null {
  const trimmed = String(input || "").trim();
  const fromUrl = trimmed.match(/[?&]id=(\d+)/);
  if (fromUrl) return fromUrl[1];
  const bare = trimmed.match(/^(\d{4,})$/);
  return bare ? bare[1] : null;
}

/** Mod ids from a Workshop description ("Mod ID: Foo"), minus Steam's BBCode. */
function modIdsFromDescription(description: string): string[] {
  const plain = String(description || "").replace(/\[[^\]]{0,40}\]/g, " ");
  const found = new Set<string>();
  for (const m of plain.matchAll(/Mod\s*ID\s*:\s*([A-Za-z0-9_.\-]+)/gi)) {
    found.add(m[1]);
  }
  return Array.from(found);
}

function toDetail(d: Record<string, unknown>): WorkshopDetail {
  const appId = Number(d.consumer_app_id ?? d.consumer_appid ?? d.creator_app_id ?? 0);
  const tags = (Array.isArray(d.tags) ? d.tags : []).map((t) =>
    String((t as Record<string, unknown>)?.tag ?? "").toLowerCase()
  );
  const children = Array.isArray(d.children) ? d.children : [];
  return {
    id: String(d.publishedfileid),
    title: String(d.title ?? ""),
    previewUrl: d.preview_url ? String(d.preview_url) : null,
    describedModIds: modIdsFromDescription(
      String(d.file_description ?? d.description ?? "")
    ),
    requires: children.map((c) => String((c as Record<string, unknown>).publishedfileid)),
    isMap: tags.includes("map"),
    ok: Number(d.result ?? 1) === 1,
    wrongGame: Number(d.result ?? 1) === 1 && appId !== 0 && appId !== PZ_STEAM_APP_ID,
  };
}

async function fetchWorkshopDetails(ids: string[]): Promise<Map<string, WorkshopDetail>> {
  const out = new Map<string, WorkshopDetail>();
  if (ids.length === 0) return out;

  const key = process.env.STEAM_API_KEY;

  // Preferred: the keyed endpoint, which also tells us the required items.
  if (key) {
    try {
      const q = new URLSearchParams({ key, includechildren: "true", includetags: "true" });
      ids.forEach((id, i) => q.set(`publishedfileids[${i}]`, id));
      const res = await fetch(`${STEAM_KEYED_DETAILS_URL}?${q}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        for (const d of (await res.json())?.response?.publishedfiledetails ?? []) {
          out.set(String(d.publishedfileid), toDetail(d));
        }
        if (out.size > 0) return out;
      }
    } catch {
      // fall through to the keyless endpoint
    }
  }

  // Fallback: no key, or the keyed call failed. Same data minus dependencies.
  try {
    const body = new URLSearchParams();
    body.set("itemcount", String(ids.length));
    ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
    const res = await fetch(STEAM_DETAILS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    for (const d of (await res.json())?.response?.publishedfiledetails ?? []) {
      out.set(String(d.publishedfileid), toDetail(d));
    }
  } catch {
    // Steam unreachable — callers fall back to whatever is cached / on disk.
  }
  return out;
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.filter(Boolean)));
}

/**
 * Swap one item's mod ids for another set, in place: the first old token marks
 * the spot, so a mod keeps its position in the load order.
 */
function spliceTokens(list: string[], remove: Set<string>, insert: string[]): string[] {
  const out: string[] = [];
  let inserted = false;
  for (const token of list) {
    if (remove.has(token)) {
      if (!inserted && insert.length > 0) {
        out.push(...insert);
        inserted = true;
      }
      continue;
    }
    out.push(token);
  }
  if (!inserted && insert.length > 0) out.push(...insert);
  return dedupe(out);
}

// ── GET: the installed list ─────────────────────────────────────────────────

export async function GET() {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  let state;
  try {
    state = await readModState();
  } catch {
    return NextResponse.json({
      mods: [],
      orphanModIds: [],
      warning:
        "The Project Zomboid config file isn't there yet — start the server once to generate it.",
    });
  }

  type CachedMod = { id: string; title: string; modIds: string; previewUrl: string | null };
  const cached: CachedMod[] = await db.zomboidMod
    .findMany({
      where: { id: { in: state.workshopIds } },
      select: { id: true, title: true, modIds: true, previewUrl: true },
    })
    .catch(() => []);
  const byId = new Map(cached.map((m) => [m.id, m]));

  // Only ask Steam about items we've never seen before; the cache covers the rest.
  const unknown = state.workshopIds.filter((id) => !byId.has(id));
  const fetched = await fetchWorkshopDetails(unknown);

  const enabled = new Set(state.modIds);
  const claimed = new Set<string>();

  const mods = await Promise.all(
    state.workshopIds.map(async (id) => {
      const row = byId.get(id);
      const detail = fetched.get(id);
      const onDisk = await installedModIds(id);
      // On-disk names are authoritative; fall back to the cache, then to what
      // the Workshop description advertised.
      const provides = dedupe(
        onDisk.length > 0 ? onDisk : splitList(row?.modIds ?? "").concat(detail?.describedModIds ?? [])
      );
      provides.forEach((m) => claimed.add(m));

      return {
        workshopId: id,
        title: row?.title || detail?.title || "",
        previewUrl: row?.previewUrl ?? detail?.previewUrl ?? null,
        provides,
        enabled: provides.filter((m) => enabled.has(m)),
        downloaded: onDisk.length > 0,
      };
    })
  );

  // Remember anything Steam just told us, so the next load is offline-friendly.
  for (const id of unknown) {
    const detail = fetched.get(id);
    if (!detail?.ok) continue;
    const provides = mods.find((m) => m.workshopId === id)?.provides ?? [];
    await db.zomboidMod
      .upsert({
        where: { id },
        update: { title: detail.title, previewUrl: detail.previewUrl, modIds: provides.join(";") },
        create: {
          id,
          title: detail.title,
          previewUrl: detail.previewUrl,
          modIds: provides.join(";"),
        },
      })
      .catch(() => {});
  }

  return NextResponse.json({
    mods,
    // Mod ids loaded from `Mods=` that no Workshop item accounts for — usually a
    // hand-edited entry or a mod dropped straight into the mods folder.
    orphanModIds: state.modIds.filter((m) => !claimed.has(m)),
  });
}

// ── POST: add a Workshop item ───────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const workshopId = parseWorkshopId(body?.workshopId ?? body?.url ?? "");
  if (!workshopId) {
    return NextResponse.json(
      { error: "Paste a Steam Workshop link or its numeric id" },
      { status: 400 }
    );
  }

  let state;
  try {
    state = await readModState();
  } catch {
    return NextResponse.json(
      { error: "Config file not found yet — start the server once first." },
      { status: 400 }
    );
  }
  if (state.workshopIds.includes(workshopId)) {
    return NextResponse.json({ error: "That mod is already installed" }, { status: 409 });
  }

  const detail = (await fetchWorkshopDetails([workshopId])).get(workshopId);
  if (detail && !detail.ok) {
    return NextResponse.json({ error: "Steam doesn't know that Workshop id" }, { status: 404 });
  }
  if (detail?.wrongGame) {
    return NextResponse.json(
      { error: "That Workshop item isn't for Project Zomboid" },
      { status: 400 }
    );
  }

  // Explicit mod ids win; then anything already on disk; then the description.
  const explicit = Array.isArray(body?.modIds) ? body.modIds.map(String) : [];
  const onDisk = await installedModIds(workshopId);
  const modIds = dedupe(
    explicit.length > 0 ? explicit : onDisk.length > 0 ? onDisk : detail?.describedModIds ?? []
  );

  // Required items, from the Workshop's own "Required items" list. A mod whose
  // dependency is missing usually fails quietly, so pull them in with it rather
  // than leaving the user to notice. One level deep, which is as deep as PZ
  // dependency chains realistically go.
  const missingDeps = (detail?.requires ?? []).filter(
    (id) => id !== workshopId && !state.workshopIds.includes(id)
  );
  const depDetails = await fetchWorkshopDetails(missingDeps);
  const addedDeps: { workshopId: string; title: string; modIds: string[] }[] = [];
  for (const depId of missingDeps) {
    const dep = depDetails.get(depId);
    if (dep && !dep.ok) continue;
    const depMods = dedupe(
      (await installedModIds(depId)).concat(dep?.describedModIds ?? [])
    );
    addedDeps.push({ workshopId: depId, title: dep?.title ?? depId, modIds: depMods });
  }

  await writeModState({
    // Dependencies go BEFORE the mod that needs them: PZ loads `Mods=` in order
    // and a library has to be loaded before whatever uses it.
    workshopIds: dedupe([...state.workshopIds, ...addedDeps.map((d) => d.workshopId), workshopId]),
    modIds: dedupe([...state.modIds, ...addedDeps.flatMap((d) => d.modIds), ...modIds]),
    prefix: state.prefix,
  });

  for (const dep of addedDeps) {
    await db.zomboidMod
      .upsert({
        where: { id: dep.workshopId },
        update: { title: dep.title, modIds: dep.modIds.join(";") },
        create: {
          id: dep.workshopId,
          title: dep.title,
          modIds: dep.modIds.join(";"),
          addedBy: session.user.id,
        },
      })
      .catch(() => {});
  }

  await db.zomboidMod
    .upsert({
      where: { id: workshopId },
      update: {
        title: detail?.title ?? "",
        previewUrl: detail?.previewUrl ?? null,
        modIds: modIds.join(";"),
      },
      create: {
        id: workshopId,
        title: detail?.title ?? "",
        previewUrl: detail?.previewUrl ?? null,
        modIds: modIds.join(";"),
        addedBy: session.user.id,
      },
    })
    .catch(() => {});

  await db.activity
    .create({
      data: {
        userId: session.user.id,
        action: "install_mod",
        details: JSON.stringify({
          game: "zomboid",
          modName: detail?.title || workshopId,
          workshopId,
        }),
      },
    })
    .catch(() => {});

  const notes: string[] = [];
  if (modIds.length === 0) {
    // No mod id means the server can download the item but won't load it.
    notes.push(
      "Couldn't work out this mod's id. Start the server once to download it — the id will then be read off disk — or type it in on the mod's card."
    );
  }
  if (detail?.isMap) {
    // A map mod needs a third list the mod manager doesn't own.
    notes.push(
      "This is a map mod, so it also needs its map name added to `Map=` in the server settings before the new areas appear."
    );
  }

  return NextResponse.json({
    success: true,
    workshopId,
    title: detail?.title ?? "",
    previewUrl: detail?.previewUrl ?? null,
    modIds,
    isMap: detail?.isMap ?? false,
    addedDependencies: addedDeps.map((d) => ({ workshopId: d.workshopId, title: d.title })),
    warning: notes.length > 0 ? notes.join(" ") : undefined,
  });
}

// ── PATCH: correct an item's mod ids ────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const workshopId = parseWorkshopId(body?.workshopId ?? "");
  const modIds = dedupe((Array.isArray(body?.modIds) ? body.modIds : []).map(String));
  if (!workshopId) {
    return NextResponse.json({ error: "workshopId required" }, { status: 400 });
  }

  let state;
  try {
    state = await readModState();
  } catch {
    return NextResponse.json({ error: "Config file not found yet" }, { status: 400 });
  }
  if (!state.workshopIds.includes(workshopId)) {
    return NextResponse.json({ error: "That mod isn't installed" }, { status: 404 });
  }

  const row = await db.zomboidMod.findUnique({ where: { id: workshopId } }).catch(() => null);
  const previous = new Set([...splitList(row?.modIds ?? ""), ...(await installedModIds(workshopId))]);

  await writeModState({
    workshopIds: state.workshopIds,
    modIds: spliceTokens(state.modIds, previous, modIds),
    prefix: state.prefix,
  });

  await db.zomboidMod
    .upsert({
      where: { id: workshopId },
      update: { modIds: modIds.join(";") },
      create: { id: workshopId, modIds: modIds.join(";"), addedBy: session.user.id },
    })
    .catch(() => {});

  return NextResponse.json({ success: true, modIds });
}

// ── DELETE: remove a Workshop item ──────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "mods.remove")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const workshopId = parseWorkshopId(new URL(request.url).searchParams.get("workshopId") ?? "");
  if (!workshopId) return NextResponse.json({ error: "workshopId required" }, { status: 400 });

  let state;
  try {
    state = await readModState();
  } catch {
    return NextResponse.json({ error: "Config file not found yet" }, { status: 400 });
  }

  const row = await db.zomboidMod.findUnique({ where: { id: workshopId } }).catch(() => null);
  const owned = new Set([...splitList(row?.modIds ?? ""), ...(await installedModIds(workshopId))]);

  await writeModState({
    workshopIds: state.workshopIds.filter((id) => id !== workshopId),
    modIds: state.modIds.filter((m) => !owned.has(m)),
    prefix: state.prefix,
  });

  await db.zomboidMod.delete({ where: { id: workshopId } }).catch(() => {});
  await db.activity
    .create({
      data: {
        userId: session.user.id,
        action: "remove_mod",
        details: JSON.stringify({
          game: "zomboid",
          modName: row?.title || workshopId,
          workshopId,
        }),
      },
    })
    .catch(() => {});

  return NextResponse.json({ success: true });
}
