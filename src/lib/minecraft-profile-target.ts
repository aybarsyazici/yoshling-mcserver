import { createHash } from "node:crypto";
import type { MinecraftJavaVariant, MinecraftProfileLoader, MinecraftProfileTarget } from "./minecraft-profile-types";

function exact(value: string): string {
  if (!/^[a-z\d][a-z\d._+\-]{0,119}$/i.test(value) || /^(latest|stable|release)$/i.test(value)) throw new Error("An exact Minecraft or loader version is required.");
  return value;
}

async function registryJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Version registry failed (${response.status}).`);
  const text = await response.text();
  if (text.length > 8 * 1024 ** 2) throw new Error("Version registry response exceeds its limit.");
  return JSON.parse(text);
}

export function profileJavaVariant(major: number, requested?: MinecraftJavaVariant): MinecraftJavaVariant {
  const supported = [8, 11, 17, 21, 25];
  const minimum = supported.find(value => value >= major);
  if (!Number.isSafeInteger(major) || major < 8 || !minimum) throw new Error(`Java ${major} is outside the supported profile images.`);
  if (requested && (!supported.includes(Number(requested.slice(4))) || Number(requested.slice(4)) < major)) throw new Error(`This Minecraft build requires Java ${major} or newer.`);
  return requested ?? `java${minimum}` as MinecraftJavaVariant;
}

export function selectProfileLoaderVersion(builds: Array<{ loader?: { version?: string; stable?: boolean } }>): string {
  const available = builds.flatMap(build => typeof build?.loader?.version === "string" ? [{ version: exact(build.loader.version), stable: build.loader.stable }] : []);
  const stable = available.filter(build => build.stable === true || (build.stable !== false && !/(?:alpha|beta|rc|snapshot)/i.test(build.version)));
  const ordered = (stable.length ? stable : available).sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
  if (!ordered.length) throw new Error("The loader registry publishes no usable build.");
  return ordered[0].version;
}

export async function resolveProfileTarget(input: { mcVersion: string; loader: MinecraftProfileLoader; loaderVersion?: string | null; javaVariant?: MinecraftJavaVariant }): Promise<MinecraftProfileTarget> {
  const mcVersion = exact(input.mcVersion);
  const manifest = await registryJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json") as { versions?: Array<{ id: string; url: string; sha1: string }> };
  const entry = manifest.versions?.find(version => version.id === mcVersion);
  if (!entry) throw new Error(`Minecraft ${mcVersion} is not in the official version registry.`);
  const url = new URL(entry.url);
  if (url.protocol !== "https:" || url.hostname !== "piston-meta.mojang.com" || url.username || url.password || url.port || !/^[a-f\d]{40}$/i.test(entry.sha1)) throw new Error("Minecraft version metadata has an invalid origin or hash.");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("Minecraft version metadata could not be downloaded.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 ** 2 || createHash("sha1").update(bytes).digest("hex") !== entry.sha1.toLowerCase()) throw new Error("Minecraft version metadata checksum could not be verified.");
  const metadata = JSON.parse(bytes.toString("utf8")) as { id?: string; javaVersion?: { majorVersion?: number }; downloads?: { server?: unknown } };
  if (metadata.id !== mcVersion || !metadata.downloads?.server) throw new Error("This Minecraft build does not publish a dedicated server.");
  // Older official manifests omit javaVersion and use the Java 8 launcher baseline.
  const javaVariant = profileJavaVariant(metadata.javaVersion?.majorVersion ?? 8, input.javaVariant);
  let loaderVersion = input.loaderVersion ? exact(input.loaderVersion) : null;
  if (input.loader === "vanilla") {
    if (loaderVersion) throw new Error("Vanilla profiles cannot specify a mod loader build.");
  } else if (!loaderVersion && (input.loader === "fabric" || input.loader === "quilt")) {
    const origin = input.loader === "fabric" ? "https://meta.fabricmc.net/v2" : "https://meta.quiltmc.org/v3";
    const builds = await registryJson(`${origin}/versions/loader/${encodeURIComponent(mcVersion)}`) as Array<{ loader?: { version?: string; stable?: boolean } }>;
    if (!Array.isArray(builds)) throw new Error("The loader registry returned an invalid build list.");
    loaderVersion = selectProfileLoaderVersion(builds);
  } else if (!loaderVersion && input.loader === "forge") {
    const data = await registryJson("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json") as { promos?: Record<string, string> };
    const build = data.promos?.[`${mcVersion}-recommended`] ?? data.promos?.[`${mcVersion}-latest`];
    if (!build) throw new Error(`No Forge build is available for Minecraft ${mcVersion}.`);
    loaderVersion = exact(build);
  } else if (!loaderVersion) {
    throw new Error(`An exact ${input.loader} loader build is required for this saved set.`);
  }
  return { mcVersion, loader: input.loader, loaderVersion, javaVariant };
}
