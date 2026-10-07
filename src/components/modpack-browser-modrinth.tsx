"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ModDetailDialog } from "@/components/mod-detail-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readOperationResponse, unconfirmedOperationMessage } from "@/lib/operation-client";
import { toast } from "sonner";
import { CAPABILITY_POLL_MS, useGames } from "@/lib/use-games";

export interface ModpackResult {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
  categories: string[];
}

export function ModpackBrowserModrinth({
  onImported,
  onChoose,
}: {
  /** Called after a successful `POST /api/modpacks/import`. Unused in choose mode. */
  onImported?: () => void;
  /**
   * Choose a pack instead of saving it.
   *
   * **One search implementation, two jobs.** The Change pack sheet needs to find a pack on
   * Modrinth and then *review* it before applying; the saved-sets section needs to put one
   * on the shelf. Those differ by one button, and a second copy of a debounced Modrinth
   * search with its own card markup is how two surfaces start disagreeing about what the
   * list means. When this is set, the per-card action reads "Choose this pack" and calls
   * back; nothing is written here.
   *
   * **Ungated, unlike Import, and that is a decision rather than an oversight.** Choosing a
   * pack fetches `GET /api/modpacks/preview`, which is a read that deliberately answers a
   * MEMBER — it is the comparison between what a pack needs and what this server runs, which
   * is information and not a write. Gating it would also make the Apply gate behind it
   * untestable: a mutation that removed `can.modsInstall` from the Apply button survived,
   * because the MEMBER test never reached the step the button is on. The gate that stops a
   * read-only account getting here at all is `Change pack` on the page itself.
   */
  onChoose?: (pack: ModpackResult) => void;
}) {
  /**
   * The fourth write control on `/minecraft/mods`, originally on its own sub-tab. Included
   * with the three on the saved-sets surface because leaving it would mean the page still
   * offered a MEMBER one button that answers 403 — `POST /api/modpacks/import` checks
   * `mods.install`.
   *
   * **The same flag gates the choose action**, deliberately: choosing leads to an apply,
   * which checks the same capability. One boolean, two labels, so a role that cannot write
   * is offered neither.
   */
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModpackResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalHits, setTotalHits] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState("downloads");
  const [importing, setImporting] = useState<string | null>(null);
  const [minDownloads, setMinDownloads] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  /**
   * Off by default, and only ever turned on by the control below.
   *
   * The pack search used to be unfiltered: it listed every modpack Modrinth publishes
   * against a 26.1.2 Fabric server, and the apply then refused each one on a version
   * mismatch. The route defaults the facet to the server's own version now, and widening is
   * a word the request carries (`version=any`) rather than an omission — the same shape as
   * the mod browser.
   */
  const [allVersions, setAllVersions] = useState(false);
  /** What the route says it actually faceted on. Not inferred from the request. */
  const [filter, setFilter] = useState<{ mcVersion: string | null; loader: string | null } | null>(
    null
  );

  /** `null` when no version facet was applied, so the two cases cannot be confused. */
  const filterLabel = filter?.mcVersion
    ? `MC ${filter.mcVersion}${filter.loader ? ` / ${filter.loader}` : ""}`
    : null;

  const search = useCallback(
    async (newOffset = 0) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("offset", String(newOffset));
      params.set("sort", sortBy);
      if (allVersions) params.set("version", "any");

      try {
        const res = await fetch(`/api/modpacks/search?${params.toString()}`);
        const data = await res.json();
        let hits = data.hits || [];

        if (minDownloads && parseInt(minDownloads) > 0) {
          hits = hits.filter((h: ModpackResult) => h.downloads >= parseInt(minDownloads));
        }

        if (newOffset === 0) {
          setResults(hits);
        } else {
          setResults((prev) => [...prev, ...hits]);
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
    [query, sortBy, minDownloads, allVersions]
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
        const data = await readOperationResponse(res);
        if (typeof data.id !== "string" || !Array.isArray(data.mods)) throw new Error("The saved import receipt is incomplete");
        toast.success(`Imported "${pack.title}" with ${data.mods.length} mods`);
        onImported?.();
      } else {
        const data = await readOperationResponse(res);
        toast.error(data.error || "The import was not confirmed");
      }
    } catch (error) {
      toast.info(unconfirmedOperationMessage(`import of "${pack.title}"`, error) + " Check Saved sets before importing again.");
      onImported?.();
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className="space-y-5">
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

      {/* Stated from the route's answer, never from the request — `filter` is what was
          actually faceted on, and nothing is claimed until a response has arrived. */}
      {filter !== null && (
        <div className="flex flex-wrap items-center gap-2">
          {filterLabel ? (
            <Badge variant="secondary" className="gap-1.5">
              Packs for {filterLabel}
              <button
                onClick={() => setAllVersions(true)}
                className="ml-1 underline hover:text-foreground"
              >
                show all versions
              </button>
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1.5">
              Packs for every Minecraft version
              {/* Offered only when widening is what caused it: with no `ServerConfig` row
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
          )}
        </div>
      )}

      {loading && results.length === 0 ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No modpacks found</p>
          {/* Name the filter rather than guessing at the cause: an empty list under a
              version facet nobody asked for is the most confusing state this can reach. */}
          <p className="text-sm mt-1">
            {filterLabel
              ? `Nothing matched this search for ${filterLabel}.`
              : "Try a different search term"}
          </p>
          {filterLabel && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setAllVersions(true)}
            >
              Show packs for all versions
            </Button>
          )}
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
                className="flex flex-col rounded-xl bg-card/60 p-4 ring-1 ring-border transition-colors hover:ring-[var(--tint)]/60 focus-within:ring-2 focus-within:ring-[var(--tint)]"
              >
                <button
                  type="button"
                  onClick={() => setDetailId(pack.project_id)}
                  className="-m-1 flex items-start gap-3 rounded-lg p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
                >
                  {pack.icon_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={pack.icon_url}
                      alt=""
                      className="h-11 w-11 rounded-lg object-cover ring-1 ring-border/50"
                    />
                  ) : (
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--tint)]/10 text-xs font-bold text-[var(--tint)]">
                      {pack.title[0]}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold">{pack.title}</h3>
                    <p className="text-xs text-muted-foreground">by {pack.author}</p>
                  </div>
                </button>
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {pack.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {pack.categories.slice(0, 3).map((cat) => (
                    <Badge key={cat} variant="secondary" className="text-[10px] font-normal">
                      {cat}
                    </Badge>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/50 pt-3">
                  <span className="text-xs text-muted-foreground">
                    {formatDownloads(pack.downloads)} downloads
                  </span>
                  {/* Choosing is a read (see `onChoose`); importing writes a `Modpack` row
                      and `POST /api/modpacks/import` checks `mods.install`, so only that
                      one is gated. */}
                  {onChoose ? (
                    <Button size="sm" onClick={() => onChoose(pack)}>
                      Choose this pack
                    </Button>
                  ) : (
                    can.modsInstall && (
                      <Button
                        size="sm"
                        disabled={importing === pack.project_id}
                        onClick={() => handleImport(pack)}
                      >
                        {importing === pack.project_id ? "Importing..." : "Import"}
                      </Button>
                    )
                  )}
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
      <ModDetailDialog
        projectId={detailId}
        open={!!detailId}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
