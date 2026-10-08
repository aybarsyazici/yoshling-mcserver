"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Compass } from "lucide-react";
import type { Driver, DriveStep, PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";
import "./minecraft-tour.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { hasUnsavedSettings, confirmUnsavedSettingsNavigation } from "@/lib/use-unsaved-settings";
import { requestMinecraftTourState, MinecraftTourRequestError } from "@/lib/minecraft-tour-client";
import { minecraftTourHeading, minecraftTourProfileHref, minecraftTourSelector, minecraftTourSteps, type MinecraftTourCapabilities, type MinecraftTourStep } from "@/lib/minecraft-tour-steps";
import type { MinecraftTourState } from "@/lib/minecraft-tour-state";

export const MINECRAFT_TOUR_TARGET_MS = 8_000;
interface TourContext { launch: () => void; active: boolean; busy: boolean }
const Context = createContext<TourContext | null>(null);
export function useMinecraftTour() { return useContext(Context); }
export function MinecraftTourButton({ compact = false, onLaunch }: { compact?: boolean; onLaunch?: () => void }) {
  const tour = useMinecraftTour();
  return <Button data-minecraft-tour="tour-launcher" variant="outline" size={compact ? "icon-sm" : "sm"} aria-label="Take tour" disabled={!tour || tour.busy || tour.active} onClick={() => { onLaunch?.(); tour?.launch(); }}><Compass aria-hidden="true" className="size-4" />{!compact && "Take tour"}</Button>;
}
export function MinecraftTourProvider({ userId, children }: { userId: string; children: ReactNode }) {
  return <TourSession key={userId} userId={userId}>{children}</TourSession>;
}
function visible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && !element.closest("[hidden],[aria-hidden=true]") && element.getClientRects().length > 0;
}
export function minecraftTourTarget(selector: string): Element | null { return [...document.querySelectorAll(selector)].find(visible) ?? null; }
function hasModal(): boolean {
  return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"],[data-slot="sheet-content"],[data-minecraft-tour-busy]')].some(element => !element.classList.contains("driver-popover") && visible(element));
}
async function loadTourDriver(signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([import("driver.js"), new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Tour loading was interrupted"));
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => reject(new Error("Tour loading timed out")), 15_000);
      if (signal.aborted) cancel();
    })]);
  } finally { clearTimeout(timer); if (cancel) signal.removeEventListener("abort", cancel); }
}
/** Bounded DOM readiness, including routing, hidden mobile targets and cancellation. */
export async function waitMinecraftTourTarget(selector: string, signal: AbortSignal, admitted: () => boolean = () => true, timeoutMs = MINECRAFT_TOUR_TARGET_MS): Promise<Element | null> {
  return new Promise(resolve => {
    let ended = false;
    const finish = (element: Element | null) => { if (ended) return; ended = true; clearTimeout(deadline); clearInterval(poll); observer.disconnect(); signal.removeEventListener("abort", abort); resolve(element); };
    const probe = () => { if (signal.aborted) finish(null); else if (admitted()) { const element = minecraftTourTarget(selector); if (element) finish(element); } };
    const abort = () => finish(null), observer = new MutationObserver(probe);
    const deadline = setTimeout(() => finish(null), Math.max(0, timeoutMs)), poll = setInterval(probe, 100);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true }); signal.addEventListener("abort", abort, { once: true }); probe();
  });
}
interface Run { id: number; index: number; steps: MinecraftTourStep[]; driver: Driver; controller: AbortController; expectedPath: string; pending: boolean; target: Element | null; resize?: ResizeObserver; mutation?: MutationObserver; inert: Map<Element, string | null>; focus: HTMLElement | null; present: (index: number, target: Element | null, extra?: string) => void }
function restoreInert(run: Run) { for (const [element, before] of run.inert) { if (before === null) element.removeAttribute("inert"); else element.setAttribute("inert", before); } run.inert.clear(); }
function TourSession({ userId, children }: { userId: string; children: ReactNode }) {
  const router = useRouter(), path = usePathname(), search = useSearchParams();
  const games = useGames(CAPABILITY_POLL_MS);
  const [progress, setProgress] = useState<MinecraftTourState | null>(null), [readError, setReadError] = useState<string | null>(null);
  const [active, setActive] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [save, setSave] = useState<"idle" | "saving" | "unconfirmed">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const mounted = useRef(true), generation = useRef(0), runRef = useRef<Run | null>(null), earlyInteraction = useRef(false), autoConsidered = useRef(false), queryConsidered = useRef(false);
  const readRequest = useRef<AbortController | null>(null), saveRequest = useRef<AbortController | null>(null), launchRequest = useRef<AbortController | null>(null);
  const pathRef = useRef(path), capabilities = useRef<MinecraftTourCapabilities>({ settings: false, manageProfiles: false, power: false });
  const capabilitiesSettled = useRef(false), capabilitiesKnown = useRef(false);
  const accessRevoked = useRef(false), knownDone = useRef(false), saveGeneration = useRef(0);
  const closeTour = useCallback((notice?: string) => {
    generation.current++; launchRequest.current?.abort(); launchRequest.current = null;
    const run = runRef.current; runRef.current = null;
    if (run) { run.controller.abort(); run.resize?.disconnect(); run.mutation?.disconnect(); restoreInert(run); run.driver.destroy(); if (run.focus?.isConnected) run.focus.focus({ preventScroll: true }); }
    if (mounted.current) { setActive(false); setBusy(false); if (notice) setMessage(notice); }
  }, []);
  const saveCompletion = useCallback(async (reconcile = false) => {
    if (!mounted.current) return;
    closeTour(); autoConsidered.current = true; readRequest.current?.abort(); saveRequest.current?.abort();
    const controller = new AbortController(), request = ++saveGeneration.current; saveRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && request === saveGeneration.current;
    setSave("saving"); setSaveError(null); setMessage(null);
    try {
      if (knownDone.current) { if (current()) { setSave("idle"); setMessage("Tour complete. Replay with Take tour any time."); } return; }
      if (reconcile) {
        const before = await requestMinecraftTourState(userId, "GET", controller.signal);
        if (!current()) return;
        setReadError(null); setProgress(before);
        if (before.done) { knownDone.current = true; setProgress(before); setSave("idle"); setMessage("Tour completion verified for your account."); return; }
      }
      // A lost/malformed write may have committed. Read current state before any retry.
      try { const receipt = await requestMinecraftTourState(userId, "POST", controller.signal); if (!receipt.done) throw new Error("Completion receipt was not confirmed"); } catch { if (!current()) return; }
      const verified = await requestMinecraftTourState(userId, "GET", controller.signal);
      if (!current()) return;
      setReadError(null); setProgress(verified);
      if (!verified.done) throw new Error("Tour completion was not confirmed");
      knownDone.current = true; setProgress(verified); setSave("idle"); setMessage("Tour completion verified for your account.");
    } catch (error) { if (current()) { setSave("unconfirmed"); if (error instanceof MinecraftTourRequestError && [401, 409].includes(error.status)) setSaveError("Your signed-in account could not be matched to this page. Reload the page before retrying."); } }
    finally { if (saveRequest.current === controller) saveRequest.current = null; }
  }, [closeTour, userId]);
  const launch = useCallback(async (automatic = false) => {
    if (!mounted.current) return;
    if (runRef.current || launchRequest.current || saveRequest.current) return;
    autoConsidered.current = true;
    if (hasUnsavedSettings()) { if (!automatic) setMessage("Save or discard your settings changes before taking the tour."); return; }
    if ([...document.querySelectorAll("[data-minecraft-tour-busy]")].some(visible)) { if (!automatic) setMessage("Finish or close the current screenshot pairing task before taking the tour."); return; }
    if (accessRevoked.current) { if (!automatic) setMessage("Your Minecraft access could not be confirmed. Recheck the screen before taking the tour."); return; }
    const controller = new AbortController(), id = ++generation.current; launchRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && id === generation.current;
    setBusy(true); setMessage(null);
    try {
      const startPath = pathRef.current;
      let target = await waitMinecraftTourTarget(minecraftTourHeading(startPath), controller.signal, () => capabilitiesSettled.current && !hasModal() && !hasUnsavedSettings() && (!automatic || !earlyInteraction.current));
      if (!current()) return;
      if (!target && !capabilitiesSettled.current) {
        if (automatic) { autoConsidered.current = false; return; }
        if (!hasModal() && !hasUnsavedSettings()) target = minecraftTourTarget(minecraftTourHeading(startPath));
      }
      if (!target || hasModal() || hasUnsavedSettings() || automatic && earlyInteraction.current) { if (!automatic) setMessage("The screen is not ready for a tour. Close other dialogs and recheck the page, then try Take tour again."); return; }
      const { driver } = await loadTourDriver(controller.signal);
      if (!current() || accessRevoked.current || hasModal() || hasUnsavedSettings() || automatic && earlyInteraction.current) return;
      if (pathRef.current !== startPath || !target.isConnected || !visible(target)) { if (!automatic) setMessage("The screen changed while the tour loaded. Take tour again on the current page."); return; }
      const steps = minecraftTourSteps(startPath, capabilities.current);
      if (!capabilitiesKnown.current) steps[0] = { ...steps[0], description: "Your management permissions could not be verified. This visit explains the read-only screens; replay Take tour after a successful permission recheck to see management controls. " + steps[0].description };
      const run = { id, index: 0, steps, controller, expectedPath: startPath, pending: false, target: null, inert: new Map(), focus: document.activeElement instanceof HTMLElement ? document.activeElement : null } as Run;
      const live = () => current() && runRef.current === run;
      const complete = () => { if (live() && !run.pending) void saveCompletion(); };
      const renderPopover = (popover: PopoverDOM) => {
        popover.wrapper.setAttribute("aria-modal", "true");
        const skip = document.createElement("button"); skip.type = "button"; skip.className = "minecraft-tour-skip"; skip.textContent = "Skip tour"; skip.disabled = run.pending;
        skip.disabled = false; skip.addEventListener("click", () => { if (live()) void saveCompletion(); }); popover.wrapper.appendChild(skip);
      };
      run.present = (index, element, extra) => {
        if (!live()) return;
        run.index = index; run.target = element; run.resize?.disconnect();
        const resolved: DriveStep[] = steps.map((step, position) => ({ element: position === index ? element ?? undefined : undefined,
          popover: { title: step.title, description: position === index && !element ? (extra || step.unavailable) : step.description, side: "bottom", align: "center" } }));
        run.driver.setConfig({ ...run.driver.getConfig(), steps: resolved });
        if (run.driver.isActive()) run.driver.moveTo(index); else run.driver.drive(index);
        if (element && typeof ResizeObserver !== "undefined") { run.resize = new ResizeObserver(() => { if (!live()) return; if (visible(element)) run.driver.refresh(); else run.present(run.index, null); }); run.resize.observe(element); }
      };
      const move = async (position: number) => {
        if (!live() || run.pending || position < 0 || position >= steps.length) return;
        const item = steps[position];
        if (item.capability && !capabilities.current[item.capability]) { closeTour("Your access changed. Replay Take tour to see the screens currently available to you."); return; }
        run.pending = true; setBusy(true);
        const until = Date.now() + MINECRAFT_TOUR_TARGET_MS;
        const popover = run.driver.getState("popover") as PopoverDOM | undefined;
        if (popover) { popover.nextButton.disabled = true; popover.previousButton.disabled = true; popover.description.textContent = "Opening the next tour screen…"; }
        let destination = item.route, missingDetail = false;
        if (destination === "profile-detail") {
          const href = minecraftTourProfileHref(document.querySelector<HTMLAnchorElement>(minecraftTourSelector("profile-details"))?.getAttribute("href") ?? null);
          missingDetail = href === null; destination = href ?? pathRef.current;
        }
        if (destination !== pathRef.current) {
          if (!confirmUnsavedSettingsNavigation()) { run.pending = false; setBusy(false); run.present(run.index, run.target); return; }
          run.expectedPath = destination; router.push(destination);
        }
        const acknowledged = await waitMinecraftTourTarget(minecraftTourHeading(destination), controller.signal, () => pathRef.current === destination && !hasModal(), until - Date.now());
        let element = acknowledged && !missingDetail ? item.immediateFallback ? minecraftTourTarget(item.selector!) : await waitMinecraftTourTarget(item.selector!, controller.signal, () => pathRef.current === destination && !hasModal(), until - Date.now()) : null;
        if (!live()) return;
        if (item.capability && !capabilities.current[item.capability]) { closeTour("Your access changed. The tour did not open a new privileged screen."); return; }
        if (pathRef.current !== destination) { element = null; run.expectedPath = pathRef.current; }
        run.pending = false; setBusy(false); run.present(position, element, acknowledged ? undefined : "The next screen could not be opened or verified. You can continue the explanation, go back, or close the tour and recheck the page.");
      };
      run.driver = driver({ animate: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, smoothScroll: false,
        allowClose: true, allowScroll: true, overlayClickBehavior: "none", disableActiveInteraction: true, advanceOnClick: false,
        showProgress: true, progressText: "{{current}} of {{total}}", nextBtnText: "Next", prevBtnText: "Previous", doneBtnText: "Finish tour", closeBtnLabel: "Close tour for this visit",
        popoverClass: "minecraft-tour-popover", stagePadding: 6, stageRadius: 12, onPopoverRender: renderPopover,
        onNextClick: () => void move(run.index + 1), onPrevClick: () => void move(run.index - 1), onDoneClick: complete,
        onCloseClick: () => closeTour(), onDestroyed: () => { if (runRef.current === run) closeTour(); } });
      runRef.current = run;
      const guardDOM = () => {
        if (!live()) return;
        if (hasModal()) { closeTour("The tour paused because another dialog opened. Replay it when you are ready."); return; }
        for (const child of document.body.children) {
          if (child.matches("script,style,link,.driver-popover,.driver-overlay,#driver-dummy-element")) continue;
          if (!run.inert.has(child)) run.inert.set(child, child.getAttribute("inert"));
          if (!child.hasAttribute("inert")) child.setAttribute("inert", "");
        }
        if (!run.pending && run.target && (!run.target.isConnected || !visible(run.target))) run.present(run.index, null);
      };
      guardDOM(); run.mutation = new MutationObserver(guardDOM); run.mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "role", "aria-modal", "data-open"] });
      setActive(true); run.present(0, target);
    } catch { if (current()) { closeTour(); setMessage("The tour could not load. Recheck this page and try Take tour again."); } }
    finally { if (launchRequest.current === controller) launchRequest.current = null; if (mounted.current && id === generation.current) setBusy(false); }
  }, [closeTour, router, saveCompletion]);
  useEffect(() => {
    pathRef.current = path;
    const confirmed = !games.loading && !games.pollError;
    capabilitiesSettled.current = !games.loading; capabilitiesKnown.current = confirmed;
    capabilities.current = { settings: confirmed && games.access.includes("minecraft") && games.can.settings, manageProfiles: confirmed && games.access.includes("minecraft") && games.can.settingsEdit === true, power: confirmed && games.access.includes("minecraft") && games.can.start };
    accessRevoked.current = confirmed && !games.access.includes("minecraft");
    const run = runRef.current, capability = run?.steps[run.index]?.capability;
    if (run && (accessRevoked.current || capability && !capabilities.current[capability] || path !== run.expectedPath && !run.pending)) closeTour("Your screen or access changed. Replay Take tour when you are ready.");
  }, [path, games.loading, games.pollError, games.access, games.can, closeTour]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); readRequest.current = controller;
    void requestMinecraftTourState(userId, "GET", controller.signal).then(state => { if (!mounted.current || controller.signal.aborted) return; knownDone.current = state.done; setProgress(state); }).catch(() => { if (mounted.current && !controller.signal.aborted) setReadError("Your tour preference could not be read. Take tour is still available for this visit."); });
    const interacted = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest(".driver-popover")) earlyInteraction.current = true; };
    const preventAppInput = (event: Event) => {
      if (runRef.current && event instanceof KeyboardEvent && event.key === "Tab") {
        const popover = document.querySelector<HTMLElement>(".minecraft-tour-popover"), controls = popover ? [...popover.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(visible) : [];
        event.preventDefault(); event.stopImmediatePropagation();
        if (controls.length) { const index = controls.indexOf(document.activeElement as HTMLElement), next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length; controls[next].focus(); }
        return;
      }
      if (!runRef.current || event.target instanceof Element && event.target.closest(".driver-popover")) return;
      if (event instanceof KeyboardEvent && ["Escape", "Tab", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const keepFocus = (event: FocusEvent) => {
      if (!runRef.current || event.target instanceof Element && event.target.closest(".driver-popover")) return;
      const control = document.querySelector<HTMLElement>(".minecraft-tour-popover .driver-popover-close-btn");
      if (control) { event.stopImmediatePropagation(); control.focus({ preventScroll: true }); }
    };
    for (const name of ["pointerdown", "click", "touchstart", "keydown", "input", "wheel"]) document.addEventListener(name, interacted, true);
    for (const name of ["click", "pointerdown", "keydown", "beforeinput"]) document.addEventListener(name, preventAppInput, true);
    document.addEventListener("focusin", keepFocus, true);
    return () => {
      mounted.current = false; controller.abort(); saveRequest.current?.abort(); closeTour();
      for (const name of ["pointerdown", "click", "touchstart", "keydown", "input", "wheel"]) document.removeEventListener(name, interacted, true);
      for (const name of ["click", "pointerdown", "keydown", "beforeinput"]) document.removeEventListener(name, preventAppInput, true);
      document.removeEventListener("focusin", keepFocus, true);
    };
  }, [userId, closeTour]);
  useEffect(() => {
    if (search.get("tour") === "1" && !queryConsidered.current) {
      queryConsidered.current = true; autoConsidered.current = true;
      const query = new URLSearchParams(search.toString()); query.delete("tour"); router.replace(path + (query.size ? "?" + query.toString() : ""), { scroll: false });
      void Promise.resolve().then(() => launch(false)); return;
    }
    if (progress?.done === false && !readError && !autoConsidered.current && !earlyInteraction.current) void Promise.resolve().then(() => launch(true));
  }, [progress, readError, path, search, router, launch, games.loading, games.pollError]);
  return <Context.Provider value={{ launch: () => void launch(false), active, busy }}>{children}
    {(message || readError) && <p role="status" className="fixed bottom-4 left-1/2 z-40 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-xl border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg">{message || readError}</p>}
    <Dialog open={save !== "idle"} onOpenChange={open => { if (!open) { saveGeneration.current++; saveRequest.current?.abort(); setSave("idle"); setMessage("Tour closed for now. Completion has not been confirmed."); } }}>
      <DialogContent><DialogHeader><DialogTitle>{save === "saving" ? "Saving tour completion" : "Tour completion is unconfirmed"}</DialogTitle><DialogDescription>{save === "saving" ? "Checking the saved preference for your account…" : saveError || "The request may have reached the server. Read the current preference before retrying; no completion is being claimed."}</DialogDescription></DialogHeader><DialogFooter><Button disabled={save === "saving"} onClick={() => void saveCompletion(true)}>Retry save/read</Button><Button variant="outline" onClick={() => { saveGeneration.current++; saveRequest.current?.abort(); setSave("idle"); setMessage("Tour closed for now. Completion has not been confirmed."); }}>Close for now</Button></DialogFooter></DialogContent>
    </Dialog>
  </Context.Provider>;
}
