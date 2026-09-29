#!/bin/bash
#
# Replacement for the image's own /server/scripts/search_folder.sh.
#
# The original only looked at <workshopId>/mods/<mod>/media/maps — exactly one
# level. Build 42 mods keep their content in a version folder
# (<mod>/42.20/media/maps, <mod>/common/media/maps), so the original found none
# of them and wrote a `map_list` containing just Authentic Z's `AZSpawn` (twice,
# because two mod folders ship it). entry.sh then does
#     sed -i "s/Map=.*/Map=${map_list}Muldraugh, KY/"
# on every boot, so a correct hand-written `Map=` was overwritten with that
# two-entry list ~3 seconds into every start, and every add-on map silently did
# nothing in game.
#
# This version finds media/maps at any depth, dedupes by map name, skips mods
# their own author marked deprecated, and orders bigger maps first so they win
# where two overlap. entry.sh appends `Muldraugh, KY`, which must stay last.
#
# ## The order saved in the dashboard is the input, not the casualty
#
# Because entry.sh's `sed` is unconditional, whatever this script emits IS the load
# order — the `Map=` a human (or `/api/zomboid/maps`) wrote survived exactly zero
# restarts, and the dashboard's own toast told the user to restart to apply it.
# Verified 2026-09-29: a reorder was written to the .ini, and after one boot `Map=`
# was back to this script's output byte for byte.
#
# So this script now *reads* the existing `Map=` first and emits those maps in that
# order, then appends anything newly installed by cell count as before. Nothing about
# the fix lives in the web app: we own the generator, so the generator is where the
# saved order has to be honoured.
#
# Contract with entry.sh, do not change: append a trailing-semicolon list to
# ${HOMEDIR}/maps.txt, and copy map folders into pz-dedicated/media/maps. entry.sh
# `source`s this file, so ${HOMEDIR} and ${SERVERNAME} are in scope here.

# Maps to leave out of `Map=`, semicolon-separated, set on the zomboid service in
# docker-compose.yml. Needed because a mod can keep shipping a map its author has
# retired: SecretZ still ships SZ_Checkpoint6 inside the current Secretz42, but
# on 42.20 its content moved into SZ_Riverside_Checkpoint_2 (map title says
# "Checkpoint 6 (ONLY 42.19)", and its standalone mod is tagged DEPRECATED). Both
# claim cells 22_22, 22_23, 23_22 and 23_23, so listing both means one silently
# loses. Excluding by mod is not enough — the copy inside Secretz42 has no
# deprecation marker of its own.
MAP_EXCLUDE="${MAP_EXCLUDE:-SZ_Checkpoint6}"

search_folder() {
    local content_dir="$1"
    local game_maps="${HOMEDIR}/pz-dedicated/media/maps"
    mkdir -p "$game_maps"

    local -A excluded=()
    local ex
    while IFS= read -r ex; do
        [ -n "$ex" ] && excluded["$ex"]=1
    done < <(printf '%s\n' "$MAP_EXCLUDE" | tr ';' '\n')

    # name -> cell count, and name -> source dir. Highest version folder wins,
    # which is why the loop walks paths in sorted order.
    declare -A cells
    declare -A src

    local maps_dir
    while IFS= read -r maps_dir; do
        [ -d "$maps_dir" ] || continue

        # Deprecated mods still ship their maps; including one resurrects a map
        # the author retired and makes it fight the replacement for cells.
        local mod_root="$maps_dir"
        while [ "$(basename "$mod_root")" != "mods" ] && [ "$mod_root" != "/" ]; do
            mod_root=$(dirname "$mod_root")
        done
        if grep -rhs "^name=" "$(dirname "$maps_dir")"/../mod.info \
               "$(dirname "$maps_dir")"/mod.info 2>/dev/null | grep -qi "DEPRECATED"; then
            echo "Skipping deprecated mod maps in $maps_dir"
            continue
        fi

        local dir name n
        for dir in "$maps_dir"/*/; do
            [ -d "$dir" ] || continue
            name=$(basename "$dir")
            if [ -n "${excluded[$name]}" ]; then
                echo "Excluding map $name (MAP_EXCLUDE)"
                continue
            fi
            n=$(find "$dir" -maxdepth 1 -name "*.lotheader" 2>/dev/null | wc -l)
            # Later (higher-sorting) version folders replace earlier ones.
            cells["$name"]=$n
            src["$name"]="$dir"
        done
    done < <(find "$content_dir" -mindepth 3 -maxdepth 6 -type d -name maps -path "*/media/maps" | sort)

    # Copy each map into the game's own media/maps, as the original did.
    local name
    for name in "${!src[@]}"; do
        if [ ! -d "$game_maps/$name" ]; then
            cp -r "${src[$name]}" "$game_maps/" 2>/dev/null \
                && echo "Copied map $name"
        fi
    done

    # The order already in the .ini comes first, so a reorder saved in the dashboard
    # survives this regeneration instead of being overwritten by it. Skipped entries:
    #   - `Muldraugh, KY` — entry.sh appends it, and it must stay last.
    #   - anything not in `cells` — a map that was uninstalled, or a stock map that
    #     ships with the game and is not ours to place.
    # `tr -d '\r'`: the live .ini has LF endings today (checked), but
    # /api/zomboid/config/import writes an uploaded file verbatim, so an .ini brought
    # over from a Windows server really can be CRLF — and then the last name in the
    # list would be "Muldraugh, KY\r", matching neither the skip below nor any key of
    # `cells`. entry.sh strips \r from this very script "for good measure" for the same
    # reason.
    local ini="${HOMEDIR}/Zomboid/Server/${SERVERNAME}.ini"
    local existing=""
    [ -f "$ini" ] && existing=$(grep -m1 '^Map=' "$ini" | cut -d= -f2- | tr -d '\r')

    local -A emitted=()
    local list=""
    local kept=0
    local name
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        [ "$name" != "Muldraugh, KY" ] || continue
        # Key existence, not value: a spawn-point map has a cell count of 0 and still
        # has to be listed, or it does nothing in game.
        [ -n "${cells[$name]+x}" ] || continue
        [ -z "${emitted[$name]}" ] || continue
        emitted["$name"]=1
        list+="$name;"
        kept=$((kept + 1))
    done < <(printf '%s\n' "$existing" | tr ';' '\n')

    # Everything the saved order did not mention — a map installed since the last boot.
    # Bigger maps first: where two claim a cell, the earlier entry in `Map=` wins, and a
    # 22-cell base should not lose to a 4-cell checkpoint.
    local added=0
    while IFS= read -r name; do
        [ -z "${emitted[$name]}" ] || continue
        emitted["$name"]=1
        list+="$name;"
        added=$((added + 1))
    done < <(for name in "${!cells[@]}"; do
                 printf '%s\t%s\n' "${cells[$name]}" "$name"
             done | sort -k1,1nr -k2,2 | cut -f2)

    # Printed so the boot log is the oracle for "did the saved order survive":
    # `docker logs yoshling-pz | grep "map(s)"`.
    echo "Found ${#cells[@]} map(s): $kept kept in the saved order, $added newly found"
    printf '%s' "$list" >> "${HOMEDIR}/maps.txt"
}

parent_folder="$1"
search_folder "$parent_folder"
