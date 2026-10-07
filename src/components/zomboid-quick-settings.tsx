"use client";

import { fileRevision, revisionHeaders } from "@/lib/file-revision-client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { Reveal } from "@/components/motion";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker } from "@/lib/operation-ui";
import { describeIniSave, type PzIniSaveReport } from "@/lib/zomboid-ini-contract";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/**
 * The handful of Project Zomboid settings people actually change, lifted out of
 * the ~140 in the .ini. Reads and writes the same endpoint as the full editor,
 * so there's one source of truth and no second copy to drift.
 */
const FIELDS = [
  { key: "PublicName", label: "Server name", hint: "Shown in the server browser", kind: "text" },
  { key: "Password", label: "Password", hint: "Leave blank for an open server", kind: "text" },
  // Was "Mind the 8 GB box". The box has had 16 GB since the netcup migration, and the
  // ceiling is derived at request time by `maxGameGb()` anyway — a figure hardcoded in a
  // hint is a figure that outlives the hardware, which is how this one came to
  // under-provision by half.
  { key: "MaxPlayers", label: "Max players", hint: "Mind the box's RAM", kind: "number" },
  { key: "Public", label: "List in the server browser", hint: "Off = join by IP only", kind: "bool" },
  { key: "PVP", label: "Players can hurt each other", hint: "", kind: "bool" },
  {
    key: "PauseEmpty",
    label: "Pause when nobody's online",
    hint: "Stops time passing while the server is empty",
    kind: "bool",
  },
] as const;

