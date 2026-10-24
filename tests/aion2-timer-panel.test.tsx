// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AionTimerPanel } from "@/components/aion2-timer-panel";
import type { AionBossReport } from "@/lib/aion2-boss-report";
import type { AionKnowledgeStatus } from "@/lib/aion2-types";
import timerData from "@/data/aion2/timers.json";

// Calendar fixtures intentionally exercise Oct23 and the DST weekend. Give only
// this test copy a matching review window; production retains its actual review.
vi.mock("@/data/aion2/timers.json", async (original) => {
  const imported = await original<{ default: typeof import("@/data/aion2/timers.json") }>();
  const data = structuredClone(imported.default);
  data.reviewedAt = "2026-10-23";
  for (const source of data.sources) source.reviewedAt = "2026-10-23";
  return { default: data };
});

const NOW = "2026-10-23T12:00:00.000Z";
const knowledge: AionKnowledgeStatus = { version: "test-review", status: "current", reviewedAt: "2026-10-23", expiresAt: "2026-10-28", checkedAt: NOW, supportedClasses: ["Gladiator"], notices: [] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function report(): AionBossReport {
  return { name: "Immortal Gartua", estimatedSpawnAt: "2026-10-23T16:00:00.000Z", lastKilledAt: "2026-10-23T04:00:00.000Z", reportedAt: "2026-10-23T04:00:00.000Z", fetchedAt: NOW, source: "https://aion2timers.com/", provider: "aion2timers.com", status: "reported-dead", region: "eu", serverId: 2322, serverName: "Atiel" };
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async () => json({ report: null, checkedAt: NOW })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("ticks reviewed entry windows using a local one-second clock and shows server timezone", async () => {
  render(<AionTimerPanel region="eu" knowledge={knowledge} />); await settle();
  const timer = screen.getByRole("timer", { name: "Shugo Festival entry closes in" });
  expect(timer.textContent).toBe("03:00");
  expect(screen.getAllByText(/Server \(Europe\/Berlin\)/).length).toBeGreaterThan(0);
  expect(screen.getByText(/Calculated from reviewed schedules/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(timer.textContent).toBe("02:59");
  expect(screen.queryByText("Live")).toBeNull();
});

it.each(["expired", "unverified", "review-required"] as const)("withholds countdowns when source status is %s", async status => {
  render(<AionTimerPanel region="eu" knowledge={{ ...knowledge, status }} />); await settle();
  expect(screen.queryAllByRole("timer")).toHaveLength(0);
  expect(screen.getByText(/Schedule countdowns are withheld/)).toBeTruthy();
});

it("does not substitute EU schedule times when switching to an unreviewed region", async () => {
  const view = render(<AionTimerPanel region="eu" knowledge={knowledge} />); await settle();
  expect(screen.getAllByRole("timer").length).toBeGreaterThan(0);
  view.rerender(<AionTimerPanel region="nae" knowledge={knowledge} />);
  expect(screen.queryAllByRole("timer")).toHaveLength(0);
  expect(screen.queryByText(/Europe\/Berlin/)).toBeNull();
  expect(screen.getByText(/North America East/)).toBeTruthy();
});

it("keeps Gartua manual until a character server is selected", async () => {
  render(<AionTimerPanel region="eu" knowledge={knowledge} />); await settle();
  expect(screen.getByText("Select a character for reports")).toBeTruthy();
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  expect(screen.getByText("Map → Exploration → Field Boss")).toBeTruthy();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it("does not poll or count down Gartua when its source review has expired", async () => {
  const source = timerData.sources.find(source => source.id === "gartua-reports")!;
  const expiry = source.expiresAt;
  source.expiresAt = "2026-10-23";
  try {
    vi.stubGlobal("fetch", vi.fn(async () => json({ report: report(), checkedAt: NOW })));
    render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  } finally { source.expiresAt = expiry; }
});

it("labels a fresh fetched kill-based forecast as a community estimate and shows its old report age", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ report: report(), checkedAt: NOW })));
  render(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} />); await settle();
  expect(screen.getByRole("timer", { name: "Immortal Gartua community estimated spawn" }).textContent).toBe("4h 00m");
  expect(screen.getByText("Community estimate · Atiel")).toBeTruthy();
  expect(screen.getByText(/Last reported kill:.*8h 0m ago/)).toBeTruthy();
  expect(screen.getByText(/Report:.*8h 0m ago/)).toBeTruthy();
  expect(screen.queryByText("Community reported alive")).toBeNull();
});

