import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { modrinthId, slug, name, versionId } = await request.json();

  if (!modrinthId || !slug || !name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const existing = await db.modpackMod.findFirst({
    where: { modpackId: id, modrinthId },
  });

  if (existing) {
    return NextResponse.json({ error: "Mod already in modpack" }, { status: 409 });
  }

  const mod = await db.modpackMod.create({
    data: {
      modpackId: id,
      modrinthId,
      slug,
      name,
      versionId: versionId || null,
    },
  });

  await db.modpack.update({
    where: { id },
    data: { updatedAt: new Date() },
  });

  return NextResponse.json(mod);
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const modId = searchParams.get("modId");

  if (!modId) {
    return NextResponse.json({ error: "modId required" }, { status: 400 });
  }

  await db.modpackMod.delete({ where: { id: modId } });

  return NextResponse.json({ success: true });
}
