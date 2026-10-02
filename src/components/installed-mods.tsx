"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES } from "@/lib/games";
import { formatBytes, pluralise } from "@/lib/format";
import { CAPABILITY_POLL_MS, useGames } from "@/lib/use-games";
/**
 * **Types only.** `mod-inventory` reads the filesystem and hashes jars, so it imports
 * `node:crypto` and `node:fs` — a value import here would put node builtins in the
 * browser bundle. `import type` is erased, so this costs nothing at runtime, and the API
 * sends `installedAt` as ISO and `installedByName` already resolved precisely so this
 * side needs neither a date library nor a second request. Same pattern and same reason as
 * `mc-bans-card.tsx`.
 */
import type { InventoryEntry, ModInventory } from "@/lib/mod-inventory";

const TINT = GAMES.minecraft.tint;

/**
 * **Installed mods — the reconcile, rendered.**
 *
 * This page used to list `InstalledMod` rows and call that "Installed". Nothing had ever
 * compared them with the directory the server loads from, so the heading was a claim about
 * the app's memory rather than about the server. `/api/mods/installed` reconciles the two
 * now and this renders all three answers: a row and its jar agreeing, a jar with no row,
 * and a row whose jar is gone.
 *
 * The drift bands name their members. A count of untracked jars cannot be acted on; a file
 * name can — it is what you would look for in the file browser.
 */

interface State extends ModInventory {
  /** Not from the API: when this reading was taken, so "Re-check" visibly does something. */
  readAt: number;
}

const STATE_STYLE: Record<
  InventoryEntry["state"],
  { rail: string; label: string | null; chip: string | null }
> = {
  matched: { rail: TINT, label: null, chip: null },
  untracked: {
    rail: "var(--op-warn)",
    label: "Not in the list",
    chip: "op-warn",
  },
  missing: {
    rail: "var(--destructive)",
    label: "File is gone",
    chip: "op-bad",
  },
};

const SOURCE_LABEL: Record<"pack" | "manual", string> = {
  pack: "Pack",
  manual: "Installed on its own",
};

