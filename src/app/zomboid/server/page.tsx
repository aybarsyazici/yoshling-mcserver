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

export default function ZomboidServerPage() {
  const [tab, setTab] = useState("controls");
  const meta = GAMES.zomboid;
  const tint = meta.tint;

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      <SectionHeading
        eyebrow="Project Zomboid · Server"
        title="Server control"
        sub="Start and stop the server, monitor resources, browse files, and run console commands."
        tint={tint}
      />

      <TabBar tabs={TABS} value={tab} onChange={setTab} tint={tint} />

      <div className="min-h-[300px]">
        {tab === "controls" && <GameControls game="zomboid" />}
        {tab === "monitor" && <ServerMonitor game="zomboid" />}
        {tab === "console" && <GameConsole game="zomboid" />}
        {tab === "files" && (
          <FileBrowser endpoint={meta.api.files} roots={meta.fileRoots} tint={tint} />
        )}
      </div>

      <PhotoFooter src="/the_judge.jpg" />
    </div>
  );
}
