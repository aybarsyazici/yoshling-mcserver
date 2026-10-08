import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MinecraftProfileError } from "./minecraft-profile-store";
import { minecraftCoverPath, minecraftProfileCoverRoot } from "./minecraft-profile-path";
import { assertFileWriteActive } from "./operations";

export const PROFILE_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_COVER_MAX_PIXELS = 16_000_000;
export async function normalizeMinecraftProfileCover(input: Buffer, pngOnly = false): Promise<Buffer> {
  if (!input.length || input.length > PROFILE_COVER_MAX_BYTES) throw new MinecraftProfileError("Choose an image smaller than 5 MiB", 413, "invalid_cover");
  const magic = input.subarray(0, 12), png = magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!(png || (!pngOnly && ((magic[0] === 255 && magic[1] === 216 && magic[2] === 255) || (magic.subarray(0, 4).toString() === "RIFF" && magic.subarray(8, 12).toString() === "WEBP"))))) throw new MinecraftProfileError(pngOnly ? "The capture must be a PNG image" : "Choose a PNG, JPEG or WebP image", 400, "invalid_cover");
  try {
    const image = sharp(input, { limitInputPixels: PROFILE_COVER_MAX_PIXELS, animated: false });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > PROFILE_COVER_MAX_PIXELS || !["png", "jpeg", "webp"].includes(metadata.format || "")) throw new Error("Invalid image");
    return await image.rotate().resize({ width: 1600, height: 1000, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch { throw new MinecraftProfileError("The image could not be decoded safely", 400, "invalid_cover"); }
}
export async function writeMinecraftProfileCover(id: string, key: string, output: Buffer): Promise<string> {
  assertFileWriteActive(); await mkdir(minecraftProfileCoverRoot(), { recursive: true, mode: 0o700 });
  const target = await minecraftCoverPath(id, key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  assertFileWriteActive(); const file = await open(target, "wx", 0o600);
  try { await file.writeFile(output); await file.sync(); } finally { await file.close(); }
  if (!(await readFile(target)).equals(output)) throw new Error("Cover write readback failed");
  return target;
}
export async function removeMinecraftProfileCover(file: string): Promise<void> {
  assertFileWriteActive(); await rm(file, { force: true });
  const remains = await lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (remains) throw new Error("Cover removal could not be verified");
}
