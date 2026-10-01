"use client";

import { ConfigPanel, type SelectOption } from "@/components/config-panel";
import { MOD_GROUP_ORDER, WORLD_GROUP_ORDER, sandboxGroupOf } from "@/lib/sandbox-lua";

/**
 * Project Zomboid's sandbox options, rendered with the same `ConfigPanel` the `.ini`
 * and 7DTD's XML use. No second settings UI, and no per-setting table of labels: the
 * Lua file documents every option with a comment of its own, including its Min/Max,
 * and `/api/zomboid/sandbox` hands that straight through as `help`.
 *
 * ## Two panels, not one
 *
 * 742 options on production, of which 403 were added by mods (`BurdJournals` alone
 * contributes 182). One panel would be 742 inputs and ~150 dropdowns in a single
 * expander, and the vanilla options — the ones anyone actually came for — would be a
 * minority of it. So the endpoint partitions on the Lua **table** an option lives in:
 * `?scope=world` is the top level plus the five tables the base game ships,
 * `?scope=mods` is every other table. Nothing is dropped by the split; see
 * `scopeOf` for why the partition is on the table and not on the key's spelling.
 *
 * ## Why the choices arrive through `loadDynamicSelects`
 *
 * `ConfigPanel` takes its dropdown options as a prop, and PZ's enums are documented
 * per option *inside the file* (`-- 4 = Normal`), so they are only knowable at
 * runtime — which is exactly what `loadDynamicSelects` exists for (7DTD's installed
 * world list uses it the same way). It costs one extra GET per panel, issued in
 * parallel with the panel's own; both read one 75 KB file.
 */

async function loadChoices(endpoint: string): Promise<Record<string, SelectOption[]>> {
  const res = await fetch(endpoint);
  const data = await res.json();
  const out: Record<string, SelectOption[]> = {};
  for (const p of (data?.properties ?? []) as {
    name: string;
    choices?: { value: string; label: string }[];
  }[]) {
    if (p.choices && p.choices.length > 0) out[p.name] = p.choices;
  }
  return out;
}

export function ZomboidSandbox({ tint }: { tint: string }) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
        <p className="eyebrow text-muted-foreground">Sandbox options</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Zombie count, speed and strength, loot rarity, XP rates, day length, and when the water
          and electricity shut off. These live in{" "}
          <span className="font-mono text-xs text-foreground">Server / &lt;name&gt;_SandboxVars.lua</span>
          , not the .ini.
        </p>
        {/*
          Not decoration, and not hedging: the measurement behind this sentence is in
          `sandbox-lua.ts`. The server reads this file once, when the world loads, and
          writes it back ~95 s into startup and at no other point — not even at
          shutdown. So an edit made while the world is up is kept, and takes effect at
          the next start. Saying "restart to apply" where someone picks a value is the
          difference between a form and a form that lies.
        */}
        <p className="mt-3 text-sm">
          <span className="font-semibold">Nothing here applies while the server is running.</span>{" "}
          <span className="text-muted-foreground">
            Project Zomboid reads these once, when the world loads. An edit is kept and takes
            effect the next time the server starts — restart it when you&apos;re done.
          </span>
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          The world&apos;s start date (year, month, day, time of day) is listed but only applies to
          a world that doesn&apos;t exist yet. The <span className="font-mono">Zombies</span>,{" "}
          <span className="font-mono">ZombieRespawn</span> and{" "}
          <span className="font-mono">ZombieMigrate</span> presets are deliberately not listed:
          nothing in the game reads them, and the population is driven by the advanced{" "}
          <span className="font-mono">ZombieConfig</span> values under Zombie population, which are.
        </p>
      </div>

      {/*
        A label above each expander because `ConfigPanel` always titles itself "All
        settings" — with the .ini panel on the same page that is three identical
        headers, and the subtitle alone is not what the eye lands on.
      */}
      <div>
        <p className="eyebrow mb-2 text-muted-foreground">Sandbox · the world</p>
        <ConfigPanel
          tint={tint}
          endpoint="/api/zomboid/sandbox?scope=world"
          subtitle="Zombie population and behaviour, loot, XP rates, time, the utility shutoff…"
          restartNote="Restart Project Zomboid to apply."
          groupOrder={WORLD_GROUP_ORDER}
          groupOf={sandboxGroupOf}
          loadDynamicSelects={() => loadChoices("/api/zomboid/sandbox?scope=world")}
        />
      </div>

      <div>
        <p className="eyebrow mb-2 text-muted-foreground">Sandbox · added by mods</p>
        <ConfigPanel
          tint={tint}
          endpoint="/api/zomboid/sandbox?scope=mods"
          subtitle="Sandbox options installed mods add, named Mod.Setting."
          restartNote="Restart Project Zomboid to apply."
          groupOrder={MOD_GROUP_ORDER}
          groupOf={sandboxGroupOf}
          loadDynamicSelects={() => loadChoices("/api/zomboid/sandbox?scope=mods")}
        />
      </div>
    </div>
  );
}
