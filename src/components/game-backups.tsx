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
import {
  Archive,
  RotateCcw,
  Trash2,
  Plus,
  AlertTriangle,
  Download,
  Clock,
  ShieldCheck,
} from "lucide-react";

interface Backup {
  name: string;
  size: number;
  createdAt: string;
  world?: string | null;
  includesWorldMap?: boolean;
  /** A checksum was recorded when it was written, so a restore can verify it. */
  verifiable?: boolean;
  /** Taken by the scheduler rather than by a person. */
  automatic?: boolean;
}

/**
 * One journal entry. The durable record of backup work on this box, including the two
 * things `/activity` structurally cannot carry: a **scheduled** backup (no user to
 * attribute — `Activity.userId` is a required foreign key) and, before this, any
 * **failure** at all.
 */
interface JournalEntry {
  at: string;
  event: "create" | "restore" | "delete" | "download" | "prune";
  outcome: "ok" | "failed";
  actor: string | null;
  name?: string;
  names?: string[];
  sizeBytes?: number;
  error?: string;
}

interface BackupMeta {
  policy: { keep: number; maxAgeDays: number };
  policyText: string;
  schedule: { enabled: boolean; everyHours: number };
  journal: JournalEntry[];
  /**
   * Whether the viewer may use the download endpoint, which requires `settings.edit`
   * because an archive contains `sdtdserver.xml` (telnet password) for 7DTD and the `.ini`
   * plus the player database for PZ.
   *
   * Reported by the server rather than derived here, and defaulted to **false** below: a
   * button that 403s is how the power controls got reported as a bug, and in this case the
   * 403 was invisible — the anchor's `download` attribute made the browser save
   * `{"error":"Forbidden"}` under the archive's own name and show a finished download.
   */
  canDownload?: boolean;
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
  // Named `lifecycle`, not `meta`: `meta` is already `GAMES[game]` in this component.
  const [lifecycle, setLifecycle] = useState<BackupMeta | null>(null);
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

  /**
   * The retention policy, the schedule and the journal, on their own request.
   *
   * A separate `?meta=1` rather than a richer listing response, so the array shape the
   * listing has always returned is untouched — and so a failure here (an old server, a
   * parse error) costs the header and never the list of archives, which is the part
   * someone came to this page for.
   */
  async function fetchMeta() {
    // Errors swallowed on purpose, and this is the one place on this page where that is
    // right: the archive list is what someone came for, and a header that failed to load
    // must not take it down. Every *mutation* here reports its failure loudly.
    const res = await fetch(`${endpoint}?meta=1`).catch(() => null);
    if (!res || !res.ok) return;
    const data = await res.json().catch(() => null);
    if (data && typeof data === "object" && data.policy) setLifecycle(data as BackupMeta);
  }

