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
#   scripts/deploy.sh --service zomboid        # recreate PZ only after dashboard power-off
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

case "$SERVICE" in
  web|zomboid) ;;
  *) echo "deploy: --service must be web or zomboid" >&2; exit 64 ;;
esac

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

# A PZ recreate must never signal a running game or start a stopped one. Power
# off through the dashboard first, where RCON quit saves and shuts it down.
# Check again after the build because somebody may have powered it on meanwhile.
assert_pz_stopped() {
  local running
  if ! running=$(docker inspect -f '{{.State.Running}}' yoshling-pz 2>/dev/null); then
    echo "deploy: cannot verify Project Zomboid is stopped; no game recreate attempted." >&2
    return 1
  fi
  if [ "$running" != "false" ]; then
    echo "deploy: Project Zomboid is running or its state is unknown. Power it off through the dashboard first." >&2
    return 1
  fi
}

# The new sign-in gate requires IDs. Validate the next web service's effective
# file/seed before replacing a working dashboard; print no policy/env contents.
assert_app_invites_ready() {
  docker compose -p yoshling -f /opt/yoshling/docker-compose.yml run --rm --no-deps -T --pull never --entrypoint node web -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const file = path.resolve(process.env.WHITELIST_FILE || "/app/data/whitelist.json");
    function absent() {
      let current = file;
      for (;;) {
        try { fs.lstatSync(current); }
        catch (e) {
          if (e.code !== "ENOENT") return false;
          const parent = path.dirname(current);
          if (parent === current) return false;
          current = parent;
          continue;
        }
        if (current === file) return false;
        try { fs.realpathSync(current); return fs.statSync(current).isDirectory(); }
        catch { return false; }
      }
    }
    function id(value) {
      return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value.trim()) && BigInt(value.trim()) <= BigInt("18446744073709551615");
    }
    try {
      let values;
      try { values = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) {
        if (e.code !== "ENOENT" || !absent()) throw e;
        values = (process.env.ALLOWED_DISCORD_IDS ?? process.env.ALLOWED_DISCORD_USERS ?? "").split(",").map(value => value.trim()).filter(Boolean);
      }
      if (!Array.isArray(values) || values.some(value => !id(value))) throw new Error("ID policy required");
      console.log("deploy: app invitation policy format verified (Discord ID strings)");
    } catch {
      console.error("deploy: app invitation policy is unreadable or still contains legacy names. Review docs/AUTHENTICATION.md and prepare Discord IDs before deploying.");
      process.exit(1);
    }
  '
}

case "$SERVICE" in
  web) assert_app_invites_ready ;;
  zomboid) assert_pz_stopped ;;
  *) echo "deploy: --service must be web or zomboid" >&2; exit 64 ;;
esac

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
assert_no_background_work() {
  local containers seeds work_dirs before_bytes after_bytes
  # Separate inspection from filtering: a Docker error is unknown, never quiet.
  if ! containers=$(docker ps --no-trunc \
      --format '{{.Names}}|{{.Label "yoshling.role"}}|{{.Command}}' 2>/dev/null); then
    echo "deploy: cannot inspect running containers; no service replacement attempted." >&2
    return 1
  fi
  seeds=$(printf '%s\n' "$containers" | grep -E 'pz-seed|steamcmd' || true)
  if [ -n "$seeds" ]; then
    echo "deploy: a SteamCMD mod seed is running — wait for it to finish:" >&2
    # Commands are useful for detection but may contain credentials. Names/roles suffice.
    printf '%s\n' "$seeds" | awk -F '|' '{printf "        %s %s\n", $1, $2}' >&2
    return 1
  fi

# Refuse present backup staging, including a copy whose size is no longer growing.
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
# commit after documenting it. A `.work-*` directory is a real artefact on a real volume.
# Growth confirms copying; static staging may still be compressing into an archive outside
# that directory. Its presence therefore cannot establish that the backup has finished.
  work_dirs=$(ls -d /var/lib/docker/volumes/yoshling_web-data/_data/backups-*/.work-* 2>/dev/null || true)
  if [ -n "$work_dirs" ]; then
    before_bytes=$(du -sb $work_dirs 2>/dev/null | awk '{t+=$1} END {print t+0}')
    sleep 3
    after_bytes=$(du -sb $work_dirs 2>/dev/null | awk '{t+=$1} END {print t+0}')
    if [ "$after_bytes" -gt "$before_bytes" ]; then
      echo "deploy: a backup is copying right now — recreating web kills it and loses the record:" >&2
      echo "$work_dirs" | sed 's/^/        /' >&2
      echo "        grew $((after_bytes-before_bytes)) bytes in 3s. Wait for it, or FORCE_OPS=1 to accept losing it." >&2
    else
      echo "deploy: backup staging is present and completion is unverified:" >&2
      echo "$work_dirs" | sed 's/^/        /' >&2
      echo "        observed $before_bytes then $after_bytes bytes; compression may still be running." >&2
      echo "        Wait for completion or inspect staging before deploying; FORCE_OPS=1 accepts interruption." >&2
    fi
    [ "${FORCE_OPS:-0}" = "1" ] || return 1
    echo "        FORCE_OPS=1 set — proceeding." >&2
  fi
}

assert_no_background_work

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

if [ "$SERVICE" = "zomboid" ]; then
  assert_pz_stopped
  docker compose create --force-recreate zomboid
  # Prove the stopped container uses the image just built and retained its
  # compose service identity. The image tag alone cannot establish that.
  assert_pz_stopped
  BUILT_IMAGE=$(docker image inspect -f '{{.Id}}' yoshling/project-zomboid:latest)
  CREATED_IMAGE=$(docker inspect -f '{{.Image}}' yoshling-pz)
  CREATED_SERVICE=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' yoshling-pz)
  if [ "$BUILT_IMAGE" != "$CREATED_IMAGE" ] || [ "$CREATED_SERVICE" != "zomboid" ]; then
    echo "deploy: Project Zomboid recreation could not be verified; check the container before powering it on." >&2
    exit 1
  fi
  echo "==> Project Zomboid image applied and container verified stopped. Power on through the dashboard when ready."
else
  # Recheck the next Compose/image's policy and work started during the build.
  # These are observations, not a lock: avoid starting new work during deployment.
  assert_app_invites_ready
  assert_no_background_work
  # --no-deps so bringing up web cannot start a game container as a side effect.
  docker compose up -d --no-deps web
fi

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
