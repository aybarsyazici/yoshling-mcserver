"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ApplyReportDialog } from "@/components/apply-report-dialog";
import {
  ModpackBrowserModrinth,
  type ModpackResult,
} from "@/components/modpack-browser-modrinth";
import { pluralise } from "@/lib/format";
import { GAMES } from "@/lib/games";
import { importAndApply, type ApplyOutcome } from "@/lib/modpack-apply";
import type { ProvenanceCounts } from "@/lib/mod-provenance";
import { CAPABILITY_POLL_MS, useGames } from "@/lib/use-games";
import { cn } from "@/lib/utils";

/**
 * **Change the pack on the server — search, then *review*, then apply.**
 *
 * The old route to this was: Modpacks tab → Modrinth sub-tab → Import (writes a `Modpack`
 * row) → switch back to My Modpacks → Install to Server → confirm. Six steps, and the one
 * fact that decides whether any of it can work — which Minecraft version the pack needs —
 * appeared only at the end, as a 409 in a toast that lives four seconds. COBBLEVERSE
 * publishes only MC 1.21.1 and `Hoplite` only up to 1.21.11, so on this 26.1.2 server that
 * refusal is the *normal* outcome, and it was being delivered as a surprise.
 *
 * So the comparison is shown **before** the button: what the pack needs beside what the
 * server runs, with Apply refused and the reason on screen when they disagree. The preview
 * (`GET /api/modpacks/preview`) writes nothing, which is also why production has nine
 * `Modpack` rows for six packs — looking at a pack and taking one used to be the same act.
 */
interface Preview {
  modrinthId: string;
  versionId: string;
  versionNumber: string;
  needs: { mcVersion: string; loader: string };
  server: { mcVersion: string; loader: string } | null;
  compatibility: { ok: boolean; mcVersionMatches: boolean; loaderMatches: boolean } | null;
  matchedServerVersion: boolean;
  modCount: number;
  unpinnedCount: number;
  publishedMcVersions: string[];
}

