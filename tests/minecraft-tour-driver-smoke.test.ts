// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { driver, type Driver } from "driver.js";
let active: Driver | null = null;
beforeEach(() => {
  document.body.innerHTML = '<button id="launcher">Take tour</button><button id="tour-target">Protected feature control</button>';
  const target = document.getElementById("tour-target")!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 20, y: 30, top: 30, left: 20, right: 220, bottom: 80, width: 200, height: 50, toJSON() {} });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(target, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => { active?.destroy(); active = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });
describe("installed Driver.js DOM adapter", () => {
  it("highlights the exact real element with an actual popover and destroys its overlay", () => {
    active = driver({ animate: false, smoothScroll: false, disableActiveInteraction: true });
    active.highlight({ element: document.getElementById("tour-target")!, popover: { title: "Real target", description: "Inspect this control without activating it." } });
    expect(active.getActiveElement()).toBe(document.getElementById("tour-target"));
    expect(document.querySelector(".driver-popover-title")?.textContent).toBe("Real target");
    expect(document.querySelector(".driver-active-element")).toBe(document.getElementById("tour-target"));
    expect(active.getConfig().disableActiveInteraction).toBe(true); expect(active.getConfig().animate).toBe(false);
    active.destroy(); expect(document.querySelector(".driver-popover")).toBeNull(); expect(document.querySelector(".driver-overlay")).toBeNull();
    expect(document.getElementById("tour-target")?.classList.contains("driver-active-element")).toBe(false);
  });
  it("binds close to dismissal and removes active keyboard/resize handlers on destroy", () => {
    const add = vi.spyOn(window, "addEventListener"), remove = vi.spyOn(window, "removeEventListener"), close = vi.fn(() => active?.destroy());
    active = driver({ animate: false, allowClose: true, onCloseClick: close });
    active.highlight({ element: "#tour-target", popover: { title: "Dismiss this visit", description: "Dismissal is separate from completion." } });
    (document.querySelector(".driver-popover-close-btn") as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledOnce(); expect(document.querySelector(".driver-overlay")).toBeNull();
    for (const [event, handler] of add.mock.calls.filter(([event]) => ["resize", "scroll", "keyup", "keydown"].includes(event))) {
      expect(remove.mock.calls.some(([removedEvent, removedHandler]) => removedEvent === event && removedHandler === handler)).toBe(true);
    }
  });
  it("calls the distinct Finish hook on the final step instead of the ordinary Next hook", () => {
    const next = vi.fn(), finish = vi.fn();
    active = driver({ animate: false, doneBtnText: "Finish tour", onNextClick: next, onDoneClick: finish, steps: [{ element: "#tour-target", popover: { title: "Final review", description: "Completion uses a separate callback." } }] });
    active.drive(); const button = document.querySelector<HTMLButtonElement>(".driver-popover-next-btn")!; expect(button.textContent).toBe("Finish tour"); button.click();
    expect(finish).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
  });
});
