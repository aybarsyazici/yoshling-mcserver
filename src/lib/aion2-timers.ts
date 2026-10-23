import manifest from "@/data/aion2/timers.json";
import type { AionRegion } from "./aion2-types";
import { validateAionTimers } from "./aion2-timer-validation";

export type AionEventTimer = {
  id: string; name: string; kind: "scheduled" | "reset" | "manual";
  source: string; sourceLabel: string; region: AionRegion; timeZone: string | null;
  nextStartAt: string | null; windowEndsAt: string | null;
  state: "upcoming" | "entry-open" | "active" | "unknown" | "review-required";
  description: string; priority: "high" | "medium";
};

type CivilDate = { year: number; month: number; day: number };
type CivilTime = CivilDate & { hour: number; minute: number; second: number };
type Event = (typeof manifest.events)[number];
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetsByDate = new Map<string, number[]>();
const manifestErrors = validateAionTimers(manifest);

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, value);
  }
  return value;
}

function civil(epoch: number, timeZone: string): CivilTime {
  const parts = formatter(timeZone).formatToParts(new Date(epoch));
  const value = (name: string) => Number(parts.find((part) => part.type === name)!.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

function civilEpoch(value: CivilTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

/** Observe both sides of a clock change; never bake a CET/CEST offset into dates. */
function offsets(date: CivilDate, timeZone: string): number[] {
  const key = `${timeZone}:${date.year}-${date.month}-${date.day}`;
  const known = offsetsByDate.get(key);
  if (known) return known;
  const noon = Date.UTC(date.year, date.month - 1, date.day, 12);
  const result = [...new Set([-36, 0, 36].map((hours) => {
    const epoch = noon + hours * 3_600_000;
    return civilEpoch(civil(epoch, timeZone)) - epoch;
  }))];
  if (offsetsByDate.size >= 64) offsetsByDate.delete(offsetsByDate.keys().next().value!);
  offsetsByDate.set(key, result);
  return result;
}

/** Zero matches means a skipped local time; two matches means a repeated hour. */
function instants(date: CivilDate, hour: number, minute: number, timeZone: string): number[] {
  const target: CivilTime = { ...date, hour, minute, second: 0 }, wall = civilEpoch(target);
  return offsets(date, timeZone).map((offset) => wall - offset).filter((epoch) => {
    const actual = civil(epoch, timeZone);
    return actual.year === target.year && actual.month === target.month && actual.day === target.day && actual.hour === hour && actual.minute === minute && actual.second === 0;
  }).sort((a, b) => a - b);
}

function reviewed(value: { reviewedAt: string; expiresAt: string }, now: number): boolean {
  const start = Date.parse(`${value.reviewedAt}T00:00:00Z`), end = Date.parse(`${value.expiresAt}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now && start < end;
}

type Occurrence = { starts: number[]; lastEnd: number };
function occurrence(event: Event, now: number): Occurrence | null {
  if (!event.timeZone) return null;
  const today = civil(now, event.timeZone), duration = (event.entryMinutes + event.activityMinutes) * 60_000;
  // One previous day covers a window crossing midnight; eight future days cover
  // every weekly recurrence even when this week's occurrence has just ended.
  for (let offset = -1; offset <= 8; offset++) {
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!event.weekdays.includes(calendar.getUTCDay())) continue;
    const date: CivilDate = { year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate() };
    for (const hour of [...event.hours].sort((a, b) => a - b)) {
      const starts = instants(date, hour, event.minute, event.timeZone);
      if (!starts.length) continue;
      const lastEnd = starts[starts.length - 1] + duration;
      if (duration ? lastEnd > now : starts[starts.length - 1] > now) return { starts, lastEnd };
    }
  }
  return null;
}

/** Client-safe schedule projection. It performs no requests or live boss checks. */
export function aionTimers(region: AionRegion, now: Date, knowledgeCurrent: boolean): AionEventTimer[] {
  if (manifestErrors.length) return [{ id: "timer-review", name: "Event timers need review", kind: "manual", priority: "high", source: "https://aion2.plaync.com/en-us/", sourceLabel: "Schedule validation failed", region, timeZone: null, nextStartAt: null, windowEndsAt: null, state: "review-required", description: "The schedule configuration could not be verified. Use the in-game calendar until it is reviewed." }];
  const epoch = now.getTime(), supported = manifest.regions.includes(region);
  return manifest.events.map<AionEventTimer>((event) => {
    const sources = event.sourceIds.map((id) => manifest.sources.find((source) => source.id === id));
    const base: AionEventTimer = {
      id: event.id, name: event.name, kind: event.kind as AionEventTimer["kind"], priority: event.priority as AionEventTimer["priority"],
      source: sources[0]?.url ?? "https://aion2.plaync.com/en-us/", sourceLabel: sources[0]?.label ?? "Unreviewed schedule",
      region, timeZone: supported ? event.timeZone : null,
      nextStartAt: null, windowEndsAt: null, state: "unknown", description: event.description,
    };
    if (!supported) return { ...base, description: "This region's schedule has not been reviewed. Check its current in-game event calendar; EU times are not substituted." };
    if (!Number.isFinite(epoch) || !knowledgeCurrent || !reviewed(manifest, epoch) || sources.some((source) => !source || !reviewed(source, epoch))) return { ...base, state: "review-required", description: "This schedule needs a current source review. Check the in-game event calendar until it is verified." };
    if (event.kind === "manual") return base;
    const next = occurrence(event, epoch);
    if (!next) return { ...base, description: "A matching schedule occurrence could not be verified. Check the in-game calendar." };
    if (next.starts.length > 1) return { ...base, description: "This local time repeats during the daylight saving clock change. Check this occurrence in game; no duplicate event or countdown is assumed." };
    const start = next.starts[0], entryEnd = start + event.entryMinutes * 60_000;
    if (epoch < start) return { ...base, state: "upcoming", nextStartAt: new Date(start).toISOString() };
    if (event.entryMinutes && epoch < entryEnd) return { ...base, state: "entry-open", nextStartAt: new Date(start).toISOString(), windowEndsAt: new Date(entryEnd).toISOString() };
    if (event.activityMinutes && epoch < next.lastEnd) return { ...base, state: "active", nextStartAt: new Date(start).toISOString(), windowEndsAt: new Date(next.lastEnd).toISOString() };
    return { ...base, description: "The next occurrence could not be verified. Check the in-game calendar." };
  });
}
