"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface ModpackResult {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
  categories: string[];
}

export function ModpackBrowserModrinth({ onImported }: { onImported: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModpackResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalHits, setTotalHits] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState("downloads");
  const [importing, setImporting] = useState<string | null>(null);
  const [minDownloads, setMinDownloads] = useState("");

  const search = useCallback(
    async (newOffset = 0) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("offset", String(newOffset));
      params.set("sort", sortBy);

      try {
        const res = await fetch(`/api/modpacks/search?${params.toString()}`);
        const data = await res.json();
        let hits = data.hits || [];

        if (minDownloads && parseInt(minDownloads) > 0) {
          hits = hits.filter((h: any) => h.downloads >= parseInt(minDownloads));
        }

        if (newOffset === 0) {
          setResults(hits);
        } else {
          setResults((prev) => [...prev, ...hits]);
        }
        setTotalHits(data.total_hits || 0);
        setOffset(newOffset);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [query, sortBy, minDownloads]
  );

  useEffect(() => {
    const timer = setTimeout(() => search(0), 400);
    return () => clearTimeout(timer);
  }, [search]);

  async function handleImport(pack: ModpackResult) {
    setImporting(pack.project_id);
    try {
      const res = await fetch("/api/modpacks/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modrinthId: pack.project_id, name: pack.title }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Imported "${pack.title}" with ${data.mods.length} mods`);
        onImported();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to import");
      }
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
        <div className="flex-1">
          <Input
            placeholder="Search Modrinth modpacks..."
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
              <SelectItem value="relevance">Relevance</SelectItem>
              <SelectItem value="updated">Recently Updated</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
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

      {loading && results.length === 0 ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No modpacks found</p>
          <p className="text-sm mt-1">Try a different search term</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {totalHits.toLocaleString()} modpacks found
          </p>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((pack) => (
              <div
                key={pack.project_id}
                className="flex flex-col p-4 rounded-xl border-2 border-border/50 hover:border-[#cba6f7] hover:shadow-[0_0_15px_rgba(203,166,247,0.3)] transition-all duration-300"
              >
                <div className="flex items-start gap-3">
                  {pack.icon_url ? (
                    <img
                      src={pack.icon_url}
                      alt=""
                      className="h-11 w-11 rounded-lg object-cover ring-1 ring-border/50"
                    />
                  ) : (
                    <div className="h-11 w-11 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                      {pack.title[0]}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm truncate">{pack.title}</h3>
                    <p className="text-xs text-muted-foreground">by {pack.author}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 mt-2 leading-relaxed">
                  {pack.description}
                </p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {pack.categories.slice(0, 3).map((cat) => (
                    <Badge key={cat} variant="secondary" className="text-[10px] font-normal">
                      {cat}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50">
                  <span className="text-xs text-muted-foreground">
                    {formatDownloads(pack.downloads)} downloads
                  </span>
                  <Button
                    size="sm"
                    disabled={importing === pack.project_id}
                    onClick={() => handleImport(pack)}
                  >
                    {importing === pack.project_id ? "Importing..." : "Import"}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {results.length < totalHits && (
            <div className="flex flex-col items-center gap-2 pt-6">
              <Button onClick={() => search(offset + 12)} disabled={loading}>
                {loading ? "Loading..." : "Load More"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Showing {results.length} of {totalHits.toLocaleString()}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
