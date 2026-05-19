"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModCard } from "@/components/mod-card";
import { Button } from "@/components/ui/button";
import type { ModrinthProject } from "@/lib/modrinth";

interface Category {
  name: string;
  icon: string;
}

interface Modpack {
  id: string;
  name: string;
  targetMcVersion: string | null;
  targetLoader: string | null;
}

export function ModBrowser() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModrinthProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalHits, setTotalHits] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState("relevance");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [modpacks, setModpacks] = useState<Modpack[]>([]);
  const [selectedModpack, setSelectedModpack] = useState("");

  const activeModpack = modpacks.find((p) => p.id === selectedModpack);

  useEffect(() => {
    fetch("/api/mods/categories")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setCategories(data);
      })
      .catch(() => {});

    fetch("/api/modpacks")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setModpacks(data);
      })
      .catch(() => {});
  }, []);

  const search = useCallback(
    async (newOffset = 0) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query) params.set("q", query);

      // Filter by modpack's version/loader if one is selected
      if (activeModpack?.targetMcVersion) {
        params.set("version", activeModpack.targetMcVersion);
      }
      if (activeModpack?.targetLoader) {
        params.set("loader", activeModpack.targetLoader);
      }

      if (category && category !== "all") params.set("category", category);
      params.set("offset", String(newOffset));
      params.set("limit", "20");
      params.set("sort", sortBy);

      try {
        const res = await fetch(`/api/mods/search?${params.toString()}`);
        const data = await res.json();
        if (newOffset === 0) {
          setResults(data.hits || []);
        } else {
          setResults((prev) => [...prev, ...(data.hits || [])]);
        }
        setTotalHits(data.total_hits || 0);
        setOffset(newOffset);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [query, sortBy, category, activeModpack]
  );

  useEffect(() => {
    const timer = setTimeout(() => search(0), 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
        <div className="flex-1">
          <Input
            placeholder="Search mods..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full lg:max-w-md"
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Select value={category} onValueChange={(v) => setCategory(v ?? "")}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat.name} value={cat.name}>
                  {cat.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={(v) => { if (v) setSortBy(v); }}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">Relevance</SelectItem>
              <SelectItem value="downloads">Downloads</SelectItem>
              <SelectItem value="updated">Recently Updated</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Select value={selectedModpack} onValueChange={(v) => setSelectedModpack(v ?? "")}>
          <SelectTrigger className="w-[250px]">
            <SelectValue placeholder="Filter: compatible with modpack..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No filter (show all)</SelectItem>
            {modpacks.map((pack) => (
              <SelectItem key={pack.id} value={pack.id}>
                {pack.name}
                {pack.targetMcVersion && (
                  <span className="text-muted-foreground ml-1">
                    ({pack.targetMcVersion})
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {activeModpack && (
          <Badge variant="secondary" className="gap-1.5">
            Showing mods for: MC {activeModpack.targetMcVersion} / {activeModpack.targetLoader}
            <button
              onClick={() => setSelectedModpack("")}
              className="ml-1 hover:text-foreground"
            >
              x
            </button>
          </Badge>
        )}
      </div>

      {category && category !== "all" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Category:</span>
          <Badge variant="secondary" className="gap-1">
            {category.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            <button
              onClick={() => setCategory("")}
              className="ml-1 hover:text-foreground"
            >
              x
            </button>
          </Badge>
        </div>
      )}

      {loading && results.length === 0 ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-48 rounded-xl bg-muted animate-pulse"
            />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No mods found</p>
          <p className="text-sm mt-1">
            Try a different search or remove the modpack filter
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {totalHits.toLocaleString()} mods found
          </p>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((mod) => (
              <ModCard key={mod.project_id} mod={mod} />
            ))}
          </div>

          {results.length < totalHits && (
            <div className="flex flex-col items-center gap-2 pt-6">
              <Button onClick={() => search(offset + 20)} disabled={loading}>
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
