import { NextResponse } from "next/server";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { getMinecraftProfileRuntimeStatus } from "@/lib/minecraft-profile-activation";
import { getMinecraftProfile, MinecraftProfileError } from "@/lib/minecraft-profile-store";
import { minecraftProfileServerPath } from "@/lib/minecraft-profile-path";
import { minecraftProfileGate, minecraftProfileResponse, profileIdentifier, profileJSON, rejectProfileKeys, requireInactiveMinecraftProfile } from "@/lib/minecraft-profile-http";
import { MINECRAFT_PROFILE_CREATION_KEYS, MINECRAFT_PROFILE_WORLD_KEYS, readMinecraftProfileWorldSettings, setMinecraftProfileWorldSettings, validateMinecraftProfileWorldSettings } from "@/lib/minecraft-profile-world-settings";
import { readFileSnapshot, recordFileRevision, assertFileRevision } from "@/lib/file-revision";
import { revisionRead, withGameFileWrite } from "@/lib/operation-response";
import { assertFileWriteActive } from "@/lib/operations";
import { hasPermission } from "@/lib/permissions";

type Context = { params: Promise<{ id: string }> };

async function generated(id: string): Promise<boolean> {
  for (const file of ["world/level.dat", "world/level.dat_old"]) {
    try {
      const entry = await lstat(await minecraftProfileServerPath(id, file, { allowMissing: false }));
      if (!entry.isFile()) throw new Error("World generation evidence is not a regular save file");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}

export async function GET(_request: Request, context: Context) {
  const gate = await minecraftProfileGate();
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const profile = await getMinecraftProfile(id);
    if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    const file = () => minecraftProfileServerPath(id, "server.properties", { allowRoot: false, allowMissing: false });
    return revisionRead(file, async () => {
      const properties = readMinecraftProfileWorldSettings(await readFileSnapshot(await file(), "utf-8"));
      const worldGenerated = await generated(id);
      const runtime = await getMinecraftProfileRuntimeStatus();
      const editable = hasPermission(gate.session.user.role, "settings.edit") && profile.status === "ready" && runtime.verified && runtime.state !== "unknown" && runtime.selectedProfileId !== id && runtime.appliedProfileId !== id;
      return NextResponse.json({ profileId: id, properties,
        editableKeys: MINECRAFT_PROFILE_WORLD_KEYS.filter(key => !worldGenerated || !(MINECRAFT_PROFILE_CREATION_KEYS as readonly string[]).includes(key)),
        creationOnlyKeys: [...MINECRAFT_PROFILE_CREATION_KEYS], lockedKeys: ["online-mode", "server-port", "server-ip", "level-name", "enable-rcon", "rcon.password", "rcon.port"],
        worldGenerated, editable }, { headers: { "Cache-Control": "no-store" } });
    });
  });
}

export async function PUT(request: Request, context: Context) {
  const gate = await minecraftProfileGate(true);
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    if (!request.headers.get("X-Expected-File-Revision") && !request.headers.get("If-Match")) throw new MinecraftProfileError("Read the current world settings before saving", 428, "profile_revision_required");
    return withGameFileWrite("minecraft", () => minecraftProfileResponse(async () => {
      const profile = await getMinecraftProfile(id);
      if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
      if (profile.status !== "ready") throw new MinecraftProfileError("Prepare this profile before editing its settings");
      requireInactiveMinecraftProfile(await getMinecraftProfileRuntimeStatus(), id);
      const body = await profileJSON(request);
      rejectProfileKeys(body, ["updates"]);
      const updates = validateMinecraftProfileWorldSettings(body.updates);
      if (Object.keys(updates).length === 0) throw new MinecraftProfileError("No settings were provided", 400, "invalid_settings");
      if (await generated(id) && MINECRAFT_PROFILE_CREATION_KEYS.some(key => Object.hasOwn(updates, key))) throw new MinecraftProfileError("Creation-only settings cannot change an existing world", 409, "world_already_generated");
      const file = await minecraftProfileServerPath(id, "server.properties", { allowRoot: false, allowMissing: false });
      const result = setMinecraftProfileWorldSettings(await readFileSnapshot(file, "utf-8"), updates);
      await assertFileRevision(file);
      assertFileWriteActive();
      await writeFile(file, result.text, "utf-8");
      recordFileRevision(file, result.text);
      const stored = await readFile(file, "utf-8");
      if (stored !== result.text) throw new Error("Profile world-settings write could not be read back");
      const properties = readMinecraftProfileWorldSettings(stored);
      if (result.applied.some(key => properties[key] !== updates[key])) throw new Error("Profile world-settings canonical readback did not match");
      return NextResponse.json({ profileId: id, applied: result.applied, ignored: [], properties });
    }), { request, file: () => minecraftProfileServerPath(id, "server.properties", { allowRoot: false, allowMissing: false }) });
  });
}
