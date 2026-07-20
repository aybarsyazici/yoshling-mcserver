"use client";

import { useState } from "react";
import { SectionHeading } from "@/components/ui-bits";
import { TabBar } from "@/components/tab-bar";
import { GameControls } from "@/components/game-controls";
import { ServerMonitor } from "@/components/server-monitor";
import { GameBackups } from "@/components/game-backups";
import { GameConsole } from "@/components/game-console";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

const TABS = [
  { value: "controls", label: "Controls" },
  { value: "monitor", label: "Monitor" },
  { value: "backups", label: "Backups" },
  { value: "console", label: "Console" },
];

export default function SevenDtdServerPage() {
  const [tab, setTab] = useState("controls");
  const tint = GAMES["7dtd"].tint;

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="7 Days to Die · Server"
        title="Server control"
        sub="Power the horde on and off, watch resources, back up your saves, and run console commands."
        tint={tint}
      />

      <TabBar tabs={TABS} value={tab} onChange={setTab} tint={tint} />

      <div className="min-h-[300px]">
        {tab === "controls" && <GameControls game="7dtd" />}
        {tab === "monitor" && <ServerMonitor game="7dtd" />}
        {tab === "backups" && <GameBackups game="7dtd" />}
        {tab === "console" && <GameConsole game="7dtd" />}
      </div>

      <PhotoFooter src="/the-stare.jpg" caption="when the screamer shows up" />
    </div>
  );
}
