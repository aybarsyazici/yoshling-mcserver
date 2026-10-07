"use client";

import { useEffect } from "react";

const drafts = new Set<object>();
const LEAVE_WARNING = "You have unsaved settings changes. Leave this page and discard them?";

function beforeUnload(event: BeforeUnloadEvent) {
  if (drafts.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
}

function appLinkClick(event: MouseEvent) {
  if (drafts.size === 0 || event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self")) return;
  let destination: URL;
  try { destination = new URL(anchor.href, window.location.href); }
  catch { return; }
  const current = new URL(window.location.href);
  if (destination.origin !== current.origin || destination.pathname.startsWith("/api/") ||
      (destination.pathname === current.pathname && destination.search === current.search)) return;
  if (!window.confirm(LEAVE_WARNING)) {
    event.preventDefault();
    // Run before React/Next link handlers; cancelling must also prevent their navigation.
    event.stopImmediatePropagation();
  }
}

/** Protect browser unloads and ordinary same-tab app links, shared across all settings panels.
 * Client-side Back/Forward and programmatic routing need routing-level integration.
 */
export function useUnsavedSettings(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const registration = {};
    if (drafts.size === 0) {
      window.addEventListener("beforeunload", beforeUnload);
      document.addEventListener("click", appLinkClick, true);
    }
    drafts.add(registration);
    return () => {
      drafts.delete(registration);
      if (drafts.size === 0) {
        window.removeEventListener("beforeunload", beforeUnload);
        document.removeEventListener("click", appLinkClick, true);
      }
    };
  }, [dirty]);
}
