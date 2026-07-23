"use client";

import { SectionHeading } from "@/components/ui-bits";
import { GameBackups } from "@/components/game-backups";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

export default function MinecraftBackupsPage() {
  const tint = GAMES.minecraft.tint;
  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="Minecraft · Backups"
        title="Backups"
        sub="Snapshot your world and roll back with one click."
        tint={tint}
      />
      <GameBackups game="minecraft" />
      <PhotoFooter src="/simba.jpg" />
    </div>
  );
}
