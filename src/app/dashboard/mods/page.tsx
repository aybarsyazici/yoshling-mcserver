"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModBrowser } from "@/components/mod-browser";
import { InstalledMods } from "@/components/installed-mods";
import { Modpacks } from "@/components/modpacks";
import { ModpackBrowserModrinth } from "@/components/modpack-browser-modrinth";

export default function ModsPage() {
  const [tab, setTab] = useState("browse");
  const [modpackSubTab, setModpackSubTab] = useState("my-packs");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Mods</h2>
        <p className="text-muted-foreground">
          Browse, install, and manage server mods
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="browse">Browse Mods</TabsTrigger>
          <TabsTrigger value="installed">Installed</TabsTrigger>
          <TabsTrigger value="modpacks">Modpacks</TabsTrigger>
        </TabsList>
        <TabsContent value="browse" className="mt-6">
          <ModBrowser />
        </TabsContent>
        <TabsContent value="installed" className="mt-6">
          <InstalledMods />
        </TabsContent>
        <TabsContent value="modpacks" className="mt-6">
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
