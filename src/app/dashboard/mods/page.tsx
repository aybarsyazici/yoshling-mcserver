"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModBrowser } from "@/components/mod-browser";
import { InstalledMods } from "@/components/installed-mods";
import { Modpacks } from "@/components/modpacks";

export default function ModsPage() {
  const [tab, setTab] = useState("browse");

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
          <TabsTrigger value="browse">Browse</TabsTrigger>
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
          <Modpacks />
        </TabsContent>
      </Tabs>
    </div>
  );
}
