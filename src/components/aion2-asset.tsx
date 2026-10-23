"use client";

import Image from "next/image";
import { useState } from "react";
import { Swords } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AionBoardNode } from "@/lib/aion2-types";

// These are the actual files used by the official armory's Daevanion CSS:
// https://assets.playnccdn.com/static-aion2/characters/css/index.css
// Grade/open selectors and all URLs were verified through HTTP on 2026-10-23.
// The armory renders these rather than the broken UT_FWindow API sprite URLs.
const BOARD_ART = {
  Common: ["https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_common.png", "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_common_open.png"],
  Rare: ["https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_rare.png", "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_rare_open.png"],
  Legend: ["https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_legend.png", "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_legend_open.png"],
  Unique: ["https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_unique.png", "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_unique_open.png"],
} as const;
const CLASS_ART: Record<string, string> = {
  gladiator: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_gladiator.png",
  templar: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_templar.png",
  ranger: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_ranger.png",
  assassin: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_assassin.png",
  spiritmaster: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_elementalist.png",
  elementalist: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_elementalist.png",
  sorcerer: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_sorcerer.png",
  cleric: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_cleric.png",
  chanter: "https://assets.playnccdn.com/static-aion2/characters/img/daevanion/board_icon_start_chanter.png",
};

export function aionClassEmblem(characterClass?: string): string | null {
  const key = characterClass?.trim().toLowerCase();
  return key && Object.hasOwn(CLASS_ART, key) ? CLASS_ART[key] : null;
}

export function aionBoardNodeIcon(node: AionBoardNode, characterClass?: string): string | null {
  if (node.kind.toLowerCase() === "start") return aionClassEmblem(characterClass);
  const grade = Object.hasOwn(BOARD_ART, node.grade) ? BOARD_ART[node.grade as keyof typeof BOARD_ART] : undefined;
  if (grade) return grade[node.unlocked ? 1 : 0];
  return aionImageSource(node.icon) && !node.icon.includes("/UT_FWindow_Daevanion_Node_") ? node.icon : null;
}

export function aionImageSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && ["assets.playnccdn.com", "profileimg.plaync.com"].includes(url.hostname);
  } catch { return false; }
}

export function AionAsset({ src, alt, size = 40, className }: { src?: string | null; alt: string; size?: number; className?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const show = aionImageSource(src) && src !== failedSource;
  return <span className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background/70 text-primary", className)} style={{ width: size, height: size }}>
    {show ? <Image src={src} alt={alt} width={size} height={size} className="h-full w-full object-cover" unoptimized onError={() => setFailedSource(src)} /> : <Swords className="h-1/2 w-1/2" aria-hidden />}
  </span>;
}
