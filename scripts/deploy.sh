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

# A seed in flight means SteamCMD is writing the workshop volume. Deploying now
# recreates web, which orphans that run and lets the fresh process start a second
# one on top of it; two SteamCMD runs race and the loser silently updates nothing.
#
# This cannot key on the image. `seedMods` runs the seed with the *same* image as
# the live game container (yoshling/project-zomboid:latest, copied off
# yoshling-pz), so the old check for 'project-zomboid-dedicated-server' matched
# nothing and never fired once — while matching the real image name would refuse
# every deploy for as long as Project Zomboid is up.
#
# Two things do tell them apart, and either is enough to refuse:
#   * the label seedMods sets on the seed (SEED_LABEL in lib/zomboid-updates.ts);
#   * the container command — the game container runs /server/scripts/entry.sh,
#     the seed runs steamcmd.sh. Needs --no-trunc; docker ps truncates commands.
# The second is kept as a backstop because bash cannot import the label from the
# app, so a rename there would otherwise quietly restore the never-fires bug.
SEEDS=$(docker ps --no-trunc \
          --format '{{.Names}} {{.Label "yoshling.role"}} {{.Command}}' \
        | grep -E 'pz-seed|steamcmd' || true)
if [ -n "$SEEDS" ]; then
  echo "deploy: a SteamCMD mod seed is running — wait for it to finish:" >&2
  echo "$SEEDS" | sed 's/^/        /' >&2
  exit 1
fi

# Refuse while a backup is mid-copy, and name an orphan if one is lying around.
#
# Paid for on 2026-09-30: a Project Zomboid `backup.create` was 4m14s into copying a
# 1.9 GB save when a deploy recreated the web container. Everything about it was lost at
# once — the copy is a child of the Next process so it died with it; the operation registry
# is in-memory so the record vanished; and `logBackup` only writes an Activity row on
# success, correctly, so nothing durable recorded that it had ever started. What was left
# was a 937 MB orphaned `.work-*` staging directory that nothing prunes.
#
# This keys on the staging directory rather than on the registry, deliberately. The obvious
# implementation — ask `/api/operations` — needs a session cookie that a deploy script has
# no business holding, and the first draft of this guard invented an unauthenticated
# endpoint that does not exist, which is the seed guard's never-fires bug reinvented one
# commit after documenting it. A `.work-*` directory is a real artefact on a real volume,
# and the growth check below is what distinguishes "in flight" from "someone's leftovers".
WORK_DIRS=$(ls -d /var/lib/docker/volumes/yoshling_web-data/_data/backups-*/.work-* 2>/dev/null || true)
if [ -n "$WORK_DIRS" ]; then
  A=$(du -sb $WORK_DIRS 2>/dev/null | awk '{t+=$1} END {print t+0}')
  sleep 3
  B=$(du -sb $WORK_DIRS 2>/dev/null | awk '{t+=$1} END {print t+0}')
  if [ "$B" -gt "$A" ]; then
    echo "deploy: a backup is copying right now — recreating web kills it and loses the record:" >&2
    echo "$WORK_DIRS" | sed 's/^/        /' >&2
    echo "        grew $((B-A)) bytes in 3s. Wait for it, or FORCE_OPS=1 to accept losing it." >&2
    [ "${FORCE_OPS:-0}" = "1" ] || exit 1
    echo "        FORCE_OPS=1 set — proceeding." >&2
  else
    echo "deploy: note — orphaned backup staging left by an interrupted run (not growing):" >&2
    du -sh $WORK_DIRS 2>/dev/null | sed 's/^/        /' >&2
    echo "        Safe to delete; nothing prunes these." >&2
  fi
fi

cd /opt/yoshling
git fetch -q /root/y.bundle main

# docker-compose.yml is GIT-OWNED, and the `checkout -f` below proves it by
# discarding anything on the box that disagrees.
#
# This comment used to say the app writes it — "/api/games/memory (heap) and
# /api/settings (Minecraft version/loader) both patch a service block". That was true
# and cost one commit working around it by hand (f0cf692, "Commit the 12 GB PZ heap so
# a deploy stops reverting it"), and it is no longer true: both now write
# /opt/yoshling/.env, which is gitignored and excluded from the `git clean` below, and
# compose reads them as ${MC_MEMORY:-4G} and friends.
#
# So a dirty compose file today means one of exactly two things, neither of which this
# script should silently revert: a hand-edit on the box, or an /api/7dtd/update that
# died between its two START_MODE patches (it flips 3 then straight back to 1 inside one
# operation — the only remaining compose writer, deliberately, because moving it to .env
# would rewrite the ${...} reference into a literal and detach the line for good).
#
# Compare the working tree against the box's CURRENT HEAD, not against FETCH_HEAD.
# Only the former isolates "something on this box edited the file"; diffing against
# the incoming commit also flags every legitimate compose change being shipped, which
# would block every deploy that touches it.
if ! git diff --quiet HEAD -- docker-compose.yml; then
  echo "deploy: docker-compose.yml on the box has local edits." >&2
  echo "        Either someone edited it on the box, or a 7DTD build update died" >&2
  echo "        between its two START_MODE patches. Deploying DISCARDS these:" >&2
  git --no-pager diff HEAD -- docker-compose.yml | sed 's/^/        /' >&2
  if [ "${FORCE_COMPOSE:-0}" != "1" ]; then
    echo "        Commit them, or re-run with FORCE_COMPOSE=1 to discard them." >&2
    exit 1
  fi
  echo "        FORCE_COMPOSE=1 set -- discarding." >&2
fi

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
  # `grep -rqF`, with NO pipe. This was `grep -rql … | head -1`, and a pipeline's exit status
  # is its LAST command's — `head -1` exits 0 on empty input, so the test succeeded whether or
  # not grep matched. Measured 2026-10-02: the invented string `zzzz_definitely_not_present_9f3a`
  # reported "found". **This guard had never once failed**, in the one script written to stop a
  # correct checkout sitting in front of a stale image — the house defect class inside the tool
  # built to prevent it.
  #
  # `-F` as well as `-q`: a verify string is a literal, and one containing `.` or `(` was being
  # read as a pattern, so `modsDirRefusal(plan,` would have matched text that is not it.
  if docker exec yoshling-web-1 grep -rqF -- "$VERIFY" /app/.next/server; then
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
