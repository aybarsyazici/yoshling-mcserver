// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { driver, type Driver } from "driver.js";
import { minecraftTourSteps, type MinecraftTourCapabilities } from "@/lib/minecraft-tour-steps";

let active: Driver | null = null;
const jargon = /\b(?:managers?|members?|admins?|roles?|prove(?:s|d)?|proof|verif(?:y|ied|ication)|unconfirmed|readback|privileged|permissions?)\b/i;
const allIds = ["welcome", "worlds", "create", "current", "cover", "join", "mods", "sets", "backups", "server", "settings", "results"];
const audiences: { name: string; capabilities: MinecraftTourCapabilities; ids: string[] }[] = [
  { name: "all available screens", capabilities: { settings: true, manageProfiles: true, power: true }, ids: allIds },
  { name: "browse-only screens", capabilities: { settings: false, manageProfiles: false, power: false }, ids: allIds.filter(id => id !== "create" && id !== "settings") },
];
afterEach(() => { active?.destroy(); active = null; vi.restoreAllMocks(); });

describe.each(audiences)("plain Minecraft tour copy: $name", ({ capabilities, ids }) => {
  it("renders every available step as short plain text without role or engineering language", () => {
    const steps = minecraftTourSteps("/minecraft", capabilities);
    expect(steps.map(step => step.id)).toEqual(ids);
    active = driver({ animate: false, smoothScroll: false, steps: steps.map(step => ({ popover: { title: step.title, description: step.description } })) });
    active.drive();
    for (const [index, step] of steps.entries()) {
      active.moveTo(index);
      const title = document.querySelector(".driver-popover-title")!;
      const description = document.querySelector(".driver-popover-description")!;
      expect(title.textContent).toBe(step.title); expect(description.textContent).toBe(step.description);
      expect(title.childElementCount).toBe(0); expect(description.childElementCount).toBe(0);
      expect(`${title.textContent} ${description.textContent}`).not.toMatch(jargon);
      expect(step.description.length).toBeLessThanOrEqual(200); expect(step.title.length).toBeLessThanOrEqual(40);
    }
  });
  it("renders an actionable plain fallback for every unavailable target", () => {
    const steps = minecraftTourSteps("/minecraft", capabilities);
    active = driver({ animate: false, smoothScroll: false, steps: steps.map(step => ({ popover: { title: step.title, description: step.unavailable } })) });
    active.drive();
    for (const [index, step] of steps.entries()) {
      active.moveTo(index); const description = document.querySelector(".driver-popover-description")!;
      expect(description.textContent).toBe(step.unavailable); expect(description.childElementCount).toBe(0);
      expect(description.textContent).not.toMatch(jargon); expect(step.unavailable.length).toBeLessThanOrEqual(200);
      expect(step.unavailable).toMatch(/\b(?:Next|continue|later|Open|find|progress|Finish tour)\b/);
    }
  });
});

it("explains all twelve steps using the controls and screens people will actually see", () => {
  const steps = minecraftTourSteps("/minecraft", audiences[0].capabilities);
  const controls: Record<string, RegExp[]> = {
    welcome: [/Next/, /Take tour/], worlds: [/Details/], create: [/Create profile/, /Prepare profile/], current: [/profile cards/, /start or switch/],
    cover: [/Details/, /upload a cover/, /capture a screenshot/], join: [/How to join/, /Multiplayer/, /client pack/], mods: [/Search/, /filters/],
    sets: [/Saved sets/, /Export/], backups: [/Create backup/, /Download/, /Restore/], server: [/Controls/, /Monitor/, /Console/],
    settings: [/save your changes/, /Game rules/, /restart/], results: [/progress/, /Take tour/],
  };
  expect(Object.keys(controls)).toEqual(allIds);
  for (const step of steps) for (const control of controls[step.id]) expect(step.description).toMatch(control);
});
