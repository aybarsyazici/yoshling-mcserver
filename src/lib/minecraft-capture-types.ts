import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";

export type MinecraftCaptureState = "waiting" | "paired" | "uploading" | "complete" | "expired" | "stale" | "unverified";
export interface MinecraftCaptureGrant {
  id: string;
  profileId: string;
  expiresAt: string;
  command: string;
  expectedRevision: number;
}
export interface MinecraftCaptureSession extends Omit<MinecraftCaptureGrant, "command"> {
  state: MinecraftCaptureState;
  reason?: string;
}
export interface MinecraftCaptureReceipt {
  session: MinecraftCaptureSession;
  verified: boolean;
  profile?: MinecraftProfileDTO;
}
export interface MinecraftCaptureCompanionManifest {
  version: "0.1.0";
  minecraftVersions: string[];
  loader: "fabric";
  fileName: string;
  downloadUrl: string;
  sha256: string;
  bytes: number;
}
