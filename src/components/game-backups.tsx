"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { GAMES, type GameId } from "@/lib/games";
import { cn } from "@/lib/utils";
import { useGames } from "@/lib/use-games";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker } from "@/lib/operation-ui";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
  const [deleting, setDeleting] = useState<string | null>(null);
  // Both confirms are Dialogs rather than `window.confirm`, matching the pre-empt
  // confirm on the landing page. `window.confirm` cannot render the consequence with
  // any emphasis, is unstyled, and on a destructive action that is the one place the
  // wording has to be readable.
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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
    setConfirmRestore(null);
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
      // "strip", not "bar". Ten other user-facing strings say strip, and both
      // `operation-tape.tsx` and `operation-ledger.tsx` record that a progress *bar* was
      // removed on purpose — so pointing someone at "the bar" sends them looking for a
      // thing that does not exist, in the middle of a destructive operation.
      toast.info(
        `Still restoring "${name}". The connection timed out before it finished, which is normal ` +
          `for a large ${noun} — watch the strip at the top of the page, and don't start it again.`
      );
    } finally {
      setRestoring(null);
      refresh();
    }
  }

  async function del(name: string) {
    setConfirmDelete(null);
    setDeleting(name);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", backupName: name }),
      });
      if (res.ok) {
        // The row leaving IS the report. There used to be a `toast.success("Backup
        // deleted")` here, written by the client off nothing but a 2xx — the one thing
        // every other path on this page is structurally forbidden from doing, and on the
        // only irreversible action of the three. The server now takes the file lane, so a
        // refusal arrives as a 409 with a readable message instead.
        setBackups((prev) => prev.filter((b) => b.name !== name));
      } else {
        // Say so. A failed delete used to leave the row in place and no message at
        // all, which reads as the button not working. A 409 from the file lane lands
        // here too and carries the reason ("a restore is in progress…").
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || "Delete failed");
      }
    } catch {
      toast.error("Delete failed — the request did not reach the server.");
    } finally {
      setDeleting(null);
      void fetchBackups();
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
                    onClick={() => setConfirmRestore(b.name)}
                    disabled={restoring !== null || locked}
                  >
                    <RotateCcw className={cn("h-3.5 w-3.5", restoring === b.name && "animate-spin")} />{" "}
                    {restoring === b.name ? "Restoring…" : "Restore"}
                  </Button>
                  {/* `disabled` and `aria-label` were both missing. Delete was the only
                      backup mutation with no gate at all, while Restore right next to it
                      carried `disabled={restoring !== null || locked}` — so an archive
                      could be removed out from under a restore that was reading it. And
                      the button is icon-only, so with no label a screen reader announced
                      it as "button" with no indication of what it deletes. */}
                  <Button
                    size="sm"
                    variant="destructive"
                    className="disabled:cursor-not-allowed"
                    aria-label={`Delete backup ${b.name}`}
                    onClick={() => setConfirmDelete(b.name)}
                    disabled={deleting !== null || restoring !== null || locked}
                  >
                    <Trash2 className={cn("h-3.5 w-3.5", deleting === b.name && "animate-pulse")} />
                  </Button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Restore confirm */}
      <Dialog open={confirmRestore !== null} onOpenChange={(o) => !o && setConfirmRestore(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{confirmRestore}</span> replaces the live {noun}, and
              there is no undo.{" "}
              {running ? (
                <>
                  <strong>
                    {meta.name} will be saved and stopped, the {noun} replaced, then started again.
                  </strong>{" "}
                  This can take several minutes, and the browser may give up waiting before it
                  finishes — the strip at the top of the page is what to watch, not this dialog.
                </>
              ) : (
                <>The server is down and stays down afterwards.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestore(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmRestore && restore(confirmRestore)}
            >
              <RotateCcw className="h-4 w-4" /> Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this backup?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{confirmDelete}</span> is removed from disk. This cannot
              be undone, and it is not a copy of anything else — once it is gone, the state it held
              is gone with it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => confirmDelete && del(confirmDelete)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The list and the ledger's "Backup created — 165 MiB" have to be the same number in
 * the same unit, so both come from one helper. This was a second copy with the same
 * MiB-arithmetic-labelled-MB bug, in the one view an admin compares the summary against.
 */
const formatSize = formatBytes;
