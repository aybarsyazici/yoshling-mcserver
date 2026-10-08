"use client";

import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { useMinecraftProfileRequest } from "@/hooks/use-minecraft-profile-request";

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
import type { BannedIpEntry, BannedPlayerEntry, LiveRead } from "@/lib/mc-bans";

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
 * whole thing, so an un-saved edit sits on screen looking applied; here each add and remove
 * is its own request with its own verified outcome, and the lists are **replaced with what
 * the route re-read off disk** rather than optimistically mutated.
 *
 * Off *disk* — said precisely because on the RCON path the two are not the same thing. The
 * files are what the stopped server will load; the `banlist` reply is what the running one is
 * enforcing. The rows come from the files and the drift notice is what compares them, so
 * "read back" here does not mean "confirmed by the server".
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
  /**
   * What each `banlist` read was worth — see `liveReadState` in `mc-bans`.
   *
   * Three states because "the server never answered" and "the server answered with
   * something that could not be read" call for different sentences, and this card is the
   * only place either of them is visible. An earlier version carried `recognised` here and
   * never read it, which is how an unrecognised reply came to be reported as "the server is
   * enforcing nothing".
   */
  live: { players: LiveRead; ips: LiveRead };
  /** `null` per list when nothing was compared — no reply, or an unreadable one. */
  drift: { players: BanDrift | null; ips: BanDrift | null };
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
  const context = useMinecraftProfileRequest();
  const request = context.request;
  const { can } = useGames(CAPABILITY_POLL_MS);
  const canWrite = context.contextReady && can.settingsEdit === true;
  const [state, setState] = useState<BansState | null>(null);
  const [newPlayer, setNewPlayer] = useState("");
  const [newIp, setNewIp] = useState("");
  const [reason, setReason] = useState("");
  /** The target currently in flight, so only its own row's button spins. */
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const res = await request("/api/server/bans");
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
    if (!canWrite) return;
    setBusy(`${kind}:${target}`);
    try {
      const res =
        action === "ban"
          ? await request("/api/server/bans", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind, target, reason }),
            })
          : await request(
              `/api/server/bans?kind=${kind}&target=${encodeURIComponent(target)}`,
              { method: "DELETE" }
            );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error || `Couldn't ${action === "ban" ? "ban" : "unban"} ${target}`);
        /**
         * Re-read anyway, because **a refusal does not mean nothing happened**. The 503 for
         * "answered, then went quiet" is the case that forces this: the command went out on a
         * socket the probe had just proved live, so the server may have executed it and
         * rewritten the ban file itself before going silent. The route's own sentence says the
         * outcome is unknown and points here; the reload is what makes that advice work.
         */
        await load();
        return;
      }

      if (data.noop) toast.info(data.message);
      else toast.success(data.message);

      // Only the field that was submitted. Clearing both wiped a half-typed address when a
      // player ban succeeded, which is a silent loss of the operator's own input in the one
      // moment they were told everything went right.
      if (action === "ban") {
        if (kind === "player") setNewPlayer("");
        else setNewIp("");
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
  const notEnforced = [...(drift.players?.notEnforced ?? []), ...(drift.ips?.notEnforced ?? [])];
  const extraLive = (drift.players?.extraLive ?? 0) + (drift.ips?.extraLive ?? 0);
  const unreadable = state.unreadable.players + state.unreadable.ips;
  /**
   * **Both** lists were compared. The green "in effect" line below speaks for everything on
   * the card, so one readable list out of two does not earn it — a player list that checked
   * out says nothing about the IP bans sitting underneath it.
   */
  const compared = drift.players !== null && drift.ips !== null;
  /** The server answered and its list could not be parsed — not the same as not answering. */
  const unparsedReply = state.live.players === "unreadable" || state.live.ips === "unreadable";

  /**
   * **Per kind, and gated on the path that is actually in use.**
   *
   * A malformed ban file only blocks a change that has to go *through* that file. On the
   * RCON path the route never opens it — it sends `ban`/`pardon` and reads the server's own
   * list back — so disabling the controls for a bad `banned-players.json` took away the one
   * working way to ban somebody, and the notice beside it said bans could not be changed
   * while they could. `refuse` is the other reason, and that one really does apply to both
   * kinds: nothing can be changed while the container is up and silent.
   *
   * Per kind because the two files fail independently: an unparseable `banned-players.json`
   * says nothing about whether an IP can be banned.
   */
  const blockedForFile = (kind: "players" | "ips") =>
    state.path === "file" && state.malformed[kind];
  const cannotChangePlayers = !canWrite || state.path === "refuse" || blockedForFile("players");
  const cannotChangeIps = !canWrite || state.path === "refuse" || blockedForFile("ips");

  /** Which files are unparseable, named, so the notices can say which and what follows. */
  const badFiles = [
    state.malformed.players && "banned-players.json",
    state.malformed.ips && "banned-ips.json",
  ].filter(Boolean) as string[];

  return (
    <Card className="border-border/50 shadow-sm" style={{ ["--tint" as string]: TINT }}>
      <CardHeader>
        <CardTitle>Bans (banned-players.json / banned-ips.json)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
          Which path a change will take, stated before the button rather than after the fact.
          The ops and whitelist cards further up this page can honestly say "restart to apply"
          because an edit to either is only ever a file write; a ban is not.
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

        {/*
          Two different things to say about an unparseable file, because what follows from it
          depends entirely on which path a change takes. On the file path it blocks the edit;
          on the RCON path it does not block anything, and claiming it did was false — but
          the list below is still short by however much the file holds, so silence would be
          wrong too.
        */}
        {badFiles.length > 0 && state.path === "file" && (
          <Notice tone="bad">
            {badFiles.join(" and ")} {badFiles.length === 1 ? "isn't" : "aren't"} valid JSON.
            The server is stopped, so a change has to go through{" "}
            {badFiles.length === 1 ? "that file" : "those files"} — and rewriting{" "}
            {badFiles.length === 1 ? "it" : "them"} would delete the bans already there, so
            that half of this card is blocked until it&apos;s fixed.
          </Notice>
        )}

        {badFiles.length > 0 && state.path !== "file" && (
          <Notice tone="warn">
            {badFiles.join(" and ")} {badFiles.length === 1 ? "isn't" : "aren't"} valid JSON,
            so the {badFiles.length === 1 ? "list" : "lists"} below {" "}
            {badFiles.length === 1 ? "leaves" : "leave"} out whatever the file holds. Bans
            still work — the server is running, so they go over RCON and never touch the file
            — but fix the file before stopping it, or it will start with no bans.
          </Notice>
        )}

        {unreadable > 0 && (
          <Notice tone="warn">
            {unreadable} {unreadable === 1 ? "entry" : "entries"} in the ban files
            couldn&apos;t be read and {unreadable === 1 ? "is" : "are"} not listed below.
          </Notice>
        )}

        {/*
          The configured-vs-live comparison. `notEnforced` is the one that matters: those bans
          are on disk, shown on this page, and the running server's own list does not hold
          them.

          Deliberately **not** attributed to one cause. The copy used to assert "the files
          were changed while it was up" for every entry; that is the common cause and not the
          only one — an entry whose uuid the game cannot use lands here too, and so does one
          naming an account the server resolves to a different canonical name. A sentence that
          names the wrong cause sends the reader to fix the wrong thing, so this one says what
          was observed and offers the restart as what to try.
        */}
        {notEnforced.length > 0 && (
          <Notice tone="warn">
            {notEnforced.length} of these {notEnforced.length === 1 ? "is" : "are"} on disk but
            not in the running server&apos;s own ban list:{" "}
            <strong className="text-foreground">{notEnforced.join(", ")}</strong>. Nothing is
            enforcing {notEnforced.length === 1 ? "it" : "them"} right now. Most often the
            files were changed while the server was up, in which case restarting it loads{" "}
            {notEnforced.length === 1 ? "this" : "these"}.
          </Notice>
        )}

        {extraLive > 0 && (
          <Notice tone="warn">
            The running server is enforcing {extraLive} more{" "}
            {extraLive === 1 ? "ban" : "bans"} than the files account for.
          </Notice>
        )}

        {/*
          Two distinct failures, and they used to share one sentence. "Nothing answered" is
          usually a server on its way up or down; "answered with something unreadable" is a
          reply this parser could not take apart — a non-English locale, a modded reply, or
          entry lines run together with no separator — and it means the comparison is
          unavailable for a server that is demonstrably fine. Either way: not "no drift".
        */}
        {unparsedReply && (
          <Notice tone="warn">
            The server answered, but its ban list came back in a form this page
            couldn&apos;t read, so nothing below has been checked against what it&apos;s
            actually enforcing.
          </Notice>
        )}

        {state.running && !compared && !unparsedReply && state.path !== "refuse" && (
          <Notice tone="warn">
            The server&apos;s ban list couldn&apos;t be read, so nothing below has been
            checked against what it is actually enforcing.
          </Notice>
        )}

        {compared && notEnforced.length === 0 && extraLive === 0 && totalBans > 0 && (
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
                  stale={drift.players?.notEnforced.includes(p.name) ?? false}
                  busy={busy === `player:${p.name}`}
                  disabled={busy !== null || cannotChangePlayers}
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
              // Gated on the same flag as the button beside it. A `disabled` button does not
              // disable the Enter key in the field next to it, so without this the one path
              // that is certain to be refused stayed reachable by the quickest input there is.
              onKeyDown={(e) => {
                if (e.key === "Enter" && newPlayer.trim() && !busy && !cannotChangePlayers) {
                  change("ban", "player", newPlayer.trim());
                }
              }}
              className="max-w-xs"
            />
            <Button
              variant="outline"
              disabled={busy !== null || cannotChangePlayers || newPlayer.trim() === ""}
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
                  stale={drift.ips?.notEnforced.includes(ip.ip) ?? false}
                  busy={busy === `ip:${ip.ip}`}
                  disabled={busy !== null || cannotChangeIps}
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
                if (e.key === "Enter" && newIp.trim() && !busy && !cannotChangeIps) {
                  change("ban", "ip", newIp.trim());
                }
              }}
              className="max-w-xs font-mono"
            />
            <Button
              variant="outline"
              disabled={busy !== null || cannotChangeIps || newIp.trim() === ""}
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
