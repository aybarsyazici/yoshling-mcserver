"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Ban, Check, Globe, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { GAMES } from "@/lib/games";
/**
 * **Types only.** `mc-bans` imports `mc-identity` for its username and UUID checks, and
 * that module pulls in `crypto` and `fs/promises` — a value import here would put node
 * builtins in the browser bundle. `import type` is erased, so this costs nothing at
 * runtime; the API sends `createdIso` precisely so no date parsing is needed on this side.
 */
import type { BannedIpEntry, BannedPlayerEntry } from "@/lib/mc-bans";

/**
 * Bans — the third of the whitelist/ops/bans set, and the only one of the three whose
 * change does not always go to a file.
 *
 * Two things this card must do that the ops and whitelist cards do not:
 *
 *  1. **Say which path a change took.** The server applies a ban immediately over RCON
 *     when it is running, and the json file is the store only when it is stopped. "Saved.
 *     Restart server to apply." — which is what the two cards beside this one say — would
 *     be wrong in the first case and is the whole failure mode named in the task: a ban
 *     that silently does not take effect until the next restart. The route returns the
 *     path it used and the sentence it proved, and this card shows that sentence rather
 *     than composing its own.
 *  2. **Show the file-versus-running disagreement.** Same idea as the memory card's
 *     configured-vs-live comparison: a ban that is in `banned-players.json` but not in
 *     the running server's list is one this page would otherwise display as real while
 *     nothing enforces it.
 *
 * There is no Save button, deliberately. Ops and whitelist edit a local array and PUT the
 * whole thing, so an un-saved edit sits on screen looking applied; here each add and
 * remove is its own request with its own verified outcome, and the list is **replaced
 * with what the server read back** rather than optimistically mutated.
 */

interface BanDrift {
  notEnforced: string[];
  extraLive: number;
}

/** `createdIso` is added by the API — see the import note above. */
type WithIso<T> = T & { createdIso: string | null };

interface BansState {
  players: WithIso<BannedPlayerEntry>[];
  ips: WithIso<BannedIpEntry>[];
  unreadable: { players: number; ips: number };
  malformed: { players: boolean; ips: boolean };
  running: boolean;
  /**
   * Where a change would go right now. `"refuse"` is the container-up-but-silent state —
   * every add and remove would answer 503, so the controls are disabled rather than
   * offered. A button that is certain to refuse is the shape `can: {}` was added to
   * remove from the power controls.
   */
  path: "rcon" | "file" | "refuse";
  live: {
    players: { count: number | null; recognised: boolean } | null;
    ips: { count: number | null; recognised: boolean } | null;
  } | null;
  drift: { players: BanDrift; ips: BanDrift } | null;
}

const TINT = GAMES.minecraft.tint;

