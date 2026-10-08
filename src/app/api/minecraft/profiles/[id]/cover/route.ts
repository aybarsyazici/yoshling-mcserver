import { NextResponse } from "next/server";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getMinecraftProfile, updateProfileRecord, MinecraftProfileError } from "@/lib/minecraft-profile-store";
import { minecraftCoverPath, minecraftProfileCoverRoot } from "@/lib/minecraft-profile-path";
import { boundedProfileBody, minecraftProfileDTO, minecraftProfileGate, minecraftProfileResponse, profileIdentifier, profileJSON, profileRevision, rejectProfileKeys } from "@/lib/minecraft-profile-http";
import { withGameFileWrite } from "@/lib/operation-response";
import { assertFileWriteActive } from "@/lib/operations";

type Context = { params: Promise<{ id: string }> };
const MAX_IMAGE = 5 * 1024 * 1024;

async function removeCover(file: string): Promise<void> {
  assertFileWriteActive();
  await rm(file, { force: true });
  const remains = await lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (remains) throw new Error("Cover removal could not be verified");
}

export async function GET(_request: Request, context: Context) {
  const gate = await minecraftProfileGate();
  if (!gate.ok) return gate.response;
  return minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const profile = await getMinecraftProfile(id);
    if (!profile?.coverKey) throw new MinecraftProfileError("Profile cover not found", 404, "cover_not_found");
    const bytes = await readFile(await minecraftCoverPath(id, profile.coverKey, { allowMissing: false }));
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
  });
}

export async function POST(request: Request, context: Context) {
  const gate = await minecraftProfileGate(true);
  if (!gate.ok) return gate.response;
  return withGameFileWrite("minecraft", () => minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const profile = await getMinecraftProfile(id);
    if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    const oldCover = profile.coverKey ? await minecraftCoverPath(id, profile.coverKey, { followFinalSymlink: false }) : null;
    let form: FormData;
    try {
      const bytes = await boundedProfileBody(request, MAX_IMAGE + 64 * 1024);
      form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData();
    } catch (error) { if (error instanceof MinecraftProfileError) throw error; throw new MinecraftProfileError("Expected a cover upload", 400, "invalid_cover"); }
    if ([...form.keys()].some(key => !["cover", "expectedRevision"].includes(key)) || form.getAll("cover").length !== 1 || form.getAll("expectedRevision").length !== 1) throw new MinecraftProfileError("Invalid cover upload fields", 400, "invalid_cover");
    const revisionText = form.get("expectedRevision");
    if (typeof revisionText !== "string" || !/^[1-9]\d*$/.test(revisionText)) throw new MinecraftProfileError("The current profile revision is required", 400, "invalid_revision");
    const revision = profileRevision(Number(revisionText));
    if (revision !== profile.revision) throw new MinecraftProfileError("This profile changed; reload before uploading", 409, "profile_stale");
    const file = form.get("cover");
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_IMAGE) throw new MinecraftProfileError("Choose an image smaller than 5 MiB", 413, "invalid_cover");
    const input = Buffer.from(await file.arrayBuffer());
    const magic = input.subarray(0, 12);
    if (!(magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || (magic[0] === 255 && magic[1] === 216 && magic[2] === 255) || (magic.subarray(0, 4).toString() === "RIFF" && magic.subarray(8, 12).toString() === "WEBP"))) throw new MinecraftProfileError("Choose a PNG, JPEG or WebP image", 400, "invalid_cover");
    let output: Buffer;
    try {
      const image = sharp(input, { limitInputPixels: 16_000_000, animated: false });
      const metadata = await image.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format || "") || !metadata.width || !metadata.height) throw new Error("Invalid image");
      output = await image.rotate().resize({ width: 1600, height: 1000, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    } catch { throw new MinecraftProfileError("The image could not be decoded safely", 400, "invalid_cover"); }
    assertFileWriteActive();
    await mkdir(minecraftProfileCoverRoot(), { recursive: true, mode: 0o700 });
    const key = `${randomUUID()}.png`;
    const target = await minecraftCoverPath(id, key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    assertFileWriteActive();
    await writeFile(target, output, { mode: 0o600, flag: "wx" });
    let published = false;
    try {
      if (!(await readFile(target)).equals(output)) throw new Error("Cover write readback failed");
      assertFileWriteActive();
      const stored = await updateProfileRecord(id, revision, { coverKey: key, coverMime: "image/png" });
      published = true;
      if (oldCover) await removeCover(oldCover);
      return NextResponse.json({ profile: await minecraftProfileDTO(stored) });
    } catch (error) { if (!published) await rm(target, { force: true }); throw error; }
  }));
}

export async function DELETE(request: Request, context: Context) {
  const gate = await minecraftProfileGate(true);
  if (!gate.ok) return gate.response;
  return withGameFileWrite("minecraft", () => minecraftProfileResponse(async () => {
    const id = profileIdentifier((await context.params).id);
    const body = await profileJSON(request);
    rejectProfileKeys(body, ["expectedRevision"]);
    const profile = await getMinecraftProfile(id);
    if (!profile) throw new MinecraftProfileError("Profile not found", 404, "profile_not_found");
    const oldCover = profile.coverKey ? await minecraftCoverPath(id, profile.coverKey, { followFinalSymlink: false }) : null;
    const stored = await updateProfileRecord(id, profileRevision(body.expectedRevision), { coverKey: null, coverMime: null });
    if (oldCover) await removeCover(oldCover);
    return NextResponse.json({ profile: await minecraftProfileDTO(stored) });
  }));
}
