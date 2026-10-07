// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUnsavedSettings } from "@/lib/use-unsaved-settings";
import type { MouseEvent as ReactMouseEvent } from "react";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { window.history.replaceState(null, "", "/settings"); });

function Guard({ dirty }: { dirty: boolean }) { useUnsavedSettings(dirty); return null; }
function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event); return event.defaultPrevented;
}

function link(href = "/activity", options: { target?: string; download?: string } = {}) {
  const navigated = vi.fn((event: ReactMouseEvent<HTMLAnchorElement>) => event.preventDefault());
  const view = render(<><Guard dirty /><a href={href} {...options} onClick={navigated}><span>Go somewhere</span></a></>);
  return { navigated, ...view };
}

describe("unsaved settings navigation", () => {
  it("warns on browser unload only while a draft is dirty", () => {
    const view = render(<Guard dirty={false} />);
    expect(unload()).toBe(false);
    view.rerender(<Guard dirty />); expect(unload()).toBe(true);
    view.rerender(<Guard dirty={false} />); expect(unload()).toBe(false);
    view.unmount(); expect(unload()).toBe(false);
  });

  it("cancels app-link navigation before its routing handler without losing the draft", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { navigated } = link();
    fireEvent.click(screen.getByText("Go somewhere"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("unsaved settings changes"));
    expect(navigated).not.toHaveBeenCalled();
    expect(unload()).toBe(true);
  });

  it("allows the existing app-link handler after explicit confirmation", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { navigated } = link();
    fireEvent.click(screen.getByText("Go somewhere"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(navigated).toHaveBeenCalledTimes(1);
  });

  it("uses one app-link prompt for multiple dirty panels and retains remaining registrations", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const navigated = vi.fn();
    const view = render(<><Guard key="first" dirty /><Guard key="second" dirty /><a href="/activity" onClick={navigated}>Leave</a></>);
    fireEvent.click(screen.getByText("Leave")); expect(confirm).toHaveBeenCalledTimes(1);
    view.rerender(<><Guard key="second" dirty /><a href="/activity" onClick={navigated}>Leave</a></>);
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByText("Leave")); expect(confirm).toHaveBeenCalledTimes(2);
    view.unmount(); expect(unload()).toBe(false);
  });

  it.each([
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 },
  ])("preserves modified/new-tab link behavior: %j", event => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    link(); fireEvent.click(screen.getByText("Go somewhere"), event);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    { href: "/settings#field", options: {} },
    { href: "/settings", options: {} },
    { href: "/activity", options: { target: "_blank" } },
    { href: "/archive.tar.gz", options: { download: "archive.tar.gz" } },
    { href: "/api/server/backups?download=fixture.tar.gz", options: {} },
    { href: "https://example.invalid/", options: {} },
    { href: "mailto:fixture@example.invalid", options: {} },
  ])("leaves non-app-navigation links unchanged: $href $options", ({ href, options }) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { navigated } = link(href, options);
    fireEvent.click(screen.getByText("Go somewhere"));
    expect(confirm).not.toHaveBeenCalled(); expect(navigated).toHaveBeenCalledTimes(1);
  });

  it("also warns when query navigation would replace the current page", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { navigated } = link("/settings?world=other");
    fireEvent.click(screen.getByText("Go somewhere"));
    expect(confirm).toHaveBeenCalledTimes(1); expect(navigated).not.toHaveBeenCalled();
  });
});
