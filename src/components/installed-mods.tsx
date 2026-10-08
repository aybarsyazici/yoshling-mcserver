"use client";

import { useMinecraftProfileRequest } from "@/hooks/use-minecraft-profile-request";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ModListFilters } from "@/components/mod-list-filters";
import { filterMinecraftMods, MINECRAFT_MOD_STATES, MINECRAFT_MOD_ORIGINS, type MinecraftModStateFilter, type MinecraftModOriginFilter } from "@/lib/mod-list-filters";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { GAMES } from "@/lib/games";
import { GameMark } from "@/components/glyphs";
import { formatBytes, pluralise } from "@/lib/format";
import { CAPABILITY_POLL_MS, useGames } from "@/lib/use-games";
import { AddModDialog } from "@/components/add-mod-dialog";
import { ChangePackDialog } from "@/components/change-pack-dialog";
import {
  packHeadline,
  packVersionNote,
  provenanceCounts,
  provenanceSentence,
} from "@/lib/mod-provenance";
/**
 * **Types only.** `mod-inventory` reads the filesystem and hashes jars, so it imports
 * `node:crypto` and `node:fs` — a value import here would put node builtins in the
 * browser bundle. `import type` is erased, so this costs nothing at runtime, and the API
 * sends `installedAt` as ISO and `installedByName` already resolved precisely so this
 * side needs neither a date library nor a second request. Same pattern and same reason as
 * `mc-bans-card.tsx`.
 */
import type { InstalledReading, InventoryEntry } from "@/lib/mod-inventory";

const TINT = GAMES.minecraft.tint;

/**
 * **The mods page's spine: one list of what is on the server, with the pack as a header.**
 *
 * Two shapes were wrong here and the second one is the interesting one.
 *
 * The page listed `InstalledMod` rows and called that "Installed", with nothing ever
 * comparing them against the directory the server loads from. `/api/mods/installed`
 * reconciles the two now and this renders all three answers: a row and its jar agreeing, a
 * jar with no row, and a row whose jar is gone. The drift bands name their members, because
 * "2 untracked jars" sends somebody to the file browser to guess which two.
 *
 * And it was the **second of three tabs** — behind "Browse mods", which until 2026-10-02
 * could not install anything — with all the power on the page nested inside a sub-tab of
 * the third. "Modpacks" with a Modrinth search beneath it nests a *source* under a
 * *collection*, and the empty state of the collection was where the install instructions
 * lived, which is the clearest possible proof the hierarchy was inverted. So: one page, one
 * list, and the pack is a **header**, because which pack is on a server is server state and
 * not a library item.
 *
 * **Provenance is the informational heart**, and it is carried by the *grouping* rather than
 * by a badge on every row. "Which of these did the pack put there and which did we add
 * ourselves" was not answerable by anything in this app before `InstalledMod.source`; four
 * identical-looking pills would bury the answer it finally has.
 */
interface State extends InstalledReading {
  /** Not from the API: when this reading was taken, so "Re-check" visibly does something. */
  readAt: number;
}

const STATE_STYLE: Record<InventoryEntry["state"], { rail: string }> = {
  matched: { rail: TINT },
  untracked: { rail: "var(--op-warn)" },
  missing: { rail: "var(--destructive)" },
};

/**
 * The groups the list is split into, in reading order: problems first.
 *
 * `kind` lands on the element as `data-group`, and it is there for the tests — the same
 * reason the drift bands carry `data-band`. A group heading and a row a few pixels below it
 * are indistinguishable in `document.body.textContent`, which is how a mutant that replaced
 * every band's file names with `"2 file(s)"` passed the whole suite. **If you add a group,
 * give it a `kind`**, and assert the names inside it.
 */
interface Group {
  kind: string;
  heading: string;
  /** One line under the heading. This is where the provenance claim is actually made. */
  note: string;
  match(mod: InventoryEntry): boolean;
}

