import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { removeMod } from "@/lib/mod-manager";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "mods.remove")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Refuse while an operation holds this world's files — the other half of the check the
  // single-mod install now makes. *Checks*, not takes: `fileLaneBusy` reads the live registry
  // and registers nothing, so this defers to a running apply and does not reserve anything
  // against one starting.
  //
  // `mods.apply` runs `removeMod` over every installed jar while holding `files:minecraft`.
  // A Remove pressed during that window hits the same jar from two directions: `removeMod`
  // throws on the loser, the apply pushes it into `errors` as "could not be removed", and
  // the operator is shown a named failure for a mod that was in fact deleted — a reported
  // fault that did not happen, which is as costly to chase as a real one.
  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

  const { id } = await params;

  await removeMod(id, session.user.id);

  return NextResponse.json({ success: true });
}
