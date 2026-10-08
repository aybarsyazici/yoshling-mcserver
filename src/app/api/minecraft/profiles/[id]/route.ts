import { NextResponse } from "next/server";
import { withMinecraftProfileOperationMarker } from "@/lib/minecraft-profile-operation-marker";
import { assertMinecraftProfileOverviewDeletable, deleteMinecraftProfileOverview } from "@/lib/minecraft-profile-overview-queue";
import { rename, rm, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getMinecraftProfileRuntimeStatus } from "@/lib/minecraft-profile-activation";
import { getMinecraftProfile, updateProfileRecord, deleteProfileRecord, MinecraftProfileError } from "@/lib/minecraft-profile-store";
import { minecraftCoverDirectory, minecraftProfilePath, minecraftProfilesRoot } from "@/lib/minecraft-profile-path";
import { minecraftProfileCapabilities, minecraftProfileDTO, minecraftProfileGate, minecraftProfileResponse, profileIdentifier, profileJSON, profileRevision, rejectProfileKeys, requireInactiveMinecraftProfile } from "@/lib/minecraft-profile-http";
import { withGameFileWrite } from "@/lib/operation-response";
import { runOperation, refuseIfPreempted, assertFileWriteActive } from "@/lib/operations";
import { resolveSafeFilePath } from "@/lib/file-guard";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const gate = await minecraftProfileGate();
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const profile = await getMinecraftProfile(id);
    if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    return NextResponse.json({ profile: await minecraftProfileDTO(profile), runtime: await getMinecraftProfileRuntimeStatus(), capabilities: minecraftProfileCapabilities(gate.session.user.role) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function PATCH(request: Request, context: Context) {
  const gate = await minecraftProfileGate(true);
  if (!gate.ok) return gate.response;
  return withGameFileWrite("minecraft", () => minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const body = await profileJSON(request);
    rejectProfileKeys(body, ["name", "description", "expectedRevision"]);
    if ((body.name !== undefined && typeof body.name !== "string") || (body.description !== undefined && typeof body.description !== "string") || (body.name === undefined && body.description === undefined)) throw new MinecraftProfileError("A display name or description update is required", 400, "invalid_profile");
    const profile = await updateProfileRecord(id, profileRevision(body.expectedRevision), { ...(body.name === undefined ? {} : { name: body.name as string }), ...(body.description === undefined ? {} : { description: body.description as string }) });
    return NextResponse.json({ profile: await minecraftProfileDTO(profile) });
  }));
}

export async function DELETE(request: Request, context: Context) {
  const gate = await minecraftProfileGate(true);
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const body = await profileJSON(request);
    rejectProfileKeys(body, ["expectedRevision", "confirm"]);
    const expected = profileRevision(body.expectedRevision);
    if (body.confirm !== true) throw new MinecraftProfileError("Confirm permanent deletion of this profile", 400, "confirmation_required");
    return runOperation({ kind: "profile.delete", game: "minecraft", resources: ["files:minecraft"], title: "Deleting a Minecraft profile", startedBy: { name: gate.session.user.name || "World moderator" } }, async op => {
      try {
        return await withMinecraftProfileOperationMarker(op, "delete", async () => {
          const profile = await getMinecraftProfile(id);
          if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
          if (profile.revision !== expected) throw new MinecraftProfileError("This profile changed; reload before deleting", 409, "profile_stale");
          requireInactiveMinecraftProfile(await getMinecraftProfileRuntimeStatus(), id);
          await assertMinecraftProfileOverviewDeletable(id);
          const source = await minecraftProfilePath(id, "", { allowMissing: false });
          const covers = await minecraftCoverDirectory(id, { allowMissing: false }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
          const parent = await minecraftProfilesRoot();
          const quarantine = await resolveSafeFilePath(parent, `.delete-${id}-${randomUUID()}`, { allowMissing: true, allowRoot: false });
          if (!quarantine) throw new Error("Profile deletion staging could not be admitted");
          refuseIfPreempted(op, "profile deletion");
          op.step("Removing the inactive profile from available profiles");
          await rename(source, quarantine);
          try {
            refuseIfPreempted(op, "profile deletion");
            assertFileWriteActive();
            await deleteProfileRecord(id, expected);
          } catch (error) {
            await rename(quarantine, source);
            throw error;
          }
          op.settle("Profile metadata and inventory removal read back");
          op.fact({ label: "Metadata", value: "Profile metadata and recorded inventory removed and verified" });
          op.step("Removing the profile's saved files");
          refuseIfPreempted(op, "profile deletion");
          await rm(quarantine, { recursive: true, force: true });
          if (covers) { refuseIfPreempted(op, "profile cover deletion"); await rm(covers, { recursive: true, force: true }); }
          await deleteMinecraftProfileOverview(id);
          const remains = await lstat(quarantine).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
          const coversRemain = covers ? await lstat(covers).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }) : false;
          if (remains || coversRemain || await getMinecraftProfile(id)) throw new Error("Profile deletion could not be verified");
          op.settle("Profile directory removal read back");
          op.fact({ label: "Profile", value: profile.name });
          op.fact({ label: "Deletion", value: "Metadata, recorded inventory, covers and saved profile files removed and verified" });
          return { value: NextResponse.json({ deleted: true, id, operationId: op.id }), facts: [] };
        });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error("Profile deletion failed"), { operationId: op.id, profileId: id });
      }
    });
  });
}