/** `createdIso` → `1 Oct 2026`. Blank when the file's date could not be parsed. */
function shortDate(createdIso: string | null): string {
  if (!createdIso) return "";
  const when = new Date(createdIso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function McBansCard() {
  const [state, setState] = useState<BansState | null>(null);
  const [newPlayer, setNewPlayer] = useState("");
  const [newIp, setNewIp] = useState("");
  const [reason, setReason] = useState("");
  /** The target currently in flight, so only its own row's button spins. */
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/server/bans");
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't read the ban list");
        return;
      }
      setState(data);
    } catch {
      toast.error("Couldn't read the ban list");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  /**
   * One request, one outcome, one toast carrying the route's own sentence.
   *
   * The route answers non-2xx for anything it could not confirm, so `res.ok` is the
   * severity — this card never has to decide whether a body means success. The
   * `data.noop` case is a 200 with "nothing changed", which is information rather than a
   * success, hence `toast.info`.
   */
  async function change(action: "ban" | "pardon", kind: "player" | "ip", target: string) {
    setBusy(`${kind}:${target}`);
    try {
      const res =
        action === "ban"
          ? await fetch("/api/server/bans", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind, target, reason }),
            })
          : await fetch(
              `/api/server/bans?kind=${kind}&target=${encodeURIComponent(target)}`,
              { method: "DELETE" }
            );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error || `Couldn't ${action === "ban" ? "ban" : "unban"} ${target}`);
        // A refusal can still have changed the files (a partial is impossible here, but a
        // 409 on a malformed file means the lists on screen are worth re-reading), and a
        // 503 means the running state may have changed under us.
        await load();
        return;
      }

      if (data.noop) toast.info(data.message);
      else toast.success(data.message);

      if (action === "ban") {
        setNewPlayer("");
        setNewIp("");
        setReason("");
      }
      // Replace the lists with what the route read back off disk rather than mutating
      // the local copy: the point of this card is that what it shows was observed.
      if (Array.isArray(data.players) && Array.isArray(data.ips)) {
        setState((prev) => (prev ? { ...prev, players: data.players, ips: data.ips } : prev));
      }
      // Drift and the live counts come from the GET, which is the only thing that asks
      // the running server for its whole list.
      await load();
    } catch {
      toast.error("The request failed");
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <div className="skeleton h-56 rounded-2xl" />;

  const totalBans = state.players.length + state.ips.length;
  const drift = state.drift;
  const notEnforced = [...(drift?.players.notEnforced ?? []), ...(drift?.ips.notEnforced ?? [])];
  const extraLive = (drift?.players.extraLive ?? 0) + (drift?.ips.extraLive ?? 0);
  const unreadable = state.unreadable.players + state.unreadable.ips;
  const malformed = state.malformed.players || state.malformed.ips;
  /**
   * Both reasons a change cannot be made right now, so every control reads the one flag.
   * `refuse` is the container-up-but-silent state and `malformed` is an unparseable ban
   * file; in both cases the route answers non-2xx, and an enabled button that is certain
   * to be refused is the exact shape the `can: {}` flags were added to remove from the
   * power controls.
   */
  const cannotChange = malformed || state.path === "refuse";

  return (
    <Card className="border-border/50 shadow-sm" style={{ ["--tint" as string]: TINT }}>
      <CardHeader>
        <CardTitle>Bans (banned-players.json / banned-ips.json)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
          Which path a change will take, stated before the button rather than after the
          fact. The two cards below this one can honestly say "restart to apply" because
          a whitelist edit is only ever a file write; a ban is not.
        */}
        <p className="text-xs text-muted-foreground">
          {state.path === "rcon"
            ? "The server is running, so bans are applied over RCON and take effect straight away."
            : state.path === "file"
              ? "The server is stopped, so bans are written to the ban files and take effect the next time it starts."
              : "Bans can't be changed right now — see below."}{" "}
          Usernames are resolved to the UUID Minecraft matches on. Only IPv4 addresses can
          be banned.
        </p>

        {state.path === "refuse" && (
          <Notice tone="bad">
            The Minecraft container is running but isn&apos;t answering RCON, so a ban
            can&apos;t be applied and the ban files can&apos;t be edited either — the server
            rewrites them from its own list, so an edit now would be discarded. Restart the
            server from the Controls tab, then come back.
          </Notice>
        )}

        {malformed && (
          <Notice tone="bad">
            One of the ban files isn&apos;t valid JSON. Bans can&apos;t be changed until
            that&apos;s fixed — rewriting the file would delete the bans already in it.
          </Notice>
        )}

        {unreadable > 0 && (
          <Notice tone="warn">
            {unreadable} {unreadable === 1 ? "entry" : "entries"} in the ban files
            couldn&apos;t be read and {unreadable === 1 ? "is" : "are"} not listed below.
          </Notice>
        )}

        {/*
          The configured-vs-live comparison. `notEnforced` is the one that matters: those
          bans are on disk, shown on this page, and the running server is not applying
          them — which is what editing the file behind a running server leaves behind.
        */}
        {notEnforced.length > 0 && (
          <Notice tone="warn">
            The running server isn&apos;t enforcing {notEnforced.length} of these:{" "}
            <strong className="text-foreground">{notEnforced.join(", ")}</strong>. The files
            were changed while it was up, so it still has its own list. Restart it to load
            these.
          </Notice>
        )}

        {extraLive > 0 && (
          <Notice tone="warn">
            The running server is enforcing {extraLive} more{" "}
            {extraLive === 1 ? "ban" : "bans"} than the files account for.
          </Notice>
        )}

        {/*
          "Up, but its list could not be read" is not the same as "no drift", and must not
          render as the green line below. The `refuse` notice already covers the common
          cause; this catches the case where one of the two banlist reads came back and the
          other did not, so no comparison was made.
        */}
        {state.running && state.drift === null && state.path !== "refuse" && (
          <Notice tone="warn">
            The server&apos;s ban list couldn&apos;t be read, so nothing below has been
            checked against what it is actually enforcing.
          </Notice>
        )}

        {state.drift && notEnforced.length === 0 && extraLive === 0 && totalBans > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5" style={{ color: TINT }} />
            In effect: the running server is enforcing every ban listed here.
          </p>
        )}

        {/* ── Players ── */}
        <div className="space-y-2">
          <p className="eyebrow text-muted-foreground">Banned players</p>
          {state.players.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players banned</p>
          ) : (
            <div className="space-y-1.5">
              {state.players.map((p) => (
                <BanRow
                  key={p.uuid || p.name}
                  icon={User}
                  label={p.name}
                  meta={[p.reason, p.source && `by ${p.source}`, shortDate(p.createdIso)]}
                  stale={drift?.players.notEnforced.includes(p.name) ?? false}
                  busy={busy === `player:${p.name}`}
                  disabled={busy !== null || cannotChange}
                  onRemove={() => change("pardon", "player", p.name)}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Minecraft username"
              value={newPlayer}
              onChange={(e) => setNewPlayer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newPlayer.trim()) change("ban", "player", newPlayer.trim());
              }}
              className="max-w-xs"
            />
            <Button
              variant="outline"
              disabled={busy !== null || cannotChange || newPlayer.trim() === ""}
              onClick={() => change("ban", "player", newPlayer.trim())}
            >
              {busy === `player:${newPlayer.trim()}` ? "Banning..." : "Ban player"}
            </Button>
          </div>
        </div>

        {/* ── IPs ── */}
        <div className="space-y-2">
          <p className="eyebrow text-muted-foreground">Banned IP addresses</p>
          {state.ips.length === 0 ? (
            <p className="text-sm text-muted-foreground">No addresses banned</p>
          ) : (
            <div className="space-y-1.5">
              {state.ips.map((ip) => (
                <BanRow
                  key={ip.ip}
                  icon={Globe}
                  label={ip.ip}
                  meta={[ip.reason, ip.source && `by ${ip.source}`, shortDate(ip.createdIso)]}
                  stale={drift?.ips.notEnforced.includes(ip.ip) ?? false}
                  busy={busy === `ip:${ip.ip}`}
                  disabled={busy !== null || cannotChange}
                  onRemove={() => change("pardon", "ip", ip.ip)}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="203.0.113.4"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newIp.trim()) change("ban", "ip", newIp.trim());
              }}
              className="max-w-xs font-mono"
            />
            <Button
              variant="outline"
              disabled={busy !== null || cannotChange || newIp.trim() === ""}
              onClick={() => change("ban", "ip", newIp.trim())}
            >
              {busy === `ip:${newIp.trim()}` ? "Banning..." : "Ban address"}
            </Button>
          </div>
        </div>

        {/* One reason field for both, because it is attached to whichever ban is added
            next. Optional: the route substitutes the same default text the game does. */}
        <div className="space-y-1.5">
          <Label className="text-xs">Reason (optional)</Label>
          <Input
            placeholder="Banned by an operator."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="max-w-md"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * `.op-warn` / `.op-bad` rather than `text-chart-5`, which measures 2.15:1 in Latte —
 * see the colour note in `docs/OPERATIONS.md`. Any outcome stated as text uses these.
 */
function Notice({ tone, children }: { tone: "warn" | "bad"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl p-3 ring-1",
        tone === "bad" ? "bg-destructive/10 ring-destructive/30" : "bg-chart-5/10 ring-chart-5/30"
      )}
    >
      <AlertTriangle
        className={cn("mt-0.5 h-4 w-4 flex-shrink-0", tone === "bad" ? "op-bad" : "op-warn")}
      />
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

function BanRow({
  icon: Icon,
  label,
  meta,
  stale,
  busy,
  disabled,
  onRemove,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  meta: (string | false | undefined)[];
  /** On disk but not in the running server's list. */
  stale: boolean;
  busy: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl bg-muted/40 px-3 py-2 ring-1 ring-foreground/5",
        stale && "ring-chart-5/40"
      )}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm">{label}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {meta.filter(Boolean).join(" · ")}
        </p>
      </div>
      {stale && <span className="eyebrow op-warn flex-shrink-0">Not enforced</span>}
      <Button
        size="sm"
        variant="ghost"
        className="flex-shrink-0"
        disabled={disabled}
        onClick={onRemove}
      >
        <Ban className="mr-1 h-3.5 w-3.5" />
        {busy ? "Unbanning..." : "Unban"}
      </Button>
    </div>
  );
}
