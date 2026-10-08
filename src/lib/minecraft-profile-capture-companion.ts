import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSafeFilePath } from "./file-guard";
import { CaptureError } from "./minecraft-profile-capture-store";
import type { MinecraftCaptureCompanionManifest } from "./minecraft-capture-types";
export async function captureCompanion(): Promise<MinecraftCaptureCompanionManifest> {
  const root = process.env.NODE_ENV !== "production" && process.env.MC_CAPTURE_COMPANION_DIR ? process.env.MC_CAPTURE_COMPANION_DIR : path.join(process.cwd(), "public", "companions");
  const fileName = "yoshling-screenshots-0.1.0+mc26.1.2.jar";
  async function regular(name: string): Promise<string> {
    const file = await resolveSafeFilePath(root, name, { allowRoot: false, followFinalSymlink: false });
    if (!file) throw new CaptureError("The client companion artifact is not contained", 503, "capture_companion_unverified");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new CaptureError("The client companion artifact is not a regular file", 503, "capture_companion_unverified");
    return file;
  }
  const manifestPath = await regular("manifest.json");
  if ((await lstat(manifestPath)).size > 16_384) throw new CaptureError("The client companion manifest is oversized", 503, "capture_companion_unverified");
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!value || typeof value !== "object") throw new CaptureError("Client companion metadata is unverified", 503, "capture_companion_unverified");
  const meta = value as MinecraftCaptureCompanionManifest;
  if (meta.version !== "0.1.0" || meta.loader !== "fabric" || !Array.isArray(meta.minecraftVersions) || meta.minecraftVersions.length !== 1 || meta.minecraftVersions[0] !== "26.1.2" || meta.fileName !== fileName || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1 || meta.bytes > 32 * 1024 * 1024) throw new CaptureError("Client companion metadata is unverified", 503, "capture_companion_unverified");
  const file = await regular(fileName), info = await lstat(file);
  if (info.size !== meta.bytes) throw new CaptureError("The client companion byte size does not match its manifest", 503, "capture_companion_unverified");
  const hash = createHash("sha256"), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes = 0;
  try { for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false })) { bytes += chunk.length; hash.update(chunk); } } finally { await handle.close(); }
  if (bytes !== meta.bytes || hash.digest("hex") !== meta.sha256) throw new CaptureError("The client companion checksum does not match its manifest", 503, "capture_companion_unverified");
  return { version: "0.1.0", minecraftVersions: ["26.1.2"], loader: "fabric", fileName, downloadUrl: `/companions/${encodeURIComponent(fileName)}`, sha256: meta.sha256, bytes: meta.bytes };
}
