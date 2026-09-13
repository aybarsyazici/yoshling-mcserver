import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
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
  const conflicts = findConflicts(maps);

  let order: string[] = [];
  let configMissing = false;
  try {
    order = await readMapOrder();
  } catch {
    configMissing = true;
  }

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
      cellCount: m.cells.length,
      /** Position in `Map=`; -1 means the server won't load it at all. */
      order: order.indexOf(m.name),
    })),
    order,
    conflicts,
    /** Installed but absent from `Map=` — these do nothing in game. */
    unlisted: maps.map((m) => m.name).filter((n) => !order.includes(n)),
    /** In `Map=` but not on disk and not a stock map — probably a typo. */
    missing: order.filter((n) => !installed.has(n) && !STOCK_MAPS.includes(n)),
    stock: order.filter((n) => STOCK_MAPS.includes(n)),
    configMissing,
  });
}

/** Reorder `Map=`. The first entry wins where two maps claim the same cell. */
export async function PUT(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