export function ZomboidQuickSettings({ tint }: { tint: string }) {
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  /**
   * `/api/zomboid/config` PUT takes the `files:zomboid` lane, and a power operation
   * declares every file lane — so a restore, a backup or a hand-off all make this Save
   * return 409. Without the gate the button stayed live, and the reply was a red toast
   * for a refusal nothing had explained.
   */
  const { operations, elapsedMs } = useOperations();
  const blocker = powerBlocker(operations, "zomboid");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/zomboid/config", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Couldn't read the server config (HTTP ${res.status}).`);
      if (!Array.isArray(data?.properties)) throw new Error("The server config response is incomplete.");
      const found: Record<string, string> = {};
      for (const p of data.properties) {
        if (!p || typeof p.name !== "string" || typeof p.value !== "string") throw new Error("The server config response is incomplete.");
        if (FIELDS.some((f) => f.key === p.name)) {
          if (p.name in found) throw new Error("The server config response contains duplicate fields.");
          found[p.name] = p.value;
        }
      }
      if (FIELDS.some((f) => !(f.key in found) || (f.kind === "bool" && !["true", "false"].includes(found[f.key])) ||
          (f.kind === "number" && !/^\d+$/.test(found[f.key])))) throw new Error("The server config response is incomplete.");
      setRevision(fileRevision(res));
      setValues(found); setDraft(found); setLoadError(null);
      setWarning(typeof data.warning === "string" ? data.warning : null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Couldn't read the server config.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // load updates state only after the awaited network read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (can.settings) void load();
  }, [can.settings, load]);

  const dirty = values ? FIELDS.filter((f) => draft[f.key] !== values[f.key]) : [];

  async function save() {
    if (!can.settingsEdit || !values || loadError || loading || saving || dirty.length === 0) return;
    setSaving(true);
    try {
      const updates = Object.fromEntries(dirty.map((f) => [f.key, draft[f.key] ?? ""]));
      const res = await fetch("/api/zomboid/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...revisionHeaders(revision) },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.stale) setLoadError(data.error);
        toast.error(data.error || "Couldn't save");
        return;
      }

      // The old line was `toast.success("Settings saved. Restart Project Zomboid to
      // apply.")` — unconditional, and wrong twice over. It claimed a save for keys the
      // route had refused, and it demanded a restart for settings the running server
      // picks up from `reloadoptions` (none of the six fields here is in
      // `RESTART_KEYS`). Changing the player cap cost a restart that kicked everyone.
      //
      // So the sentence now comes from what the route reports it did, and only the keys
      // it lists are written back into the displayed values — a field the server refused
      // must snap back to the real value rather than keep showing the edit.
      const report: PzIniSaveReport = {
        applied: Array.isArray(data.applied) ? data.applied : [],
        ignored: Array.isArray(data.ignored) ? data.ignored : [],
        locked: Array.isArray(data.locked) ? data.locked : [],
        restartNeeded: Array.isArray(data.restartNeeded) ? data.restartNeeded : [],
        live: data.live ?? null,
      };
      const accepted = Object.fromEntries(
        Object.entries(updates).filter(([key]) => report.applied.includes(key))
      );
      setValues((prev) => ({ ...(prev ?? {}), ...accepted }));
      setDraft((d) => {
        const next = { ...d };
        // `?? ""` and not `?? next[f.key]`: a field the .ini has no key for has no value to
        // restore, and leaving the typed one in place keeps the form dirty forever — the
        // Save button stays live and every press is refused again.
        for (const f of FIELDS) {
          if (!report.applied.includes(f.key)) next[f.key] = values?.[f.key] ?? "";
        }
        return next;
      });

      const { tone, message } = describeIniSave(report);
      if (tone === "success") toast.success(message);
      else if (tone === "warning") toast.warning(message);
      else toast.error(message);
      if (fileRevision(res)) setRevision(fileRevision(res));
      else await load();
    } catch {
      toast.info("The settings save result is unconfirmed. Read the config again before retrying.");
      setLoadError("The save result could not be confirmed.");
    } finally {
      setSaving(false);
    }
  }

  if (!can.settings) return <p className="text-sm text-muted-foreground">Server settings require settings access.</p>;
  if (values === null && loading) return <div className="skeleton h-72 rounded-2xl" />;
  if (values === null) return <div role="alert" className="rounded-2xl bg-card/70 p-6">
    <p>{loadError}</p><Button onClick={() => { setLoading(true); void load(); }} disabled={loading}>Retry quick settings</Button>
  </div>;

  return (
    <Reveal>
      <div className="space-y-6 rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur">
        <p className="eyebrow text-muted-foreground">Quick settings</p>
        {loadError && <div role="alert"><p>{loadError} The fields show the last successful read.</p><Button onClick={() => { setLoading(true); void load(); }} disabled={loading}>Retry quick settings</Button></div>}
        {warning && <p className="text-xs text-chart-5">{warning}</p>}
        <div className="grid gap-5 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-sm">{f.label}</Label>
              {f.kind === "bool" ? (
                <div className="flex h-9 items-center gap-2">
                  <Switch
                    disabled={!can.settingsEdit || !!loadError || loading}
                    checked={(draft[f.key] ?? "false") === "true"}
                    onCheckedChange={(c) =>
                      setDraft((d) => ({ ...d, [f.key]: c ? "true" : "false" }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {(draft[f.key] ?? "false") === "true" ? "Yes" : "No"}
                  </span>
                </div>
              ) : (
                <Input
                  disabled={!can.settingsEdit || !!loadError || loading}
                  type={f.kind === "number" ? "number" : "text"}
                  value={draft[f.key] ?? ""}
                  placeholder={f.key === "Password" ? "No password" : undefined}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              )}
              {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-5">
          <Button
            onClick={save}
            disabled={!can.settingsEdit || !!loadError || loading || saving || dirty.length === 0 || blocker !== undefined}
            style={{ background: tint, color: "var(--background)" }}
          >
            {saving ? "Saving…" : "Save settings"}
          </Button>
          {/* The reason ships with the disable. A control that goes dead without saying
              why is the same failure as a silent operation.

              This used to end "applies on the next restart", for all six fields. None of
              them is in `RESTART_KEYS`: a running server picks every one of them up from
              `reloadoptions`, which the save now calls and then verifies with
              `showoptions`. The caption no longer promises either outcome — the toast
              reports whichever actually happened, because whether the server is up is
              not something this card knows. */}
          <p className="text-xs text-muted-foreground">
            {blocker
              ? blockedReason(blocker, elapsedMs(blocker))
              : dirty.length > 0
              ? `${dirty.length} changed · saving asks the server to reload them`
              : "Saved settings are reloaded by the server straight away, if it's running."}
          </p>
        </div>
      </div>
    </Reveal>
  );
}
