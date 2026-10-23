"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AION_NOTIFICATION_LATENESS_MS, aionNotificationMessage, aionNotificationOccurrence, aionNotificationSettingKey, emptyAionNotificationState, planAionNotifications, validAionNotificationSetting, type AionEventNotificationSetting, type AionNotificationAlert, type AionNotificationSound, type AionNotificationTarget } from "@/lib/aion2-notifications";
import { openAionNotificationStore, type AionNotificationCoordination, type AionNotificationStore } from "@/lib/aion2-notification-store";

export type AionNotificationsController = {
  settings: Record<string, AionEventNotificationSetting>;
  setEventSetting(eventId: string, patch: Partial<AionEventNotificationSetting>): Promise<boolean>;
  updateTargets(targets: AionNotificationTarget[]): void;
  permission: NotificationPermission | "unsupported";
  requestPermission(): Promise<void>;
  audioStatus: "locked" | "ready" | "unsupported" | "error";
  testSound(sound: AionNotificationSound, volume: number): Promise<void>;
  storageStatus: "loading" | "ready" | "error";
  storageError: string | null;
  retryStorage(): Promise<void>;
  coordination: AionNotificationCoordination;
  lastAlert: AionNotificationAlert | null;
  deliveryError: string | null;
};

/** Small generated tones require no fetched assets or external player. */
export function playAionNotificationSound(audio: AudioContext, sound: AionNotificationSound, volume: number): void {
  if (sound === "silent" || volume <= 0 || audio.state !== "running") return;
  const notes = sound === "bell" ? [880, 1320, 1760] : sound === "pulse" ? [440, 440, 660] : [660, 880];
  notes.forEach((frequency, index) => {
    const oscillator = audio.createOscillator(), gain = audio.createGain(), start = audio.currentTime + index * 0.17;
    oscillator.type = sound === "pulse" ? "triangle" : "sine"; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(Math.min(100, volume) / 100 * 0.16, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(start + 0.34);
  });
}

function audioConstructor(): typeof AudioContext | undefined {
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}
function permission(): NotificationPermission | "unsupported" { return typeof Notification === "undefined" ? "unsupported" : Notification.permission; }
function gestureAllowed(): boolean { return navigator.userActivation?.isActive !== false; }

/** Starts no permission request or audio context during mount. Call the explicit
 * actions from buttons. The clock keeps running while this app remains open. */
export function useAionNotifications({ contextKey, targets }: { contextKey: string; targets?: AionNotificationTarget[] }): AionNotificationsController {
  const [read, setRead] = useState<{ context: string; settings: Record<string, AionEventNotificationSetting>; status: "loading" | "ready" | "error"; error: string | null }>({ context: "", settings: {}, status: "loading", error: null });
  const [permissionState, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [audioStatus, setAudioStatus] = useState<AionNotificationsController["audioStatus"]>("locked");
  const [coordination, setCoordination] = useState<AionNotificationCoordination>("unavailable");
  const [lastAlert, setLastAlert] = useState<AionNotificationAlert | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0), store = useRef<{ context: string; value: AionNotificationStore } | null>(null);
  const latestTargets = useRef<AionNotificationTarget[]>([]), latestSettings = useRef<Record<string, AionEventNotificationSetting>>({});
  const engine = useRef(emptyAionNotificationState()), audio = useRef<AudioContext | null>(null), mounted = useRef(false);

  const updateTargets = useCallback((value: AionNotificationTarget[]) => { latestTargets.current = value.filter((target) => target.contextKey === contextKey); }, [contextKey]);
  useEffect(() => { if (targets) updateTargets(targets); }, [targets, updateTargets]);

  useEffect(() => {
    const generation = ++epoch.current;
    let active = true, unsubscribe = () => {};
    mounted.current = true; latestSettings.current = {}; engine.current = emptyAionNotificationState();
    // A different context cannot keep targets from the previously selected server.
    latestTargets.current = latestTargets.current.filter((target) => target.contextKey === contextKey);
    const applySettings = (settings: Record<string, AionEventNotificationSetting>) => {
      if (!active || epoch.current !== generation) return;
      latestSettings.current = settings;
      setRead({ context: contextKey, settings, status: "ready", error: null });
    };
    const fail = (error: unknown) => {
      if (!active || epoch.current !== generation) return;
      latestSettings.current = {}; engine.current = emptyAionNotificationState();
      setRead({ context: contextKey, settings: {}, status: "error", error: error instanceof Error ? error.message : "Browser alert storage is unavailable." });
    };
    queueMicrotask(() => { if (active) { setPermission(permission()); setAudioStatus(audioConstructor() ? "locked" : "unsupported"); setCoordination("unavailable"); } });
    void openAionNotificationStore().then(async (value) => {
      if (!active) { value.close(); return; }
      store.current = { context: contextKey, value };
      const settings = await value.load(contextKey);
      if (!active) return;
      setCoordination(value.mode); applySettings(settings);
      unsubscribe = value.subscribe(() => { void value.load(contextKey).then(applySettings).catch(fail); });
    }).catch(fail);

    const authorized = (alert: AionNotificationAlert) => {
      const now = Date.now(), alarm = Date.parse(alert.startsAt) - alert.setting.leadMinutes * 60_000;
      const target = latestTargets.current.find((candidate) => aionNotificationOccurrence(candidate) === alert.occurrenceKey);
      return active && epoch.current === generation && store.current?.context === contextKey && alert.contextKey === contextKey
        && !!target?.verified && target.startsAt === alert.startsAt && Date.parse(target.verifiedUntil) > now && Date.parse(alert.verifiedUntil) > now
        && now >= alarm && now - alarm <= AION_NOTIFICATION_LATENESS_MS
        && (Date.parse(alert.startsAt) > now || alert.setting.leadMinutes === 0 && now - Date.parse(alert.startsAt) <= AION_NOTIFICATION_LATENESS_MS)
        && aionNotificationSettingKey(latestSettings.current[alert.id] ?? { enabled: false, leadMinutes: 10, sound: "silent", volume: 0 }) === aionNotificationSettingKey(alert.setting);
    };
    const deliver = async (alert: AionNotificationAlert) => {
      try {
        const current = store.current;
        if (!current || !authorized(alert) || !await current.value.claim(alert) || !authorized(alert)) return;
        setLastAlert(alert);
        let issue: string | null = null;
        if (audio.current?.state === "running") {
          try { playAionNotificationSound(audio.current, alert.setting.sound, alert.setting.volume); }
          catch { setAudioStatus("error"); issue = "The alert sound could not play. Use Preview sound to unlock or retry browser audio."; }
        }
        else if (alert.setting.sound !== "silent" && alert.setting.volume > 0) setAudioStatus(audioConstructor() ? "locked" : "unsupported");
        if (permission() === "granted") {
          try { new Notification(`Aion 2 · ${alert.label}`, { body: aionNotificationMessage(alert, Date.now()), tag: alert.occurrenceKey, silent: true }); }
          catch { issue = "This browser could not display a desktop notification. In-app reminders and unlocked sound still work while the helper is open."; }
        }
        setDeliveryError(issue);
      } catch (error) { fail(error); }
    };
    const tick = () => {
      if (!active || !store.current || store.current.context !== contextKey) return;
      const plan = planAionNotifications(engine.current, latestTargets.current, latestSettings.current, Date.now());
      engine.current = plan.state;
      for (const alert of plan.alerts) void deliver(alert);
    };
    const timer = setInterval(tick, 1_000);
    const visible = () => {
      if (document.visibilityState === "visible") { setPermission(permission()); tick(); }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false; mounted.current = false; epoch.current = generation + 1; clearInterval(timer); unsubscribe(); document.removeEventListener("visibilitychange", visible);
      if (store.current?.context === contextKey) { store.current.value.close(); store.current = null; }
      engine.current = emptyAionNotificationState();
      const context = audio.current; audio.current = null;
      if (context) context.onstatechange = null;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    };
  }, [contextKey, retry]);

  const setEventSetting = useCallback(async (eventId: string, patch: Partial<AionEventNotificationSetting>) => {
    const current = store.current, generation = epoch.current;
    if (!current || current.context !== contextKey || read.context !== contextKey || read.status !== "ready") return false;
    try {
      const settings = await current.value.save(contextKey, eventId, patch);
      const confirmed = await current.value.load(contextKey);
      if (JSON.stringify(settings[eventId]) !== JSON.stringify(confirmed[eventId])) throw new Error("Alert preferences changed while saving. Review the current values.");
      if (epoch.current !== generation || !mounted.current) return false;
      latestSettings.current = confirmed;
      setRead({ context: contextKey, settings: confirmed, status: "ready", error: null }); return true;
    } catch (error) {
      if (epoch.current === generation && mounted.current) { latestSettings.current = {}; engine.current = emptyAionNotificationState(); setRead({ context: contextKey, settings: {}, status: "error", error: error instanceof Error ? error.message : "Alert preferences could not be saved." }); }
      return false;
    }
  }, [contextKey, read.context, read.status]);
  const requestPermission = useCallback(async () => {
    if (!gestureAllowed()) { setDeliveryError("Use the notification permission button to request access."); return; }
    if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") { setPermission("unsupported"); return; }
    try { const value = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission; if (mounted.current) { setPermission(value); setDeliveryError(null); } }
    catch { if (mounted.current) setDeliveryError("Browser notification permission could not be requested. Check browser site settings."); }
  }, []);
  const testSound = useCallback(async (sound: AionNotificationSound, volume: number) => {
    if (!gestureAllowed() || !validAionNotificationSetting({ enabled: true, leadMinutes: 0, sound, volume })) return;
    const Audio = audioConstructor(); if (!Audio) { setAudioStatus("unsupported"); return; }
    const generation = epoch.current;
    try {
      if (!audio.current) {
        audio.current = new Audio();
        audio.current.onstatechange = () => { if (generation === epoch.current && mounted.current) setAudioStatus(audio.current?.state === "running" ? "ready" : "locked"); };
      }
      const current = audio.current;
      await current.resume();
      if (generation !== epoch.current || !mounted.current) return;
      if (current.state !== "running") { setAudioStatus("locked"); return; }
      setAudioStatus("ready"); setDeliveryError(null); playAionNotificationSound(current, sound, volume);
    } catch { if (generation === epoch.current && mounted.current) setAudioStatus("error"); }
  }, []);
  const retryStorage = useCallback(async () => { setRetry((value) => value + 1); }, []);
  const currentRead = read.context === contextKey ? read : { settings: {}, status: "loading" as const, error: null };
  return { settings: currentRead.settings, setEventSetting, updateTargets, permission: permissionState, requestPermission, audioStatus, testSound, storageStatus: currentRead.status, storageError: currentRead.error, retryStorage, coordination: currentRead.status === "ready" ? coordination : "unavailable", lastAlert: lastAlert?.contextKey === contextKey ? lastAlert : null, deliveryError };
}
