// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AionNotificationSettings, AionNotificationStatus } from "@/components/aion2-notification-settings";
import { DEFAULT_AION_NOTIFICATION_SETTING } from "@/lib/aion2-notifications";
import type { AionNotificationsController } from "@/hooks/use-aion2-notifications";

afterEach(cleanup);
const now = Date.parse("2026-10-23T12:00:00Z");
const target = { id: "shugo-festival", label: "Shugo Festival", contextKey: "eu:2322", startsAt: "2026-10-23T13:00:00Z", verified: true, verifiedUntil: "2026-10-23T12:30:00Z" };
function controller(): AionNotificationsController {
  const c: AionNotificationsController = { settings: {}, storageStatus: "ready", storageError: null, coordination: "web-locks", permission: "default", audioStatus: "locked", lastAlert: null, deliveryError: null, requestPermission: vi.fn(async () => {}), testSound: vi.fn(async () => {}), retryStorage: vi.fn(async () => {}), updateTargets: vi.fn(), setEventSetting: vi.fn(async (id, patch) => { c.settings = { ...c.settings, [id]: { ...DEFAULT_AION_NOTIFICATION_SETTING, ...c.settings[id], ...patch } }; return true; }) };
  return c;
}
function panel(c = controller(), extra: Partial<React.ComponentProps<typeof AionNotificationSettings>> = {}) {
  return { c, ...render(<AionNotificationSettings eventId="shugo-festival" label="Shugo Festival" target={target} contextLabel="Europe · Atiel" now={now} controller={c} onClose={vi.fn()} {...extra} />) };
}

