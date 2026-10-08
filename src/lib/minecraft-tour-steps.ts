export interface MinecraftTourCapabilities { settings: boolean; manageProfiles: boolean; power: boolean }
export interface MinecraftTourStep {
  id: string; route: string | "profile-detail"; selector?: string; title: string; description: string;
  unavailable: string; capability?: keyof MinecraftTourCapabilities; immediateFallback?: boolean;
}
export function minecraftTourSelector(name: string): string { return `[data-minecraft-tour="${name}"]`; }
export function minecraftTourHeading(path: string): string {
  return minecraftTourSelector(path === "/minecraft/mods" ? "mods" : path === "/minecraft/backups" ? "backups" : path === "/minecraft/server" ? "server" : path === "/minecraft/settings" ? "settings" : path.startsWith("/minecraft/profiles/") ? "profile-image" : "profiles");
}
export function minecraftTourProfileHref(value: string | null): string | null {
  return value && /^\/minecraft\/profiles\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : null;
}
/** Descriptions are owned static text. A tour never submits a game action. */
export function minecraftTourSteps(path: string, capabilities: MinecraftTourCapabilities): MinecraftTourStep[] {
  const step = (id: string, route: string, target: string, title: string, description: string, unavailable: string, capability?: keyof MinecraftTourCapabilities): MinecraftTourStep => ({ id, route, selector: minecraftTourSelector(target), title, description, unavailable, capability });
  return [
    { id: "welcome", route: path, selector: minecraftTourHeading(path), title: "Let’s look around", description: "Find your worlds, join friends and explore the Minecraft tools. Use Next to follow along. Take tour is here whenever you want another look.", unavailable: "We’ll start with your worlds. Use Next to continue." },
    step("worlds", "/minecraft", "worlds", "Your worlds", "Each profile is a separate world with its own version, mods and settings. Open Details to learn more about one.", "Your worlds aren’t showing here. You can continue the tour and come back later."),
    step("create", "/minecraft", "profile-create", "Make a new world", "Choose Create profile, give it a name and pick vanilla or a modpack. Prepare profile gets it ready; you choose when to start it.", "Create profile isn’t showing here. You can continue the tour.", "manageProfiles"),
    step("current", "/minecraft", "current-profile", "Your current world", "This panel shows which world Minecraft is using and whether it’s running. Use the profile cards to start or switch worlds.", "Open Profiles later to check your current world."),
    { ...step("cover", "profile-detail", "profile-image", "Give your world a picture", "Profile images help you recognise your worlds. Open Details to see the terrain overview, upload a cover or capture a screenshot from your game.", "Open a profile’s Details later to choose its picture."), route: "profile-detail" },
    step("join", "/minecraft", "join", "Join your friends", "Open How to join, copy the address and add it in Minecraft Java Edition’s Multiplayer screen. Match the shown version and use the world’s client pack when needed.", "Open How to join on Profiles for the address and client details."),
    step("mods", "/minecraft/mods", "mods-installed", "Explore your mods", "See the mods this world uses. Search and filters help you find one, and opening it shows more details.", "Open Mods later to browse the list."),
    step("sets", "/minecraft/mods", "saved-mod-sets", "Keep favourite mod sets", "Saved sets keep collections of mods handy for another world. Open a set to see its contents, or choose Export for client installation instructions.", "You can find saved sets below the installed mods."),
    step("backups", "/minecraft/backups", "backup-list", "Keep a save to return to", "Create backup keeps a copy of your world. Download a copy to keep for yourself, or use Restore to return to an earlier save.", "Open Backups later to check your saved archives."),
    step("server", "/minecraft/server", "server-tabs", "Check the server", "Use Controls for power and players, Monitor for performance, and Console for logs and commands.", "Open Server later to explore its tools."),
    step("settings", "/minecraft/settings", "settings", "Make the world yours", "Adjust gameplay settings here and save your changes when ready. Game rules apply straight away; other settings may ask for a restart.", "Open Settings later when the page is ready.", "settings"),
    { ...step("results", "/minecraft", "operation-strip", "You’re ready to explore", "This bar shows progress while worlds are being prepared, backups are being made and other jobs are running. Use Take tour whenever you’d like a reminder.", "Job progress appears here when there’s work to follow. Choose Finish tour to wrap up."), immediateFallback: true },
  ].filter(item => !item.capability || capabilities[item.capability]);
}
