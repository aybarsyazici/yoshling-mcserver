import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { getProject, getProjectVersions } from "@/lib/modrinth";
import { minecraftProfilePackBuilds } from "@/lib/minecraft-profile-sources";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  const ref = new URL(request.url).searchParams.get("ref");
  if (!ref || !/^[A-Za-z0-9_-]{1,128}$/.test(ref)) return NextResponse.json({ error: "A valid published pack is required" }, { status: 400 });
  try {
    const project = await getProject(ref);
    const id = project.id ?? project.project_id;
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || project.project_type !== "modpack" || typeof project.title !== "string" || !project.title) return NextResponse.json({ error: "Choose a published Modrinth modpack" }, { status: 400 });
    const versions = minecraftProfilePackBuilds(id, await getProjectVersions(id));
    return NextResponse.json({ project: { id, title: project.title }, versions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "The published pack builds could not be read. Retry before creating a profile." }, { status: 502 }); }
}
