import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const modpacks = await db.modpack.findMany({
    include: { mods: true },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(modpacks);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name, description } = await request.json();

  if (!name || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const modpack = await db.modpack.create({
    data: {
      name: name.trim(),
      description: description?.trim() || "",
      createdBy: session.user.id,
    },
    include: { mods: true },
  });

  return NextResponse.json(modpack);
}
