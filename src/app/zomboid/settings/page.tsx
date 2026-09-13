"use client";

import { SectionHeading } from "@/components/ui-bits";
import { ZomboidQuickSettings } from "@/components/zomboid-quick-settings";
import { ZomboidAllSettings } from "@/components/zomboid-all-settings";
import { ZomboidConfigImport } from "@/components/zomboid-config-import";
import { MemoryCard } from "@/components/memory-card";
import { GAMES } from "@/lib/games";

export default function ZomboidSettingsPage() {
  const tint = GAMES.zomboid.tint;
  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="Project Zomboid · Settings"
        title="World settings"
        sub="The essentials, written straight into the server config. Restart to apply."
        tint={tint}
      />

      <ZomboidQuickSettings tint={tint} />

      <MemoryCard game="zomboid" tint={tint} />

      <ZomboidAllSettings tint={tint} />

      <ZomboidConfigImport tint={tint} />

      <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
        <p className="eyebrow text-muted-foreground">Sandbox options</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Zombie population, loot rarity, XP rates and the rest of the sandbox preset live in a Lua
          file rather than the .ini. Edit it under{" "}
          <span className="font-mono text-xs text-foreground">
            Server / &lt;name&gt;_SandboxVars.lua
          </span>{" "}
          in the file browser on the Server page.
        </p>
      </div>
    </div>
  );
}
