# Project Zomboid, with the image's map scanner fixed.
#
# The upstream /server/scripts/search_folder.sh only looks for maps at
# <workshopId>/mods/<mod>/media/maps — one fixed level. Build 42 mods put their
# content under a version folder (<mod>/42.20/media/maps), so upstream finds none
# of them, and entry.sh then overwrites `Map=` with what it did find. On this
# server that meant `Map=AZSpawn;AZSpawn;Muldraugh, KY` about three seconds into
# every boot, wiping any correct list and leaving 20 add-on maps inert.
#
# Patching the file into the image rather than bind-mounting it because entry.sh
# runs `sed -i` on the script itself (a CRLF fix), which fails on a bind-mounted
# single file.
FROM danixu86/project-zomboid-dedicated-server:latest

COPY --chmod=755 search_folder.sh /server/scripts/search_folder.sh
