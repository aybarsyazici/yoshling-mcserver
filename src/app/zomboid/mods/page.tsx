"use client";

import { SectionHeading } from "@/components/ui-bits";
import { ZomboidMods } from "@/components/zomboid-mods";
import { GAMES } from "@/lib/games";

export default function ZomboidModsPage() {
  const tint = GAMES.zomboid.tint;
  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="Project Zomboid · Content"
        title="Mods"
        sub="Steam Workshop mods, written straight into the server config. Restart to apply."
        tint={tint}
      />
      <ZomboidMods tint={tint} />
    </div>
  );
}
