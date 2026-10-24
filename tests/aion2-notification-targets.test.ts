import { expect, it, vi } from "vitest";
import { aionNotificationTargets } from "@/lib/aion2-notification-targets";
import { DEFAULT_AION_NOTIFICATION_SETTING, emptyAionNotificationState, planAionNotifications } from "@/lib/aion2-notifications";
import type { AionKnowledgeStatus } from "@/lib/aion2-types";
import type { AionBossReport } from "@/lib/aion2-boss-report";

// Calendar fixtures intentionally exercise Oct23 and the DST weekend. Give only
// this test copy a matching review window; production retains its actual review.
vi.mock("@/data/aion2/timers.json", async (original) => {
  const imported = await original<{ default: typeof import("@/data/aion2/timers.json") }>();
  const data = structuredClone(imported.default);
  data.reviewedAt = "2026-10-23";
  for (const source of data.sources) source.reviewedAt = "2026-10-23";
  return { default: data };
});

const now = Date.parse("2026-10-23T12:00:00Z");
const knowledge: AionKnowledgeStatus = { version: "review", status: "current", reviewedAt: "2026-10-23", expiresAt: "2026-10-28", checkedAt: new Date(now).toISOString(), supportedClasses: [], notices: [] };
const args = { region: "eu" as const, serverId: 2322, contextKey: "eu:2322", now, knowledge };
function report(): AionBossReport { return { name: "Immortal Gartua", region: "eu", serverId: 2322, serverName: "Atiel", status: "reported-dead", provider: "aion2timers.com", source: "https://www.aion2timers.com/", fetchedAt: new Date(now).toISOString(), reportedAt: "2026-10-23T04:00:00Z", lastKilledAt: "2026-10-23T04:00:00Z", estimatedSpawnAt: "2026-10-23T16:00:00Z" }; }

it("enumerates event starts through 180 minutes plus the next occurrence, never entry or play deadlines", () => {
  const targets = aionNotificationTargets(args).filter(target => target.id === "shugo-festival");
  expect(targets.map(target => target.startsAt)).toEqual(["2026-10-23T12:00:00.000Z", "2026-10-23T13:00:00.000Z", "2026-10-23T14:00:00.000Z", "2026-10-23T15:00:00.000Z", "2026-10-23T16:00:00.000Z"]);
  expect(targets.every(target => target.verified && target.occurrenceId === target.startsAt && target.verifiedUntil === "2026-10-23T12:30:00.000Z")).toBe(true);
  expect(targets.some(target => target.startsAt?.includes("12:03") || target.startsAt?.includes("12:08"))).toBe(false);
});

it("retains a just-crossed zero-minute event start and delivers it once across the entry-open transition", () => {
  const settings = { "shugo-festival": { ...DEFAULT_AION_NOTIFICATION_SETTING, enabled: true, leadMinutes: 0 } };
  const armed = planAionNotifications(emptyAionNotificationState(), aionNotificationTargets({ ...args, now: now - 1_000 }), settings, now - 1_000);
  const crossing = planAionNotifications(armed.state, aionNotificationTargets(args), settings, now);
  expect(crossing.alerts.filter(alert => alert.id === "shugo-festival").map(alert => alert.startsAt)).toEqual(["2026-10-23T12:00:00.000Z"]);
  expect(planAionNotifications(crossing.state, aionNotificationTargets({ ...args, now: now + 1_000 }), settings, now + 1_000).alerts).toHaveLength(0);
});

it("arms an hourly event with a 120-minute warning instead of dropping every alarm in the past", () => {
  const settings = { "shugo-festival": { ...DEFAULT_AION_NOTIFICATION_SETTING, enabled: true, leadMinutes: 120 } };
  const before = now - 30_000;
  const armed = planAionNotifications(emptyAionNotificationState(), aionNotificationTargets({ ...args, now: before }), settings, before);
  const crossing = planAionNotifications(armed.state, aionNotificationTargets({ ...args, now: now + 1_000 }), settings, now + 1_000);
  expect(crossing.alerts.filter(alert => alert.id === "shugo-festival").map(alert => alert.startsAt)).toEqual(["2026-10-23T14:00:00.000Z"]);
});

