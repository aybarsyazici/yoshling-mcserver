"use client";

import { useState } from "react";
import { SectionHeading } from "@/components/ui-bits";
import { TabBar } from "@/components/tab-bar";
import { GameControls } from "@/components/game-controls";
import { GameConsole } from "@/components/game-console";
import { FileBrowser } from "@/components/file-browser";
import { ServerMonitor } from "@/components/server-monitor";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

const TABS = [
  { value: "controls", label: "Controls" },
  { value: "monitor", label: "Monitor" },
  { value: "console", label: "Console" },
  { value: "files", label: "Files" },
];

export default function MinecraftServerPage() {
  const [tab, setTab] = useState("controls");
  const tint = GAMES.minecraft.tint;

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading eyebrow="Minecraft · Server" title="Server control" sub="Power, monitor, browse files, and run console commands." tint={tint} />

      <TabBar tabs={TABS} value={tab} onChange={setTab} tint={tint} />

      <div className="min-h-[300px]">
        {tab === "controls" && <GameControls game="minecraft" />}
        {tab === "monitor" && <ServerMonitor game="minecraft" />}
        {tab === "console" && <GameConsole game="minecraft" />}
        {tab === "files" && <FileBrowser tint={tint} rootLabel="minecraft" />}
      </div>

      <PhotoFooter src="/cat.jpg" />
    </div>
  );
}
