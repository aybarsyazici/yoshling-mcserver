"use client";

import { useMinecraftProfileRequest, type MinecraftProfileRequest } from "@/hooks/use-minecraft-profile-request";

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
import { CAPABILITY_POLL_MS, useGames } from "@/lib/use-games";
import { searchFilterParams } from "@/lib/mod-search-filter";
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

export function ModBrowser({ activeRequest }: { activeRequest?: MinecraftProfileRequest } = {}) {
  const ownRequest = useMinecraftProfileRequest(!activeRequest);
  const context = activeRequest ?? ownRequest;
  const request = context.request;
  // One poll for the whole grid, not one per card — see `ModCardProps.canAddToPack`.
  const { can } = useGames(CAPABILITY_POLL_MS);
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
  /**
   * Off by default, and only ever turned on by the button below.
   *
   * The search used to be unfiltered by version and loader unless a modpack was selected, so
   * the default list — the one with an Install button on every card — offered mods for every
   * Minecraft version ever published against a 26.1.2 Fabric server. The route now defaults
   * the facet to the server's own version; this is the deliberate way out of it, and it is
   * a word the request has to carry (`version=any`) rather than an omission.
   */
  const [allVersions, setAllVersions] = useState(false);
  /** What the route says it actually filtered on. Not inferred from the request. */
  const [filter, setFilter] = useState<{ mcVersion: string | null; loader: string | null } | null>(
    null
  );

  const activeModpack = modpacks.find((p) => p.id === selectedModpack);
  /** `null` when no version facet was applied, so the two cases cannot be confused. */
  const serverFilterLabel = filter?.mcVersion
    ? `MC ${filter.mcVersion}${filter.loader ? ` / ${filter.loader}` : ""}`
    : null;

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

      // Nothing sent = the route filters on the server's own version and loader; `any`
      // widens; a selected modpack's target outranks both. The rule is in
      // `mod-search-filter.ts` so it is asserted rather than trusted — reaching it through
      // this component means driving a base-ui combobox behind a debounce.
      const versionFilter = searchFilterParams({
        pack: activeModpack,
        allVersions,
      });
      if (versionFilter.version) params.set("version", versionFilter.version);
      if (versionFilter.loader) params.set("loader", versionFilter.loader);

      if (category && category !== "all") params.set("category", category);
      params.set("offset", String(newOffset));
      params.set("limit", "20");
      params.set("sort", sortBy);

      try {
        const res = await request(`/api/mods/search?${params.toString()}`);
        const data = await res.json();
        if (newOffset === 0) {
          setResults(data.hits || []);
        } else {
          setResults((prev) => [...prev, ...(data.hits || [])]);
        }
        setTotalHits(data.total_hits || 0);
        setOffset(newOffset);
        setFilter(data.filter ?? null);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [query, sortBy, category, activeModpack, allVersions, request]
  );

  useEffect(() => {
    const timer = setTimeout(() => search(0), 300);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="space-y-6">
      {context.contextError && <p role="alert">{context.contextError}</p>}
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

        {/*
          Stated from the route's answer, never from the request — `filter` is what was
          actually faceted on. Nothing is claimed until a response has arrived (`filter` is
          null on the first render), because "showing mods for MC 26.1.2" over an unfiltered
          list is the kind of small lie this project keeps paying for.
        */}
        {!activeModpack && filter !== null && (
          serverFilterLabel ? (
            <Badge variant="secondary" className="gap-1.5">
              Showing mods for: {serverFilterLabel}
              <button
                onClick={() => setAllVersions(true)}
                className="ml-1 underline hover:text-foreground"
              >
                show all versions
              </button>
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1.5">
              Showing mods for every Minecraft version
              {/* Offered only when widening is what caused it. With no `ServerConfig` row
                  there is no version to narrow back to, and a button that would change
                  nothing is worse than no button. */}
              {allVersions && (
                <button
                  onClick={() => setAllVersions(false)}
                  className="ml-1 underline hover:text-foreground"
                >
                  only this server&apos;s version
                </button>
              )}
            </Badge>
          )
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
          {/* Name the filter rather than guessing at the cause. An empty list under a version
              facet nobody asked for is the single most confusing state this page can reach,
              and it was reachable with no explanation on screen. */}
          <p className="text-sm mt-1">
            {activeModpack
              ? "Try a different search or remove the modpack filter"
              : serverFilterLabel
              ? `Nothing matched this search for ${serverFilterLabel}.`
              : "Try a different search"}
          </p>
          {!activeModpack && serverFilterLabel && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setAllVersions(true)}
            >
              Show mods for all versions
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {totalHits.toLocaleString()} mods found
          </p>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((mod) => (
              <ModCard
                key={mod.project_id}
                mod={mod}
                canAddToPack={can.modsInstall}
                canInstall={can.modsInstall}
                activeRequest={context}
              />
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