it("requests desktop permission only after its explicit button and keeps audio activation separate", async () => {
  const c = controller(); render(<AionNotificationStatus controller={c} verifiedEvents={3} />);
  expect(c.requestPermission).not.toHaveBeenCalled(); expect(c.testSound).not.toHaveBeenCalled();
  expect(screen.getByText(/Keep this page open/)).toBeTruthy();
  expect(screen.getByText(/Sound: not activated/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Enable desktop notifications" }));
  await waitFor(() => expect(c.requestPermission).toHaveBeenCalledOnce());
  expect(c.testSound).not.toHaveBeenCalled();
});

it.each(["denied", "unsupported"] as const)("does not prompt when desktop notifications are %s", permission => {
  const c = { ...controller(), permission, deliveryError: "Desktop display unavailable." };
  render(<AionNotificationStatus controller={c} verifiedEvents={0} />);
  expect(screen.queryByRole("button", { name: "Enable desktop notifications" })).toBeNull();
  expect(screen.getByText(/Desktop display unavailable.*In-page reminders remain available/)).toBeTruthy();
  expect(c.requestPermission).not.toHaveBeenCalled();
});

it("saves per-event enabled, early-time, sound and volume preferences after canonical acknowledgement", async () => {
  const { c } = panel();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable this alert" }));
  fireEvent.click(screen.getByRole("button", { name: "5 min" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Alert sound" }), { target: { value: "bell" } });
  fireEvent.change(screen.getByRole("slider", { name: "Alert volume" }), { target: { value: "80" } });
  expect(screen.queryByText("Preferences saved in this browser")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save alerts" }));
  await screen.findByText("Preferences saved in this browser");
  expect(c.setEventSetting).toHaveBeenCalledExactlyOnceWith("shugo-festival", { enabled: true, leadMinutes: 5, sound: "bell", volume: 80 });
  expect(screen.getByText("Saved preference: enabled")).toBeTruthy();
  expect(c.requestPermission).not.toHaveBeenCalled(); expect(c.testSound).not.toHaveBeenCalled();
});

it("validates custom minutes and accepts a zero-minute start reminder", async () => {
  const { c } = panel();
  fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  const input = screen.getByRole("spinbutton", { name: "Minutes before event" });
  fireEvent.change(input, { target: { value: "181" } });
  fireEvent.submit(screen.getByRole("form", { name: "Shugo Festival alert preferences" }));
  expect(screen.getByText("Enter a whole number from 0 to 180 minutes.")).toBeTruthy(); expect(c.setEventSetting).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save alerts" }));
  await screen.findByText("Preferences saved in this browser");
  expect(c.setEventSetting).toHaveBeenCalledWith("shugo-festival", expect.objectContaining({ leadMinutes: 0 }));
});

it("plainly explains when a custom warning for the displayed next start has already passed", () => {
  panel(); fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Minutes before event" }), { target: { value: "120" } });
  const notice = screen.getByText("The 120-minute warning for this start has already passed. This preference applies to a later occurrence.");
  expect(notice.closest("details")).toBeNull();
});

it("blocks new alerts for unknown or expired times but permits disabling an existing preference", async () => {
  const c = controller(); const view = panel(c, { target: undefined });
  expect((screen.getByRole("checkbox", { name: "Enable this alert" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/The next start is unverified/)).toBeTruthy();
  view.unmount(); c.settings["shugo-festival"] = { ...DEFAULT_AION_NOTIFICATION_SETTING, enabled: true };
  panel(c, { target: { ...target, verifiedUntil: "2026-10-23T11:59:00Z" } });
  const enabled = screen.getByRole("checkbox", { name: "Enable this alert" }) as HTMLInputElement;
  expect(enabled.disabled).toBe(false); fireEvent.click(enabled);
  fireEvent.click(screen.getByRole("button", { name: "Save alerts" }));
  await screen.findByText("Preferences saved in this browser");
  expect(c.setEventSetting).toHaveBeenCalledWith("shugo-festival", expect.objectContaining({ enabled: false }));
});

it("plays only the selected sound on Preview sound and keeps Silent silent", async () => {
  const { c } = panel();
  expect(c.testSound).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Alert sound" }), { target: { value: "pulse" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview sound" }));
  await waitFor(() => expect(c.testSound).toHaveBeenCalledExactlyOnceWith("pulse", 60));
  expect(c.setEventSetting).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Alert sound" }), { target: { value: "silent" } });
  expect((screen.getByRole("button", { name: "Preview sound" }) as HTMLButtonElement).disabled).toBe(true);
});

it("waits for a browser settings read and refuses to save defaults after a read error", () => {
  const c = controller(); c.storageStatus = "loading";
  const view = panel(c);
  expect(screen.getByText("Loading saved alert settings…")).toBeTruthy(); expect(screen.queryByRole("button", { name: "Save alerts" })).toBeNull();
  c.storageStatus = "error"; c.storageError = "Browser storage is blocked.";
  view.rerender(<AionNotificationSettings eventId="shugo-festival" label="Shugo Festival" target={target} contextLabel="Europe · Atiel" now={now} controller={c} onClose={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Save alerts" }) as HTMLButtonElement).disabled).toBe(true);
  expect(c.setEventSetting).not.toHaveBeenCalled();
});

it("does not report a failed save as saved and waits for a pending acknowledgement", async () => {
  const c = controller(); let release!: (value: boolean) => void;
  const pending = new Promise<boolean>(resolve => { release = resolve; }); c.setEventSetting = vi.fn(() => pending);
  panel(c); fireEvent.click(screen.getByRole("button", { name: "Save alerts" }));
  expect((screen.getByRole("button", { name: "Save alerts" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Preferences saved in this browser")).toBeNull();
  await act(async () => { release(false); await pending; });
  expect(screen.getByText(/Alert preferences could not be saved/)).toBeTruthy();
  expect(screen.queryByText("Preferences saved in this browser")).toBeNull();
});

it("freezes a draft when another tab changes its saved preferences", () => {
  const c = controller(); const view = panel(c);
  c.settings["shugo-festival"] = { ...DEFAULT_AION_NOTIFICATION_SETTING, sound: "bell" };
  view.rerender(<AionNotificationSettings eventId="shugo-festival" label="Shugo Festival" target={target} contextLabel="Europe · Atiel" now={now} controller={c} onClose={vi.fn()} />);
  expect(screen.getByText(/Preferences changed in another tab/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save alerts" }) as HTMLButtonElement).disabled).toBe(true);
});
