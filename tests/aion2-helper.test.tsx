// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AionHelper, isAionCharacterList, isAionTrackedCharacter } from "@/components/aion2-helper";
import type { AionCharacterList, AionTrackedCharacter } from "@/lib/aion2-types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function character(): AionTrackedCharacter {
  const now = new Date().toISOString();
  return {
    id: "saved-a", region: "eu", serverId: 2322, characterId: "character-a=", name: "Daeva", serverName: "Atiel", tracking: true,
    lastAttemptAt: now, lastSuccessAt: now, nextRefreshAt: new Date(Date.now() + 900_000).toISOString(), lastError: null,
    snapshot: { version: 1, ref: { region: "eu", serverId: 2322, characterId: "character-a=" }, observedAt: now,
      profile: { name: "Daeva", serverName: "Atiel", className: "Gladiator", level: 45, combatPower: 73000, gearScore: 1638, portrait: "https://profileimg.plaync.com/game_profile_images/aion2global/images?gameServerKey=2322&charKey=1" },
      equipment: [{ id: 1, slot: 1, slotName: "MainHand", name: "Example Greatsword", grade: "Unique", enchantLevel: 15, ampLevel: 0, icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/greatsword.png" }],
      skills: [{ id: 11170000, name: "Overhead Slam", category: "Active", level: 14, acquired: true, equipped: true, icon: "https://assets.playnccdn.com/static-aion2-gamedata/resources/skill.png" }],
      boards: [{ id: 11, name: "Nezekan", openNodes: 62, totalNodes: 88 }], stats: [], wing: null, pet: null,
      coverage: { equipment: true, skills: true, boards: true } },
    history: [{ observedAt: now, combatPower: 73000, gearScore: 1638 }],
    recommendations: [{ id: "slam", priority: "high", title: "Work toward Overhead Slam level 20", evidence: "Overhead Slam is level 14.", action: "Review your ring and Arcana skill bonuses.", source: "https://docs.google.com/document/d/guide/edit" }],
  };
}
function list(characters: AionTrackedCharacter[] = []): AionCharacterList { return { characters, pollIntervalMs: 900_000, checkedAt: new Date().toISOString(), knowledge: { version: "test-review", reviewedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: "current", supportedClasses: ["Gladiator"], notices: [] } }; }
function backend(custom?: (url: string, options?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn((input: string, options?: RequestInit) => {
    const url = String(input);
    const override = custom?.(url, options);
    if (override) return Promise.resolve(override);
    if (url.includes("/servers")) return Promise.resolve(json({ servers: [{ id: 2322, name: "Atiel", race: 2 }] }));
    if (url.includes("/search")) return Promise.resolve(json({ characters: [{ name: "Yoshiane", serverName: "Atiel", region: "eu", serverId: 2322, characterId: "character-a=", level: 45, className: "Gladiator" }] }));
    return Promise.resolve(json(list()));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("loads an empty roster and prefills a name/server without tracking anything automatically", async () => {
  const calls = backend(); render(<AionHelper />);
  await screen.findByText("Add your first character below to start a progression history.");
  expect(screen.getByRole("heading", { level: 1, name: "Track your progress" })).toBeTruthy();
  expect(screen.queryByText(/A stronger Daeva|one step at a time|Your next upgrade starts here/)).toBeNull();
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Server" }) as HTMLSelectElement).value).toBe("2322"));
  expect((screen.getByRole("textbox", { name: "Character name" }) as HTMLInputElement).value).toBe("Yoshiane");
  expect(calls.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  expect(screen.queryByRole("button", { name: /Track Yoshiane/ })).toBeNull();
});

it("accepts only a validated same-identity snapshot and safe guide links", () => {
  const c = character(); expect(isAionTrackedCharacter(c)).toBe(true); expect(isAionCharacterList(list([c]))).toBe(true);
  expect(isAionTrackedCharacter({ ...c, snapshot: { ...c.snapshot, ref: { ...c.snapshot!.ref, serverId: 1000 } } })).toBe(false);
  expect(isAionTrackedCharacter({ ...c, recommendations: [{ ...c.recommendations[0], source: "javascript:alert(1)" }] })).toBe(false);
  expect(isAionCharacterList({ ...list([c]), characters: [c, c] })).toBe(false);
  expect(isAionTrackedCharacter({ ...c, snapshot: { ...c.snapshot, profile: { ...c.snapshot!.profile, combatPower: "73000" } } })).toBe(false);
});

it("validates gear report identity and sources, then withholds its priorities after a failed canonical read", async () => {
  const c = character(); c.snapshot!.equipment[0].details = { maxEnchantLevel: 20, maxAmpLevel: 0, randomStats: true, bindRate: 100, stats: [{ name: "Attack", value: "10" }], skills: [] };
  c.gearPriorities = { version: "review-1", status: "current", notice: "Reviewed item references.", items: [{ slot: 1, slotName: "MainHand", itemId: 1, itemName: "Example Greatsword", status: "item-pool-verified", basis: "A reviewed keep reference, not a calculated DPS order.", priorities: [{ rank: 1, kind: "stat", id: "attack", label: "Attack", reason: "A reviewed line in the item pool." }], currentLines: [{ kind: "stat", label: "Attack", value: "10", priorityRank: 1 }], notices: [], sources: [{ title: "Item reference", url: "https://docs.google.com/document/d/guide/edit", kind: "community-guide", reviewedAt: "2026-10-24" }] }] };
  expect(isAionTrackedCharacter(c)).toBe(true);
  expect(isAionTrackedCharacter({ ...c, gearPriorities: { ...c.gearPriorities, items: [{ ...c.gearPriorities.items[0], itemId: 999 }] } })).toBe(false);
  expect(isAionTrackedCharacter({ ...c, gearPriorities: { ...c.gearPriorities, items: [{ ...c.gearPriorities.items[0], sources: [{ ...c.gearPriorities.items[0].sources[0], url: "javascript:alert(1)" }] }] } })).toBe(false);
  let failed = false;
  backend(url => url === "/api/aion2/characters" ? failed ? json({ error: "Read failed" }, 503) : json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Example Greatsword");
  fireEvent.click(screen.getByLabelText("Example Greatsword: view stats and priorities"));
  expect(screen.getByRole("list", { name: "Example Greatsword substat priorities" })).toBeTruthy();
  failed = true; fireEvent.click(screen.getByRole("button", { name: "Check saved characters" }));
  await screen.findByText(/Saved data is shown below. Read failed/);
  expect(screen.queryByRole("list", { name: "Example Greatsword substat priorities" })).toBeNull();
  expect(within(screen.getByRole("list", { name: "Example Greatsword observed stats" })).getByText("10")).toBeTruthy();
});

it("keeps initial malformed list data unavailable and prevents add actions", async () => {
  backend(url => url === "/api/aion2/characters" ? json({ characters: [] }) : undefined);
  render(<AionHelper />); await screen.findByText("Saved characters could not be verified. Please retry.");
  await screen.findByRole("option", { name: "Atiel" });
  expect((screen.getByRole("button", { name: "Find character" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Combat Power")).toBeNull();
});

it("renders observed metrics, evidence, skills and a one-point history without invented earlier values", async () => {
  backend(url => url === "/api/aion2/characters" ? json(list([character()])) : undefined);
  render(<AionHelper />); await screen.findByText("Work toward Overhead Slam level 20");
  expect(screen.getAllByText("73,000").length).toBeGreaterThan(0); expect(screen.getByText("1,638")).toBeTruthy();
  expect(screen.getByText("Overhead Slam is level 14.")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Daeva portrait" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "Example Greatsword icon" })).toBeTruthy();
  expect(screen.getByText(/First snapshot recorded/)).toBeTruthy();
  expect(screen.queryByRole("img", { name: /history/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "skills" }));
  expect(screen.getByText("Overhead Slam")).toBeTruthy(); expect(screen.getByText("Lv. 14")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Overhead Slam icon" })).toBeTruthy();
  expect(screen.getByText(/Quest completion, currencies, inventory and daily entries are not available/)).toBeTruthy();
});

it("discards a late search result after the name changes", async () => {
  let resolve!: (value: Response) => void;
  const result = new Promise<Response>(r => { resolve = r; });
  backend(url => url.includes("/search") ? result : undefined);
  render(<AionHelper />); await waitFor(() => expect((screen.getByRole("button", { name: "Find character" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Find character" }));
  await screen.findByText("Searching…");
  fireEvent.change(screen.getByRole("textbox", { name: "Character name" }), { target: { value: "Another" } });
  await act(async () => { resolve(json({ characters: [{ name: "Yoshiane", serverName: "Atiel", region: "eu", serverId: 2322, characterId: "old=", level: 45, className: "Gladiator" }] })); await result; });
  expect(screen.queryByRole("button", { name: /Track Yoshiane/ })).toBeNull();
});

it("retains the last snapshot after a failed list check but disables mutations until recovery", async () => {
  let failed = false;
  backend(url => url === "/api/aion2/characters" ? (failed ? json({ error: "Armory unavailable" }, 503) : json(list([character()]))) : undefined);
  render(<AionHelper />); await screen.findByText("Work toward Overhead Slam level 20");
  failed = true; fireEvent.click(screen.getByRole("button", { name: "Check saved characters" }));
  await screen.findByText(/Saved data is shown below. Armory unavailable/);
  expect(screen.getByText("Example Greatsword")).toBeTruthy();
  expect(screen.queryByText("Work toward Overhead Slam level 20")).toBeNull();
  expect(screen.queryByText("Activity guide")).toBeNull();
  expect(screen.getByText(/Recommendations are withheld because saved characters could not be checked/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement).disabled).toBe(true);
  failed = false; fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText("Work toward Overhead Slam level 20")).toBeTruthy();
});

it("does not accept a malformed add receipt as a saved character and rechecks canonical state", async () => {
  const calls = backend((url, options) => url === "/api/aion2/characters" && options?.method === "POST" ? json({ character: { id: "wrong", name: "Fake" } }) : undefined);
  render(<AionHelper />); await waitFor(() => expect((screen.getByRole("button", { name: "Find character" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Find character" }));
  fireEvent.click(await screen.findByRole("button", { name: "Track Yoshiane on Atiel" }));
  await screen.findByText(/The saved character could not be verified. Current saved characters are shown/);
  expect(screen.queryByText("Fake")).toBeNull();
  expect(calls.mock.calls.filter(([url]) => url === "/api/aion2/characters").length).toBe(3);
});

it("renders unavailable values as unavailable and preserves a recorded decrease in history", async () => {
  const c = character(); c.snapshot!.profile.combatPower = null;
  c.history = [{ observedAt: "2026-10-20T12:00:00Z", combatPower: 90000, gearScore: 1700 }, { observedAt: "2026-10-21T12:00:00Z", combatPower: 80000, gearScore: 1638 }];
  backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Unavailable");
  expect(screen.getByRole("img", { name: "Combat Power history: 90,000 to 80,000" })).toBeTruthy();
  expect(screen.getByText("-10,000 since first saved point")).toBeTruthy();
});

it.each(["missing", "expired", "unverified", "review-required"] as const)("withholds recommendations and routine when source status is %s without claiming no upgrade gap", async status => {
  const payload = list([character()]);
  if (status === "missing") delete payload.knowledge;
  else payload.knowledge!.status = status;
  backend(url => url === "/api/aion2/characters" ? json(payload) : undefined);
  render(<AionHelper />); await screen.findByText(/Recommendations are withheld/);
  expect(screen.queryByText("Work toward Overhead Slam level 20")).toBeNull();
  expect(screen.queryByText("Activity guide")).toBeNull();
  expect(screen.queryByText(/No specific upgrade gap|No applicable recommendations/)).toBeNull();
  expect(screen.getByText("Example Greatsword")).toBeTruthy();
  expect(screen.getByText("1,638")).toBeTruthy();
});

it("describes a reference review hold without claiming that a newer patch exists", async () => {
  const payload = list([character()]); payload.knowledge!.status = "review-required";
  payload.knowledge!.notices = ["A pinned reference changed after review."];
  backend(url => url === "/api/aion2/characters" ? json(payload) : undefined);
  render(<AionHelper />);
  await screen.findByText("Recommendations are withheld until updated patch or reference information has been reviewed.");
  expect(screen.queryByText(/a newer patch needs/)).toBeNull();
});

it("withholds a current status whose review deadline has passed", async () => {
  const payload = list([character()]); payload.knowledge!.expiresAt = new Date(Date.now() - 1_000).toISOString();
  backend(url => url === "/api/aion2/characters" ? json(payload) : undefined);
  render(<AionHelper />); await screen.findByText("Recommendations are withheld because the source review has expired.");
  expect(screen.queryByText("Work toward Overhead Slam level 20")).toBeNull();
  expect(screen.queryByText("Activity guide")).toBeNull();
});

it.each([31 * 60_000, -6 * 60_000])("withholds recommendations for a snapshot with an age of %s milliseconds", async age => {
  const c = character(); c.snapshot!.observedAt = new Date(Date.now() - age).toISOString();
  backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText(/Recommendations are withheld because the snapshot needs a fresh check/);
  expect(screen.getByText("Snapshot needs a check")).toBeTruthy();
  expect(screen.queryByText("Work toward Overhead Slam level 20")).toBeNull();
  expect(screen.queryByText("Activity guide")).toBeNull();
});

it("ages recommendations out using the client clock while an inactive tab does not poll", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  const payload = list([character()]);
  backend(url => url === "/api/aion2/characters" ? json(payload) : undefined);
  render(<AionHelper />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("Work toward Overhead Slam level 20")).toBeTruthy();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000); });
  expect(screen.queryByText("Work toward Overhead Slam level 20")).toBeNull();
  expect(screen.getByText(/Recommendations are withheld because the snapshot needs a fresh check/)).toBeTruthy();
  expect(screen.getByText("Snapshot needs a check")).toBeTruthy();
  expect(screen.getByText("Example Greatsword")).toBeTruthy();
});

function withPlan() {
  const c = character();
  c.recommendations[0].steps = [
    { id: "inspect", title: "Inspect your skill sources", instruction: "Open Skills, select Overhead Slam, and check its level sources.", reason: "Choose an upgrade that contributes to this skill.", source: "https://docs.google.com/document/d/guide/edit", status: "ready" },
    { id: "farm", title: "Choose a reward claim", instruction: "If you have at least 40 Odyle, claim a suitable dungeon reward. Otherwise, review your Daevanion skill nodes first.", cost: { resource: "odyle", amount: 40 }, status: "manual-check" },
  ];
  c.recommendations[0].budget = { available: null, costPerRun: 40, affordableRuns: null, updatedAt: null };
  return c;
}

function withChecklist(name = "Daeva", id = "saved-a"): AionTrackedCharacter {
  const c = character(); c.name = name; c.id = id; c.characterId = `${id}=`;
  c.snapshot!.ref.characterId = c.characterId; c.snapshot!.profile.name = name;
  c.checklist = { status: "current", notice: "Report the available activities you checked in game.", revision: "checklist-v1", items: [
    { id: "daily-dungeon", name: "Daily Dungeon", cadence: "daily", scope: "character", instruction: "Open Daily Dungeon and check remaining entries.", rewardTags: ["Enhancement materials"], source: "https://docs.google.com/spreadsheets/d/checklist/edit#gid=1", completed: false, completedAt: null, periodKey: "daily-period", nextResetAt: new Date(Date.now() + 86_400_000).toISOString() },
    { id: "scrolls", name: "Command Mission scroll purchases", cadence: "weekly", scope: "server", instruction: "Review Command Mission scrolls in the shop.", rewardTags: ["Daevanion Crystals"], source: "https://docs.google.com/spreadsheets/d/checklist/edit#gid=1", completed: false, completedAt: null, periodKey: "weekly-period", nextResetAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
  ] };
  return c;
}

it("validates checklist scopes, reset periods, safe sources and linked report fields", () => {
  const c = withChecklist(); expect(isAionTrackedCharacter(c)).toBe(true);
  const item = c.checklist!.items[0];
  for (const malformed of [{ ...item, scope: "friends" }, { ...item, nextResetAt: "not-a-time" }, { ...item, periodKey: "" }, { ...item, source: "https://docs.google.com.evil.test/" }]) {
    expect(isAionTrackedCharacter({ ...c, checklist: { ...c.checklist!, items: [malformed] } })).toBe(false);
  }
  expect(isAionTrackedCharacter({ ...c, checklist: { ...c.checklist!, items: [item, item] } })).toBe(false);
  c.recommendations[0].steps = [{ id: "collect", title: "Collect materials", instruction: "Check the activity list.", checklistActivityIds: ["daily-dungeon"], reportedDone: true, progressNote: "Your activity was reported; the skill remains level 14." }];
  expect(isAionTrackedCharacter(c)).toBe(true);
  expect(isAionTrackedCharacter({ ...c, recommendations: [{ ...c.recommendations[0], steps: [{ ...c.recommendations[0].steps[0], reportedDone: "yes" }] }] })).toBe(false);
});

it("saves an activity report with its period and revision, then reloads shared server checks for your other character", async () => {
  let reported = false;
  const all = () => [withChecklist(), withChecklist("Alt Daeva", "saved-b")].map(c => {
    if (reported) { c.checklist!.revision = "checklist-v2"; c.checklist!.items[1].completed = true; c.checklist!.items[1].completedAt = new Date().toISOString(); }
    return c;
  });
  let release!: (response: Response) => void;
  const saved = new Promise<Response>(resolve => { release = resolve; });
  const calls = backend((url, options) => {
    if (url === "/api/aion2/characters/saved-a/checklist" && options?.method === "PATCH") return saved;
    if (url === "/api/aion2/characters") return json(list(all()));
  });
  render(<AionHelper />); await screen.findByText("Daily Dungeon");
  fireEvent.click(screen.getByRole("button", { name: "This week 0/1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Mark Command Mission scroll purchases complete" }));
  await screen.findByText("Saving your report…");
  const pending = screen.getByRole("checkbox", { name: "Mark Command Mission scroll purchases complete" }) as HTMLInputElement;
  expect(pending.checked).toBe(false); expect(pending.disabled).toBe(true);
  const patch = calls.mock.calls.find(([url]) => url.endsWith("/checklist"));
  expect(JSON.parse(patch![1]!.body as string)).toEqual({ activityId: "scrolls", completed: true, periodKey: "weekly-period", revision: "checklist-v1" });
  reported = true;
  await act(async () => { release(json({ character: all()[0] })); await saved; });
  await screen.findByRole("button", { name: "This week 1/1" });
  expect((screen.getByRole("checkbox", { name: "Mark Command Mission scroll purchases incomplete" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Alt Daeva Atiel/ }));
  fireEvent.click(screen.getByRole("button", { name: "This week 1/1" }));
  expect((screen.getByRole("checkbox", { name: "Mark Command Mission scroll purchases incomplete" }) as HTMLInputElement).checked).toBe(true);
  expect(calls.mock.calls.filter(([url]) => url === "/api/aion2/characters")).toHaveLength(2);
});

it("treats a mismatched checklist receipt as unconfirmed and reloads instead of claiming completion", async () => {
  const c = withChecklist();
  backend((url, options) => url.endsWith("/checklist") && options?.method === "PATCH" ? json({ character: c }) : url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Daily Dungeon");
  fireEvent.click(screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }));
  await screen.findByText(/The checklist report could not be confirmed. Current saved characters are shown/);
  expect((screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }) as HTMLInputElement).checked).toBe(false);
});

it("reconciles a lost checklist response and leaves checks disabled when canonical reread also fails", async () => {
  let changed = false;
  backend((url, options) => {
    if (url.endsWith("/checklist") && options?.method === "PATCH") { changed = true; return Promise.reject(new Error("Connection lost")); }
    if (url === "/api/aion2/characters") return changed ? json({ error: "Read unavailable" }, 503) : json(list([withChecklist()]));
  });
  render(<AionHelper />); await screen.findByText("Daily Dungeon");
  fireEvent.click(screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }));
  await screen.findByText(/The change is unconfirmed until saved characters can be reloaded/);
  expect((screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }) as HTMLInputElement).disabled).toBe(true);
});

it("does not switch back to an old selected character when a delayed report finishes", async () => {
  const a = withChecklist(), b = withChecklist("Alt Daeva", "saved-b");
  let release!: (response: Response) => void;
  const saved = new Promise<Response>(resolve => { release = resolve; });
  backend((url, options) => url.endsWith("/checklist") && options?.method === "PATCH" ? saved : url === "/api/aion2/characters" ? json(list([a, b])) : undefined);
  render(<AionHelper />); await screen.findByText("Daily Dungeon");
  fireEvent.click(screen.getByRole("checkbox", { name: "Mark Daily Dungeon complete" }));
  fireEvent.click(screen.getByRole("button", { name: /Alt Daeva Atiel/ }));
  a.checklist!.items[0].completed = true;
  await act(async () => { release(json({ character: a })); await saved; });
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("heading", { name: "Alt Daeva" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Daeva" })).toBeNull();
});

it("uses reported activity progress to point to the next resource check without marking the skill goal complete", async () => {
  const c = withPlan();
  c.recommendations[0].steps![0] = { ...c.recommendations[0].steps![0], checklistActivityIds: ["daily-dungeon"], reportedDone: true, progressNote: "Activity reported; verify the skill separately." };
  c.recommendations[0].steps![1] = { ...c.recommendations[0].steps![1], checklistActivityIds: ["scrolls"], reportedDone: false };
  backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Activity reported; verify the skill separately.");
  const steps = within(screen.getByRole("list", { name: "Work toward Overhead Slam level 20 steps" }));
  expect(steps.getByText("Activity reported done")).toBeTruthy();
  expect(steps.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.getByText("Next resource check:").parentElement!.textContent).toContain("Choose a reward claim");
  expect(screen.getByText("Overhead Slam is level 14.")).toBeTruthy();
  expect(screen.getByText("Work toward Overhead Slam level 20")).toBeTruthy();
});

it("shows concrete numbered instructions and reasons without requiring an Odyle entry", async () => {
  const c = withPlan(); backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Inspect your skill sources");
  expect(screen.getByRole("list", { name: "Work toward Overhead Slam level 20 steps" })).toBeTruthy();
  expect(screen.getByText("Open Skills, select Overhead Slam, and check its level sources.")).toBeTruthy();
  expect(screen.getByText(/Otherwise, review your Daevanion skill nodes first/)).toBeTruthy();
  expect(screen.getByText("40 Odyle")).toBeTruthy();
  expect(screen.getByText("Why this step?")).toBeTruthy();
  expect(screen.getByText("No balance entered")).toBeTruthy();
  expect(screen.getByText(/entering a balance here is optional/)).toBeTruthy();
  expect((screen.getByText("Optional Odyle budget").closest("details") as HTMLDetailsElement).open).toBe(false);
});

it("treats an entered zero as zero and labels the estimate as based on the last entry", async () => {
  const c = withPlan(); c.resources = { odyleEnergy: 0, updatedAt: new Date().toISOString() };
  c.recommendations[0].budget = { available: 0, costPerRun: 40, affordableRuns: 0, updatedAt: c.resources.updatedAt };
  backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText(/Based on your last entry of 0: 0 reward claims/);
  expect(screen.getByText("Last entry: 0")).toBeTruthy();
  expect(screen.getByText(/spending and recharge since then are not tracked/)).toBeTruthy();
});

it("saves an optional balance using a canonical readback and leaves unknown clearing explicit", async () => {
  let current = withPlan(); current.resources = { odyleEnergy: null, updatedAt: null };
  const calls = backend((url, options) => {
    if (url === "/api/aion2/characters/saved-a" && options?.method === "PATCH") {
      const body = JSON.parse(String(options.body));
      current = { ...current, resources: { odyleEnergy: body.odyleEnergy, updatedAt: new Date().toISOString() } };
      return json({ character: current });
    }
    return url === "/api/aion2/characters" ? json(list([current])) : undefined;
  });
  render(<AionHelper />); await screen.findByText("Inspect your skill sources");
  fireEvent.click(screen.getByText("Optional Odyle budget"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Odyle shown in game" }), { target: { value: "80" } });
  fireEvent.submit(screen.getByRole("form", { name: "Odyle budget" }));
  await screen.findByText("Last entry: 80");
  expect(calls.mock.calls.find(([url, options]) => url.endsWith("/saved-a") && options?.method === "PATCH")?.[1]?.body).toBe(JSON.stringify({ odyleEnergy: 80 }));
  fireEvent.click(screen.getByText("Optional Odyle budget"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Odyle shown in game" }), { target: { value: "" } });
  fireEvent.submit(screen.getByRole("form", { name: "Odyle budget" }));
  await screen.findByText("No balance entered");
  const writes = calls.mock.calls.filter(([url, options]) => url.endsWith("/saved-a") && options?.method === "PATCH");
  expect(writes[1][1]?.body).toBe(JSON.stringify({ odyleEnergy: null }));
});

it("rejects fractional balances locally and rejects malformed step and budget data", async () => {
  const c = withPlan(); const calls = backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Inspect your skill sources");
  fireEvent.click(screen.getByText("Optional Odyle budget"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Odyle shown in game" }), { target: { value: "2.5" } });
  fireEvent.submit(screen.getByRole("form", { name: "Odyle budget" }));
  expect(screen.getByText(/Enter a whole number between 0 and 10,000/)).toBeTruthy();
  expect(calls.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  const bad = structuredClone(c); bad.recommendations[0].steps![0].source = "javascript:alert(1)";
  expect(isAionTrackedCharacter(bad)).toBe(false);
  expect(isAionTrackedCharacter({ ...c, resources: { odyleEnergy: -1, updatedAt: null } })).toBe(false);
});

it("keeps multiple reviewed source links and related explanations collapsed until requested", async () => {
  const c = withPlan();
  c.recommendations[0].evidenceSources = [
    { title: "Reviewed gear guide", url: "https://docs.google.com/document/d/guide/edit", kind: "community-guide", reviewedAt: "2026-10-23" },
    { title: "Item data reference", url: "https://aion2.gg/items/example", kind: "client-data", reviewedAt: "2026-10-23" },
  ];
  c.recommendations[0].relatedEvidence = [{ id: "skill-source", title: "How skill levels combine", text: "Ring bonuses and Arcana add to the skill's invested levels.", sources: [c.recommendations[0].evidenceSources[0]] }];
  backend(url => url === "/api/aion2/characters" ? json(list([c])) : undefined);
  render(<AionHelper />); await screen.findByText("Sources for this plan (2)");
  const sourceDetails = screen.getByText("Sources for this plan (2)").closest("details") as HTMLDetailsElement;
  const relatedDetails = screen.getByText("Related reviewed explanations (1)").closest("details") as HTMLDetailsElement;
  expect(sourceDetails.open).toBe(false); expect(relatedDetails.open).toBe(false);
  fireEvent.click(screen.getByText("Sources for this plan (2)"));
  expect(within(sourceDetails).getByRole("link", { name: "Reviewed gear guide" }).getAttribute("href")).toBe("https://docs.google.com/document/d/guide/edit");
  expect(within(sourceDetails).getByRole("link", { name: "Item data reference" }).getAttribute("href")).toBe("https://aion2.gg/items/example");
  expect(screen.getByText(/Game data reference · Reviewed/)).toBeTruthy();
  fireEvent.click(screen.getByText("Related reviewed explanations (1)"));
  expect(screen.getByText("How skill levels combine")).toBeTruthy();
  expect(screen.queryByText(/confidence|cosine|embedding model/i)).toBeNull();
});

it("rejects unsafe or unreviewed semantic evidence metadata before rendering recommendations", () => {
  const c = withPlan();
  c.recommendations[0].evidenceSources = [{ title: "Bad source", url: "javascript:alert(1)", kind: "community-guide", reviewedAt: "2026-10-23" }];
  expect(isAionTrackedCharacter(c)).toBe(false);
  c.recommendations[0].evidenceSources = undefined;
  c.recommendations[0].relatedEvidence = [{ id: "bad", title: "Bad evidence", text: "Unsupported text", sources: [{ title: "Unreviewed", url: "https://attacker.example/guide", kind: "community-guide", reviewedAt: "2026-10-23" }] }];
  expect(isAionTrackedCharacter(c)).toBe(false);
  c.recommendations[0].relatedEvidence[0].sources[0] = { title: "Missing review", url: "https://aion2.gg/example", kind: "client-data", reviewedAt: "unknown" };
  expect(isAionTrackedCharacter(c)).toBe(false);
});
