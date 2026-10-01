"use client";

import { SectionHeading } from "@/components/ui-bits";
import { ZomboidQuickSettings } from "@/components/zomboid-quick-settings";
import { ZomboidAllSettings } from "@/components/zomboid-all-settings";
import { ZomboidConfigImport } from "@/components/zomboid-config-import";
import { ZomboidSandbox } from "@/components/zomboid-sandbox";
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

      {/*
        Was a card pointing at the file browser: "edit it under Server/<name>_SandboxVars.lua".
        That is 1,800 lines of Lua in a textarea with no validation and no help, for the
        742 settings players actually argue about. It is a real editor now.
      */}
      <ZomboidSandbox tint={tint} />
    </div>
  );
}
