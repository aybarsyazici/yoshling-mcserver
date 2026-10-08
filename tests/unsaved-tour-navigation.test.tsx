// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { confirmUnsavedSettingsNavigation, hasUnsavedSettings, useUnsavedSettings } from "@/lib/use-unsaved-settings";
function Draft({ dirty }: { dirty: boolean }) { useUnsavedSettings(dirty); return null; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("tour navigation uses real draft registrations", () => {
  it("reports actual drafts and releases them only on clean state or unmount", () => {
    expect(hasUnsavedSettings()).toBe(false); const view = render(<Draft dirty />); expect(hasUnsavedSettings()).toBe(true);
    view.rerender(<Draft dirty={false} />); expect(hasUnsavedSettings()).toBe(false);
    view.rerender(<Draft dirty />); expect(hasUnsavedSettings()).toBe(true); view.unmount(); expect(hasUnsavedSettings()).toBe(false);
  });
  it("requires explicit consent and retains a declined draft", () => {
    const prompt = vi.spyOn(window, "confirm").mockReturnValue(false); render(<Draft dirty />);
    expect(confirmUnsavedSettingsNavigation()).toBe(false); expect(prompt).toHaveBeenCalledWith(expect.stringContaining("unsaved settings changes")); expect(hasUnsavedSettings()).toBe(true);
    prompt.mockReturnValue(true); expect(confirmUnsavedSettingsNavigation()).toBe(true); expect(hasUnsavedSettings()).toBe(true);
  });
  it("does not prompt or change anything without a registered draft", () => {
    const prompt = vi.spyOn(window, "confirm").mockReturnValue(false); render(<Draft dirty={false} />);
    expect(confirmUnsavedSettingsNavigation()).toBe(true); expect(prompt).not.toHaveBeenCalled(); expect(hasUnsavedSettings()).toBe(false);
  });
});
