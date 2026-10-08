"use client";

import { useState } from "react";
import { InstalledMods } from "@/components/installed-mods";
import { Modpacks } from "@/components/modpacks";
import { ModpackBrowserModrinth } from "@/components/modpack-browser-modrinth";
import { SectionHeading } from "@/components/ui-bits";
import { PhotoFooter } from "@/components/photo-footer";
import { GAMES } from "@/lib/games";
import { MinecraftProfileContext } from "@/components/minecraft-profile-context";

/**
 * **One page, one list, the pack as a header.**
 *
 * This was three tabs — **Browse mods / Installed / Modpacks** — with the last holding two
 * sub-tabs of its own, and that split cut across the task rather than along it:
 *
 * - Two of the three were inert until 2026-10-02. You could not install from Browse
 *   (`/api/mods/install` had no caller anywhere in the tree) and could not add from
 *   Installed, so the page opened on a search that could not do anything.
 * - **All the power sat in a nested sub-tab**, and the empty state of the *collection* was
 *   where the install instructions lived, which is the clearest possible proof the
 *   hierarchy was inverted.
 * - "Modpacks" with a **Modrinth** sub-tab nests a *source* under a *collection*, and
 *   stacks two different kinds of thing: a set somebody curated here, and somebody else's
 *   published artefact. The Modrinth sub-tab was a one-shot importer with no reason to
 *   persist as a tab — nothing is ever read from it again.
 *
 * So: what is on the server is the page. Searching Modrinth is an **action** (`Add a mod`,
 * `Change pack`) rather than a place, because that is what it is. Saved sets keep a home,
 * below, as a shelf rather than the spine.
 *
 * Nothing here is deleted from the database: production has nine `Modpack` rows for six
 * distinct packs, three of them `(re-imported)` duplicates and one named `a` with four
 * mods and no target version. The saved-sets section makes that **legible** — an unpinned
 * set says so, a set with no target version says so — which is the honest treatment of a
 * mess somebody may still want.
 */
export default function ModsPage() {
  const tint = GAMES.minecraft.tint;
  /** Changes when a pack is imported, so the saved-set list re-reads. */
  const [refreshKey, setRefreshKey] = useState(0);
  const [showImport, setShowImport] = useState(false);

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: tint }}>
      {/* The subtitle once said "install with one click" for a control that did not exist.
          It now names what the page answers first, because that is the change: the list is
          a *reading* of the mods directory reconciled against the database, not a recital
          of this app's own writes. */}
      <SectionHeading
        eyebrow="Minecraft · Content"
        title="Mods"
        sub="Search Modrinth, install a mod or a whole pack, and see what is on the server."
        tint={tint}
      />

      <MinecraftProfileContext />
      <InstalledMods />

      {/* ── the shelf ───────────────────────────────────────────────────────── */}
      <section className="space-y-4 border-t border-border/60 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow" style={{ color: tint }}>
              Secondary
            </p>
            <h2 className="font-display text-xl font-bold tracking-tight">Saved sets</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Lists of mods kept for later. Apply one to replace what is on the server, or
              export one to install in your own launcher.
            </p>
          </div>
          {/* Mounted only when asked for. `ModpackBrowserModrinth` owns a debounced
              Modrinth search and a capability poll, and neither should run on page load for
              a surface described here as secondary — the Change pack sheet at the top is
              the primary route to a Modrinth pack. */}
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            className="rounded text-sm text-muted-foreground underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
          >
            {showImport ? "Hide the Modrinth search" : "Import a pack from Modrinth"}
          </button>
        </div>

        {showImport && (
          <div className="rounded-2xl bg-card/40 p-4 ring-1 ring-border">
            <p className="mb-3 text-xs text-muted-foreground">
              Importing saves a pack here without touching the server. To install one, use
              Change pack at the top.
            </p>
            <ModpackBrowserModrinth
              onImported={() => {
                setRefreshKey((k) => k + 1);
                setShowImport(false);
              }}
            />
          </div>
        )}

        <Modpacks key={refreshKey} />
      </section>

      <PhotoFooter src="/the-rizzler.jpg" caption="approves of your mod list" />
    </div>
  );
}
