/** Client-safe planning. Alerts are app-open reminders, never push subscriptions. */
export const AION_NOTIFICATION_SOUNDS = ["chime", "bell", "pulse", "silent"] as const;
export type AionNotificationSound = (typeof AION_NOTIFICATION_SOUNDS)[number];
export type AionEventNotificationSetting = { enabled: boolean; leadMinutes: number; sound: AionNotificationSound; volume: number };
export const DEFAULT_AION_NOTIFICATION_SETTING: AionEventNotificationSetting = { enabled: false, leadMinutes: 10, sound: "chime", volume: 60 };
export type AionNotificationTarget = {
  id: string; label: string; startsAt: string | null; contextKey: string; verified: boolean;
  verifiedUntil: string; estimate?: boolean; occurrenceId?: string;
};
export type AionNotificationAlert = {
  id: string; label: string; startsAt: string; contextKey: string; estimate: boolean;
  occurrenceKey: string; verifiedUntil: string; setting: AionEventNotificationSetting;
};
type Armed = { target: AionNotificationTarget; setting: AionEventNotificationSetting; alarmAt: number; armedAt: number; occurrenceKey: string };
export type AionNotificationState = { lastTick: number | null; armed: Record<string, Armed> };
export const AION_NOTIFICATION_LATENESS_MS = 90_000;
export const AION_NOTIFICATION_SLEEP_MS = 180_000;

export function validAionNotificationContext(value: unknown): value is string {
  return typeof value === "string" && /^(eu|nae|naw|la|as):(?:[1-9]\d{0,4}|none)$/.test(value);
}
export function validAionNotificationEvent(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value);
}
export function validAionNotificationSetting(value: unknown): value is AionEventNotificationSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const setting = value as Record<string, unknown>;
  return typeof setting.enabled === "boolean" && Number.isInteger(setting.leadMinutes) && Number(setting.leadMinutes) >= 0 && Number(setting.leadMinutes) <= 180
    && AION_NOTIFICATION_SOUNDS.includes(setting.sound as AionNotificationSound) && typeof setting.volume === "number" && Number.isFinite(setting.volume) && setting.volume >= 0 && setting.volume <= 100;
}
export function aionNotificationSettingKey(setting: AionEventNotificationSetting): string {
  return JSON.stringify([setting.enabled, setting.leadMinutes, setting.sound, setting.volume]);
}
export function aionNotificationOccurrence(target: AionNotificationTarget): string {
  return JSON.stringify([target.contextKey, target.id, target.occurrenceId ?? target.startsAt]);
}
export function emptyAionNotificationState(): AionNotificationState { return { lastTick: null, armed: {} }; }

function verified(target: AionNotificationTarget, now: number): boolean {
  return validAionNotificationEvent(target.id) && validAionNotificationContext(target.contextKey) && typeof target.label === "string" && target.label.length > 0 && target.label.length <= 160
    && target.verified === true && typeof target.startsAt === "string" && Number.isFinite(Date.parse(target.startsAt))
    && Number.isFinite(Date.parse(target.verifiedUntil)) && Date.parse(target.verifiedUntil) > now
    && (target.occurrenceId === undefined || typeof target.occurrenceId === "string" && target.occurrenceId.length > 0 && target.occurrenceId.length <= 160);
}

/** New/changed settings and targets arm only future alarms. A slept/resumed runtime
 * never replays old reminders. Small timer delays are accepted only for prior arms. */
export function planAionNotifications(previous: AionNotificationState, targets: AionNotificationTarget[], settings: Record<string, AionEventNotificationSetting>, now: number): { state: AionNotificationState; alerts: AionNotificationAlert[] } {
  const state: AionNotificationState = { lastTick: now, armed: {} }, alerts: AionNotificationAlert[] = [];
  if (!Number.isFinite(now)) return { state: emptyAionNotificationState(), alerts };
  const continuous = previous.lastTick !== null && now >= previous.lastTick && now - previous.lastTick <= AION_NOTIFICATION_SLEEP_MS;
  const duplicates = new Set(targets.filter((target, index) => targets.findIndex((other) => aionNotificationOccurrence(other) === aionNotificationOccurrence(target)) !== index).map(aionNotificationOccurrence));
  for (const target of targets.slice(0, 120)) {
    const setting = settings[target.id];
    const occurrenceKey = aionNotificationOccurrence(target);
    if (duplicates.has(occurrenceKey) || !verified(target, now) || !validAionNotificationSetting(setting) || !setting.enabled) continue;
    const starts = Date.parse(target.startsAt!), alarmAt = starts - setting.leadMinutes * 60_000;
    const old = previous.armed[occurrenceKey];
    const same = continuous && old?.occurrenceKey === occurrenceKey && old.target.startsAt === target.startsAt && aionNotificationSettingKey(old.setting) === aionNotificationSettingKey(setting);
    if (same && old && now >= alarmAt) {
      if (old.armedAt < alarmAt && now - alarmAt <= AION_NOTIFICATION_LATENESS_MS && (starts > now || setting.leadMinutes === 0 && now - starts <= AION_NOTIFICATION_LATENESS_MS)) {
        alerts.push({ id: target.id, label: target.label, startsAt: target.startsAt!, contextKey: target.contextKey, estimate: !!target.estimate, occurrenceKey, verifiedUntil: target.verifiedUntil, setting: { ...setting } });
      }
      continue;
    }
    if (alarmAt > now && starts > now) state.armed[occurrenceKey] = same && old ? { ...old, target: { ...target } } : { target: { ...target }, setting: { ...setting }, alarmAt, armedAt: now, occurrenceKey };
  }
  return { state, alerts };
}

export function aionNotificationMessage(alert: Pick<AionNotificationAlert, "label" | "startsAt" | "estimate">, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(alert.startsAt) - now) / 60_000));
  const timing = minutes ? `in ${minutes} minute${minutes === 1 ? "" : "s"}` : now > Date.parse(alert.startsAt) + 5_000 ? "just passed (browser reminder was delayed)" : "now";
  return alert.estimate ? `${alert.label}: community-estimated spawn ${timing}. Verify in game; this is not confirmed boss status.` : `${alert.label} starts ${timing}. Check the in-game event notice.`;
}
