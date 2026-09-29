"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { GAMES, type GameId } from "@/lib/games";
import { cn } from "@/lib/utils";
import { useGames } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker } from "@/lib/operation-ui";
import { Button } from "@/components/ui/button";
import { Archive, RotateCcw, Trash2, Plus, AlertTriangle } from "lucide-react";

interface Backup {
  name: string;
  size: number;
  createdAt: string;
  world?: string | null;
  includesWorldMap?: boolean;
}

// What a backup captures, and what a restore replaces, spelled out per game.
const NOUN: Record<GameId, string> = {
  minecraft: "world",
  "7dtd": "saves",
  zomboid: "save",
};

const DESCRIBES: Record<GameId, string> = {
  minecraft: "Each backup is a full copy of your Minecraft world folder.",
  "7dtd":
    "Each backup bundles your saves (player progress), the world map, and the server settings — so a restore rebuilds everything.",
  zomboid:
    "Each backup bundles the world save, the player database, and the server config files — so a restore rebuilds everything.",
};

export function GameBackups({ game }: { game: GameId }) {
  const meta = GAMES[game];
  const endpoint = meta.api.backups;
  const noun = NOUN[game];
  const describes = DESCRIBES[game];

  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  // A restore is a power operation — it saves + stops the server, swaps the files and
  // starts it back up, all inside one operation. So it has to know whether the server
  // is up (to say what will happen) and whether anything else already holds this
  // world's files (the request would come back 409).
  const { games, refresh } = useGames();
  const { operations, elapsedMs } = useOperations();
  const running = games?.[game]?.containerRunning ?? false;
  // The registry, not just the power lock: a create and a restore on the same world
  // both hold `files:{game}`, and two of them at once is how an archive gets torn.
  const blocker = powerBlocker(operations, game);
  const locked = blocker !== undefined;

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
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.backup) {
        setBackups((prev) => [data.backup, ...prev]);
        // No success toast: the operation's completion toast carries the archive's
        // read-back size, which is the only evidence that the file exists.
      } else {
        toast.error(data.error || "Backup failed");
      }
    } catch {
      // This whole function used to be `try { … } finally {}` with **no catch**. A
      // Project Zomboid create measures 4 min 20 s, so Cloudflare answers 524 with an
      // HTML body, `res.json()` throws, and the result was total *silence*: no toast at
      // all, the spinner just stopped, no row appeared — for an operation that had in
      // fact written a 198 MB archive.
      toast.info(
        `Still creating the backup. The connection timed out before it finished, which is normal ` +
          `for a large world — watch the strip at the top of the page, and don't start another.`
      );
    } finally {
      setCreating(false);
      void fetchBackups();
    }
  }

  async function restore(name: string) {
    const consequence = running
      ? `${meta.name} will be saved and stopped, the ${noun} replaced, then started again. ` +
        `This can take several minutes, and the browser may give up waiting before it finishes — ` +
        `the bar at the top of the page is what to watch, not this dialog.`
      : `This replaces the current ${noun}. The server stays powered down.`;
    if (!confirm(`Restore "${name}"?\n\n${consequence}`)) return;
    setRestoring(name);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", backupName: name }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(d.error || "Restore failed");
      // On success, say nothing here: the operation's completion toast carries the
      // server's own summary, which names the archive and whether the world came back
      // up. That sentence is derived from what was recorded, so it cannot overstate.
    } catch {
      // The request died, but the restore did not: it runs server-side under the
      // control lock and carries on regardless. A Project Zomboid restore opens
      // with `docker stop -t 300`, which outlasts Cloudflare's ~100s origin
      // timeout, so the *successful* path routinely ends with a dead connection.
      // Reporting that as "Restore failed" on a destructive operation is the worst
      // available answer — it invites someone to run it a second time.
      toast.info(
        `Still restoring "${name}". The connection timed out before it finished, which is normal ` +
          `for a large ${noun} — watch the bar at the top of the page, and don't start it again.`
      );
    } finally {
      setRestoring(null);
      refresh();
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
    } else {
      // Say so. A failed delete used to leave the row in place and no message at
      // all, which reads as the button not working.
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || "Delete failed");
    }
  }

  return (
    <div className="space-y-5" style={{ ["--tint" as string]: meta.tint }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {describes} Take one before switching worlds, changing settings, or installing updates — then you can roll back with one click.
        </p>
        <Button
          onClick={create}
          disabled={creating || locked}
          className="disabled:cursor-not-allowed"
          style={{ background: meta.tint, color: "var(--background)" }}
        >
          <Plus className="h-4 w-4" /> {creating ? "Creating…" : "Create backup"}
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
        <p className="text-xs text-muted-foreground">
          Restoring replaces the live {noun} and everything else in the backup, and there is no undo.
          {running
            ? ` ${meta.name} is running, so a restore saves and stops it first, then starts it again — a running server would otherwise write its own copy back over the restored files.`
            : " The server is down, so it will stay down afterwards."}
        </p>
      </div>

      {/* A disabled control that doesn't say why is the same failure as a silent
          operation, so this always names the work and how long it has been going. */}
      {blocker && (
        <p className="text-xs text-muted-foreground">
          {blockedReason(blocker, elapsedMs(blocker))}
        </p>
      )}

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
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{new Date(b.createdAt).toLocaleString()}</span>
                      <span>· {formatSize(b.size)}</span>
                      {b.world && (
                        <span className="rounded px-1.5 py-0.5 font-mono" style={{ background: `color-mix(in oklab, ${meta.tint} 12%, transparent)`, color: meta.tint }}>
                          {b.world}{b.includesWorldMap ? " · map incl." : ""}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="disabled:cursor-not-allowed"
                    onClick={() => restore(b.name)}
                    disabled={restoring !== null || locked}
                  >
                    <RotateCcw className={cn("h-3.5 w-3.5", restoring === b.name && "animate-spin")} />{" "}
                    {restoring === b.name ? "Restoring…" : "Restore"}
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
