"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface TechnicPack {
  name: string;
  displayName: string;
  url: string;
  iconUrl: string | null;
  downloads: number;
  mcVersion: string;
}

export function ModpackBrowserTechnic({ onImported }: { onImported: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TechnicPack[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState("downloads");
  const [minDownloads, setMinDownloads] = useState("");

  const search = useCallback(
    async () => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`/api/modpacks/search-technic?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        let packs = data.packs || [];

        if (minDownloads && parseInt(minDownloads) > 0) {
          packs = packs.filter((p: any) => p.downloads >= parseInt(minDownloads));
        }

        if (sortBy === "downloads") {
          packs.sort((a: any, b: any) => b.downloads - a.downloads);
        } else if (sortBy === "name") {
          packs.sort((a: any, b: any) => a.displayName.localeCompare(b.displayName));
        }

        setResults(packs);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [query, sortBy, minDownloads]
  );

  useEffect(() => {
    if (!query.trim()) return;
    const timer = setTimeout(search, 400);
    return () => clearTimeout(timer);
  }, [search, query]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-chart-5/30 bg-chart-5/5 p-3">
        <p className="text-xs text-muted-foreground">
          Technic modpacks are pre-built and may include mods not available on Modrinth.
          Importing creates a modpack with the mods we can identify — some may need manual addition.
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
        <div className="flex-1">
          <Input
            placeholder="Search Technic modpacks..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full lg:max-w-md"
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={sortBy} onValueChange={(v) => { if (v) setSortBy(v); }}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="downloads">Most Downloads</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Min downloads"
            value={minDownloads}
            onChange={(e) => setMinDownloads(e.target.value.replace(/\D/g, ""))}
            className="w-[130px]"
          />
        </div>
      </div>

      {!query.trim() ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">Search for Technic modpacks</p>
          <p className="text-sm mt-1">Type a name to find modpacks on technicpack.net</p>
        </div>
      ) : loading ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No modpacks found</p>
          <p className="text-sm mt-1">Try a different search term</p>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {results.map((pack) => (
            <div
              key={pack.name}
              className="flex flex-col p-4 rounded-xl border-2 border-border/50 hover:border-[#cba6f7] hover:shadow-[0_0_15px_rgba(203,166,247,0.3)] transition-all duration-300"
            >
              <div className="flex items-start gap-3">
                {pack.iconUrl ? (
                  <img
                    src={pack.iconUrl}
                    alt=""
                    className="h-11 w-11 rounded-lg object-cover ring-1 ring-border/50"
                  />
                ) : (
                  <div className="h-11 w-11 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                    {pack.displayName[0]}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-sm truncate">{pack.displayName}</h3>
                  <p className="text-[10px] text-muted-foreground">
                    {formatDownloads(pack.downloads)} downloads
                    {pack.mcVersion && pack.mcVersion !== "unknown" && (
                      <span className="ml-2 font-mono">MC {pack.mcVersion}</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50">
                <a
                  href={pack.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  View on Technic
                </a>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    toast.info("Technic import creates a placeholder — add mods manually from the Browse tab");
                    // Create an empty modpack with the name since Technic doesn't expose individual mod info via their API
                    fetch("/api/modpacks", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: pack.displayName,
                        description: `From Technic Pack (${formatDownloads(pack.downloads)} downloads). Add mods manually.`,
                      }),
                    }).then(() => onImported());
                  }}
                >
                  Create Pack
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
