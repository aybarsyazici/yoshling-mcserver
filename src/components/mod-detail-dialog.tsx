"use client";

import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import parse from "html-react-parser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ModDetail {
  title: string;
  description: string;
  body: string;
  icon_url: string | null;
  gallery: { url: string; title?: string; description?: string }[];
  downloads: number;
  followers: number;
  categories: string[];
  loaders: string[];
  game_versions: string[];
  license: string | null;
  source_url: string | null;
  issues_url: string | null;
  wiki_url: string | null;
  discord_url: string | null;
  date_created: string;
  date_modified: string;
  client_side: string;
  server_side: string;
}

interface Props {
  projectId: string | null;
  open: boolean;
  onClose: () => void;
}

function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|vimeo\.com/.test(url);
}

function getYoutubeId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
  return match ? match[1] : null;
}

export function ModDetailDialog({ projectId, open, onClose }: Props) {
  const [detail, setDetail] = useState<ModDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId || !open) {
      setDetail(null);
      return;
    }
    setLoading(true);
    fetch(`/api/mods/detail?id=${projectId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.title) setDetail(data);
      })
      .finally(() => setLoading(false));
  }, [projectId, open]);

  const imageGallery = detail?.gallery.filter((g) => {
    const url = typeof g === "string" ? g : g.url;
    return !isVideoUrl(url);
  }) || [];

  const videoGallery = detail?.gallery.filter((g) => {
    const url = typeof g === "string" ? g : g.url;
    return isVideoUrl(url);
  }) || [];

  const navigateLightbox = useCallback((dir: 1 | -1) => {
    if (lightboxIndex === null) return;
    const next = lightboxIndex + dir;
    if (next >= 0 && next < imageGallery.length) {
      setLightboxIndex(next);
    }
  }, [lightboxIndex, imageGallery.length]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") navigateLightbox(1);
      else if (e.key === "ArrowLeft") navigateLightbox(-1);
      else if (e.key === "Escape") setLightboxIndex(null);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lightboxIndex, navigateLightbox]);

  return (
    <>
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="!max-w-[90vw] !w-[90vw] max-h-[90vh] overflow-y-auto">
        {loading ? (
          <div className="space-y-4 py-8">
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
            <div className="h-4 w-full bg-muted animate-pulse rounded" />
            <div className="h-40 w-full bg-muted animate-pulse rounded" />
          </div>
        ) : detail ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-4">
                {detail.icon_url && (
                  <img
                    src={detail.icon_url}
                    alt=""
                    className="h-16 w-16 rounded-xl object-cover ring-1 ring-border/50 flex-shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <DialogTitle className="text-xl">{detail.title}</DialogTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {detail.description}
                  </p>
                </div>
              </div>
            </DialogHeader>

            {/* Stats */}
            <div className="flex flex-wrap gap-4 py-3 border-y border-border/50 text-sm">
              <div>
                <span className="text-muted-foreground">Downloads:</span>{" "}
                <span className="font-medium">{formatNumber(detail.downloads)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Followers:</span>{" "}
                <span className="font-medium">{formatNumber(detail.followers)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">License:</span>{" "}
                <span className="font-medium">{detail.license || "Unknown"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Updated:</span>{" "}
                <span className="font-medium">
                  {new Date(detail.date_modified).toLocaleDateString()}
                </span>
              </div>
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-1.5">
              {detail.loaders.map((l) => (
                <Badge key={l} className="capitalize text-[10px]">
                  {l}
                </Badge>
              ))}
              {detail.categories.map((c) => (
                <Badge key={c} variant="secondary" className="text-[10px]">
                  {c.replace(/-/g, " ")}
                </Badge>
              ))}
            </div>

            {/* Supported versions */}
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Supported versions:</p>
              <div className="flex flex-wrap gap-1">
                {detail.game_versions.slice(-10).map((v) => (
                  <Badge key={v} variant="outline" className="text-[10px] font-mono">
                    {v}
                  </Badge>
                ))}
                {detail.game_versions.length > 10 && (
                  <Badge variant="outline" className="text-[10px]">
                    +{detail.game_versions.length - 10} more
                  </Badge>
                )}
              </div>
            </div>

            {/* Gallery - Images */}
            {imageGallery.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Screenshots</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {imageGallery.slice(0, 9).map((img, i) => {
                    const url = typeof img === "string" ? img : img.url;
                    return (
                      <img
                        key={i}
                        src={getFullResUrl(url)}
                        alt=""
                        className="rounded-xl w-full h-40 object-cover border border-border/50 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
                        onClick={(e) => { e.stopPropagation(); setLightboxIndex(i); }}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Gallery - Videos */}
            {videoGallery.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Videos</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {videoGallery.map((vid, i) => {
                    const url = typeof vid === "string" ? vid : vid.url;
                    const ytId = getYoutubeId(url);
                    return ytId ? (
                      <div key={i} className="aspect-video rounded-xl overflow-hidden border border-border/50">
                        <iframe
                          src={`https://www.youtube.com/embed/${ytId}`}
                          className="w-full h-full"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      </div>
                    ) : (
                      <a
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 p-3 rounded-xl border border-border/50 hover:border-primary/50 transition-colors"
                      >
                        <div className="h-10 w-10 rounded-lg bg-destructive/10 flex items-center justify-center flex-shrink-0">
                          <svg className="h-5 w-5 text-destructive" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                        <span className="text-sm text-primary truncate">Watch video</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Links */}
            <div className="flex flex-wrap gap-2">
              {detail.source_url && (
                <a href={detail.source_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">Source <ExternalIcon /></Button>
                </a>
              )}
              {detail.wiki_url && (
                <a href={detail.wiki_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">Wiki <ExternalIcon /></Button>
                </a>
              )}
              {detail.issues_url && (
                <a href={detail.issues_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">Issues <ExternalIcon /></Button>
                </a>
              )}
              {detail.discord_url && (
                <a href={detail.discord_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">Discord <ExternalIcon /></Button>
                </a>
              )}
            </div>

            {/* Body */}
            {detail.body && (
              <div className="prose prose-sm dark:prose-invert max-w-none border-t border-border/50 pt-4">
                {detail.body.trim().startsWith("<") ? (
                  parse(detail.body, {
                    replace: (domNode: any) => {
                      if (domNode.type === "tag" && domNode.name === "img" && domNode.attribs?.src) {
                        return <img src={domNode.attribs.src} alt={domNode.attribs.alt || ""} className="rounded-xl max-w-full" />;
                      }
                      if (domNode.type === "tag" && domNode.name === "a" && domNode.attribs?.href) {
                        return undefined;
                      }
                    },
                  })
                ) : (
                  <ReactMarkdown
                    rehypePlugins={[rehypeRaw]}
                    components={{
                      img: ({ src, alt }) => (
                        <img src={src} alt={alt || ""} className="rounded-xl max-w-full" />
                      ),
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all inline-flex items-center gap-0.5">
                          {children}<ExternalIcon />
                        </a>
                      ),
                    }}
                  >
                    {detail.body}
                  </ReactMarkdown>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            Failed to load mod details
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* Lightbox */}
    {lightboxIndex !== null && imageGallery.length > 0 && (
      <div
        className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
        onClick={() => setLightboxIndex(null)}
      >
        <button
          className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl font-bold"
          onClick={() => setLightboxIndex(null)}
        >
          &times;
        </button>

        {lightboxIndex > 0 && (
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white text-4xl px-3"
            onClick={(e) => { e.stopPropagation(); navigateLightbox(-1); }}
          >
            &#8249;
          </button>
        )}

        {lightboxIndex < imageGallery.length - 1 && (
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white text-4xl px-3"
            onClick={(e) => { e.stopPropagation(); navigateLightbox(1); }}
          >
            &#8250;
          </button>
        )}

        <img
          src={getFullResUrl(typeof imageGallery[lightboxIndex] === "string" ? imageGallery[lightboxIndex] as any : (imageGallery[lightboxIndex] as any).url)}
          alt=""
          className="w-[95vw] h-[90vh] object-contain"
          onClick={(e) => e.stopPropagation()}
        />

        <p className="absolute bottom-4 text-white/60 text-sm">
          {lightboxIndex + 1} / {imageGallery.length} — Use arrow keys to navigate
        </p>
      </div>
    )}
    </>
  );
}

function getFullResUrl(url: string): string {
  // Modrinth CDN serves thumbnails with _350.webp suffix. Remove it to get full res.
  return url.replace(/_\d+\.webp$/, ".webp");
}

function ExternalIcon() {
  return (
    <svg className="inline h-3 w-3 flex-shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
    </svg>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
