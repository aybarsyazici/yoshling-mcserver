// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AionGearPriorities } from "@/components/aion2-gear-priorities";
import type { AionGearPriorityReport, AionSnapshot } from "@/lib/aion2-types";

afterEach(cleanup);
function snapshot(): AionSnapshot {
  return { version: 1, ref: { region: "eu", serverId: 2322, characterId: "char" }, observedAt: "2026-10-24T09:00:00Z", profile: { name: "Daeva", serverName: "Atiel", className: "Gladiator", level: 45, combatPower: 73000, gearScore: 1600 }, equipment: [
    { id: 101, slot: 1, slotName: "MainHand", name: "Example Greatsword", grade: "Unique", enchantLevel: 15, ampLevel: 0, icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/weapon.png", details: { randomStats: true, bindRate: 100, maxEnchantLevel: 20, maxAmpLevel: 5, stats: [{ name: "Attack", value: "55" }, { name: "Back Attack Damage", value: "8%" }], skills: [{ id: 11, name: "Overhead Slam", level: 1 }] } },
    { id: 102, slot: 2, slotName: "SubHand", name: "Fixed Guard", grade: "Unique", enchantLevel: 10, ampLevel: 0, icon: null, details: { randomStats: false, bindRate: 0, maxEnchantLevel: 10, maxAmpLevel: 0, stats: [{ name: "Defense", value: "100" }], skills: [] } },
  ], skills: [], boards: [], stats: [], wing: { name: "Observed Wings", grade: "Unique", level: 1 }, pet: { name: "Observed Pet", level: 3 }, coverage: { equipment: true, skills: true, boards: true } };
}
function report(): AionGearPriorityReport {
  return { version: "gear-review-1", status: "current", notice: "Gladiator PvE references, scoped to this snapshot.", items: [{ slot: 1, slotName: "MainHand", itemId: 101, itemName: "Example Greatsword", status: "item-pool-verified", basis: "Skill milestone first; remaining groups follow the guide’s rarity keep order, not a calculated DPS ranking.", priorities: [
    { rank: 3, id: "hp", kind: "stat", label: "Max HP", reason: "A lower reference group." },
    { rank: 1, id: "slam", kind: "skill", label: "Overhead Slam", reason: "Check the relevant skill milestone first." },
    { rank: 2, id: "back", kind: "stat", label: "Back Attack Damage", reason: "A reviewed damage-line preference." },
  ], currentLines: [{ label: "Attack", value: "55", kind: "stat", priorityRank: null }, { label: "Back Attack Damage", value: "8%", kind: "stat", priorityRank: 2 }, { label: "Overhead Slam", value: "+1", kind: "skill", priorityRank: 1 }], notices: ["Inspect the current item pool before using Sync."], sources: [{ title: "Gladiator reference", url: "https://docs.google.com/document/d/review/edit", kind: "community-guide", reviewedAt: "2026-10-24" }] }] };
}
function open(name = "Example Greatsword") { const summary = screen.getByLabelText(`${name}: view stats and priorities`); fireEvent.click(summary); return summary.closest("details")!; }

it("opens an equipped item and shows explicit numbered groups beside its actual reported lines", () => {
  render(<AionGearPriorities snapshot={snapshot()} report={report()} />);
  const detail = open(); expect(detail.open).toBe(true);
  const list = within(screen.getByRole("list", { name: "Example Greatsword substat priorities" }));
  const rows = list.getAllByRole("listitem");
  expect(rows.map(row => row.getAttribute("value"))).toEqual(["1", "2", "3"]);
  expect(rows[0].textContent).toContain("Overhead Slam"); expect(rows[1].textContent).toContain("Back Attack Damage"); expect(rows[2].textContent).toContain("Max HP");
  expect(screen.getByText(/remaining groups follow the guide’s rarity keep order/)).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Example Greatsword observed stats" })).getByText("55")).toBeTruthy();
  expect(screen.getByText("Enhancement limit +20 / Amp 5")).toBeTruthy(); expect(screen.getByText("Bind 100%")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Example Greatsword icon" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Gladiator reference" }).getAttribute("href")).toBe("https://docs.google.com/document/d/review/edit");
  expect(screen.getByText("Observed Wings")).toBeTruthy(); expect(screen.getByText("Observed Pet · Level 3")).toBeTruthy();
});

