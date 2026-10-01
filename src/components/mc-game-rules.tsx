"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, RotateCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker } from "@/lib/operation-ui";
import {
  gameRuleLabel,
  gameRuleMeta,
  groupGameRules,
  inferGameRuleType,
  isDefaultGameRuleValue,
} from "@/lib/mc-gamerules";

/**
 * The Minecraft game-rule panel.
 *
 * Until this existed the dashboard could *detect* that a `server.properties` key had moved
 * to a game rule and refuse to write it — `/api/server/properties` does exactly that for
 * four keys — and then had to tell the operator to type `gamerule <x> false` into the
 * console, for 48-odd rules none of which it listed. Somebody was doing it by hand:
 * `mob_griefing` is false on the live server and nothing in this app set it.
 *
 * ## Every row shows what the game said, never what was typed
 *
 * A write is `gamerule <id> <value>` followed by a **fresh** `gamerule <id>` query, and the
 * value rendered after a save is the one that second query returned. The route sends a 502
 * when the two disagree, so a rule the server quietly declined cannot land here as a green
 * toast — this project's recurring defect, and the reason the confirmed tick stays on the
 * row instead of being a toast that lives four seconds.
 *
 * ## No restart note, deliberately
 *
 * Every other settings panel in the app ends with "Restart to apply", because the file it
 * writes is read at boot. A game rule takes effect the moment the command runs, so saying
 * that here would be false. The panel says nothing about persistence either, which is a
 * different claim and one this change did not measure.
 *
 * Ids are listed next to the labels on purpose: 26.1 renamed the rules, so the id is the
 * one thing that lets a reader cross-check a row against the console or against
 * `server.properties`.
 */

interface GameRuleRow {
  id: string;
  value: string;
}

type RowPhase =
  | { kind: "idle" }
  | { kind: "writing" }
  | { kind: "confirmed"; value: string }
  | { kind: "failed"; message: string };

