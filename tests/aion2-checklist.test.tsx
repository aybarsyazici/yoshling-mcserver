// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AionChecklistPanel } from "@/components/aion2-checklist";
import type { AionKnowledgeStatus, AionTrackedCharacter } from "@/lib/aion2-types";

afterEach(cleanup);
const now = Date.parse("2026-10-23T12:00:00Z");
const knowledge: AionKnowledgeStatus = { version: "review-1", reviewedAt: "2026-10-23T11:00:00Z", checkedAt: "2026-10-23T11:59:00Z", expiresAt: "2026-10-24T12:00:00Z", status: "current", supportedClasses: ["Gladiator"], notices: [] };
function character(): AionTrackedCharacter {
  return { id: "tracked-1", region: "eu", serverId: 2322, characterId: "char-1", name: "Daeva", serverName: "Atiel", tracking: true, lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextRefreshAt: "2026-10-23T12:15:00Z", snapshot: null, history: [], recommendations: [], checklist: { status: "current", notice: "Check current entry limits in game.", revision: "revision-1", items: [
    { id: "daily-dungeon", name: "Daily Dungeon", cadence: "daily", scope: "character", instruction: "Open the Daily Dungeon menu and use available entries before they cap.", rewardTags: ["Enhancement materials"], source: "https://docs.google.com/spreadsheets/d/review/edit#gid=1", completed: false, completedAt: null, periodKey: "daily-2026-10-23", nextResetAt: "2026-10-24T07:00:00Z" },
    { id: "odyle-check", name: "Check Odyle recharge", cadence: "daily", scope: "character", instruction: "Check energy before collecting dungeon rewards.", rewardTags: ["Odyle"], source: "https://docs.google.com/document/d/review/edit", completed: true, completedAt: "2026-10-23T11:30:00Z", periodKey: "daily-2026-10-23", nextResetAt: "2026-10-24T07:00:00Z" },
    { id: "scrolls", name: "Command Mission scroll purchases", cadence: "weekly", scope: "server", instruction: "Review the current Command Mission scroll supply in the shop.", rewardTags: ["Daevanion Crystals"], source: "https://docs.google.com/spreadsheets/d/review/edit#gid=1", completed: false, completedAt: null, periodKey: "weekly-2026-10-21", nextResetAt: "2026-10-28T07:00:00Z" },
  ] } };
}
function props() { return { character: character(), knowledge, now, readFailed: false, disabled: false, busy: false, onToggle: vi.fn() }; }

it("shows actual recurring activity counts, reset countdowns, rewards and source instructions", () => {
  render(<AionChecklistPanel {...props()} />);
  expect(screen.getByText("Daeva · Atiel · Europe")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Today 1/2" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  expect(screen.getByText("Resets in 19h")).toBeTruthy();
  const today = within(screen.getByRole("list", { name: "Today activities" }));
  expect(today.getByText("Enhancement materials")).toBeTruthy();
  expect(today.getByText(/Open the Daily Dungeon menu/)).toBeTruthy();
  expect(today.getAllByRole("link", { name: "Activity source" })).toHaveLength(2);
  expect((today.getByRole("checkbox", { name: "Mark Check Odyle recharge incomplete" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "This week 0/1" }));
  expect(screen.getByText("Command Mission scroll purchases")).toBeTruthy();
  expect(screen.getByText("Atiel · your account")).toBeTruthy();
  expect(screen.getByText("Resets in 4d 19h")).toBeTruthy();
  expect(screen.queryByText("Daily Dungeon")).toBeNull();
});

it("sends the captured activity and desired report without marking it done optimistically", () => {
  const p = props(); render(<AionChecklistPanel {...p} />);
  const input = screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }) as HTMLInputElement;
  fireEvent.click(input);
  expect(p.onToggle).toHaveBeenCalledExactlyOnceWith(p.character.checklist!.items[0], true);
  expect(input.checked).toBe(false);
  expect(screen.getByRole("button", { name: "Today 1/2" })).toBeTruthy();
});

