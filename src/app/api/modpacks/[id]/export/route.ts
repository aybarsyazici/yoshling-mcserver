import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { db } from "@/lib/db";
import { getProjectVersions, getVersion } from "@/lib/modrinth";
import type { ModpackMod } from "@/generated/prisma/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  const { id } = await params;
  const modpack = await db.modpack.findUnique({ where: { id }, include: { mods: true } });
  if (!modpack) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Export describes the saved set for a launcher. A legacy absent target is unknown;
  // the currently running server cannot supply that missing historical information.
  const mcVersion = modpack.targetMcVersion || null;
  const loader = modpack.targetLoader?.toLowerCase() || null;
  const savedMods = modpack.mods as ModpackMod[];
  const mods = await Promise.all(savedMods.map(async mod => {
    const empty = { name: mod.name, slug: mod.slug, modrinthId: mod.modrinthId,
      fileName: null as string | null, downloadUrl: null as string | null,
      version: null as string | null, versionId: mod.versionId, error: null as string | null };
    if (mod.downloadUrl) return { ...empty, fileName: `${mod.slug}.jar`, downloadUrl: mod.downloadUrl };
    if (!mod.modrinthId) return { ...empty, error: "No download source is recorded" };
    if (!mcVersion || !loader) return { ...empty, error: "The saved pack target is not recorded" };
    try {
      const version = mod.versionId
        ? await getVersion(mod.versionId)
        : (await getProjectVersions(mod.modrinthId, { loaders: [loader], game_versions: [mcVersion] }))[0];
      if (!version || version.project_id !== mod.modrinthId ||
          (mod.versionId && version.id !== mod.versionId) ||
          !version.game_versions.includes(mcVersion) ||
          !version.loaders.some(value => value.toLowerCase() === loader)) {
        return { ...empty, error: mod.versionId ? "The pinned build does not match the saved target/project" : "No compatible build is available for the saved target" };
      }
      const file = version.files.find(value => value.primary) || version.files[0];
      if (!file?.url || !file.filename) return { ...empty, error: "The selected build has no downloadable file" };
      return { ...empty, fileName: file.filename, downloadUrl: file.url,
        version: version.version_number, versionId: version.id };
    } catch {
      return { ...empty, error: "The recorded project/build could not be resolved" };
    }
  }));
  const unresolved = mods.flatMap(mod => mod.error ? [{ name: mod.name, reason: mod.error }] : []);
  if (!mcVersion || !loader) unresolved.unshift({ name: modpack.name, reason: "The saved pack target is not recorded" });
  return NextResponse.json({
    modpack: { name: modpack.name, description: modpack.description, mcVersion, loader },
    mods, complete: unresolved.length === 0, unresolved,
  });
}