export function InstalledMods() {
  // `can.modsRemove` only; see `CAPABILITY_POLL_MS` for why it is not the 5 s default.
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Sticky: once hashes have been asked for, a re-check keeps asking for them. */
  const [withHashes, setWithHashes] = useState(false);

  /**
   * `spinner` separates the two readings this does. The mount read does not touch
   * `loading` — it starts `true`, and setting it again from inside the effect is a
   * cascading render for no effect on screen. A re-read asked for by a button does set it,
   * so Re-check visibly becomes "Re-reading…".
   *
   * (It does **not** silence `react-hooks/set-state-in-effect`; that rule flags the direct
   * call in the effect body regardless, and it fires in five other components here. Only a
   * deferral dodges it, which is a worse trade than the warning.)
   */
  const load = useCallback(async (hash: boolean, opts: { spinner?: boolean } = {}) => {
    if (opts.spinner) setLoading(true);
    try {
      const res = await fetch(`/api/mods/installed${hash ? "?hash=1" : ""}`);
      const data = (await res.json()) as ModInventory & { error?: string };
      if (!res.ok || !Array.isArray(data.mods)) {
        toast.error(data.error || "Couldn't read what is installed.");
        return;
      }
      setState({ ...data, readAt: Date.now() });
    } catch {
      toast.error("Couldn't reach the server to read what is installed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  async function handleRemove(mod: InventoryEntry) {
    if (!mod.id) return;
    setRemoving(mod.id);
    try {
      const res = await fetch(`/api/mods/${mod.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(`${mod.name} removed. Restart server to apply.`);
        // Re-read rather than splice the row out locally. The row and the jar are two
        // things and the point of this page is that it does not assume they agree: a
        // `removeMod` whose `unlink` hit ENOENT leaves the jar, which the next reconcile
        // reports as untracked. Dropping the row from local state would hide exactly that.
        await load(withHashes);
      } else {
        // Both of these were `toast.error("Failed to remove mod")` with the body never
        // read, so `/api/mods/[id]`'s own message — which says *why* — was discarded.
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || `Couldn't remove ${mod.name}`);
      }
    } catch {
      toast.error(`Couldn't reach the server to remove ${mod.name}. Nothing was changed.`);
    } finally {
      setRemoving(null);
    }
  }

  /** Two jars with the same bytes under different names — what the hash is good for. */
  const twins = useMemo(() => twinsOf(state?.mods ?? []), [state]);

  if (loading && !state) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (!state) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Couldn&apos;t read what is installed. Try again.
      </p>
    );
  }

  const { mods, matched, untracked, missing, ignored, modsDirPresent, hashed } = state;
  // Problems first — the whole reason this list is a reconcile and not a listing.
  const order: InventoryEntry["state"][] = ["missing", "untracked", "matched"];
  const sorted = [...mods].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));

  return (
    <div className="space-y-4" style={{ ["--tint" as string]: TINT }}>
      {/* ── the reading, and what it cost to take ───────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card/60 px-4 py-3 ring-1 ring-border backdrop-blur">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {matched.length > 0 || untracked.length > 0
              ? `${pluralise(matched.length + untracked.length, "jar")} in the mods folder`
              : "No jars in the mods folder"}
            {state.totalBytes > 0 && (
              <span className="text-muted-foreground"> · {formatBytes(state.totalBytes)}</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{verdict(state)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!hashed && (matched.length > 0 || untracked.length > 0) && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => {
                setWithHashes(true);
                void load(true, { spinner: true });
              }}
            >
              {/* Deliberately not called "Verify": nothing stores the digest Modrinth
                  published, so this cannot check a jar against its publisher. What it can
                  do is tell two jars apart — or find the same bytes under two names. */}
              Hash the jars
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void load(withHashes, { spinner: true })}
          >
            {loading ? "Re-reading…" : "Re-check"}
          </Button>
        </div>
      </div>

      {/* ── drift, named ────────────────────────────────────────────────────── */}
      {missing.length > 0 && (
        <Band
          tone="bad"
          kind="missing"
          heading={`${pluralise(missing.length, "mod")} has no jar on disk`}
        >
          <Names names={missing} />
          <p className="mt-2">
            The server will not load {missing.length === 1 ? "it" : "them"}. Remove the entry
            here to clear the record, or install the mod again to put the file back.
          </p>
        </Band>
      )}
      {untracked.length > 0 && (
        <Band
          tone="warn"
          kind="untracked"
          heading={`${pluralise(untracked.length, "jar")} in the mods folder ${
            untracked.length === 1 ? "is" : "are"
          } not in this list`}
        >
          <Names names={untracked} />
          <p className="mt-2">
            The server loads {untracked.length === 1 ? "it" : "them"} anyway — this page is
            the only thing that did not know about {untracked.length === 1 ? "it" : "them"}.
            Delete {untracked.length === 1 ? "it" : "them"} from the file browser, or install
            the mod through this page so it is tracked.
          </p>
        </Band>
      )}
      {twins.length > 0 && (
        <Band
          tone="warn"
          kind="twins"
          heading="The same bytes are on disk under more than one name"
        >
          {twins.map((group) => (
            <p key={group.join("|")} className="mt-1">
              <Names names={group} />
            </p>
          ))}
        </Band>
      )}
      {!modsDirPresent && (
        <Band tone="muted" kind="no-dir" heading="There is no mods folder on the server yet">
          <p>
            Minecraft creates it on first start, and installing a mod creates it too.
            Nothing is wrong.
          </p>
        </Band>
      )}
      {ignored.length > 0 && (
        <Band
          tone="muted"
          kind="ignored"
          heading={`${pluralise(ignored.length, "other file")} in the mods folder`}
        >
          <Names names={ignored} />
          <p className="mt-2">
            Not a <code>.jar</code>, so not counted as a mod either way.
          </p>
        </Band>
      )}

      {/* ── the list ────────────────────────────────────────────────────────── */}
      {sorted.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p className="text-lg">No mods installed</p>
          <p className="mt-1 text-sm">Find one on the Browse mods tab and press Install.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {sorted.map((mod) => (
            <Row
              key={mod.id ?? `file:${mod.fileName}`}
              mod={mod}
              hashed={hashed}
              canRemove={can.modsRemove}
              // **`mod.id != null &&` is load-bearing.** `removing` is `null` when nothing
              // is being removed and an untracked entry's `id` is also `null`, so a bare
              // `removing === mod.id` is `true` for every untracked row — which renders
              // its control stuck on "Removing...". It is currently invisible because the
              // button is gated on `mod.id` as well, and that is exactly the kind of
              // second guard that stops being there: a mutation that removed it found
              // this.
              removing={mod.id != null && removing === mod.id}
              onRemove={() => void handleRemove(mod)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  mod,
  hashed,
  canRemove,
  removing,
  onRemove,
}: {
  mod: InventoryEntry;
  hashed: boolean;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const style = STATE_STYLE[mod.state];
  return (
    <li
      className="flex items-stretch gap-0 overflow-hidden rounded-2xl bg-card/60 ring-1 ring-border backdrop-blur"
      data-state={mod.state}
    >
      {/* The state rail: one glance tells a clean row from a drifted one. */}
      <span aria-hidden className="w-1 shrink-0" style={{ background: style.rail }} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{mod.name}</span>
            {mod.version && (
              <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                v{mod.version}
              </span>
            )}
            {style.label && (
              <span
                className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-medium", style.chip)}
                style={{
                  background: `color-mix(in oklab, ${style.rail} 12%, transparent)`,
                }}
              >
                {style.label}
              </span>
            )}
            {/* Provenance. Only on rows — an untracked jar has no row, so there is nothing
                that could have recorded where it came from, and the state chip says so. */}
            {mod.id && (
              <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {mod.source ? SOURCE_LABEL[mod.source] : "source not recorded"}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {mod.mcVersion && <span>MC {mod.mcVersion}</span>}
            {mod.loader && <span className="capitalize">{mod.loader}</span>}
            {mod.sizeBytes != null && <span>{formatBytes(mod.sizeBytes)}</span>}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{mod.fileName}</p>
          {hashed && mod.sha512 && (
            <p
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={mod.sha512}
            >
              sha512 {mod.sha512.slice(0, 16)}…
            </p>
          )}
          {(mod.installedByName || mod.installedAt) && (
            <p className="text-[11px] text-muted-foreground">
              {/* Nothing is said about *who* when the id did not resolve: the column holds
                  whatever `session.user.id` was and an account can be gone, so printing a
                  cuid or guessing a reason would both be worse than the date alone. */}
              {mod.installedByName ? `Added by ${mod.installedByName}` : "Added"}
              {mod.installedAt ? ` · ${shortDate(mod.installedAt)}` : ""}
            </p>
          )}
        </div>
        {/* `DELETE /api/mods/[id]` checks `mods.remove`, so for a MEMBER this button
            was a live destructive control that answered a bare 403. An untracked jar has
            no row to delete, so the control is absent rather than broken — the band above
            names the file browser as the way to remove it. */}
        {canRemove && mod.id && (
          <Button variant="destructive" size="sm" disabled={removing} onClick={onRemove}>
            {removing ? "Removing..." : mod.state === "missing" ? "Clear entry" : "Remove"}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * `kind` is on the element as `data-band`, and it is there for the tests.
 *
 * A band that names a file and a row that prints the same file name are indistinguishable
 * in `document.body.textContent` — which is how a mutant that replaced every band's names
 * with `"2 file(s)"` passed the whole suite. The names have to be asserted *inside the
 * band*, so the band has to be findable.
 */
function Band({
  tone,
  kind,
  heading,
  children,
}: {
  tone: "warn" | "bad" | "muted";
  kind: string;
  heading: string;
  children: React.ReactNode;
}) {
  const colour = tone === "warn" ? "var(--op-warn)" : "var(--destructive)";
  return (
    <div
      data-band={kind}
      className={cn(
        "rounded-2xl px-4 py-3 text-xs",
        tone === "muted" ? "bg-muted/40 text-muted-foreground" : "ring-1",
        tone === "warn" && "op-warn",
        tone === "bad" && "op-bad"
      )}
      style={
        tone === "muted"
          ? undefined
          : {
              background: `color-mix(in oklab, ${colour} 10%, transparent)`,
              ["--tw-ring-color" as string]: `color-mix(in oklab, ${colour} 35%, transparent)`,
            }
      }
    >
      <p className="font-medium">{heading}</p>
      <div className="mt-1 leading-relaxed">{children}</div>
    </div>
  );
}

/** File names, as individually readable chips — the part that makes a band actionable. */
function Names({ names }: { names: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {names.map((n) => (
        <span
          key={n}
          className="rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[11px]"
        >
          {n}
        </span>
      ))}
    </span>
  );
}

/**
 * The one sentence about whether the two sides agree.
 *
 * "They agree" is only said when it was actually checked and nothing differed — which is
 * a measurement this endpoint now takes, and the reason it exists. Before it, the page
 * could not have said this truthfully in either direction.
 */
function verdict(inv: ModInventory): string {
  if (inv.untracked.length === 0 && inv.missing.length === 0) {
    if (inv.matched.length === 0) return "Nothing installed, and nothing on disk.";
    return "Every mod on this list has its jar on disk, and nothing else is there.";
  }
  const parts: string[] = [];
  if (inv.missing.length > 0) parts.push(`${pluralise(inv.missing.length, "missing jar")}`);
  if (inv.untracked.length > 0)
    parts.push(`${pluralise(inv.untracked.length, "untracked jar")}`);
  return `The list and the mods folder disagree: ${parts.join(", ")}.`;
}

/** `createdIso` → `1 Oct 2026`. Blank when the date could not be parsed. */
function shortDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Groups of two or more file names whose jars hashed identically.
 *
 * The one thing a digest can prove without a published reference to compare against: the
 * two writers name files differently (`installMod` uses Modrinth's filename, the Technic
 * path writes `<slug>.jar`), so the same mod really can land twice under two names — and
 * Fabric loading one mod twice is a crash, not a duplicate line in a list.
 */
function twinsOf(mods: InventoryEntry[]): string[][] {
  const byDigest = new Map<string, string[]>();
  for (const m of mods) {
    if (!m.sha512) continue;
    const seen = byDigest.get(m.sha512) ?? [];
    // A `fileName` claimed by two rows is one jar, not two copies of one.
    if (!seen.includes(m.fileName)) seen.push(m.fileName);
    byDigest.set(m.sha512, seen);
  }
  return [...byDigest.values()].filter((g) => g.length > 1);
}
