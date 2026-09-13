"use client";

import { ConfigPanel, type SelectOption } from "@/components/config-panel";

// Known enumerations for a nicer dropdown instead of a raw text box.
// GameWorld is populated at runtime (stock + uploaded worlds).
const SELECTS: Record<string, SelectOption[]> = {
  Region: [
    "NorthAmericaEast",
    "NorthAmericaWest",
    "CentralAmerica",
    "SouthAmerica",
    "Europe",
    "Russia",
    "Asia",
    "MiddleEast",
    "Africa",
    "Oceania",
  ].map((v) => ({ value: v, label: v })),
  GameMode: [{ value: "GameModeSurvival", label: "Survival" }],
  ServerVisibility: [
    { value: "2", label: "Public (2)" },
    { value: "1", label: "Friends only (1)" },
    { value: "0", label: "Not listed (0)" },
  ],
  PlayerKillingMode: [
    { value: "0", label: "No killing" },
    { value: "1", label: "Kill allies only" },
    { value: "2", label: "Kill strangers only" },
    { value: "3", label: "Kill everyone" },
  ],
};

// Group properties by name prefix / topic so the long list is navigable.
function groupOf(name: string): string {
  if (
    /^Server(Name|Description|Website|Password|LoginConfirmation|Visibility|Disabled|MaxWorldTransfer|MaxPlayer|Reserved|Admin)/.test(
      name
    ) ||
    name === "Region" ||
    name === "Language" ||
    name === "ServerPort"
  )
    return "Server";
  if (/^(WebDashboard|EnableMapRendering|Terminal|EAC|IgnoreEOS|HideCommand|ServerAllowCrossplay)/.test(name))
    return "Access & tools";
  if (/^(GameWorld|WorldGen|GameName|GameMode|SaveDataLimit|MaxChunkAge|MaxUncovered|PersistentPlayer)/.test(name))
    return "World";
  if (/^LandClaim/.test(name)) return "Land claims";
  if (/^DynamicMesh/.test(name)) return "Dynamic mesh";
  if (/^Twitch/.test(name)) return "Twitch";
  if (/^(Max(Spawned|Queued)|ServerMaxAllowedView|PartyShared)/.test(name))
    return "Performance & limits";
  return "Gameplay";
}

const GROUP_ORDER = [
  "Server",
  "World",
  "Gameplay",
  "Performance & limits",
  "Land claims",
  "Dynamic mesh",
  "Access & tools",
  "Twitch",
];

/** The installed worlds, so GameWorld is a dropdown rather than a typo waiting to happen. */
async function loadWorlds(): Promise<Record<string, SelectOption[]>> {
  const res = await fetch("/api/7dtd/world");
  const data = await res.json();
  if (!Array.isArray(data.allWorlds)) return {};
  return { GameWorld: data.allWorlds.map((v: string) => ({ value: v, label: v })) };
}

export function SdtdAllSettings({ tint }: { tint: string }) {
  return (
    <ConfigPanel
      tint={tint}
      endpoint="/api/7dtd/config/all"
      subtitle="Every option in sdtdserver.xml — world size, XP, day length, loot, PvP…"
      restartNote="Restart 7DTD to apply."
      groupOrder={GROUP_ORDER}
      groupOf={groupOf}
      selects={SELECTS}
      loadDynamicSelects={loadWorlds}
    />
  );
}