it("uses only backend rank matches and groups tied priorities without inventing string matches", () => {
  const guide = report(); guide.items[0].priorities.push({ rank: 2, id: "critical", kind: "stat", label: "Critical Damage", reason: "An alternative within this reference group." });
  render(<AionGearPriorities snapshot={snapshot()} report={guide} />); open();
  const priorities = within(screen.getByRole("list", { name: "Example Greatsword substat priorities" }));
  expect(priorities.getAllByRole("listitem")).toHaveLength(3);
  expect(priorities.getByText("Back Attack Damage / Critical Damage")).toBeTruthy();
  expect(priorities.getByText("Back Attack Damage 8%")).toBeTruthy();
  const observed = within(screen.getByRole("list", { name: "Example Greatsword observed stats" }));
  const attack = observed.getByText("Attack").closest("li")!;
  expect(within(attack).queryByText(/Reviewed priority/)).toBeNull();
  expect(observed.getByText("Reviewed priority 1")).toBeTruthy(); expect(observed.getByText("Reviewed priority 2")).toBeTruthy();
});

it("does not replace known observed values or attach ranks from a mismatched derived line", () => {
  const guide = report(); guide.items[0].currentLines[0] = { label: "Attack", value: "999", kind: "stat", priorityRank: 1 };
  render(<AionGearPriorities snapshot={snapshot()} report={guide} />); open();
  const observed = within(screen.getByRole("list", { name: "Example Greatsword observed stats" }));
  expect(observed.getByText("55")).toBeTruthy(); expect(observed.queryByText("999")).toBeNull();
  expect(within(observed.getByText("Attack").closest("li")!).queryByText(/Reviewed priority/)).toBeNull();
  expect(within(screen.getByRole("list", { name: "Example Greatsword substat priorities" })).queryByText(/Attack 999/)).toBeNull();
});

it("keeps fixed stats visible and never supplies a reroll priority list for fixed gear", () => {
  const guide = report(); guide.items[0] = { ...guide.items[0], itemId: 102, slot: 2, slotName: "SubHand", itemName: "Fixed Guard", status: "item-pool-verified" };
  render(<AionGearPriorities snapshot={snapshot()} report={guide} />); open("Fixed Guard");
  expect(screen.getByText("Fixed stats — not rerollable")).toBeTruthy(); expect(screen.getByText("These fixed lines cannot be changed with Sync.")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Fixed Guard observed stats" })).getByText("Defense")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Fixed Guard substat priorities" })).toBeNull();
  expect(screen.getByText("Bind 0%")).toBeTruthy(); expect(screen.getByText("Enhancement limit +10 / Amp 0")).toBeTruthy();
});

it("withholds ordered guidance and rank badges under a source hold while preserving observed stats", () => {
  render(<AionGearPriorities snapshot={snapshot()} report={report()} holdReason="Reference information needs review." />); open();
  expect(screen.getByRole("status").textContent).toContain("Reference information needs review.");
  expect(screen.getByRole("status").textContent).toContain("Observed item stats remain visible.");
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
  expect(screen.queryByText(/Reviewed priority 1/)).toBeNull();
  expect(screen.getByText("55")).toBeTruthy(); expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.queryByText("Inspect the current item pool before using Sync.")).toBeNull();
});

it.each(["review-required", "stale", "unsupported", "unverified"] as const)("keeps a %s report from supplying a generic or outdated priority list", status => {
  const guide = report(); guide.status = status; guide.notice = "The class or current source has not been reviewed.";
  render(<AionGearPriorities snapshot={snapshot()} report={guide} />); open();
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
  expect(screen.getByText("55")).toBeTruthy(); expect(screen.getByText("No verified priority for this item")).toBeTruthy();
});

it.each(["wrong-item", "wrong-slot", "slot-reference", "unknown-capability"])("does not substitute a verified order for %s", condition => {
  const data = snapshot(), guide = report();
  if (condition === "wrong-item") guide.items[0].itemId = 999;
  if (condition === "wrong-slot") guide.items[0].slot = 5;
  if (condition === "slot-reference") guide.items[0].status = "slot-reference";
  if (condition === "unknown-capability") data.equipment[0].details!.randomStats = null;
  render(<AionGearPriorities snapshot={data} report={guide} />); open();
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
  expect(screen.getByText("No verified priority for this item")).toBeTruthy();
});

it("leaves unavailable item details unknown instead of substituting zeros or class defaults", () => {
  const data = snapshot(); data.equipment = [data.equipment[0]]; delete data.equipment[0].details;
  render(<AionGearPriorities snapshot={data} />); open();
  expect(screen.getByText("Item detail stats were not reported in this snapshot.")).toBeTruthy();
  expect(screen.queryByText(/Enhancement limit/)).toBeNull(); expect(screen.queryByText(/Bind 0/)).toBeNull();
  expect(screen.queryByRole("list", { name: /substat priorities/ })).toBeNull();
});

