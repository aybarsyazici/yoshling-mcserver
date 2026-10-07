"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pluralise } from "@/lib/format";
import { GAMES } from "@/lib/games";
import type { ApplyOutcome } from "@/lib/modpack-apply";

/** Reports counted origin results or an unconfirmed response, without guessing execution. */
export function ApplyReportDialog({
  outcome,
  onClose,
}: {
  outcome: ApplyOutcome | null;
  onClose: () => void;
}) {
  const open = outcome?.kind === "report" || outcome?.kind === "still-running";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* **`--tint` has to be set here, and it never was.**
          It is only ever set by an inline style on a page wrapper (`grep '"--tint"'`), and a
          dialog renders through a **portal into `document.body`** — outside that wrapper, so
          the variable is undefined. `color-mix(in oklab, var(--tint) …)` with an undefined
          custom property is an invalid value and the whole declaration is dropped, so the
          skipped-mods block below has been bordered in *nothing* since the accent was added,
          while its own comment explained that the colour was the claim. One line, and the
          claim is true. (Minecraft's accent by name: both callers of this dialog are the
          Minecraft mods page.) */}
      <DialogContent
        className="max-w-2xl max-h-[80vh] overflow-y-auto"
        style={{ ["--tint" as string]: GAMES.minecraft.tint }}
      >
        {outcome?.kind === "still-running" ? (
          <StillRunning operationId={outcome.operationId} packName={outcome.packName} onClose={onClose} />
        ) : outcome?.kind === "report" ? (
          <Report report={outcome.report} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StillRunning({ packName, operationId, onClose }: { packName: string; operationId?: string; onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        {/* **No counts, and not destructive.** Nothing on this path knows how many mods
            landed or whether work continues. The old wording —
            "Installed 0 of 0 mods" in `text-destructive` — named a failure that had not
            happened on exactly the runs long enough to hit the timeout. */}
        <DialogTitle>Install result unconfirmed · {packName}</DialogTitle>
        <DialogDescription>
          The connection ended before a usable install result arrived.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 pt-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          The install may still be running on the server. Its result is unknown until the operation strip reports it.
          {operationId && <> Operation {operationId}.</>}
        </p>
        <p>
          Watch the operation strip at the top of the page for the per-mod result, and
          don&apos;t start it again — a second apply deletes what the first one has written
          so far.
        </p>
      </div>
      <div className="flex justify-end pt-2">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

function Report({
  report,
  onClose,
}: {
  report: Extract<ApplyOutcome, { kind: "report" }>["report"];
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        {/* Destructive only when the apply genuinely installed nothing. The counts come
            from the route, which derives them from what it actually wrote. */}
        <DialogTitle className={report.installed === 0 ? "text-destructive" : undefined}>
          Installed {report.installed} of {report.total} mods
        </DialogTitle>
        <DialogDescription>
          {report.packName}
          {report.installed > 0 ? " — restart the server to apply." : ""}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 pt-2">
        {report.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">{report.error}</p>
          </div>
        )}

        {report.warnings.map((w, i) => (
          <div key={i} className="rounded-lg border border-chart-5/30 bg-chart-5/5 p-3">
            <p className="text-xs text-chart-5">{w}</p>
          </div>
        ))}

        {/* Skipped client-only mods, bordered in the world's own accent (`--tint`) rather
            than the amber `chart-5` the warning blocks above use. The colour is the claim:
            nothing went wrong here, and dressing a correct decision as a warning is how a
            report teaches people to ignore it. The route used to push the same sentence
            into `warnings` as well, so one decision rendered twice in two contradictory
            colours on every apply of every real pack. Named one per row with the reason,
            because a count alone cannot be checked. */}
        {report.skipped.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {pluralise(report.skipped.length, "client-only mod")} skipped
            </p>
            <p className="text-xs text-muted-foreground">
              These do not run on a dedicated server, so they were left out instead of being
              copied into the server&apos;s mods folder. Install them in your own launcher.
            </p>
            <div className="max-h-[30vh] overflow-y-auto rounded-lg border border-[var(--tint)]/30">
              {report.skipped.map((s, i) => (
                <p
                  key={i}
                  className="px-3 py-1.5 text-xs border-b border-border/40 last:border-0 break-words"
                >
                  <span className="font-mono">{s.name}</span>
                  <span className="text-muted-foreground"> — {s.reason}</span>
                </p>
              ))}
            </div>
          </div>
        )}

        {report.errors.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {pluralise(report.errors.length, "mod")} failed
            </p>
            <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border/50">
              {report.errors.map((err, i) => (
                <p
                  key={i}
                  className="px-3 py-1.5 text-xs font-mono border-b border-border/40 last:border-0 break-words"
                >
                  {err}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </>
  );
}
