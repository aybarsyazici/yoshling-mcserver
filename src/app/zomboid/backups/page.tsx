"use client";

import { SectionHeading } from "@/components/ui-bits";
import { GameBackups } from "@/components/game-backups";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

export default function ZomboidBackupsPage() {
  const tint = GAMES.zomboid.tint;
  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="Project Zomboid · Backups"
        title="Backups"
        sub="Full snapshots — the world, player accounts, and settings — with one-click restore."
        tint={tint}
      />
      <GameBackups game="zomboid" />
      <PhotoFooter src="/simba.jpg" />
    </div>
  );
}
