"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModBrowser } from "@/components/mod-browser";
import { GAMES } from "@/lib/games";

/**
 * **Searching Modrinth is an action, not a place.**
 *
 * It was a tab — "Browse mods", the page's first and default tab — and until 2026-10-02 it
 * could not install anything: `/api/mods/install` had no caller anywhere in the tree, so
 * the page opened on a search whose only outcome was adding a mod to a list. The thing
 * somebody actually comes to this page for is *what is on the server*, which was the second
 * tab.
 *
 * So the list is the page and this is a dialog opened from it. It writes nothing itself —
 * the Install and Add-to-pack controls are on each search result (`mod-card.tsx`), gated
 * there on `can.modsInstall`, which is also what gates the button that opens this.
 *
 * `ModBrowser` is mounted unchanged, and only while the dialog is open: it owns a debounced
 * `/api/mods/search` loop and a `useGames` capability poll, and neither should run behind a
 * page nobody is searching on.
 */
export function AddModDialog({
  open,
  onOpenChange,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called once the dialog has closed, so the page can re-read the mods directory.
   *
   * An install happens inside here and the list outside is a *reading* of the directory —
   * it must not be told what landed, it has to look. Same argument as the per-row remove,
   * which re-reads rather than splicing: an install whose write failed after the row was
   * created shows up as `missing`, and assuming would hide exactly that.
   */
  onClosed: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onClosed();
      }}
    >
      {/* `--tint` is set here because a dialog portals into `document.body`, outside the
          page wrapper that is the only place it is ever defined — see the note in
          `apply-report-dialog.tsx`. The search cards read it for their hover and focus
          rings. */}
      <DialogContent
        className="max-h-[85vh] w-full max-w-4xl overflow-y-auto sm:max-w-4xl"
        style={{ ["--tint" as string]: GAMES.minecraft.tint }}
      >
        <DialogHeader>
          <DialogTitle>Add a mod</DialogTitle>
          <DialogDescription>
            Search Modrinth and install one mod onto the server. The results are filtered to
            builds this server can load.
          </DialogDescription>
        </DialogHeader>
        <ModBrowser />
      </DialogContent>
    </Dialog>
  );
}
