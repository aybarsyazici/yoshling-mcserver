#!/usr/bin/env bash
#
# Run RCON commands against Project Zomboid on the production box.
#
# PZ's RCON port (27015) is deliberately NOT published to the host, so nothing on
# the box can reach it directly — you have to be on the compose network. This
# ships scripts/rcon.py over, runs it in a throwaway container on that network,
# and reads the password out of the box's .env so it never appears in your shell
# history or in this repo.
#
#   scripts/pz-rcon.sh players
#   scripts/pz-rcon.sh 'servermsg "restarting in 5"' save
#   scripts/pz-rcon.sh checkModsNeedUpdate        # answer lands in the PZ log
#   scripts/pz-rcon.sh 'changeoption AntiCheatHit 4'
#
# Note on commands that mutate: `changeoption` takes effect immediately and PZ
# writes it into the .ini itself, so no restart is needed. `teleportplayer "a" "b"`
# is the admin teleport — plain `teleport` moves *you*, which is meaningless from
# a console and just prints its usage text.
set -euo pipefail

BOX="${YOSHLING_BOX:-root@89.58.50.155}"
KEY="${YOSHLING_KEY:-$HOME/.ssh/mc_yoshling_netcup}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -eq 0 ]; then
  echo "usage: $(basename "$0") <command> [command...]" >&2
  exit 64
fi

scp -q -i "$KEY" "$HERE/rcon.py" "$BOX:/tmp/rcon.py"

# shellcheck disable=SC2016 -- the inner quotes are evaluated on the box, by design
ssh -i "$KEY" "$BOX" bash -s -- "$@" <<'REMOTE'
set -euo pipefail
NET=$(docker inspect yoshling-pz --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
if [ -z "$NET" ]; then
  echo "pz-rcon: yoshling-pz is not on any network — is it running?" >&2
  exit 1
fi
PW=$(grep -E '^PZ_RCON_PASSWORD=' /opt/yoshling/.env | cut -d= -f2- | tr -d '"'"'"'')
if [ -z "$PW" ]; then
  echo "pz-rcon: PZ_RCON_PASSWORD not found in /opt/yoshling/.env" >&2
  exit 1
fi
docker run --rm --network "$NET" -v /tmp/rcon.py:/rcon.py:ro python:3-alpine \
  python /rcon.py --host zomboid --port 27015 --password "$PW" "$@"
REMOTE
