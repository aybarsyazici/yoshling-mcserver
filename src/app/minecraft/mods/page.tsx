"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModBrowser } from "@/components/mod-browser";
import { InstalledMods } from "@/components/installed-mods";
import { Modpacks } from "@/components/modpacks";
import { ModpackBrowserModrinth } from "@/components/modpack-browser-modrinth";
import { SectionHeading } from "@/components/ui-bits";
import { TabBar } from "@/components/tab-bar";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";

const TABS = [
  { value: "browse", label: "Browse mods" },
  { value: "installed", label: "Installed" },
  { value: "modpacks", label: "Modpacks" },
];

export default function ModsPage() {
  const [tab, setTab] = useState("browse");
  const [modpackSubTab, setModpackSubTab] = useState("my-packs");
  const [refreshKey, setRefreshKey] = useState(0);
  const tint = GAMES.minecraft.tint;

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      {/* This subtitle once said "install with one click" for a control that did not exist —
          `/api/mods/install` had no caller anywhere in the tree, so the only way to put a jar
          on the server was to apply a whole pack. It has one since 2026-10-02 (the Install
          button on each search result), so the sentence can say so again.

          "what is on the server" rather than "what is installed", because the Installed tab
          now reconciles the database against the mods directory and reports the difference —
          it is a reading of the server, not a recital of the app's own writes. */}
      <SectionHeading
        eyebrow="Minecraft · Content"
        title="Mods & modpacks"
        sub="Search Modrinth, install a mod or a whole pack, and see what is on the server."
        tint={tint}
      />

      <TabBar tabs={TABS} value={tab} onChange={setTab} tint={tint} />

      <div className="min-h-[300px]">
        {tab === "browse" && <ModBrowser />}
        {tab === "installed" && <InstalledMods />}
        {tab === "modpacks" && (
          <Tabs value={modpackSubTab} onValueChange={setModpackSubTab}>
            <TabsList>
              <TabsTrigger value="my-packs">My Modpacks</TabsTrigger>
              <TabsTrigger value="modrinth">Modrinth</TabsTrigger>
            </TabsList>
            <TabsContent value="my-packs" className="mt-6">
              <Modpacks key={refreshKey} />
            </TabsContent>
            <TabsContent value="modrinth" className="mt-6">
              <ModpackBrowserModrinth
                onImported={() => {
                  setRefreshKey((k) => k + 1);
                  setModpackSubTab("my-packs");
                }}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>

      <PhotoFooter src="/the-rizzler.jpg" caption="approves of your mod list" />
    </div>
  );
}
