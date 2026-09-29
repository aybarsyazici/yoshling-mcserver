import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import {
  STOCK_MAPS,
  findConflicts,
  readMapOrder,
  scanMaps,
  writeMapOrder,
} from "@/lib/zomboid-maps";

/**
 * Installed map mods, the `Map=` load order, and every cell they fight over.
 * See lib/zomboid-maps.ts for why the cells are trustworthy.
 */
export async function GET() {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  const maps = await scanMaps();

  let order: string[] = [];
  let configMissing = false;
  try {
    order = await readMapOrder();
  } catch {
    configMissing = true;
  }

  // The order has to be read *before* the conflicts, because a map that is not in
  // `Map=` claims no cells and so cannot be in a conflict. With no config yet there is
  // no order to judge against, so report every overlap rather than none.
  const conflicts = findConflicts(maps, configMissing ? undefined : order);

  const installed = new Set(maps.map((m) => m.name));
  type ModTitle = { id: string; title: string };
  const titles: ModTitle[] = await db.zomboidMod
    .findMany({ select: { id: true, title: true } })
    .catch(() => []);
  const titleById = new Map(titles.map((t) => [t.id, t.title]));

  return NextResponse.json({
    maps: maps.map((m) => ({
      name: m.name,
      workshopId: m.workshopId,
      modId: m.modId,
      title: titleById.get(m.workshopId) ?? "",
      mapTitle: m.title ?? "",
      /** `lots=` — the map this sits on top of. Set = an add-on. */
      parent: m.parent ?? "",
      cellCount: m.cells.length,
      /** Position in `Map=`; -1 means absent, which is normal for an add-on. */
      order: order.indexOf(m.name),
    })),
    // `Map=` as PZ left it, minus repeats — it writes duplicates of its own
    // accord (we saw `AZSpawn;AZSpawn;Muldraugh, KY`) and a repeat can't mean
    // anything, since the first occurrence already won.
    order: Array.from(new Set(order)),
    conflicts,
    /**
     * Only maps that actually have to be in `Map=` and aren't: parentless ones
     * with cells. An add-on (`lots=` set) loads with its mod and is stripped
     * from `Map=` by the server on every start, so it is NOT a problem.
     */
    unlisted: maps
      .filter((m) => !m.parent && m.cells.length > 0 && !order.includes(m.name))
      .map((m) => m.name),
    /** In `Map=` but not on disk and not a stock map — probably a typo. */
    missing: order.filter((n) => !installed.has(n) && !STOCK_MAPS.includes(n)),
    stock: order.filter((n) => STOCK_MAPS.includes(n)),
    configMissing,
  });
}

/**
 * Reorder `Map=`. The first entry wins where two maps claim the same cell.
 *
 * What is saved here now **survives a restart**, and until 2026-09-29 it did not:
 * the container's `entry.sh` (line 234) unconditionally `sed`s the whole `Map=` line
 * to `${map_list}Muldraugh, KY` about 3 s before the world loads, from whatever
 * `pz/search_folder.sh` wrote to `maps.txt`. So this route genuinely wrote the file,
 * the card said "restart to apply", and the restart was the thing that reverted it.
 * `search_folder.sh` now seeds itself from the `Map=` already on disk, which makes the
 * saved order the input to the regeneration instead of its casualty. **A change to
 * that script only takes effect after `docker compose build zomboid` and a recreate.**
 */
export async function PUT(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The same lane the other three writers of this exact file take (`/api/zomboid/config`,
  // `config/import` and `files`). This one was the only `yoshling.ini` writer without it:
  // a restore holds the lane for minutes and extracts the archive's own `Server/` over
  // the top, so a reorder saved through the middle of one is silently discarded — while
  // the card toasts "Map order saved".
  const laneBusy = fileLaneBusy("zomboid");
  if (laneBusy) return laneBusy;

  const body = await request.json();
  const order = (Array.isArray(body?.order) ? body.order : [])
    .map((n: unknown) => String(n).trim())
    .filter(Boolean);
  if (order.length === 0) {
    return NextResponse.json({ error: "Send the map order to save" }, { status: 400 });
  }

  try {
    await writeMapOrder(order);
  } catch {
    return NextResponse.json(
      { error: "Config file not found yet — start the server once first." },
      { status: 400 }
    );
  }

  await db.activity
    .create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({ game: "zomboid", file: "server.ini", key: "Map" }),
      },
    })
    .catch(() => {});

  return NextResponse.json({ success: true, order });
}
