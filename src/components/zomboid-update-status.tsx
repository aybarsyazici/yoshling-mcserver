"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

interface StaleMod {
  id: string;
  title: string;
  installed: number;
  published: number;
}
interface UpdateStatus {
  stale: StaleMod[] | null;
  checkedAt: number | null;
  lastError: string;
  applyingSince: number | null;
  applyingTitles: string[];
  announcedAt: number | null;
  appliedAt: number | null;
  pollMs: number;
  watching: boolean;
}

/**
 * Whether the server's Workshop mods are current.
 *
 * Worth surfacing because a stale mod has no visible symptom on the server: the
 * version check is client-side, so the server logs nothing and simply stops
 * accepting anyone who logs off. This card is the only place that failure is
 * legible before a player reports it.
 *
 * `checkedAt` is shown rather than implied — "up to date" and "the watcher died"
 * are indistinguishable without it.
 */
export function ZomboidUpdateStatus({ tint }: { tint: string }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/zomboid/updates", { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      /* keep last known */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  // While a restart is in flight the state changes on the order of seconds, so a
  // 30s refresh leaves a stale screen during exactly the window someone is
  // watching it.
  useEffect(() => {
    if (!status?.applyingSince) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [status?.applyingSince, load]);

  async function checkNow() {
    setChecking(true);
    try {
      const res = await fetch("/api/zomboid/updates", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't check for updates");
        return;
      }
      const n = data.stale?.length ?? 0;
      if (data.action === "applied") toast.success("Updates applied and the server restarted");
      else if (data.action === "seeded") toast.success("Mods updated on disk");
      else if (data.action === "announced")
        toast.info(`${n} update${n === 1 ? "" : "s"} pending — waiting for the server to empty`);
      else if (data.action === "skipped") toast.info("A server operation is already running");
      else toast.success("All mods are up to date");
      await load();
    } catch {
      toast.error("Network error");
    } finally {
      setChecking(false);
    }
  }

  if (!status) return <div className="skeleton h-24 rounded-2xl" />;

  const stale = status.stale;
  // An apply in progress outranks everything else: the server is being restarted
  // right now, which is the one thing someone looking at this card needs told.
  const applying = status.applyingSince;
  const pending = !applying && stale && stale.length > 0;
  const failed = !applying && (stale === null || status.lastError !== "");

  return (
    <div
      className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur"
      style={{ ["--tint" as string]: tint }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg"
            style={{
              background:
                pending || failed
                  ? "color-mix(in oklab, var(--chart-5) 14%, transparent)"
                  : `color-mix(in oklab, ${tint} 14%, transparent)`,
              color: pending || failed ? "var(--chart-5)" : tint,
            }}
          >
            {applying ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : pending || failed ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="font-display text-base font-semibold">
              {applying
                ? "Updating now — restarting the server"
                : failed
                ? "Couldn't check for updates"
                : pending
                ? `${stale!.length} mod update${stale!.length === 1 ? "" : "s"} pending`
                : "All mods up to date"}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {applying ? (
                <>
                  Saving and stopping, downloading{" "}
                  {status.applyingTitles.length === 1 ? "the mod" : "the mods"}, then starting back
                  up. Usually about 5 minutes. Started {relative(status.applyingSince)}.
                </>
              ) : failed ? (
                status.lastError || "The last check didn't complete."
              ) : pending ? (
                <>
                  The server restarts to apply {stale!.length === 1 ? "it" : "them"} once everyone has
                  logged off. Players have been told in game.
                </>
              ) : (
                <>Steam is checked every {Math.round(status.pollMs / 60000)} minutes.</>
              )}
            </p>
          </div>
        </div>

        <Button variant="outline" size="sm" disabled={checking || !!applying} onClick={checkNow}>
          <RefreshCw className={checking ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          {checking ? "Checking…" : "Check now"}
        </Button>
      </div>

      {applying && status.applyingTitles.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {status.applyingTitles.map((t) => (
            <span key={t} className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]">
              {t}
            </span>
          ))}
        </div>
      )}

      {pending && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {stale!.map((m) => (
            <span
              key={m.id}
              className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]"
              title={`installed ${new Date(m.installed * 1000).toLocaleString()} · published ${new Date(
                m.published * 1000
              ).toLocaleString()}`}
            >
              {m.title}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
        <span>Last checked {relative(status.checkedAt)}</span>
        {status.appliedAt && <span>Last update applied {relative(status.appliedAt)}</span>}
        {!status.watching && (
          <span className="text-chart-5">Automatic checking is turned off</span>
        )}
      </div>
    </div>
  );
}

/** "4 minutes ago" — short, and honest when it has never happened. */
function relative(ts: number | null): string {
  if (!ts) return "never";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
