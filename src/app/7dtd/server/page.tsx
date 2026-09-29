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

export default function SevenDtdServerPage() {
  const [tab, setTab] = useState("controls");
  // `games.ts` is the single source of truth for a world's identity, and this page kept
  // a second copy of its file-roots table plus a literal `/api/7dtd/files`. The two
  // copies were byte-identical (verified), which is the only reason nothing broke — and
  // also why a drift would have gone unnoticed. The PZ page already reads `meta`.
  const meta = GAMES["7dtd"];
  const tint = meta.tint;

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
        {tab === "files" && (
          <FileBrowser endpoint={meta.api.files} roots={meta.fileRoots} tint={tint} />
        )}
      </div>

      <PhotoFooter src="/the-stare.jpg" />
    </div>
  );
}
