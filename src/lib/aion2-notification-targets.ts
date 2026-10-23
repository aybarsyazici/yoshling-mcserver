import manifest from "@/data/aion2/timers.json";
import { aionTimers } from "@/lib/aion2-timers";
import type { AionKnowledgeStatus, AionRegion } from "@/lib/aion2-types";
import type { AionBossReport } from "@/lib/aion2-boss-report";
import type { AionNotificationTarget } from "@/lib/aion2-notifications";

const MINUTE = 60_000;
const DAY = 86_400_000;
const INVALID = new Date(0).toISOString();

export function aionTimerSourcesCurrent(knowledge: AionKnowledgeStatus | undefined, now: number, failed = false) {
  const checked = knowledge?.checkedAt ? Date.parse(knowledge.checkedAt) : NaN;
  return !failed && !!knowledge && knowledge.status === "current" && Date.parse(knowledge.expiresAt) > now && now - checked >= -5 * MINUTE && now - checked <= 30 * MINUTE;
}

function sourceDeadline(eventId: string, knowledge: AionKnowledgeStatus | undefined) {
  const event = manifest.events.find(value => value.id === eventId);
  if (!event || !knowledge?.checkedAt) return 0;
  const times = [Date.parse(knowledge.expiresAt), Date.parse(knowledge.checkedAt) + 30 * MINUTE, Date.parse(`${manifest.expiresAt}T00:00:00Z`), ...event.sourceIds.map(id => {
    const source = manifest.sources.find(value => value.id === id);
    return source ? Date.parse(`${source.expiresAt}T00:00:00Z`) : NaN;
  })];
  return times.every(Number.isFinite) ? Math.min(...times) : 0;
}

export function aionGartuaEstimate(report: AionBossReport | null | undefined, failed: boolean, enabled: boolean, now: number) {
  const basis = report?.reportedAt ?? report?.lastKilledAt;
  const basisAge = basis ? now - Date.parse(basis) : Infinity;
  const fetchedAge = report ? now - Date.parse(report.fetchedAt) : Infinity;
  const fresh = enabled && !!report && !failed && fetchedAge >= -5 * MINUTE && fetchedAge <= 2 * MINUTE && basisAge >= -5 * MINUTE && basisAge <= DAY;
  const estimate = report?.estimatedSpawnAt;
  const until = estimate ? Date.parse(estimate) - now : null;
  const killAge = report?.lastKilledAt ? now - Date.parse(report.lastKilledAt) : Infinity;
  const countdown = fresh && report?.status === "reported-dead" && killAge >= -5 * MINUTE && killAge <= DAY && until !== null && until > 0 && until <= DAY;
  const justElapsed = fresh && report?.status === "reported-dead" && killAge >= -5 * MINUTE && killAge <= DAY && until !== null && until <= 0 && until >= -90_000;
  return { fresh, estimate, countdown, alertStart: countdown || justElapsed, elapsed: !!estimate && until !== null && until <= 0 };
}

/** Authorize starts, never entry/play window ends. Past starts are retained briefly
 * for an alert armed before a zero-minute warning crosses its start boundary. */
export function aionNotificationTargets({ region, serverId, serverName, contextKey, now, knowledge, failed = false, report, reportFailed = false }: {
  region: AionRegion; serverId?: number; serverName?: string; contextKey: string; now: number; knowledge?: AionKnowledgeStatus; failed?: boolean;
  report?: AionBossReport | null; reportFailed?: boolean;
}): AionNotificationTarget[] {
  const current = contextKey === `${region}:${serverId ?? "none"}` && aionTimerSourcesCurrent(knowledge, now, failed);
  const timers = aionTimers(region, new Date(now), current);
  const horizon = now + 180 * MINUTE;
  return timers.flatMap(timer => {
    const base = { id: timer.id, label: `${timer.name} · ${serverName ? `${serverName} · ` : ""}${region.toUpperCase()}`, contextKey, startsAt: null, verified: false, verifiedUntil: INVALID };
    const deadline = sourceDeadline(timer.id, knowledge);
    if (!current || deadline <= now || timer.state === "unknown" && timer.kind !== "manual" || timer.state === "review-required") return [base];
    if (timer.kind === "manual") {
      const state = aionGartuaEstimate(report, reportFailed, timer.id === "gartua" && region === "eu" && !!serverId && report?.region === region && report.serverId === serverId && contextKey === `${region}:${report.serverId}`, now);
      if (!state.alertStart || !state.estimate || !report?.lastKilledAt) return [base];
      const expires = Math.min(deadline, Date.parse(report.fetchedAt) + 2 * MINUTE, Date.parse(report.reportedAt ?? report.lastKilledAt) + DAY, Date.parse(report.lastKilledAt) + DAY);
      return [{ ...base, label: `${report.name} · ${report.serverName} · ${region.toUpperCase()}`, startsAt: state.estimate, verified: expires > now, verifiedUntil: new Date(expires).toISOString(), estimate: true, occurrenceId: report.lastKilledAt }];
    }
    const targets: AionNotificationTarget[] = [];
    const seen = new Set<string>();
    let cursor = now - 90_000;
    for (let attempts = 0; attempts < 64; attempts++) {
      const occurrence = aionTimers(region, new Date(cursor), true).find(value => value.id === timer.id);
      if (!occurrence || occurrence.state === "unknown" || occurrence.state === "review-required" || !occurrence.nextStartAt) break;
      const start = Date.parse(occurrence.nextStartAt);
      if (!Number.isFinite(start)) break;
      if (start >= now - 90_000 && !seen.has(occurrence.nextStartAt)) {
        seen.add(occurrence.nextStartAt);
        targets.push({ ...base, startsAt: occurrence.nextStartAt, verified: true, verifiedUntil: new Date(deadline).toISOString(), occurrenceId: occurrence.nextStartAt });
      }
      // Include one start beyond the longest supported warning, so a warning
      // longer than an hourly recurrence still has a future alarm to arm.
      if (start > horizon) break;
      const next = occurrence.windowEndsAt ? Date.parse(occurrence.windowEndsAt) + 1 : start + 1;
      if (!Number.isFinite(next) || next <= cursor) break;
      cursor = next;
    }
    return targets.length ? targets : [base];
  });
}
