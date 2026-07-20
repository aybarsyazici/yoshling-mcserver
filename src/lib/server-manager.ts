// Compatibility shim.
//
// The server manager used to speak only Minecraft. It now delegates to the
// generalized game-manager (which drives both Minecraft and 7 Days to Die).
// These wrappers preserve the original Minecraft-only API so existing callers
// (mod-manager, modpack install, legacy routes) keep working unchanged.

import path from "path";
import {
  getGameStatus,
  powerOn,
  powerOff,
  restartGame,
  getMinecraftProperties,
  RUNTIME,
} from "@/lib/game-manager";

export type ServerStatus = "online" | "offline" | "starting" | "stopping";

export async function getServerStatus(): Promise<{ status: ServerStatus; uptime?: string }> {
  const s = await getGameStatus("minecraft");
  return { status: (s.status === "installing" ? "starting" : s.status) as ServerStatus, uptime: s.uptime };
}

export async function startServer(): Promise<void> {
  await powerOn("minecraft");
}

export async function stopServer(): Promise<void> {
  await powerOff("minecraft");
}

export async function restartServer(): Promise<void> {
  await restartGame("minecraft");
}

export async function getServerProperties(): Promise<Record<string, string>> {
  return getMinecraftProperties();
}

export function getModsDir(): string {
  return path.join(RUNTIME.minecraft.dir, "mods");
}