export function McGameRules({ tint }: { tint: string }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [unread, setUnread] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [phases, setPhases] = useState<Record<string, RowPhase>>({});
  /** Draft text for the int fields only; booleans write straight through. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");

  /**
   * The PUT takes the `files:minecraft` lane, and a power operation declares every file
   * lane — so during a hand-off, a stop or a restore every write here comes back 409. Left
   * ungated, the toggles stayed live and the answer was a red toast for a refusal nothing
   * had explained, which is the shape `can:{}` and this hook were added to remove.
   */
  const { operations, elapsedMs } = useOperations();
  const blocker = powerBlocker(operations, "minecraft");
  // `elapsedMs` is a function of the operation, not a number, and it is read on every render
  // so the duration in the sentence keeps counting while the operation runs.
  const blocked = blocker ? blockedReason(blocker, elapsedMs(blocker)) : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/server/gamerules");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Shown, not swallowed. A panel that renders empty on a 403 or on a stopped server
        // reads as "this world has no game rules" — the failure `zomboid-quick-settings.tsx`
        // records as worse than an error, because blank fields look like data.
        //
        // The 403 is reworded because the route answers the bare "Forbidden" every route here
        // answers, and "Forbidden" on its own does not say what was forbidden or that reading
        // is the part you lack. The route's own message wins for every other status — a 503
        // naming a powered-off server is more useful than anything this file could invent.
        setError(
          res.status === 403
            ? "Reading the game rules needs admin or mod access — each one is a command run on the server."
            : data.error || "Couldn't read the game rules."
        );
        setValues(null);
        return;
      }
      const rows: GameRuleRow[] = Array.isArray(data.rules) ? data.rules : [];
      setValues(Object.fromEntries(rows.map((r) => [r.id, r.value])));
      setOrder(rows.map((r) => r.id));
      setUnread(Array.isArray(data.unread) ? data.unread : []);
      setWarning(typeof data.warning === "string" ? data.warning : null);
      setError(null);
      setPhases({});
      setDrafts({});
    } catch {
      setError("Couldn't reach the dashboard to read the game rules.");
      setValues(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function write(id: string, value: string) {
    setPhases((p) => ({ ...p, [id]: { kind: "writing" } }));
    try {
      const res = await fetch("/api/server/gamerules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: id, value }),
      });
      const data = await res.json().catch(() => ({}));
      // `data.value` is the route's read-back and is authoritative on BOTH paths: the 502
      // for "the server did not take it" carries the value the rule is actually at, so a
      // refused write snaps the control back to the truth rather than leaving it showing
      // the position it was dragged to.
      if (typeof data.value === "string") {
        setValues((prev) => (prev ? { ...prev, [id]: data.value } : prev));
        setDrafts((prev) => ({ ...prev, [id]: data.value }));
      }
      if (!res.ok) {
        const message = data.error || "Couldn't set that game rule.";
        setPhases((p) => ({ ...p, [id]: { kind: "failed", message } }));
        toast.error(message);
        return;
      }
      setPhases((p) => ({ ...p, [id]: { kind: "confirmed", value: data.value ?? value } }));
      toast.success(
        data.changed
          ? `${id} is ${data.value}.`
          : `${id} was already ${data.value} — nothing changed.`
      );
    } catch {
      const message = "The request didn't complete, so this rule's value is unconfirmed.";
      setPhases((p) => ({ ...p, [id]: { kind: "failed", message } }));
      toast.error(message);
    }
  }

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = needle
      ? order.filter(
          (id) =>
            id.toLowerCase().includes(needle) ||
            gameRuleLabel(id).toLowerCase().includes(needle) ||
            (gameRuleMeta(id)?.help ?? "").toLowerCase().includes(needle)
        )
      : order;
    return groupGameRules(visible);
  }, [order, filter]);

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader>
        <CardTitle>Game rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Read from the running server over RCON and written the same way. Unlike the
          settings above, a game rule takes effect as soon as you change it — no restart.
          The list is whatever the running Minecraft build has, so the names match the
          version you are on.
        </p>

        {blocked && (
          <div className="flex items-start gap-2 rounded-xl bg-chart-5/10 p-3 ring-1 ring-chart-5/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-chart-5" />
            <p className="text-xs text-muted-foreground">{blocked}</p>
          </div>
        )}

        {loading && !values && <div className="skeleton h-40 rounded-2xl" />}

        {error && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 ring-1 ring-destructive/30">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RotateCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
              Try again
            </Button>
          </div>
        )}

        {/*
          Belt and braces: the route answers 502 rather than 200-with-nothing when it reads no
          values, so this should be unreachable — but a card that renders only its own intro
          paragraph reads as "this server has no game rules", and that is too cheap a sentence
          to leave to one route's status code.
        */}
        {values && order.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">
            The server didn&apos;t report any game rules. Re-read, or check{" "}
            <span className="font-mono text-xs">help gamerule</span> in the console.
          </p>
        )}

        {values && order.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative max-w-xs flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-xs"
                  placeholder={`Filter ${order.length} rules`}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
                <RotateCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
                Re-read
              </Button>
            </div>

            {warning && <p className="op-warn text-[11px] leading-snug">{warning}</p>}

            {unread.length > 0 && (
              /*
                Named rather than omitted. These are rules the server listed and then did not
                report a value for — a build whose reply shape changed, or the read budget
                running out. Dropping them would make the panel look complete while a setting
                was simply absent from it.
              */
              <p className="text-[11px] leading-snug text-muted-foreground">
                {unread.length} {unread.length === 1 ? "rule was" : "rules were"} listed by the
                server but couldn&apos;t be read: {unread.join(", ")}. Re-read to try again.
              </p>
            )}

            {groups.length === 0 && (
              <p className="text-sm text-muted-foreground">No rule matches that filter.</p>
            )}

            {groups.map((group) => (
              <div key={group.title} className="space-y-2">
                <p className="eyebrow text-muted-foreground">{group.title}</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.ids.map((id) => {
                    const value = values[id];
                    const meta = gameRuleMeta(id);
                    const type = inferGameRuleType(value);
                    const phase = phases[id] ?? { kind: "idle" };
                    const draft = drafts[id] ?? value;
                    const atDefault = isDefaultGameRuleValue(id, value);
                    const busy = phase.kind === "writing" || !!blocked;
                    return (
                      <div key={id} className="space-y-1.5">
                        <Label className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                          <span>{gameRuleLabel(id)}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{id}</span>
                        </Label>

                        {type === "boolean" ? (
                          /*
                            `checked` is the read-back and there is deliberately no optimistic
                            local state behind it, so the switch does not move until the game
                            has confirmed the new value — it reads as momentarily unresponsive
                            and "Setting..." covers that. Do not "fix" it by tracking the
                            pressed position: a control that moves on click shows what was
                            typed, which is the exact thing the route makes a second query to
                            avoid claiming.
                          */
                          <div className="flex items-center gap-2 pt-1">
                            <Switch
                              checked={value === "true"}
                              disabled={busy}
                              onCheckedChange={(v) => write(id, v ? "true" : "false")}
                            />
                            <span className="text-xs text-muted-foreground">
                              {phase.kind === "writing"
                                ? "Setting..."
                                : value === "true"
                                  ? "Enabled"
                                  : "Disabled"}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Input
                              className="h-8 text-xs"
                              type="number"
                              value={draft}
                              disabled={busy}
                              onChange={(e) =>
                                setDrafts((prev) => ({ ...prev, [id]: e.target.value }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && draft !== value) write(id, draft);
                              }}
                            />
                            {/* Only offered when it would do something, so pressing it is
                                never a no-op that still toasts. */}
                            {draft !== value && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 px-2 text-xs"
                                disabled={busy}
                                onClick={() => write(id, draft)}
                              >
                                {phase.kind === "writing" ? "..." : "Set"}
                              </Button>
                            )}
                          </div>
                        )}

                        {/*
                          The proof, kept on the row. This is the read-back the route did
                          after writing — not the value that was typed — which is the whole
                          reason the route makes a second query.
                        */}
                        {phase.kind === "confirmed" && (
                          <p
                            className="flex items-center gap-1 text-[11px] leading-snug"
                            style={{ color: tint }}
                          >
                            <Check className="h-3 w-3 flex-shrink-0" />
                            The server reports {phase.value}.
                          </p>
                        )}
                        {phase.kind === "failed" && (
                          <p className="op-bad text-[11px] leading-snug">{phase.message}</p>
                        )}

                        {meta?.help && (
                          <p className="text-[11px] leading-snug text-muted-foreground">
                            {meta.help}
                          </p>
                        )}
                        {/*
                          How a rule somebody set by hand becomes visible. Hedged to "the
                          vanilla default" because that column is published 1.21.x behaviour
                          and was not read off this deployment — see `mc-gamerules.ts`.
                        */}
                        {atDefault === false && meta && (
                          <p className="text-[11px] leading-snug text-muted-foreground">
                            Not the vanilla default ({meta.default}).
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
