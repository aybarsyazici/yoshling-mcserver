"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Reveal } from "@/components/motion";
import { useOperations } from "@/components/operations-provider";
import { blockedReason, powerBlocker } from "@/lib/operation-ui";
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

  useEffect(() => {
    fetch("/api/zomboid/config")
      .then((r) => r.json())
      .then((data) => {
        // `data.error` first. The GET requires `settings.read` now — the `.ini` carries
        // `Password` and `DiscordToken` — and this read `data.properties ?? []`, so a
        // refusal rendered as a panel of blank fields with no message at all, while
        // `config-panel.tsx` next to it toasted the explanation. Blank fields are worse
        // than an error: they look like a server with no settings.
        if (data.error) {
          setWarning(String(data.error));
          return;
        }
        const found: Record<string, string> = {};
        for (const p of data.properties ?? []) {
          if (FIELDS.some((f) => f.key === p.name)) found[p.name] = p.value;
        }
        setValues(found);
        setDraft(found);
        setWarning(data.warning ?? null);
      })
      .catch(() => setWarning("Couldn't read the server config."));
  }, []);

  const dirty = values ? FIELDS.filter((f) => draft[f.key] !== values[f.key]) : [];

  async function save() {
    if (dirty.length === 0) return;
    setSaving(true);
    try {
      const updates = Object.fromEntries(dirty.map((f) => [f.key, draft[f.key] ?? ""]));
      const res = await fetch("/api/zomboid/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json();
      if (res.ok) {
        setValues((prev) => ({ ...(prev ?? {}), ...updates }));
        toast.success("Settings saved. Restart Project Zomboid to apply.");
      } else {
        toast.error(data.error || "Couldn't save");
      }
    } finally {
      setSaving(false);
    }
  }

  if (values === null) {
    return <div className="skeleton h-72 rounded-2xl" />;
  }

  if (warning) {
    return (
      <div className="rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur">
        <p className="text-sm text-muted-foreground">{warning}</p>
      </div>
    );
  }

  return (
    <Reveal>
      <div className="space-y-6 rounded-2xl bg-card/70 p-6 ring-1 ring-foreground/10 backdrop-blur">
        <p className="eyebrow text-muted-foreground">Quick settings</p>
        <div className="grid gap-5 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-sm">{f.label}</Label>
              {f.kind === "bool" ? (
                <div className="flex h-9 items-center gap-2">
                  <Switch
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
            disabled={saving || dirty.length === 0 || blocker !== undefined}
            style={{ background: tint, color: "var(--background)" }}
          >
            {saving ? "Saving…" : "Save settings"}
          </Button>
          {/* The reason ships with the disable. A control that goes dead without saying
              why is the same failure as a silent operation. */}
          <p className="text-xs text-muted-foreground">
            {blocker
              ? blockedReason(blocker, elapsedMs(blocker))
              : dirty.length > 0
              ? `${dirty.length} changed · applies on the next restart`
              : "Changes apply on the next server restart."}
          </p>
        </div>
      </div>
    </Reveal>
  );
}