  useEffect(() => {
    fetchBackups();
    // `react-hooks/set-state-in-effect` flags this line and not the one above it, which is
    // a quirk of the analyzer rather than a difference in the code: both are async fetches
    // on mount that settle state when they return. The same shape is already in
    // `server-monitor.tsx`, `mod-detail-dialog.tsx`, `motion.tsx` and `theme-toggle.tsx`,
    // all of which the rule also flags — so this is the house pattern, and contorting one
    // call site would make this file the odd one out without changing what it does.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMeta();
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
      // A create also applies the retention policy, so the journal (and possibly the list)
      // has changed. Refetching both is what makes a prune visible rather than something
      // you notice later by counting rows.
      void fetchMeta();
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
      // The journal now carries this restore — including, for the first time, a restore
      // that failed. That entry is the whole reason the failure path writes anything.
      void fetchMeta();
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
      void fetchMeta();
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

      {/* What happens without anyone clicking anything. Both halves are stated out loud
          because both of them delete or create files on their own: pruning is destructive,
          and a schedule that nobody knows about is how you get surprised by disk use. */}
      {lifecycle && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl bg-card/70 px-3 py-2 text-xs text-muted-foreground ring-1 ring-foreground/10">
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {lifecycle.schedule.enabled
              ? `Automatic backup every ${lifecycle.schedule.everyHours}h — skipped while anyone is playing.`
              : "Automatic backups are switched off."}
          </span>
          <span className="flex items-center gap-1.5">
            <Trash2 className="h-3.5 w-3.5" />
            Retention: {lifecycle.policyText}. The newest is never deleted.
          </span>
        </div>
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
                      {b.automatic && <span>· automatic</span>}
                      {/* Said only when it is true. The absence of a checksum is not a
                          defect in the archive — every archive written before checksums
                          existed has none, and a restore reports that honestly rather
                          than refusing — so an "unverified" badge on all of them would
                          be noise that made the real signal invisible. */}
                      {b.verifiable && (
                        <span className="flex items-center gap-1" title="A checksum was recorded when this was written, and a restore verifies it first.">
                          <ShieldCheck className="h-3 w-3" /> checksummed
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {/* A plain link, not a fetch: the archive is 165–305 MB, so the browser
                      has to own the transfer — streaming it through JS would buffer it in
                      the tab, which is the same defect the server side avoids by piping
                      `createReadStream` straight into the response.

                      Deliberately NOT disabled while an operation runs. A download only
                      reads, and the moment someone most wants a copy off the box is the
                      moment something is going wrong on it. The lane exists to stop two
                      *writers*; this is not one. */}
                  {lifecycle?.canDownload && (
                    <Button
                      size="sm"
                      variant="outline"
                      // `render`, not `<a><Button/></a>` as the mod dialog does: a <button>
                      // inside an <a> is invalid HTML and only one of the two is keyboard
                      // activatable. This renders a single anchor wearing the button's
                      // styling.
                      //
                      // **No `download` attribute.** `archiveResponse` already sends
                      // `Content-Disposition: attachment; filename="<name>"`, so a successful
                      // download still saves under the right name — while a 403 or a 404
                      // (reachable now that archives get pruned: a listing rendered before a
                      // prune, clicked after it) renders its JSON in the tab instead of being
                      // saved as a 27-byte `.tar.gz` under a finished-download indicator.
                      render={
                        <a
                          href={`${endpoint}?download=${encodeURIComponent(b.name)}`}
                          aria-label={`Download backup ${b.name}`}
                        />
                      }
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </Button>
                  )}
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

      {/* The durable record.
          Two things live here that cannot live in `/activity`: a **scheduled** backup, which
          has no user to attribute (`Activity.userId` is a required foreign key, and putting
          a person's name on work they did not do is this project's own defect class), and
          any **failure** — the registry drops a failed record after six hours and the
          activity log only ever saw successes, so a restore that half-happened left no
          trace at all beyond the world being off. */}
      {lifecycle && lifecycle.journal.length > 0 && (
        <div className="space-y-2 rounded-2xl bg-card/70 p-4 ring-1 ring-foreground/10">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recent backup activity
          </p>
          <ul className="space-y-1.5">
            {lifecycle.journal.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className={cn(
                  "flex flex-wrap items-baseline gap-x-2 text-xs",
                  e.outcome === "failed" ? "op-bad" : "text-muted-foreground"
                )}
              >
                <span className="tabular-nums">{new Date(e.at).toLocaleString()}</span>
                <span>{journalSentence(e)}</span>
              </li>
            ))}
          </ul>
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

/**
 * One journal line, in words.
 *
 * Written from the recorded fields and nothing else — `outcome`, `event`, `actor` — so it
 * cannot describe an event differently from the way it was recorded. `actor === null` is
 * rendered as "the scheduler" because that is what it means: nobody asked, the timer did.
 * It is not "unknown", and saying "unknown" would invite someone to go looking for a
 * person who does not exist.
 */
function journalSentence(e: JournalEntry): string {
  // `=== null`, not falsy: the distinction being drawn is between a recorded ABSENCE of an
  // actor and a recorded-but-blank one. `actor: ""` reaching here used to print "the
  // scheduler" and claim the timer did something a person did; `recordBackupEvent` now
  // normalises "" to null, and this is the belt to that braces.
  const who = e.actor === null || e.actor === undefined ? "the scheduler" : e.actor || "someone";
  const what = e.name ? ` ${e.name}` : "";
  if (e.outcome === "failed") {
    return `${e.event === "restore" ? "Restore" : "Backup"}${what} failed — ${
      e.error || "no reason recorded"
    } (${who})`;
  }
  switch (e.event) {
    case "create":
      return `${who} made${what}${
        typeof e.sizeBytes === "number" ? ` (${formatBytes(e.sizeBytes)})` : ""
      }`;
    case "restore":
      return `${who} restored from${what}`;
    case "delete":
      return `${who} deleted${what}`;
    case "download":
      return `${who} downloaded${what}`;
    case "prune":
      return `Retention removed ${e.names?.length ?? 0} older ${
        (e.names?.length ?? 0) === 1 ? "archive" : "archives"
      }${e.names?.length ? `: ${e.names.join(", ")}` : ""}`;
  }
}
