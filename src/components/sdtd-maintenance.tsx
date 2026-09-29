"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { RefreshCw, DownloadCloud, RotateCcw, CheckCircle2, AlertTriangle } from "lucide-react";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker } from "@/lib/operation-ui";

interface UpdateInfo {
  branch: string;
  installedBuildId: string | null;
  latestBuildId: string | null;
  updateAvailable: boolean;
}

export function SdtdMaintenance({ tint }: { tint: string }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [resetInfo, setResetInfo] = useState<{ world: string; gameName: string; nextGameName: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Both of these hold every resource, so they have to refuse while anything else is
  // running — and say which thing, because a disabled button with no reason is the
  // same failure in miniature as a silent operation.
  const { operations, elapsedMs, refresh: refreshOperations } = useOperations();
  const blocker = powerBlocker(operations, "7dtd");

  async function check() {
    setChecking(true);
    try {
      const [u, r] = await Promise.all([
        fetch("/api/7dtd/update").then((x) => x.json()),
        fetch("/api/7dtd/reset").then((x) => x.json()),
      ]);
      if (!u.error) setInfo(u);
      if (!r.error) setResetInfo(r);
    } catch {
      toast.error("Couldn't check server status");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    check();
  }, []);

  async function doUpdate() {
    setUpdating(true);
    try {
      const res = await fetch("/api/7dtd/update", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Update failed");
        return;
      }
      // No start toast. `toast.success("Update started")` was the *only* feedback that
      // ever existed for a ~17 GB, ~20-minute download, and it was gone in four
      // seconds. The strip at the top of the page now carries it, survives a reload,
      // and keeps carrying it after this request has returned — the synthetic boot
      // operation reads the download's own percentage out of the container log.
      //
      // Nor is the build id re-polled here: it cannot change for twenty minutes, so
      // `setTimeout(check, 8000)` confidently redisplayed the OLD build and "update
      // available" for the whole download.
      await refreshOperations();
    } catch {
      toast.error("Update failed");
    } finally {
      setUpdating(false);
    }
  }

  async function doReset() {
    setResetting(true);
    setConfirmReset(false);
    try {
      const res = await fetch("/api/7dtd/reset", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(data.error || "Reset failed");
      // Success is the operation's own completion toast, which names the new save and
      // whether the server came back up.
      await refreshOperations();
    } catch {
      // A reset stops the server, wipes the save and starts it again, which outlasts
      // Cloudflare's ~100s origin read timeout. Reporting that as "Reset failed" would
      // invite someone to run a destructive operation a second time.
      toast.info(
        "Still resetting. The connection timed out before it finished — watch the strip at the " +
          "top of the page, and don't run it again."
      );
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur" style={{ ["--tint" as string]: tint }}>
      <p className="eyebrow mb-4 text-muted-foreground">Server maintenance</p>

      {blocker && (
        <p className="mb-3 text-xs text-muted-foreground">{blockedReason(blocker, elapsedMs(blocker))}</p>
      )}

      {/* Update */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background/50 p-4 ring-1 ring-foreground/10">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <DownloadCloud className="h-4 w-4" style={{ color: tint }} /> Game version
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {info ? (
              <>
                branch <span className="text-foreground">{info.branch}</span> · build{" "}
                <span className="text-foreground">{info.installedBuildId ?? "?"}</span>
                {info.updateAvailable ? (
                  <span style={{ color: tint }}> → {info.latestBuildId} available</span>
                ) : info.installedBuildId ? (
                  <span className="text-[color:var(--mc)]"> · up to date</span>
                ) : null}
              </>
            ) : (
              "checking…"
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Keep this matched to your Steam client&rsquo;s build — a mismatch stops players joining (stuck at &ldquo;Starting game&rdquo;).
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={check} disabled={checking || updating}>
            <RefreshCw className={checking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> Check
          </Button>
          <Button
            size="sm"
            onClick={doUpdate}
            className="disabled:cursor-not-allowed"
            disabled={updating || !info?.updateAvailable || blocker !== undefined}
            style={info?.updateAvailable ? { background: tint, color: "var(--background)" } : undefined}
          >
            {updating ? "Updating…" : info?.updateAvailable ? "Update now" : info?.installedBuildId ? <><CheckCircle2 className="h-3.5 w-3.5" /> Up to date</> : "Update"}
          </Button>
        </div>
      </div>

      {/* Reset world */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background/50 p-4 ring-1 ring-foreground/10">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <RotateCcw className="h-4 w-4" style={{ color: tint }} /> Reset world
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Wipes the current save and starts fresh on the <span className="font-mono text-foreground">{resetInfo?.world || "current"}</span> map.
            Keeps the map, backs up the old save first, and starts a new game
            {resetInfo ? <> (<span className="font-mono text-foreground">{resetInfo.gameName}</span> → <span className="font-mono" style={{ color: tint }}>{resetInfo.nextGameName}</span>)</> : null}. Everyone starts over.
          </p>
        </div>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirmReset(true)}
          disabled={resetting || blocker !== undefined}
          className="flex-shrink-0 disabled:cursor-not-allowed"
        >
          {resetting ? "Resetting…" : "Reset world"}
        </Button>
      </div>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" /> Reset the world?
            </DialogTitle>
            <DialogDescription>
              This <strong>deletes all current progress</strong> on{" "}
              <strong>{resetInfo?.world}</strong> and starts a brand-new game
              {resetInfo ? <> as <strong>{resetInfo.nextGameName}</strong></> : null}. The map is kept and the old
              save is backed up first, but everyone will start from scratch. This can&rsquo;t be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button variant="destructive" onClick={doReset}>Reset &amp; start fresh</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