it("retains a zero-duration reset start at its exact crossing", () => {
  const start = Date.parse("2026-10-24T07:00:00Z");
  const currentKnowledge = { ...knowledge, checkedAt: new Date(start - 10_000).toISOString() };
  const settings = { "daily-reset": { ...DEFAULT_AION_NOTIFICATION_SETTING, enabled: true, leadMinutes: 0 } };
  const armed = planAionNotifications(emptyAionNotificationState(), aionNotificationTargets({ ...args, knowledge: currentKnowledge, now: start - 1_000 }), settings, start - 1_000);
  const next = planAionNotifications(armed.state, aionNotificationTargets({ ...args, knowledge: currentKnowledge, now: start }), settings, start);
  expect(next.alerts.some(alert => alert.id === "daily-reset" && alert.startsAt === new Date(start).toISOString())).toBe(true);
});

it.each(["expired", "unverified", "review-required", "stale-check", "failed-read", "wrong-context", "unreviewed-region"])("authorizes no starts for %s", condition => {
  const input = { ...args };
  if (["expired", "unverified", "review-required"].includes(condition)) input.knowledge = { ...knowledge, status: condition as AionKnowledgeStatus["status"] };
  if (condition === "stale-check") input.now = now + 31 * 60_000;
  if (condition === "wrong-context") input.contextKey = "eu:2323";
  const targets = aionNotificationTargets({ ...input, ...(condition === "failed-read" ? { failed: true } : {}), ...(condition === "unreviewed-region" ? { region: "nae", contextKey: "nae:2322" } : {}) });
  expect(targets.some(target => target.verified)).toBe(false);
});

it("uses only a fresh same-server future community estimate and a stable kill identity", () => {
  const value = report();
  const target = aionNotificationTargets({ ...args, report: value }).find(target => target.id === "gartua")!;
  expect(target).toMatchObject({ startsAt: value.estimatedSpawnAt, occurrenceId: value.lastKilledAt, estimate: true, verified: true, verifiedUntil: "2026-10-23T12:02:00.000Z" });
  expect(target.label).toBe("Immortal Gartua · Atiel · EU");
  const shifted = aionNotificationTargets({ ...args, report: { ...value, estimatedSpawnAt: "2026-10-23T16:01:00Z" } }).find(target => target.id === "gartua")!;
  expect(shifted.occurrenceId).toBe(target.occurrenceId);
});

it("retains a fresh just-elapsed community estimate for a previously armed zero-minute reminder only", () => {
  const value = { ...report(), estimatedSpawnAt: "2026-10-23T12:00:01Z" };
  const settings = { gartua: { ...DEFAULT_AION_NOTIFICATION_SETTING, enabled: true, leadMinutes: 0 } };
  const armed = planAionNotifications(emptyAionNotificationState(), aionNotificationTargets({ ...args, report: value }), settings, now);
  const targets = aionNotificationTargets({ ...args, now: now + 1_000, report: value });
  const crossing = planAionNotifications(armed.state, targets, settings, now + 1_000);
  expect(crossing.alerts.map(alert => alert.id)).toEqual(["gartua"]);
  expect(planAionNotifications(emptyAionNotificationState(), targets, settings, now + 1_000).alerts).toHaveLength(0);
  expect(planAionNotifications(crossing.state, aionNotificationTargets({ ...args, now: now + 2_000, report: value }), settings, now + 2_000).alerts).toHaveLength(0);
  expect(aionNotificationTargets({ ...args, now: now + 92_000, report: value }).find(target => target.id === "gartua")!.verified).toBe(false);
});

it.each(["old-fetch", "failed-feed", "elapsed", "no-kill", "wrong-server", "wrong-region", "wrong-context", "no-server"])("withholds community alerts for %s", condition => {
  const value = report();
  if (condition === "old-fetch") value.fetchedAt = new Date(now - 121_000).toISOString();
  if (condition === "elapsed") value.estimatedSpawnAt = new Date(now - 91_000).toISOString();
  if (condition === "no-kill") value.lastKilledAt = null;
  if (condition === "wrong-server") value.serverId = 2323;
  if (condition === "wrong-region") value.region = "nae";
  const target = aionNotificationTargets({ ...args, report: value, reportFailed: condition === "failed-feed", ...(condition === "wrong-context" ? { contextKey: "eu:2323" } : {}), ...(condition === "no-server" ? { serverId: undefined, contextKey: "eu:none" } : {}) }).find(target => target.id === "gartua")!;
  expect(target.verified).toBe(false); expect(target.startsAt).toBeNull();
});
