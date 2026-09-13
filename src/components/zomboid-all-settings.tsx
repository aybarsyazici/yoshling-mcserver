"use client";

import { ConfigPanel } from "@/components/config-panel";

// Project Zomboid's .ini is one flat list of ~140 keys (32 of them anti-cheat
// toggles), so grouping is the difference between a usable page and a wall of
// inputs. First match wins. Booleans and numbers are detected from the value
// itself, so nothing here needs a hand-written dropdown.
const GROUPS: [RegExp, string][] = [
  [/^AntiCheat/i, "Anti-cheat"],
  [/^(Safehouse|SafeHouse|PlayerSafehouse|AdminSafehouse|DisableSafehouseWhenPlayerConnected|SledgehammerOnlyInSafehouse)/i, "Safehouses"],
  [/^(GlobalChat|ChatStreams|Voice|Discord|DisableRadio)/i, "Chat & radio"],
  [/^(ClientCommandFilter|ClientActionLogs|PerkLogs|DoLuaChecksum)/i, "Logging & checks"],
  [
    /^(PVP|Safety|ShowSafety|DisplayUserName|ShowFirstAndLastName|MouseOverToSeeDisplayName|HidePlayersBehindYou|PlayerBumpPlayer|KnockedDownAllowed|SneakMode|Faction|MapRemotePlayerVisibility|AnnounceDeath|AllowDestructionBySledgehammer)/i,
    "Players & PVP",
  ],
  [
    /^(Public|MaxPlayers|Open|Password|MaxAccountsPerUser|ServerWelcomeMessage|AutoCreateUserInWhiteList|DropOffWhiteListAfterDeath|DenyLoginOnOverloadedServer|LoginQueue|PingLimit|KickFastPlayers|SpeedLimit|server_browser|ServerPlayerID|ResetID|Steam|UPnP|BanKickGlobalSound|AllowNonAsciiUsername)/i,
    "Server",
  ],
  [/^(Map|Mods|WorkshopItems|SpawnPoint|SpawnItems|SaveWorldEveryMinutes|Backups|PauseEmpty|MinutesPerPage|FastForwardMultiplier)/i, "World & saves"],
];

function groupOf(name: string): string {
  for (const [re, group] of GROUPS) if (re.test(name)) return group;
  return "Simulation";
}

const GROUP_ORDER = [
  "Server",
  "Players & PVP",
  "World & saves",
  "Simulation",
  "Safehouses",
  "Chat & radio",
  "Logging & checks",
  "Anti-cheat",
];

export function ZomboidAllSettings({ tint }: { tint: string }) {
  return (
    <ConfigPanel
      tint={tint}
      endpoint="/api/zomboid/config"
      subtitle="Every option in the server .ini — PVP, safehouses, loot respawn, saving, anti-cheat…"
      restartNote="Restart Project Zomboid to apply."
      groupOrder={GROUP_ORDER}
      groupOf={groupOf}
    />
  );
}