export function ChangePackDialog({
  open,
  onOpenChange,
  counts,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The reading from `/api/mods/installed`, so the review can say what the apply would
   * destroy **by measurement** rather than as a generic warning. "Every mod is removed" is
   * what the old confirm said; "3 jars are removed, 3 of them ones you added yourself" is
   * the sentence somebody can act on.
   */
  counts: ProvenanceCounts;
  /** Re-read the directory after an apply: the page must not assume what landed. */
  onApplied: () => void;
}) {
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [chosen, setChosen] = useState<ModpackResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);

  const load = useCallback(async (pack: ModpackResult) => {
    setReading(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const res = await fetch(
        `/api/modpacks/preview?modrinthId=${encodeURIComponent(pack.project_id)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.modCount !== "number") {
        // The route's own sentence. It distinguishes "Modrinth lists no versions for this
        // pack" from "Modrinth was unreachable", and those lead to different next steps.
        setPreviewError(data?.error || "Couldn't read this pack from Modrinth.");
        return;
      }
      setPreview(data as Preview);
    } catch {
      setPreviewError("Couldn't reach the server to read this pack. Nothing was changed.");
    } finally {
      setReading(false);
    }
  }, []);

  /**
   * Choosing a pack and reading it are **one event**, not a state change plus an effect
   * that notices.
   *
   * The obvious shape is `useEffect(() => { if (chosen) load(chosen) }, [chosen])`, and it
   * is what `react-hooks/set-state-in-effect` flags — correctly here, because nothing
   * external is being synchronised: the preview is wanted because somebody pressed a
   * button, which is exactly where the request belongs.
   */
  function choose(pack: ModpackResult) {
    setChosen(pack);
    void load(pack);
  }

  /**
   * Close, and go back to a clean sheet, so reopening is not step two of the last visit.
   *
   * Every close goes through here — the backdrop, Escape and the X all arrive as the
   * dialog's `onOpenChange`, and the two buttons call it explicitly — so this does not need
   * an effect watching `open` either.
   */
  function setOpen(next: boolean) {
    if (!next) {
      setChosen(null);
      setPreview(null);
      setPreviewError(null);
    }
    onOpenChange(next);
  }

  async function apply() {
    if (!chosen) return;
    setApplying(true);
    try {
      const result = await importAndApply({
        modrinthId: chosen.project_id,
        packName: chosen.title,
      });
      if (result.kind === "error") {
        toast.error(result.message);
        return;
      }
      setOutcome(result.kind === "quiet" ? null : result);
      // The dialog closes on anything that reached the server: the page behind it is about
      // to re-read, and leaving a search sheet open over a fresh reading hides it.
      setOpen(false);
      onApplied();
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* `--tint` is set here because a dialog portals into `document.body`, outside the
            page wrapper that is the only place it is ever defined — see the note in
            `apply-report-dialog.tsx`. Everything accented in here (the comparison block, the
            focus rings, the pack cards' hover ring) reads it. */}
        <DialogContent
          className="max-h-[85vh] w-full max-w-3xl overflow-y-auto sm:max-w-3xl"
          style={{ ["--tint" as string]: GAMES.minecraft.tint }}
        >
          <DialogHeader>
            <DialogTitle>{chosen ? chosen.title : "Change the server's mods"}</DialogTitle>
            <DialogDescription>
              {chosen
                ? "What this pack needs, and what applying it would do."
                : "Find a pack on Modrinth. Nothing is installed until you have seen what it needs."}
            </DialogDescription>
          </DialogHeader>

          {!chosen ? (
            <ModpackBrowserModrinth onChoose={choose} />
          ) : (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => setChosen(null)}
                className="rounded text-xs text-muted-foreground underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
              >
                Back to the search
              </button>

              {reading && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Reading this pack from Modrinth…
                </p>
              )}

              {previewError && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-xs text-destructive">{previewError}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nothing has been changed on the server.
                  </p>
                </div>
              )}

              {preview && (
                <>
                  <VersionComparison preview={preview} />
                  <PackFacts preview={preview} />
                  <Consequences counts={counts} />
                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    {/* The reason, not a disabled button with none. A read-only account can
                        reach this review — the preview is a read — so the one thing it must
                        not do is end in an Apply that answers a bare 403, which is exactly
                        how the power controls' missing gate was reported. */}
                    {!can.modsInstall && (
                      <p className="mr-auto text-xs text-muted-foreground">
                        Your account can look at packs but not change what is installed. Ask
                        an admin to apply this one.
                      </p>
                    )}
                    <Button variant="outline" onClick={() => setOpen(false)}>
                      Cancel
                    </Button>
                    {/* Gated on `mods.install`, the capability both writes behind it check
                        (`/api/modpacks/import` and `/api/mods/install-modpack`). Hidden
                        rather than disabled, like every other write on this page: a
                        disabled Apply with no reason reads as a broken button.

                        `destructive`, because it removes every jar on the server. Disabled
                        on a version mismatch rather than hidden — the reason is on screen
                        directly above it, which is the whole point of the comparison. */}
                    {can.modsInstall && (
                      <Button
                        variant="destructive"
                        disabled={applying || preview.compatibility?.ok !== true}
                        onClick={() => void apply()}
                      >
                        {applying ? "Applying…" : "Apply this pack"}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ApplyReportDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </>
  );
}

/**
 * The comparison, as two rows and a verdict.
 *
 * **Three verdicts, not two.** `compatibility === null` means there is no `ServerConfig`
 * row to compare against, and rendering that as a disagreement is the mistake every
 * settings surface in this app is built to avoid — "not reported" is its own answer.
 */
function VersionComparison({ preview }: { preview: Preview }) {
  const { needs, server, compatibility } = preview;
  const tone = compatibility === null ? "muted" : compatibility.ok ? "ok" : "bad";
  return (
    <div
      data-comparison={tone}
      className={cn(
        "rounded-xl p-3 ring-1",
        tone === "ok" && "ring-[color-mix(in_oklab,var(--tint)_40%,transparent)]",
        tone === "bad" && "op-bad ring-[color-mix(in_oklab,var(--destructive)_35%,transparent)]",
        tone === "muted" && "bg-muted/40 ring-border"
      )}
      style={
        tone === "bad"
          ? { background: "color-mix(in oklab, var(--destructive) 8%, transparent)" }
          : tone === "ok"
            ? { background: "color-mix(in oklab, var(--tint) 8%, transparent)" }
            : undefined
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">This pack needs</dt>
        <dd className="font-mono text-xs sm:text-sm">
          Minecraft {needs.mcVersion} · {needs.loader}
        </dd>
        <dt className="text-muted-foreground">The server runs</dt>
        <dd className="font-mono text-xs sm:text-sm">
          {server ? `Minecraft ${server.mcVersion} · ${server.loader}` : "not recorded"}
        </dd>
      </dl>
      <p className="mt-2 text-xs leading-relaxed">
        {compatibility === null ? (
          <>
            This server has no version recorded yet, so there is nothing to compare against.
            Set the Minecraft version on the settings page first.
          </>
        ) : compatibility.ok ? (
          <>These match, so this pack can be applied.</>
        ) : (
          <>
            {!compatibility.mcVersionMatches && (
              <>
                This pack cannot be applied: it is built for Minecraft {needs.mcVersion} and
                the server is set to {server?.mcVersion}.{" "}
              </>
            )}
            {!compatibility.loaderMatches && (
              <>
                It needs the {needs.loader} loader and the server runs {server?.loader}.{" "}
              </>
            )}
            {/* The versions a pack *does* publish, because "it needs 1.21.1" invites "then
                which build should I pick" — and the answer is often "there is no build for
                this server at all", which is a fact about the pack rather than something to
                keep re-discovering. Changing the server's version is the other way out, and
                it is a decision with its own consequences, so it is named and not offered
                as a button here. */}
            {preview.publishedMcVersions.length > 0 && (
              <>
                It publishes builds for {preview.publishedMcVersions.join(", ")}. Either pick
                a different pack, or change the server&apos;s Minecraft version on the
                settings page first.
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

function PackFacts({ preview }: { preview: Preview }) {
  return (
    <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
      <p>
        <span className="text-foreground">{preview.versionNumber}</span> —{" "}
        {pluralise(preview.modCount, "mod")}.
        {/* Said when it happened, because it explains a version the user did not pick: the
            resolver falls back to the newest build when the server's version has no
            release, and a pack silently pinned to 26.3 on a 26.1.2 server is how the
            re-import "repair" produced another unusable pack. */}
        {!preview.matchedServerVersion && (
          <> This is the pack&apos;s newest build; it has none for this server&apos;s version.</>
        )}
      </p>
      {preview.unpinnedCount > 0 && (
        <p>
          {preview.unpinnedCount === preview.modCount
            ? "None of its mods carries a pinned version"
            : `${preview.unpinnedCount} of its ${preview.modCount} mods carry no pinned version`}
          , so the newest matching build of those is what gets installed — not necessarily
          what the pack author shipped.
        </p>
      )}
      {/* **Not knowable here, and said so rather than guessed.** The client-only count comes
          from reading every mod's Modrinth version, which is what the apply itself does over
          up to 166 sequential requests. Putting a number here would mean either doing that
          work in a dialog or inventing one. A large pack is 30-50% client mods, so this is
          not a footnote. */}
      <p>
        How many of these are client-only is decided during the apply, which reads each
        mod&apos;s build. Those are left out of the server&apos;s mods folder and named in
        the report afterwards.
      </p>
      <p>Applying also saves this pack under Saved sets, so it can be re-applied or exported.</p>
    </div>
  );
}

/**
 * What applying would do to what is on the server now — counted, not warned about.
 *
 * The old confirm dialog said "this will remove every mod currently installed", which is
 * true and says nothing about whether that is three jars or eighty-one, or how many of them
 * somebody on this box installed by hand. `provenanceCounts` already has both numbers.
 */
function Consequences({ counts }: { counts: ProvenanceCounts }) {
  return (
    <div className="rounded-xl bg-muted/40 p-3 text-xs leading-relaxed">
      <p className="font-medium">What happens to the mods on the server now</p>
      <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
        <li>
          {counts.jars === 0 ? (
            <>Nothing is installed, so nothing is removed.</>
          ) : (
            <>
              All {pluralise(counts.jars, "jar")} in the mods folder are removed first
              {counts.ownInstall > 0 && (
                <>
                  {" "}
                  — including the {pluralise(counts.ownInstall, "mod")} added one at a time
                  rather than by a pack
                </>
              )}
              .
            </>
          )}
        </li>
        <li>
          The world folder and the mods directory are archived first as a rollback point, and
          restoring that archive puts both back.
        </li>
        {/* The same sentence the standing banner on the saved-sets section uses, word for
            word. Two surfaces warning about one thing in two wordings is how one of them
            ends up being the wrong one. */}
        <li>Changing mods under an existing world can lose modded items and blocks.</li>
      </ul>
    </div>
  );
}