const GROUPS: Group[] = [
  {
    kind: "missing",
    heading: "Missing their jar",
    note: "The record is here and the file is not, so the server will not load these.",
    match: (m) => m.state === "missing",
  },
  {
    kind: "untracked",
    heading: "Not installed from here",
    note: "The server loads these; this dashboard has no record of them.",
    match: (m) => m.state === "untracked",
  },
  {
    kind: "pack",
    heading: "From a pack",
    note: "Installed by a modpack apply. Applying another pack replaces all of these.",
    match: (m) => m.state === "matched" && m.source === "pack",
  },
  {
    kind: "manual",
    heading: "Added one at a time",
    note: "Installed individually, not by a pack — a pack apply removes these too.",
    match: (m) => m.state === "matched" && m.source === "manual",
  },
  {
    kind: "unrecorded",
    heading: "No record of how these arrived",
    note:
      "Installed before this dashboard recorded where a mod came from, or restored from " +
      "an archive that carried no record.",
    match: (m) => m.state === "matched" && m.source !== "pack" && m.source !== "manual",
  },
];

export function InstalledMods() {
  const context = useMinecraftProfileRequest();
  const request = context.request;
  // `can.modsRemove` / `can.modsInstall`; see `CAPABILITY_POLL_MS` for why it is not 5 s.
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  /** Sticky: once hashes have been asked for, a re-check keeps asking for them. */
  const [withHashes, setWithHashes] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [changePackOpen, setChangePackOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<MinecraftModStateFilter>("all");
  const [originFilter, setOriginFilter] = useState<MinecraftModOriginFilter>("all");
  const resetFilters = () => { setQuery(""); setStateFilter("all"); setOriginFilter("all"); };

  const readInstalled = useCallback(async (hash: boolean): Promise<State> => {
    const response = await request(`/api/mods/installed${hash ? "?hash=1" : ""}`);
    const data = (await response.json()) as InstalledReading & { error?: string };
    if (!response.ok || !Array.isArray(data.mods)) throw new Error(data.error || "Couldn't read what is installed.");
    return { ...data, readAt: Date.now() };
  }, [request]);
  const load = useCallback(async (hash: boolean, opts: { spinner?: boolean } = {}) => {
    if (opts.spinner) setLoading(true);
    try { setState(await readInstalled(hash)); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't read what is installed."); }
    finally { setLoading(false); }
  }, [readInstalled]);

  useEffect(() => {
    let current = true;
    void readInstalled(false).then((reading) => { if (current) setState(reading); })
      .catch((error) => { if (current) toast.error(error instanceof Error ? error.message : "Couldn't read what is installed."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [readInstalled]);

  async function handleRemove(mod: InventoryEntry) {
    if (!context.contextReady || !mod.id || !can.modsRemove) return;
    setRemoving(mod.id);
    try {
      const response = await request(`/api/mods/${mod.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        toast.error(typeof data?.error === "string" ? data.error : `Couldn't remove ${mod.name}`);
      } else if (data?.success === true) {
        toast.success(`${mod.name} removed. Restart server to apply.`);
      } else {
        toast.info(`${mod.name}'s removal result is unconfirmed. Reading the current inventory before another attempt.`);
      }
    } catch {
      toast.info(`${mod.name}'s removal result is unconfirmed. Reading the current inventory before another attempt.`);
    } finally {
      // Reconcile after every receipt or lost reply; do not infer the row/jar state or retry DELETE.
      await load(withHashes);
      setRemoving(null);
    }
  }

  /** Two jars with the same bytes under different names — what the hash is good for. */
  const twins = useMemo(() => twinsOf(state?.mods ?? []), [state]);
  /** Where each jar came from, counted. Drives the header and the Change pack review. */
  const counts = useMemo(() => provenanceCounts({ mods: state?.mods ?? [] }), [state]);

  if (loading && !state) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted" />
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

  const { mods, untracked, missing, ignored, modsDirPresent, hashed } = state;
  const headline = packHeadline(state.pack, counts);
  const versionNote = packVersionNote(state.pack, state.server);
  // Problems first — the whole reason this list is a reconcile and not a listing. The
  // groups are walked in order and every entry lands in exactly one of them.
  const visibleMods = filterMinecraftMods(mods, query, stateFilter, originFilter);
  const filtersActive = query.trim().length > 0 || stateFilter !== "all" || originFilter !== "all";
  const grouped = GROUPS.map((g) => ({ group: g, mods: visibleMods.filter(g.match) })).filter(
    (g) => g.mods.length > 0
  );

  return (
    <div data-minecraft-tour="mods-installed" className="space-y-4" style={{ ["--tint" as string]: TINT }}>
      {/* ── the pack, as server state ───────────────────────────────────────── */}
      <section
        data-pack-header
        className="overflow-hidden rounded-3xl bg-card/60 ring-1 ring-border backdrop-blur"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex min-w-0 items-start gap-3">
            <GameMark
              game="minecraft"
              className="mt-0.5 h-8 w-8 shrink-0"
              style={{ color: TINT }}
            />
            <div className="min-w-0">
              <p className="eyebrow" style={{ color: TINT }}>
                Pack on the server
              </p>
              <h2
                className={cn(
                  "font-display text-xl font-bold tracking-tight",
                  // A real pack name is the heading; "No pack applied" is a *state*, and
                  // setting it in the same weight makes an absence look like a title.
                  !headline.named && "text-base font-semibold text-muted-foreground"
                )}
              >
                {headline.title}
              </h2>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                {headline.detail}
              </p>
              {/* Real drift, and previously invisible: the version dropdown can be changed
                  after a pack is applied and the jars do not move with it. */}
              {versionNote && (
                <p className="op-warn mt-1.5 max-w-xl text-xs leading-relaxed">{versionNote}</p>
              )}
            </div>
          </div>
          {/* `/api/modpacks/import` and `/api/mods/install-modpack` both check
              `mods.install`, so this is gated — hidden rather than disabled, like every
              other write on this page. There is deliberately **no "Remove pack"**: nothing
              removes a set of mods as one operation, and N client-side DELETEs would be a
              bulk destructive action with no rollback archive, no operation record and a
              partial-failure state this page could not report. Per-row Remove is the
              supported way out; Change pack is the supported way to replace the set. */}
          {can.modsInstall && (
            <Button variant="outline" onClick={() => setChangePackOpen(true)}>
              Change pack
            </Button>
          )}
        </div>
      </section>

      {/* ── the reading, and what it cost to take ───────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card/60 px-4 py-3 ring-1 ring-border backdrop-blur">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            {provenanceSentence(counts)}
            {state.totalBytes > 0 && (
              <span className="text-muted-foreground"> · {formatBytes(state.totalBytes)}</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{verdict(state)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* **Not gated — searching Modrinth is a read.** The old page had a `Browse mods`
              tab open to everyone, and making this button the only door to `ModBrowser` took
              that away from a MEMBER: a capability lost by a redesign meant to stop offering
              capabilities nobody has. The *install* is gated where the request is made, on the
              card (`mod-card.tsx` takes `canInstall`), so a MEMBER can look and cannot write.

              The label changes with the capability instead, because "Add a mod" is a promise
              to someone who cannot. */}
          <Button
            variant={can.modsInstall ? "default" : "outline"}
            onClick={() => setAddOpen(true)}
            // The game's own accent, the way `game-backups.tsx` does it for `Create backup`.
            // CLAUDE.md puts the per-game accent on `--tint`, and this page's primary action
            // is the one place on it that should read as Minecraft's rather than the app's
            // default mauve. Only on the writable variant: an outline `Browse mods` is not the
            // page's main action and tinting it would claim an emphasis it does not have.
            style={can.modsInstall ? { background: TINT, color: "var(--background)" } : undefined}
          >
            {can.modsInstall ? "Add a mod" : "Browse mods"}
          </Button>
          {!hashed && counts.jars > 0 && (
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
          heading={`${pluralise(missing.length, "mod")} ${missing.length === 1 ? "has" : "have"} no jar on disk`}
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
          {/* Says what the reading is and what to do about it, and **stops short of
              naming a consequence nobody here has observed.** The duplicate is a measured
              fact — identical digests under two names; that it crashes Fabric is a claim
              this code cannot check, and it has not been seen on this box. */}
          <p className="mt-2">
            Nothing needs two copies of the same jar. Delete one of each pair from the file
            browser.
          </p>
        </Band>
      )}
      {/* "Nothing is wrong" is only true when there is also nothing expecting the folder.
          With rows in the database and no directory, every one of them is `missing` and the
          band above says "The server will not load it" — so this printed a reassurance
          directly underneath a problem. Gated on there being nothing to be wrong. */}
      {!modsDirPresent && (
        <Band tone="muted" kind="no-dir" heading="There is no mods folder on the server yet">
          <p>
            Minecraft creates it on first start, and installing a mod creates it too.
            {missing.length === 0
              ? " Nothing is wrong."
              : ` ${pluralise(missing.length, "mod")} on this list ${missing.length === 1 ? "expects" : "expect"} it, which is why ` +
                `${missing.length === 1 ? "it is" : "they are"} shown as missing above.`}
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

      <ModListFilters searchLabel="Search Minecraft mods" placeholder="Name, project ID or jar filename"
        query={query} onQueryChange={setQuery} active={filtersActive} onReset={resetFilters}
        filters={[
          { label: "File state", value: stateFilter, options: MINECRAFT_MOD_STATES, onChange: (value) => setStateFilter(value as MinecraftModStateFilter) },
          { label: "Recorded origin", value: originFilter, options: MINECRAFT_MOD_ORIGINS, onChange: (value) => setOriginFilter(value as MinecraftModOriginFilter) },
        ]}
        count={`Showing ${visibleMods.length} of ${mods.length} mod entries`}
        note="Filters change the rows below. The server summary, warnings and pack actions cover the full inventory." />

      {/* ── the list, grouped by where each jar came from ───────────────────── */}
      {mods.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p className="text-lg">No mods installed</p>
          <p className="mt-1 text-sm">
            {can.modsInstall
              ? "Add a mod to install one, or change the pack to install a whole set."
              : "Nothing is in the server's mods folder."}
          </p>
        </div>
      ) : visibleMods.length === 0 ? (
        <div className="rounded-2xl bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">No Minecraft mods match these filters.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={resetFilters}>Show all mods</Button>
        </div>
      ) : (
        <div className="space-y-5" data-mod-list="minecraft">
          {grouped.map(({ group, mods: rows }) => (
            <section key={group.kind} data-group={group.kind}>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-2 px-1">
                <h3 className="text-sm font-semibold">{group.heading}</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {rows.length}
                </span>
                <p className="w-full text-xs leading-relaxed text-muted-foreground sm:w-auto">
                  {group.note}
                </p>
              </div>
              <ul className="space-y-2">
                {rows.map((mod) => (
                  <Row
                    key={mod.id ?? `file:${mod.fileName}`}
                    mod={mod}
                    hashed={hashed}
                    canRemove={can.modsRemove && context.contextReady}
                    // **`mod.id != null &&` is load-bearing.** `removing` is `null` when
                    // nothing is being removed and an untracked entry's `id` is also
                    // `null`, so a bare `removing === mod.id` is `true` for every untracked
                    // row — which renders its control stuck on "Removing...". It is
                    // currently invisible because the button is gated on `mod.id` as well,
                    // and that is exactly the kind of second guard that stops being there:
                    // a mutation that removed it found this.
                    removing={mod.id != null && removing === mod.id}
                    onRemove={() => void handleRemove(mod)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Both dialogs re-read on close rather than being told what landed — the list is a
          reading of the directory, and an install or an apply that half-worked has to show
          up as drift rather than as whatever the dialog assumed. */}
      <AddModDialog
        activeRequest={context}
        open={addOpen}
        onOpenChange={setAddOpen}
        onClosed={() => void load(withHashes)}
      />
      <ChangePackDialog
        open={changePackOpen}
        onOpenChange={setChangePackOpen}
        counts={counts}
        request={context}
        onApplied={() => void load(withHashes)}
      />
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
      // **`data-busy` is what makes the `mod.id != null` guard below observable**, and that
      // is why it is here rather than only on the button. `removing` is `null` when nothing
      // is being removed and an untracked entry's `id` is also `null`, so a bare
      // `removing === mod.id` is `true` for every untracked row. With the label only inside
      // a button that is itself gated on `mod.id`, dropping that guard changes nothing a
      // test can see — measured: the mutation survived the whole suite. On the row it is
      // visible, so the guard is pinned instead of merely commented.
      data-busy={removing ? "true" : undefined}
      aria-busy={removing || undefined}
    >
      {/* The state rail: one glance tells a clean row from a drifted one. The group heading
          above says *why*; this is what makes a problem findable while scrolling. */}
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
function verdict(inv: Pick<InstalledReading, "untracked" | "missing" | "matched">): string {
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
