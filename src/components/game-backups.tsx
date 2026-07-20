"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { GAMES, type GameId } from "@/lib/games";
import { Button } from "@/components/ui/button";
import { Archive, RotateCcw, Trash2, Plus, AlertTriangle } from "lucide-react";

interface Backup {
  name: string;
  size: number;
  createdAt: string;
}

export function GameBackups({ game }: { game: GameId }) {
  const meta = GAMES[game];
  const endpoint = game === "minecraft" ? "/api/server/backups" : "/api/7dtd/backups";
  const noun = game === "minecraft" ? "world" : "saves";

  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function fetchBackups() {
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      if (Array.isArray(data)) setBackups(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setCreating(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (res.ok && data.backup) {
        setBackups((prev) => [data.backup, ...prev]);
        toast.success("Backup created");
      } else {
        toast.error(data.error || "Backup failed");
      }
    } finally {
      setCreating(false);
    }
  }

  async function restore(name: string) {
    if (!confirm(`Restore "${name}"? This replaces the current ${noun}. Stop the server first.`)) return;
    setRestoring(name);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", backupName: name }),
      });
      if (res.ok) toast.success(`${noun[0].toUpperCase() + noun.slice(1)} restored. Power on to play.`);
      else {
        const d = await res.json();
        toast.error(d.error || "Restore failed");
      }
    } finally {
      setRestoring(null);
    }
  }

  async function del(name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", backupName: name }),
    });
    if (res.ok) {
      setBackups((prev) => prev.filter((b) => b.name !== name));
      toast.success("Backup deleted");
    }
  }

  return (
    <div className="space-y-5" style={{ ["--tint" as string]: meta.tint }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Snapshots of your <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{noun}</code>. Take one before big changes.
        </p>
        <Button onClick={create} disabled={creating} style={{ background: meta.tint, color: "var(--background)" }}>
          <Plus className="h-4 w-4" /> {creating ? "Creating…" : "Create backup"}
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
        <p className="text-xs text-muted-foreground">
          Restoring overwrites the live {noun}. Power the server down first to avoid corruption.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : backups.length === 0 ? (
        <div className="rounded-2xl bg-card/70 py-12 text-center ring-1 ring-foreground/10">
          <Archive className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">No backups yet. Create one to be safe.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {backups.map((b) => (
              <motion.div
                key={b.name}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card/70 p-4 ring-1 ring-foreground/10 backdrop-blur"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${meta.tint} 12%, transparent)`, color: meta.tint }}>
                    <Archive className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="font-mono text-sm font-medium">{b.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(b.createdAt).toLocaleString()} · {formatSize(b.size)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => restore(b.name)} disabled={restoring === b.name}>
                    <RotateCcw className="h-3.5 w-3.5" /> {restoring === b.name ? "Restoring…" : "Restore"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => del(b.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
