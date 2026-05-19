import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mods = await db.installedMod.findMany({
    orderBy: { installedAt: "desc" },
  });

  return NextResponse.json(mods);
}
