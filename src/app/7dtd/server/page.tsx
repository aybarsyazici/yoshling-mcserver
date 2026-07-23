"use client";

import { useState } from "react";
import { SectionHeading } from "@/components/ui-bits";
import { TabBar } from "@/components/tab-bar";
import { GameControls } from "@/components/game-controls";
import { ServerMonitor } from "@/components/server-monitor";
import { GameConsole } from "@/components/game-console";
import { FileBrowser } from "@/components/file-browser";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

const TABS = [
  { value: "controls", label: "Controls" },
  { value: "monitor", label: "Monitor" },
  { value: "console", label: "Console" },
  { value: "files", label: "Files" },
];

const FILE_ROOTS = [
  { key: "config", label: "Config" },
  { key: "saves", label: "Saves" },
];

export default function SevenDtdServerPage() {
  const [tab, setTab] = useState("controls");
  const tint = GAMES["7dtd"].tint;

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="7 Days to Die · Server"
        title="Server control"
        sub="Start and stop the server, monitor resources, browse files, and run console commands."
        tint={tint}
      />

      <TabBar tabs={TABS} value={tab} onChange={setTab} tint={tint} />

      <div className="min-h-[300px]">
        {tab === "controls" && <GameControls game="7dtd" />}
        {tab === "monitor" && <ServerMonitor game="7dtd" />}
        {tab === "console" && <GameConsole game="7dtd" />}
        {tab === "files" && <FileBrowser endpoint="/api/7dtd/files" roots={FILE_ROOTS} tint={tint} />}
      </div>

      <PhotoFooter src="/the-stare.jpg" />
    </div>
  );
}