it("retains an absolute historical estimate after a failed feed refresh but hides its countdown", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? json({ report: report(), checkedAt: NOW }) : json({ error: "Unavailable" }, 503)));
  render(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} />); await settle();
  expect(screen.getByRole("timer", { name: /Gartua community estimated spawn/ })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  expect(screen.getByText("Last report · stale · Atiel")).toBeTruthy();
  expect(screen.getByText(/Last estimated spawn:/)).toBeTruthy();
  expect(screen.getByText("Feed check failed; verify in game.")).toBeTruthy();
});

it("ages a report out even if a later feed request hangs", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(() => ++calls === 1 ? Promise.resolve(json({ report: report(), checkedAt: NOW })) : new Promise<Response>(() => {})));
  render(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} />); await settle();
  await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  expect(screen.getByText("Last report · stale · Atiel")).toBeTruthy();
});

it("does not invent a new cycle after a community estimate elapses", async () => {
  const value = { ...report(), estimatedSpawnAt: "2026-10-23T12:00:01.000Z" };
  vi.stubGlobal("fetch", vi.fn(async () => json({ report: value, checkedAt: NOW })));
  render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  expect(screen.getByRole("timer", { name: /Gartua community estimated spawn/ }).textContent).toBe("00:01");
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  expect(screen.getByText("Estimate elapsed — check in game")).toBeTruthy();
});

it("discards a late previous-server report and validates the returned server identity", async () => {
  let release!: (value: Response) => void;
  const old = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn((url: string) => String(url).includes("serverId=2322") ? old : Promise.resolve(json({ report: { ...report(), name: "Other Gartua", serverId: 2323, serverName: "Another" }, checkedAt: NOW }))));
  const view = render(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} />); await settle();
  view.rerender(<AionTimerPanel region="eu" serverId={2323} serverName="Another" knowledge={knowledge} />); await settle();
  expect(screen.getByRole("heading", { name: "Other Gartua" })).toBeTruthy();
  await act(async () => { release(json({ report: { ...report(), name: "Old server boss" }, checkedAt: NOW })); await old; });
  expect(screen.queryByRole("heading", { name: "Old server boss" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Other Gartua" })).toBeTruthy();
});

it("refuses a mismatched report and withdraws a retained estimate when knowledge becomes unverified", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ report: report(), checkedAt: NOW })));
  const view = render(<AionTimerPanel region="eu" serverId={2323} knowledge={knowledge} />); await settle();
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  view.rerender(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} />); await settle();
  expect(screen.getByRole("timer", { name: /Gartua community estimated spawn/ })).toBeTruthy();
  view.rerender(<AionTimerPanel region="eu" serverId={2322} serverName="Atiel" knowledge={knowledge} readFailed />);
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
  expect(screen.getByText("Last report · stale · Atiel")).toBeTruthy();
});

it("attributes an alive report to the community and gives it no invented spawn countdown", async () => {
  const value = { ...report(), status: "reported-alive" as const, estimatedSpawnAt: null, reportedAt: NOW, lastKilledAt: null };
  vi.stubGlobal("fetch", vi.fn(async () => json({ report: value, checkedAt: NOW })));
  render(<AionTimerPanel region="eu" serverId={2322} knowledge={knowledge} />); await settle();
  expect(screen.getByText("Community reported alive")).toBeTruthy();
  expect(screen.queryByRole("timer", { name: /Gartua/ })).toBeNull();
});
