# Minecraft user walkthrough

`/minecraft/guide` is the interactive, read-only user guide. It is discoverable
from the **Minecraft guide** sidebar link and the Profiles welcome card. The
Minecraft layout and guide page both require a current authenticated Minecraft
grant. Other game sidebars do not offer it.

Eight chapters cover the dashboard, profiles, starting/switching/joining, mods,
backups, settings/player access, profile covers, and server tools/recovery. The
content lives in `src/lib/minecraft-guide.ts`; keep its instructions and button
names aligned with the real screens and the relevant Minecraft topic docs.
Feature links are ordinary same-tab links, retaining the existing unsaved-settings
navigation guard. The guide never starts servers, creates profiles, installs
mods, restores data, pairs screenshots or submits feature API requests.

Each chapter has short steps, a practical note and a link to its screen. Chapters
can be revisited in any order. **Mark read & continue** records reading, not a
successful server action. The final chapter can be marked read; completion requires
all eight chapters. **Start over** asks before clearing only the tutorial checklist.
Keyboard controls use native buttons/links; focus moves to the chapter heading.
Layout wraps for small screens, and motion uses reduced-motion-aware classes.

Progress is a bounded versioned localStorage preference scoped to the signed-in
user ID. It holds only chapter IDs, visited completion and current chapter—no
credentials, pairing codes or game data. Storage is read after mount and written
only for explicit tutorial actions. Writes require exact readback before saying
**Progress saved in this browser**. Unavailable/corrupt storage leaves the guide
usable for the current visit; fresh user identity remounts and reloads its own record.
Browser tabs may replace one another's tutorial preferences.

Player/member instructions distinguish reading and joining from management.
Managers are ADMIN or MOD with Minecraft access. Settings links require confirmed
live settings capability; pending, failed or revoked capability reads hide them.
Descriptions do not grant permission or bypass the real feature's confirmations.
Routine Minecraft backup records can be read by members; backup download/create/
restore/delete require management permission. Website Discord admission and the
Minecraft player whitelist are separate.

Verification evidence and deployments belong in `CLOSED.md`. Component fixtures
are not a real login, game join, restore or complete browser accessibility trial.
