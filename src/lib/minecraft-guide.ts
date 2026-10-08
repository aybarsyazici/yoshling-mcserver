import { GAMES } from "./games";
import type { MinecraftGuideChapterId } from "./minecraft-guide-progress";

export interface MinecraftGuideChapter {
  id: MinecraftGuideChapterId;
  title: string;
  summary: string;
  steps: readonly { label: string; text: string }[];
  note: string;
  href: string;
  linkLabel: string;
  settingsOnly?: boolean;
}

/** Navigation and explanations only. Completing a chapter does not operate a game. */
export const MINECRAFT_GUIDE_CHAPTERS: readonly MinecraftGuideChapter[] = [
  {
    id: "welcome",
    title: "Find your way around",
    summary: "Your Minecraft worlds live in Profiles. The other pages describe the currently selected world.",
    steps: [
      { label: "Open Minecraft", text: "Choose Minecraft in the sidebar. If it is missing, ask an admin to grant your account Minecraft access." },
      { label: "Know your role", text: "Members can inspect profiles, join the game, browse mods and view server information. Managers—admins or moderators with Minecraft access—can prepare, edit and operate worlds." },
      { label: "Watch the operation strip", text: "After a manager changes something, read its checked result. A failed, partial or unverified result needs a fresh reading before another attempt." },
    ],
    note: "Tutorial completion records reading progress in this browser. It does not confirm that a world was started, changed or backed up.",
    href: "/minecraft",
    linkLabel: "Open Minecraft profiles",
  },
  {
    id: "profiles",
    title: "Keep each world together",
    summary: "A profile keeps its world, Minecraft version, loader, mods and settings together.",
    steps: [
      { label: "Inspect a profile", text: "On Profiles, open Details to see a world's target and source. Applied identifies the profile verified against the server; check its current state before making changes." },
      { label: "Prepare a new world", text: "Managers choose Create profile, enter a name, then select Vanilla, Saved mod set or Published pack. Choose an exact version or published build and an optional new-world seed. Leave Java runtime automatic unless the owner has reviewed another choice." },
      { label: "Wait until it is ready", text: "Press Prepare profile and follow the operation strip. Preparation does not start Minecraft. If the existing-world banner appears, use Keep existing world as a profile first; adoption preserves it and leaves Minecraft stopped." },
    ],
    note: "Prepared versions and loaders are fixed. Create another profile for a different target. Members can open Details and ask a manager to prepare a world.",
    href: "/minecraft",
    linkLabel: "Browse profiles",
  },
  {
    id: "play",
    title: "Start a world and join",
    summary: "Choose the right profile, review who will disconnect, then match your Minecraft client to it.",
    steps: [
      { label: "Start or switch", text: "Managers use Start this profile, select the world and press Start selected profile. While Minecraft runs, another world offers Switch & restart. Review the listed running games and confirm the player disconnections before submitting." },
      { label: "Read the join instructions", text: `Open How to join and use Copy beside ${GAMES.minecraft.connect[0]}. Check the Minecraft server target, then add the address in Minecraft Java Edition's Multiplayer screen.` },
      { label: "Match your client", text: "Use the displayed Minecraft version. For a modded world, ask its owner for the matching client loader and pack. Use Recheck target if the world changes, and ask a manager about Minecraft whitelist admission." },
    ],
    note: "Members ask a manager to start or switch worlds. The server mod list is not a complete client pack. If readings or operation progress are uncertain, use Recheck profiles and status before trying again.",
    href: "/minecraft",
    linkLabel: "Choose a world to play",
  },
  {
    id: "mods",
    title: "Mods and saved recipes",
    summary: "The Mods page shows the selected profile's installed files. Saved sets keep recipes for later.",
    steps: [
      { label: "Check the selected profile", text: "Read Selected profile before acting. Members use Browse mods; managers use Add a mod and review compatibility and dependencies before Install. Re-check refreshes the installed inventory." },
      { label: "Keep or export a recipe", text: "Import a pack from Modrinth saves a set without installing it. Export shows client installation instructions; an incomplete export cannot use bulk download. A saved set does not contain your world progress." },
      { label: "Review replacements", text: "For another pack or target, prepare a separate profile. Change pack or Install to Server replaces the current mods, so review its warning and rollback point first. Follow the operation result and any restart instruction after installation or removal." },
    ],
    note: "Hash the jars measures file bytes; it does not verify them against a publisher. Members can browse and export saved sets, while installation and removal require a manager.",
    href: "/minecraft/mods",
    linkLabel: "Open mods and saved sets",
  },
  {
    id: "backups",
    title: "Protect world progress",
    summary: "Backups belong to the selected profile. A restore replaces its current data.",
    steps: [
      { label: "Create and check an archive", text: "Managers check Selected profile, press Create backup, then confirm the archive appears with its date and size. Download keeps a separate copy." },
      { label: "Read what it contains", text: "Routine archives contain the world. The · mods incl. label marks a pack rollback that also includes mods. A checksummed archive has a recorded byte checksum; that is not a gameplay test or a complete profile backup." },
      { label: "Restore deliberately", text: "Choose Restore, review Restore this backup?, then confirm Restore. Successful restoration resumes a previously running server; a stopped server stays stopped. Watch the operation strip and refresh current records before retrying an uncertain result." },
    ],
    note: "Members can view backup records and policy, but cannot create, download, restore or delete archives. Live backups retain consistency limits. Private checkpoint recovery requires owner review.",
    href: "/minecraft/backups",
    linkLabel: "Open world backups",
  },
  {
    id: "settings",
    title: "Settings and player access",
    summary: "Managers edit the applied profile here. Inactive worlds have a separate editor in their Details page.",
    steps: [
      { label: "Save gameplay settings", text: "Check Selected profile, edit Game Settings (server.properties), then press Save N changes. Read the result and restart guidance. Game rules apply immediately; numeric changes use Set." },
      { label: "Manage game admission", text: "Use Add Op followed by Save Ops for operators, and Add Player followed by Save Whitelist for Minecraft's join list. Website Users and the Discord sign-in Whitelist are separate, admin-only controls." },
      { label: "Edit an inactive world", text: "Open its Details, change World settings and press Save world settings. Seed and generation fields lock once the world exists. A different Minecraft version or loader requires another profile; Save memory changes shared server resources." },
    ],
    note: "Members do not have Settings access. Saved file values may need a restart or a new world; follow each field's explanation. After a stale or unconfirmed result, reload before another edit.",
    href: "/minecraft/settings",
    linkLabel: "Open applied profile settings",
    settingsOnly: true,
  },
  {
    id: "covers",
    title: "Give your world its image",
    summary: "Open a profile's Details to see its generated overview or add a custom screenshot.",
    steps: [
      { label: "Read the generated overview", text: "Defaults show saved Overworld terrain near spawn for Minecraft 26.1.2 and 1.21.1. Check the source and age. Managers use Request world overview or Refresh world overview; new worlds wait for saved terrain." },
      { label: "Choose a custom cover", text: "Managers select a JPEG, PNG or WebP image up to 5 MiB and press Upload cover. A custom image takes priority. Remove cover reveals the generated default when one is available." },
      { label: "Capture from your client", text: "For a vanilla or Fabric 26.1.2 server profile, install the client companion with Fabric Loader 0.19.5+ and Java 25. Join the world, choose Request pairing session, then Copy command and enter /yoshling pair CODE in your client. Use /yoshling capture if needed and wait for the saved readback." },
    ],
    note: "Members can view images. Generated views cover a 64-block radius near spawn; some modded blocks may be simplified or missing. Pairing codes stay private, expire after 15 minutes and authorize one image. Review visible player information before capturing.",
    href: "/minecraft",
    linkLabel: "Choose a profile's Details",
  },
  {
    id: "server",
    title: "Inspect and recover carefully",
    summary: "Server tools show current readings, recent logs and the controls managers use for recovery.",
    steps: [
      { label: "Inspect the server", text: "Open Controls, Monitor or Console to check state, resources and recent output. Read freshness warnings: historical graphs or old logs do not confirm the current state." },
      { label: "Use the right control", text: "Managers use Power off to stop Minecraft, Power on to choose a profile, Restart for the current profile, or Switch profile & restart for another. Review player disconnections and wait for existing file jobs." },
      { label: "Recheck before recovery", text: "Read the operation strip and refusal message before another attempt. Managers also have Files and Console Send; console commands need no leading slash. Unverified profile identity, private checkpoints or interrupted renderer jobs require owner review." },
    ],
    note: "Members can inspect server information but cannot power it, send commands or use raw Files. Avoid deleting world files to troubleshoot a pack. Failed, stale or unknown readings need a fresh check before relying on them.",
    href: "/minecraft/server",
    linkLabel: "Open server tools",
  },
];
