// Where Minecraft's mods live.
//
// This file used to be a compatibility shim: the server manager spoke only
// Minecraft, and when `game-manager` generalised it, a set of thin wrappers
// (`startServer`, `stopServer`, `restartServer`, `getServerProperties`,
// `getServerStatus`, plus a local `ServerStatus` type that duplicated the one in
// `games.ts` minus `"installing"`) stayed behind so the legacy
// `/api/server/{control,status,stats}` routes kept working.
//
// Those three routes are gone, and with them the wrappers' only callers. Deleting
// them matters rather than being tidiness: `/api/server/control` was a *second*
// power path that had drifted from `/api/games/control` — it set `changed = true`
// unconditionally on `start`, so a Power on of an already-running world wrote a
// permanent `server_start` Activity row for something that did not happen, which
// is exactly the defect `/api/games/control` fixed ("a log of things that did not
// happen is worse than no log"). A dormant duplicate of a power path is a standing
// invitation to re-diverge, so the whole shim went with it.
//
// `getModsDir` resolves the selected profile for each call. `mod-path` anchors
// readers and writers to that profile's data root.

import path from "path";
import { getMinecraftDataRoot } from "./minecraft-profile-store";

export async function getModsDir(): Promise<string> {
  return path.join(await getMinecraftDataRoot(), "mods");
}
