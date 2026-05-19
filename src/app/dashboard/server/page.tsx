"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ServerControls } from "@/components/server-controls";
import { ServerConsole } from "@/components/server-console";
import { FileBrowser } from "@/components/file-browser";

export default function ServerPage() {
  const [tab, setTab] = useState("controls");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Server</h2>
        <p className="text-muted-foreground mt-1">
          Control, monitor, and browse your Minecraft server
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="controls">Controls</TabsTrigger>
          <TabsTrigger value="console">Console</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="controls" className="mt-6">
          <ServerControls />
        </TabsContent>
        <TabsContent value="console" className="mt-6">
          <ServerConsole />
        </TabsContent>
        <TabsContent value="files" className="mt-6">
          <FileBrowser />
        </TabsContent>
      </Tabs>
    </div>
  );
}