it("never fills missing observed metadata with lines injected into a derived report", () => {
  const data = snapshot(); data.equipment = [data.equipment[0]]; delete data.equipment[0].details;
  const guide = report(); guide.items[0].currentLines = [{ label: "Injected stat", value: "777", kind: "stat", priorityRank: 1 }];
  render(<AionGearPriorities snapshot={data} report={guide} />); open();
  expect(screen.getByText("Item detail stats were not reported in this snapshot.")).toBeTruthy();
  expect(screen.queryByText("Injected stat")).toBeNull(); expect(screen.queryByText("777")).toBeNull();
  expect(screen.queryByRole("list", { name: "Example Greatsword observed stats" })).toBeNull();
});

it("shows an exact-pool reference order without inventing observed stats or editable capability", () => {
  const data = snapshot(); data.equipment = [data.equipment[0]]; delete data.equipment[0].details;
  const guide = report(); guide.items[0].status = "item-pool-reference"; guide.items[0].notices = ["Compare the reviewed pool; current item capability is unverified."];
  render(<AionGearPriorities snapshot={data} report={guide} />); open();
  expect(screen.getByText("Reference substat order")).toBeTruthy();
  expect(screen.getByRole("note").textContent).toContain("Exact item pool reviewed; current capability or lines were not returned. Compare only");
  expect(screen.getByRole("note").textContent).toContain("does not establish Sync capability");
  expect(within(screen.getByRole("list", { name: "Example Greatsword substat priorities" })).getAllByRole("listitem").map(row => row.getAttribute("value"))).toEqual(["1", "2", "3"]);
  expect(screen.getByText("Item detail stats were not reported in this snapshot.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Example Greatsword observed stats" })).toBeNull();
  expect(screen.queryByText(/Reviewed priority/)).toBeNull(); expect(screen.queryByText("Reported on item:")).toBeNull();
  expect(screen.getAllByText("Current line match not verified")).toHaveLength(3);
  expect(screen.queryByText("55")).toBeNull(); expect(screen.queryByText("+1")).toBeNull();
});

it("does not display observed match badges for a reference-only pool even when metadata or injected ranks exist", () => {
  const guide = report(); guide.items[0].status = "item-pool-reference";
  render(<AionGearPriorities snapshot={snapshot()} report={guide} />); open();
  expect(screen.getByText("Reference substat order")).toBeTruthy();
  expect(screen.getByText("55")).toBeTruthy();
  expect(screen.queryByText(/Reviewed priority/)).toBeNull(); expect(screen.queryByText("Reported on item:")).toBeNull();
});

it.each(["held", "fixed"])("keeps reference comparison lists hidden when %s", condition => {
  const data = snapshot(), guide = report(); guide.items[0].status = "item-pool-reference";
  if (condition === "fixed") data.equipment[0].details!.randomStats = false;
  render(<AionGearPriorities snapshot={data} report={guide} holdReason={condition === "held" ? "Reference needs review." : null} />); open();
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
  expect(screen.queryByText("Reference substat order")).toBeNull();
});

it("shows the exact parent hold reason in the gear banner and the expanded item", () => {
  const reason = "Saved characters could not be checked. Retry the current character read.";
  render(<AionGearPriorities snapshot={snapshot()} report={report()} holdReason={reason} />);
  expect(within(screen.getByRole("status")).getByText(reason)).toBeTruthy();
  expect(within(open()).getByText(reason)).toBeTruthy();
  expect(screen.queryByText(/Current reviewed guidance is unavailable/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
});

it.each(["stale", "review-required", "unverified"] as const)("shows the specific %s report notice inside the item instead of a generic review claim", status => {
  const guide = report(); guide.status = status;
  guide.notice = `${status}: the equipped snapshot or reference status needs a fresh check.`;
  render(<AionGearPriorities snapshot={snapshot()} report={guide} />);
  expect(within(open()).getByText(guide.notice)).toBeTruthy();
  expect(screen.queryByText(/Current reviewed guidance is unavailable/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
});

it("identifies a missing optional gear report and points to Check saved characters without claiming a stale review", () => {
  render(<AionGearPriorities snapshot={snapshot()} />);
  const message = "The gear priority report was not returned. Use Check saved characters to request it.";
  expect(within(screen.getByRole("status")).getByText(message)).toBeTruthy();
  expect(within(open()).getByText(message)).toBeTruthy();
  expect(screen.queryByText(/Current reviewed guidance is unavailable|needs a current review/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
});
