"use client";
import Image from "next/image";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
import { overviewDate, profileImagePresentation } from "@/lib/minecraft-profile-images";

/** Parent supplies a positioned, sized image frame. Illustrations never represent saved blocks. */
export function MinecraftProfileImage({ profile, sizes = "100vw", decorative = false, compact = false }: { profile: MinecraftProfileDTO; sizes?: string; decorative?: boolean; compact?: boolean }) {
  const image = profileImagePresentation(profile);
  const variant = profile.source.kind === "legacy" ? "adopt" : profile.source.kind;
  return <>
    {image.url ? <Image src={image.url} alt={decorative ? "" : image.kind === "custom" ? `Cover for ${profile.name}` : `Generated Overworld overview for ${profile.name}`} fill sizes={sizes} className="object-cover motion-safe:transition-transform motion-safe:duration-500 motion-safe:group-hover:scale-105" unoptimized /> : <MinecraftProfileScene variant={variant} className="absolute inset-0 size-full" />}
    <div data-profile-image-kind={image.kind} className={`absolute inset-x-0 bottom-0 bg-black/80 px-3 py-2 text-white ${compact ? "text-[10px]" : "text-xs"}`}>
      <p className="font-medium">{image.label}</p>
      {image.timestamp && <p title={overviewDate(image.timestamp)}>Generated {compact ? new Date(image.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : overviewDate(image.timestamp)}</p>}
      {image.detail && <p className="break-words text-white/90">{image.detail}</p>}
    </div>
  </>;
}
