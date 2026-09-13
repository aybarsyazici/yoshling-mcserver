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
# Contract with entry.sh, do not change: append a trailing-semicolon list to
# ${HOMEDIR}/maps.txt, and copy map folders into pz-dedicated/media/maps.

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

    # Bigger maps first: where two claim a cell, the earlier entry in `Map=`
    # wins, and a 22-cell base should not lose to a 4-cell checkpoint.
    local list=""
    while IFS= read -r name; do
        list+="$name;"
    done < <(for name in "${!cells[@]}"; do
                 printf '%s\t%s\n' "${cells[$name]}" "$name"
             done | sort -k1,1nr -k2,2 | cut -f2)

    echo "Found ${#cells[@]} map(s)"
    printf '%s' "$list" >> "${HOMEDIR}/maps.txt"
}

parent_folder="$1"
search_folder "$parent_folder"
