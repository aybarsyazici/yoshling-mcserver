"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
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

interface ServerConfig {
  mcVersion: string;
  modLoader: string;
}

interface Category {
  name: string;
  icon: string;
}

export function ModBrowser() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModrinthProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalHits, setTotalHits] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filterCompatible, setFilterCompatible] = useState(true);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [sortBy, setSortBy] = useState("relevance");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [showClientOnly, setShowClientOnly] = useState(false);

  useEffect(() => {
    fetch("/api/server/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.config) setServerConfig(data.config);
      })
      .catch(() => {});

    fetch("/api/mods/categories")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setCategories(data);
      })
      .catch(() => {});
  }, []);

  const search = useCallback(
    async (newOffset = 0) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (filterCompatible && serverConfig) {
        params.set("version", serverConfig.mcVersion);
        params.set("loader", serverConfig.modLoader);
      }
      if (category && category !== "all") params.set("category", category);
      if (showClientOnly) params.set("showClientOnly", "true");
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
    [query, filterCompatible, serverConfig, sortBy, category, showClientOnly]
  );

  useEffect(() => {
    const timer = setTimeout(() => search(0), 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            placeholder="Search mods..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-md"
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

      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <Switch
            id="compat-filter"
            checked={filterCompatible}
            onCheckedChange={setFilterCompatible}
          />
          <Label htmlFor="compat-filter" className="text-sm whitespace-nowrap">
            Compatible only
            {serverConfig && (
              <span className="text-muted-foreground ml-1">
                ({serverConfig.mcVersion} / {serverConfig.modLoader})
              </span>
            )}
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="server-filter"
            checked={!showClientOnly}
            onCheckedChange={(v) => setShowClientOnly(!v)}
          />
          <Label htmlFor="server-filter" className="text-sm whitespace-nowrap">
            Server-compatible only
          </Label>
        </div>
      </div>

      {category && category !== "all" && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Filtering by:</span>
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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-48 rounded-lg bg-muted animate-pulse"
            />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No mods found</p>
          <p className="text-sm mt-1">
            Try a different search or adjust the filters
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {totalHits.toLocaleString()} mods found
          </p>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {results.map((mod) => (
              <ModCard key={mod.project_id} mod={mod} />
            ))}
          </div>

          {results.length < totalHits && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={() => search(offset + 20)}
                disabled={loading}
              >
                {loading ? "Loading..." : "Load More"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
