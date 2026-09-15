# Project Zomboid — mod defect backlog

An open list of everything wrong with the installed mods, why, and what (if
anything) to do about it. Split out of `docs/PROJECT-ZOMBOID.md` so it can be
worked through as a backlog rather than read as reference material — that file
describes how the server *works*, this one tracks what's *broken*.

**Nothing here has been acted on.** No mod has been removed, no patch written, no
upstream issue filed. That is the state as of 2026-09-15.

Where it came from: three parallel read-only investigations of the whole log
history on 2026-09-14 (5 boots, ~106k lines), plus a follow-up research pass on
2026-09-15 into whether we could repair mods ourselves. Both were bytecode- and
log-derived; see [What is NOT verified](#what-is-not-verified) before trusting any
of it enough to act.

## Contents

- [Start here: the shortlist](#start-here-the-shortlist)
- [Can we fix mods ourselves?](#can-we-fix-mods-ourselves) — the blocking answer
- [Defects that break something](#defects-that-break-something)
- [Investigated and deliberately not fixed](#investigated-and-deliberately-not-fixed)
- [Verified harmless — do not chase these](#verified-harmless--do-not-chase-these)
- [A burst that has already settled](#a-burst-that-has-already-settled)
- [What is NOT verified](#what-is-not-verified)

## Start here: the shortlist

If you only do one thing: **file the `lgd_antibodies` issue.** MIT licence, issues
open, bug present at HEAD, a one-word fix in five files, and it permanently fixes 5
of the 6 real `complete()` bugs for everyone with zero local maintenance. Highest
leverage available anywhere in this document, ~an hour of work.

| # | Action | Why | Cost |
|---|--------|-----|------|
| 1 | File upstream: `lgd_antibodies` (5 files), SecretZ bugs thread (author already acknowledged), Extra Gun Slot one-liner | Permanent, no maintenance, helps everyone | ~1 h, no restart |
| 2 | Remove **Better Push** (`3715137752`) | 100% dead in MP, zero player reports, freely removable | one restart |
| 3 | Decide **Extra Gun Slot** (`3120702374`): remove, or ship the one-line fix as our own Workshop item | Upstream abandoned since 2024-12-20; slot doesn't sync | one restart |
| 4 | Decide the two missing dependencies: install **True Music** + **EasyConfigChucked**, or drop their dependents | Unmet `require=`; 60 cassettes have no model | one restart |
| 5 | Verify then probably remove `Secretz42_tilepack_com` | Tiledef 6264 collision — **verify first**, a wrong move degrades the map | one restart |
| 6 | Remove `errorMagnifier` (`2896041179`) | Client-only debug mod; just gives players error popups | one restart |

Items 2-6 want the **same** restart, so batching them is one interruption. Nothing
here is urgent: across every finding, **not one item is a player complaint.**

The working rule this list was judged against — *"fix what you can't remove, remove
what you can't fix"* — needs a third clause here: **and fix nothing nobody has
noticed.** On this list fixability and impact anti-correlate with removability. The
two mods that *can't* be removed (SecretZ, RV Interior, both own `Map=` entries)
are the two least worth fixing.

## Can we fix mods ourselves?

Researched 2026-09-15. Short answer: **not the way we first assumed.**

- **A patch mod in `pz-data/mods/` listed in `Mods=` disconnects every player.**
  `ConnectionDetails.writeMods` advertises *every* `Mods=` entry including local
  ones (empty workshop id), and `ConnectToServerState.CheckMods()` drops the client
  with `forceDisconnect("connect-mod-required")` on the first id it cannot resolve
  locally. Not gated by any option; runs *before* the Lua checksum, so
  `DoLuaChecksum=false` does not rescue it. No `serverOnly` flag exists — all 26,020
  classes were scanned for one.
  **The trap:** on the *server* an unresolvable mod is silently dropped and the
  server keeps running, so it looks like the patch worked.
- **Patch mods are nonetheless the dominant community practice** — hundreds of
  Workshop items, examples at 20k–100k+ subscribers, and The Indie Stone's Modding
  Policy §4.1/§8 explicitly permits it. They work because they are **published
  Workshop items**, which clients auto-download *before* `CheckMods` runs.
- Viable routes, if we ever want one: **publish our own (possibly unlisted) Workshop
  item** — the only path that satisfies `CheckMods`, preserves the Lua checksum and
  survives `steamcmd validate`. Its one unknown (do unlisted items auto-download on
  connect?) is a ~20-minute test.
- **Rejected:** dropping Lua into the game image (breaks the Lua checksum, needs
  `DoLuaChecksum=false`, has three separate silent-no-op failure modes, and rollback
  needs an image rebuild mid-outage), and hand-distributing files to five players
  (fragile; any Steam verify silently locks that player out).
- `DoLuaChecksum=false` would **not** fix the recurring "mod updated → nobody can
  join" pain either. That is a separate per-item install-timestamp check.

## Defects that break something
Investigated 2026-09-14 across the whole log history (5 boots, 106k lines). The
server is healthy: no OOM, zero GC stalls, 87/87 `Mods=` entries load, disk 14%,
`RestartCount=0`, and **no error class is growing**. ~19,000 lines/boot are
verified vanilla or cosmetic noise. These are the ones that actually break
something.

| Mod | Defect | Action |
|-----|--------|--------|
| **Better Push** (`3715137752`) | `BetterPush_Server.lua:40` calls `getZombieByOnlineID`, which **exists nowhere** (0 hits in the jar, no mod defines it). The handler throws on every invocation, so MP domino-knockdown is 100% dead — clients predict the push, zombies snap back. | Remove. Zero risk; the feature already doesn't work. |
| **Extra Gun Slot** (`3120702374`) | `holsterbackb` is defined only under `media/lua/**client**/`. A dedicated server never loads `lua/client/*`, so every attach is rejected: `no such location "holsterbackb"`. 216 events, 3 players. The slot doesn't sync and may not survive a relog. | Remove, or upstream moves the definition to `lua/shared`. **Unknown** whether items in the slot are lost — have players empty it first. |
| **`truemusic_mixtape_megapack`** | Declares `require=truemusic`, which is **not installed**. 60 cassette items have no world model and no playback base. | Install True Music, or drop the megapack. |
| **`SwapIt`** | Declares `require=EasyConfigChucked`, **not installed**. Config layer absent; unknown whether it still works on defaults. | Install it, or drop SwapIt. |
| **`Secretz42_tilepack_com`** | Ships `secretz_42.tiles` claiming **tiledef number 6264**, the same as `Secretz42` — and the two files *differ* (different md5). One set of tile properties is silently discarded, so SecretZ tiles can resolve to the wrong definition (worst case: a wall you can walk through). Also the source of 2,490 duplicate-sprite warnings. | Probably remove from `Mods=` — the pack is a *compatibility* shim for servers running SecretZ tiles **without** the map mod, i.e. either/or. **Verify first**: confirm no other installed map builds on it, and back up the `.ini`. |
| **`[B42] SecretZ Pandemic`** | `SZCServer.lua` is 683 lines and throws at line 394 (`Commands` is nil, after `require("server/SZCBlueServer") failed`) on **every** boot, so ~289 lines never run — door despawn and no-key autoclose are dead. | Report upstream. **Do not remove SecretZ** — it owns 16 of the 22 `Map=` entries. |
| **`errorMagnifier`** (`2896041179`) | A debug mod; entirely `lua/client`, so inert server-side. Only effect is error popups for players. | Remove for their sake. |

### Investigated and deliberately not fixed

- **The `NetTimedAction` NPE** — ~35/boot, `Cannot invoke "java.lang.Boolean.booleanValue()" because ... protectedCallBoolean(...) is null`.
  A **vanilla defect**: `NetTimedAction.perform()` (line 140) does
  `protectedCallBoolean(...).booleanValue()` with no null check, while its siblings
  `start()`/`stop()`/`animEvent()` all guard with `rawget` + skip-if-null.
  - **The trace carries no Lua frames and never will** — `KahluaThread.pcallBoolean`
    leaves its result `null` unless the pcall succeeded *and* returned a Boolean,
    and never reads or logs the Lua error object. Don't waste time grepping for a
    `MOD:` tag; there isn't one. Getting the action name requires a restart with
    `DebugType.Action` DEBUG on (`ActionManager.update:69` then prints it).
  - Dominant source is *probably* vanilla `ISGenericCraftStart`, whose `complete()`
    is commented out in the vanilla source — inferred from timing (hard floor of
    3.90 s between events, mode 7-8 s, and a lone player producing sub-6.3 s gaps,
    which excludes every 50-150 s candidate). **Not proven.**
  - Impact is nil: the Lua work finishes, the NPE is on unboxing afterwards, the
    client has always completed first so the reject packet matches nothing, and
    nothing reads the action's done/rejected state. Flat at 5-12 per player-hour.
  - Three mods *do* have a real one-word bug of this shape — they wrap a vanilla
    `complete()` and drop its return value: **`lgd_antibodies`** (5 actions),
    **`EQUIPMENT_UI`** (`ISWearClothing`), **`GunsOfMarz`** (`ISUpgradeWeapon`).
    Worth an upstream report; patching locally gets clobbered by the next update.
- **`[B42] PROJECT RV Interior`** (`3543229299`) — `RVServerMP_V3.lua:188` throws
  `Cannot read field "loadedBits" because "square.chunk" is null`.
  - Cause: line 162 uses `getCell():getOrCreateGridSquare(...)`, which **does not
    check that a chunk exists** (the sibling `createNewGridSquare` does). On an
    unloaded chunk it fabricates a detached square, and `AddSpecialObject` →
    `PolygonalMap2.squareChanged` → `PathfindNative.squareChanged` dereferences
    `square.chunk`.
  - **Caught**: `KahluaThread.pcall` has a `catch Throwable` handler, so Lua
    continues. The object was already added; only three trailing bookkeeping calls
    are skipped.
  - **The interior is static map content** in `world_92_47.lotpack`, not generated
    at runtime — `gen()` only places one generator for RV power. There is no
    half-generated state to reach. Worst case: that visit's RV has no power.
  - The 4× `IsoGenerator not found on square` lines are a **separate** ordering bug
    — the mod calls `setFuel`/`setCondition`/`setConnected`/`setActivated` (each of
    which `sync()`s) *before* `AddSpecialObject`, so `getObjectIndex()` is -1 and
    four broadcasts are dropped. Harmless (re-sent after attach) but happens on
    **every** RV entry.
  - **`AntiCheatSpeed=4` removed the trigger.** `gen()` fires ~14 s after entry;
    the anti-cheat kick was force-disconnecting the only nearby player, so nothing
    kept the cell loaded. The kick caused the NPE, not the reverse.
  - Installed version is the latest published (`modversion=2.3`, no update
    pending), so there is no fix to apply. **Don't remove it**: it ships
    `map_distanciado`, which is first in `Map=`, and removal would strand anyone
    inside an interior.

### Verified harmless — do not chase these

All byte-identical every boot, so not growing. Largest first:
`buildingDef.ID=N expected=N` (1,146/boot, vanilla building renumber across 22
stacked maps) · `XuiSkin ... Could not find icon` (1,068/boot, **client** UI icons)
· `ModelScript.checkMesh no such mesh` (856/boot, gun mods vs B42 mesh moves) ·
`Sprite duplicate texture` (498/boot — symptom of the tilepack collision above) ·
`AdvancedAnimator$1.visitFileFailed` / `NoSuchFileException .../{AnimSets,actiongroups}`
(321/boot, 267 dirs — the animation loader logs a full ERROR trace for every mod
that simply has no animations) · `SkeletonBone not resolved for bone: Bone_Door*`
(vehicle rig bones; message ends "defaulting to SkeletonBone.None", and ragdoll is
client-side) · `AnimState not found: turning180` (vanilla ships transitions *into* a
state it never defines — `turning180` appears nowhere in the jar) ·
`ItemPickInfo -> cannot get ID for container: inventorymale/inventoryfemale`
(vanilla zombie pseudo-containers) · `Mannequin zone missing properties` (1/boot,
vanilla Muldraugh data defect) · `action was null, object: null` (vanilla animal AI)
· `No packet handler for type: ...` (**one** line carrying 60 vanilla packet names,
not 60 problems) · `Missing ThumpSound` · `ladderW/ladderS Property Name not found`
· `module "Base" imports itself`.

Two with a non-harmless tail worth knowing:
- `ItemPickInfo` also fires for ~120 **modded vehicle** containers (`SeatP1-6`,
  `B700Trunk*`, `DAM60Gunrack`…), paired with 60 `template "..." not found` and 80
  `vehicle type "Base.BTR-80Burnt" doesn't exist`. Inferred: those military
  vehicles spawn empty/incomplete.
- Authentic Z uses the B41 skill name in one recipe: `Unknown skill "Metalworking"
  in recipe "Fix Chainsaw with Small Sheet Metal"` — that recipe is unusable.

### A burst that has already settled

Boot 1 on 2026-09-13 produced one `MetaEntitySystem.loadMetaEntities` failure
(`newPosition > limit: 1769171059 > 1172`) plus 233 `IsoThumpable not found on
square`, 4 `IsoGenerator not found`, and 8 `CreatePlayerPacket` position warnings.
Per boot since: 233 / 0 / 0 / 2 / 4 — over.

**Inferred cause, and it's self-inflicted:** that was the first boot after the
`Map=` / mod-list rework, so already-saved chunks referenced objects the new map
set no longer resolved. **Some placed entities were probably silently dropped.** If
a player reports a missing generator or crafting station, this is why. Escalate
only if it recurs.

Related, still present: 14 dead spawn buildings (`initSpawnBuildings: no room or
building at x,y,0`), 5 maps in `Map=` with no `objects.lua`
(`SZ_ExtraSpawnPoints`, `SZ_Basements`, `SZ_Bunker_3`, `SZ_DeerheadLake_Base`,
`DeltaForce_Team_Spawn`), `invalid room metaID` in cell 25,33 (**0 in boot 1, 4 in
every boot since** — appeared with the map rework and is now permanent), and 18
duplicate `RoomDef.metaID`/boot. The price of 22 stacked maps; act only on a
concrete player report.

## What is NOT verified

Read this before acting on anything above.

- **Nothing was tested empirically.** Every conclusion is bytecode- or log-derived.
  No live join test was run, and no patch Lua was ever written or executed.
- **The client jar was never read.** The installed app is 380870 (dedicated server);
  `CheckMods`, the Lua checksum and `VersionMismatch` were all read out of the
  *server* build. Strong inference, not observation.
- **Five claims labelled `verified` were later refuted** by an adversarial pass,
  including one inside the verdict that carried the cheapest-looking plan. Treat
  confidence labels in this document as calibrated-but-fallible.
- **The single best next step before patching anything** is a throwaway second PZ
  instance (314 GB disk free, compose file in hand). One afternoon with a second
  container and one client would settle: whether an unlisted Workshop item
  auto-downloads, whether `validate` eats symlinks, which post-mod-load hook fires,
  and what a mismatched client actually sees.
- Load-bearing claims that are only `likely`:
  - Better Push's knockdown "does not network" — the *entire* basis for removing it
    rather than shimming it. Zombie authority direction in B42 MP was never
    investigated.
  - The `complete()` wrappers "only the ACK lies, nothing checks rejection" — the
    entire basis for report-don't-patch.
- **Frequency figures are not comparable across findings.** `docker logs` holds
  ~5 boots, so totals taken from it (203 NPEs, 216 `holsterbackb`) are ~5× the
  per-boot rate. Only one agent read the on-disk `/Logs/` history, which is why it
  alone could say the RV bug fired once in 7+ sessions.
- **Nobody asked the players.** Every player-visible cost here is code-derived.

### Two live bugs found incidentally and never researched

- `IsoObject:transmitCompleteItemToServer()` **does not exist in 42.20** and is
  called in six live places, including SecretZ Hive paths reachable from
  uncommented client code.
- Spongie's non-chaining `ISWearClothing` replacement silently orphans TrueSmoking's
  correct wrapper.

### If the goal is a readable boot log, this list targets the wrong bug

`AdvancedAnimator$1.visitFileFailed` is **29.6%** of the boot log — 2.3× the
`x_extends` noise — caused by PZ walking non-existent `media/AnimSets` /
`media/actiongroups` for every mod, and fixable with **empty directories**. Nobody
researched it. That is a new investigation, not a decision.