it.each(["missing", "expired", "review-required", "old-check", "future-check", "read-failed", "catalog-review", "busy"])("keeps saved reports visible and blocks changes when %s", condition => {
  const p = props();
  if (condition === "missing") p.knowledge = undefined as unknown as AionKnowledgeStatus;
  if (condition === "expired") p.knowledge = { ...knowledge, expiresAt: "2026-10-23T11:00:00Z" };
  if (condition === "review-required") p.knowledge = { ...knowledge, status: "review-required" };
  if (condition === "old-check") p.knowledge = { ...knowledge, checkedAt: "2026-10-23T11:29:00Z" };
  if (condition === "future-check") p.knowledge = { ...knowledge, checkedAt: "2026-10-23T12:06:00Z" };
  if (condition === "read-failed") p.readFailed = true;
  if (condition === "catalog-review") p.character.checklist!.status = "review-required";
  if (condition === "busy") p.busy = true;
  render(<AionChecklistPanel {...p} />);
  const input = screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }) as HTMLInputElement;
  expect(input.disabled).toBe(true); fireEvent.click(input); expect(p.onToggle).not.toHaveBeenCalled();
  expect((screen.getByRole("checkbox", { name: /Check Odyle recharge/ }) as HTMLInputElement).checked).toBe(true);
});

it("does not carry old completion into an elapsed reset or invent an unknown reset", () => {
  const p = props();
  p.character.checklist!.items[1].nextResetAt = "2026-10-23T12:00:01Z";
  const view = render(<AionChecklistPanel {...p} />);
  expect((screen.getByRole("checkbox", { name: "Mark Check Odyle recharge incomplete" }) as HTMLInputElement).checked).toBe(true);
  view.rerender(<AionChecklistPanel {...p} now={now + 2_000} />);
  const expired = screen.getByRole("checkbox", { name: "Mark Check Odyle recharge complete" }) as HTMLInputElement;
  expect(expired.checked).toBe(false); expect(expired.disabled).toBe(true);
  expect(screen.getAllByText(/Period ended/).length).toBeGreaterThan(0);
  p.character.checklist!.items[0].nextResetAt = null;
  view.rerender(<AionChecklistPanel {...p} now={now + 2_000} />);
  expect((screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("Reset unconfirmed")).toBeTruthy();
});

it.each(["unknown reset", "previous reset estimate"])("preserves read-only historical reports during source hold with %s without certifying the current period", resetState => {
  const p = props(); p.character.checklist!.status = "review-required";
  p.character.checklist!.notice = "The activity sources need a new review.";
  if (resetState === "unknown reset") p.character.checklist!.items.forEach(item => { item.nextResetAt = null; });
  render(<AionChecklistPanel {...p} />);
  const saved = screen.getByRole("checkbox", { name: "Check Odyle recharge: last reported done (current period unverified)" }) as HTMLInputElement;
  expect(saved.checked).toBe(true); expect(saved.disabled).toBe(true);
  fireEvent.click(saved); expect(p.onToggle).not.toHaveBeenCalled();
  const report = screen.getByText(/Last reported done ·/);
  expect(report.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-23T11:30:00Z");
  expect(report.closest("details")).toBeNull();
  expect(screen.getByRole("button", { name: "Today —/2" })).toBeTruthy();
  expect(screen.getByText("Current period unverified")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/Resets in/)).toBeNull();
  expect(screen.queryByText("1 reported done")).toBeNull();
});

it("explains private account scope and keeps source detail folded without inventing activities", () => {
  const p = props(); delete p.character.checklist;
  render(<AionChecklistPanel {...p} />);
  expect(screen.getByText("The recurring checklist is not available for this character yet.")).toBeTruthy();
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  const detail = screen.getByText("How this checklist works").closest("details") as HTMLDetailsElement;
  expect(detail.open).toBe(false);
  expect(within(detail).getByText(/other Yoshling accounts have their own checks/)).toBeTruthy();
});
