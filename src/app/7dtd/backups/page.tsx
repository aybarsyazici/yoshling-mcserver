"use client";

import { SectionHeading } from "@/components/ui-bits";
import { GameBackups } from "@/components/game-backups";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

export default function SevenDtdBackupsPage() {
  const tint = GAMES["7dtd"].tint;
  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="7 Days to Die · Backups"
        title="Backups"
        sub="Full snapshots — saves, world map, and settings — with one-click restore."
        tint={tint}
      />
      <GameBackups game="7dtd" />
      <PhotoFooter src="/the-stare.jpg" />
    </div>
  );
}
