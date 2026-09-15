#!/usr/bin/env bash
#
# Deploy to the production box.
#
# The box has no GitHub SSH key, so `git fetch origin` fails there — code travels
# as a git bundle. That much is in CLAUDE.md; what this script adds is the part
# that is easy to skip by hand:
#
#   * It verifies the change is in the BUILT IMAGE, not just at git HEAD. A
#     checkout can be correct while the running container is still serving the old
#     bundle, and `git rev-parse` looks identical either way. That mismatch cost
#     real debugging time.
#   * It refuses to run while a Project Zomboid mod seed is in flight. Two
#     SteamCMD runs on the same workshop volume race, and one reports
#     "updated 0 of N mods".
#
#   scripts/deploy.sh                          # rebuild web (the usual case)
#   scripts/deploy.sh --service zomboid        # rebuild the derived PZ image
#   scripts/deploy.sh --verify 'AbortSignal'   # assert a string reached the image
#
# Only `web` is rebuilt by default. Game containers are left alone: recreating one
# would evict whichever world currently holds the box.
set -euo pipefail

BOX="${YOSHLING_BOX:-root@89.58.50.155}"
KEY="${YOSHLING_KEY:-$HOME/.ssh/mc_yoshling_netcup}"
SERVICE="web"
VERIFY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --verify)  VERIFY="$2";  shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "deploy: unknown argument $1" >&2; exit 64 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy: working tree is dirty — commit first, or the box gets a bundle" >&2
  echo "        that does not match what you think you are shipping." >&2
  git status --short >&2
  exit 1
fi

# Full SHA for the comparison: `--short` picks the shortest *unambiguous* prefix,
# which depends on how many objects a repo has, so it came out 7 chars locally and
# 8 on the box and the equality check failed on two identical commits.
LOCAL_SHA=$(git rev-parse HEAD)
echo "==> shipping ${LOCAL_SHA:0:7} ($SERVICE)"

git bundle create /tmp/yoshling-deploy.bundle main --quiet 2>/dev/null \
  || git bundle create /tmp/yoshling-deploy.bundle main
scp -q -i "$KEY" /tmp/yoshling-deploy.bundle "$BOX:/root/y.bundle"

# ssh joins its arguments into one string and the REMOTE shell re-splits them, so
# anything containing a space arrives as several arguments. A --verify string like
# "Saving and stopping the server" turned $3 into "and", and the SHA check then
# compared against that. printf %q quotes each one for the remote shell.
REMOTE_ARGS=$(printf '%q ' "$SERVICE" "$VERIFY" "$LOCAL_SHA")

# shellcheck disable=SC2029 -- REMOTE_ARGS is deliberately expanded locally
ssh -i "$KEY" "$BOX" "bash -s -- $REMOTE_ARGS" <<'REMOTE'
set -euo pipefail
SERVICE="$1"; VERIFY="$2"; EXPECT_SHA="$3"

# A seed in flight means SteamCMD is writing the workshop volume. Starting a
# second one races it, and the loser silently updates nothing.
if docker ps --format '{{.Image}}' | grep -q 'project-zomboid-dedicated-server'; then
  echo "deploy: a SteamCMD mod seed is running — wait for it to finish" >&2
  exit 1
fi

cd /opt/yoshling
git fetch -q /root/y.bundle main
git checkout -f -q -B main FETCH_HEAD
# A plain reset leaves files that were deleted upstream sitting on disk.
git clean -fdq -e .env -e '*.db'

BOX_SHA=$(git rev-parse HEAD)
if [ "$BOX_SHA" != "$EXPECT_SHA" ]; then
  echo "deploy: box is at ${BOX_SHA:0:7} but expected ${EXPECT_SHA:0:7}" >&2
  exit 1
fi
echo "==> box checkout ${BOX_SHA:0:7}"

# Back up the DB before anything that might touch the schema. Cheap insurance.
mkdir -p /root/yoshling-deploy-backup
docker cp yoshling-web-1:/app/data/yoshling.db \
  "/root/yoshling-deploy-backup/yoshling-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null || true

echo "==> building $SERVICE"
if ! docker compose build "$SERVICE" >/tmp/deploy-build.log 2>&1; then
  echo "deploy: build failed" >&2
  tail -30 /tmp/deploy-build.log >&2
  exit 1
fi

# --no-deps so bringing up web cannot start a game container as a side effect.
docker compose up -d --no-deps "$SERVICE"

if [ -n "$VERIFY" ] && [ "$SERVICE" = "web" ]; then
  sleep 8
  echo "==> verifying '$VERIFY' is in the running image, not just in git"
  if docker exec yoshling-web-1 sh -c "grep -rql -- '$VERIFY' /app/.next/server 2>/dev/null | head -1" >/dev/null; then
    echo "    found"
  else
    echo "deploy: '$VERIFY' is NOT in the built bundle — the checkout is right but" >&2
    echo "        the image is stale. Rebuild before believing the deploy." >&2
    exit 1
  fi
fi

echo "==> containers"
docker ps --format '    {{.Names}}  {{.Status}}'
REMOTE

echo "==> done"
