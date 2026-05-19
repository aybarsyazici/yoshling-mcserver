"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
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

export function ModDetailDialog({ projectId, open, onClose }: Props) {
  const [detail, setDetail] = useState<ModDetail | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
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

            {/* Gallery */}
            {detail.gallery.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Gallery</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {detail.gallery.slice(0, 6).map((img, i) => (
                    <img
                      key={i}
                      src={typeof img === "string" ? img : img.url}
                      alt=""
                      className="rounded-xl w-full h-48 object-cover border border-border/50"
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Links */}
            <div className="flex flex-wrap gap-2">
              {detail.source_url && (
                <a href={detail.source_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm">Source</Button>
                </a>
              )}
              {detail.wiki_url && (
                <a href={detail.wiki_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm">Wiki</Button>
                </a>
              )}
              {detail.issues_url && (
                <a href={detail.issues_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm">Issues</Button>
                </a>
              )}
              {detail.discord_url && (
                <a href={detail.discord_url} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm">Discord</Button>
                </a>
              )}
            </div>

            {/* Body (markdown) */}
            {detail.body && (
              <div className="prose prose-sm dark:prose-invert max-w-none border-t border-border/50 pt-4">
                <ReactMarkdown
                  components={{
                    img: ({ src, alt }) => (
                      <img src={src} alt={alt || ""} className="rounded-xl max-w-full" />
                    ),
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                        {children}
                      </a>
                    ),
                    p: ({ children }) => {
                      const text = String(children);
                      // Auto-linkify bare URLs in text
                      if (typeof children === "string" && /https?:\/\/\S+/.test(text)) {
                        const parts = text.split(/(https?:\/\/\S+)/g);
                        return (
                          <p>
                            {parts.map((part, i) =>
                              /^https?:\/\//.test(part) ? (
                                <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                                  {part}
                                </a>
                              ) : (
                                part
                              )
                            )}
                          </p>
                        );
                      }
                      return <p>{children}</p>;
                    },
                  }}
                >
                  {detail.body}
                </ReactMarkdown>
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
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
