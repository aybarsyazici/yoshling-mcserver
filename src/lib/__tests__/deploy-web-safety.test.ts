import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type Scenario = "normal" | "initial-seed" | "initial-ps-error" | "late-seed" |
  "late-command-seed" | "late-ps-error" | "late-backup" | "policy-change" |
  "static-work" | "late-static-work" | "initial-profile" | "late-profile" | "renderer-build-failed";

/** Execute the real remote Bash and invitation validator, with no Docker or remote access. */
async function deploy(scenario: Scenario = "normal", stream = false, forceOps = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yoshling-web-deploy-test-"));
  scratch.push(root);
  // These paths are substituted into shell words and quoted paths in the real body.
  if (!/^[\w./-]+$/.test(root)) throw new Error("fixture path is not shell-safe");
  const bin = path.join(root, "bin");
  const staging = path.join(root, "data", "backups-zomboid", ".work-fixture");
  await mkdir(bin);
  await mkdir(path.dirname(staging), { recursive: true });
  await mkdir(path.join(root, "mc-data"));
  if (scenario === "static-work") await mkdir(staging);
  if (scenario === "initial-profile") {
    await mkdir(path.join(root, "data/minecraft-profile-operations"));
    await writeFile(path.join(root, "data/minecraft-profile-operations/.operation-adopt-fixture.json"), "fixture-private-operation-content");
  }
  const callsFile = path.join(root, "calls");
  const currentPolicy = path.join(root, "current-policy.json");
  const nextPolicy = path.join(root, "next-policy.json");
  await writeFile(currentPolicy, '["9007199254740993"]');
  await writeFile(nextPolicy, '["9007199254740993"]');
  await writeFile(path.join(root, "docker-compose.yml"), "services:\n  web:\n    image: fixture/web:current\n");

  const source = await readFile(path.resolve(__dirname, "../../../scripts/deploy.sh"), "utf8");
  const scanner = (await readFile(path.resolve(__dirname, "../../../scripts/check-minecraft-overview-staging.mjs"), "utf8")).replace('scanMinecraftOverviewStaging("/app/data/minecraft-profile-overviews")', `scanMinecraftOverviewStaging(${JSON.stringify(path.join(root, "data/minecraft-profile-overviews"))})`);
  await writeFile(path.join(root, "overview-scan.mjs"), scanner);
  const body = source.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/)?.[1];
  if (!body) throw new Error("remote deploy body missing");
  const remote = body
    .replaceAll("/opt/yoshling", root)
    .replaceAll("/tmp/deploy-build.log", path.join(root, "build.log"))
    .replaceAll("/tmp/deploy-overview-build.log", path.join(root, "overview-build.log"))
    .replaceAll("/root/yoshling-overview-deploy-scan.mjs", path.join(root, "overview-scan.mjs"))
    .replaceAll("/root/yoshling-deploy-backup", path.join(root, "backup"))
    .replaceAll("/root/y.bundle", path.join(root, "bundle"))
    .replaceAll("/var/lib/docker/volumes/yoshling_web-data/_data", path.join(root, "data"))
    .replaceAll("/var/lib/docker/volumes/yoshling_mc-data/_data", path.join(root, "mc-data"));
  if (/\/opt\/yoshling|\/root\/|\/var\/lib\/docker|\/tmp\/deploy-(?:overview-)?build\.log/.test(remote)) {
    throw new Error("production host path escaped fixture substitution");
  }
  await writeFile(path.join(root, "remote.sh"), remote);

  await writeFile(path.join(bin, "docker"), `#!/usr/bin/env bash
set -eu
record() { printf '%s\\n' "$1" >> "$FIXTURE_CALLS"; }
if [ "$1" = ps ]; then
  if [ "$2" = --no-trunc ]; then
    phase=before
    [ ! -f "$FIXTURE_BUILT" ] || phase=after
    record "docker ps seeds:$phase"
    if { [ "$phase" = before ] && [ "$FIXTURE_SCENARIO" = initial-ps-error ]; } ||
       { [ "$phase" = after ] && [ "$FIXTURE_SCENARIO" = late-ps-error ]; }; then
      echo 'fixture Docker ps inspection failed' >&2
      exit 42
    fi
    if { [ "$phase" = before ] && [ "$FIXTURE_SCENARIO" = initial-seed ]; } ||
       { [ "$phase" = after ] && [ "$FIXTURE_SCENARIO" = late-seed ]; }; then
      echo 'fixture-seed|pz-seed|fixture-workshop-command fixture-private-marker'
    elif [ "$phase" = after ] && [ "$FIXTURE_SCENARIO" = late-command-seed ]; then
      echo 'fixture-seed|other-role|steamcmd.sh fixture-private-marker'
    fi
  elif [ "$2" = -aq ]; then
    record 'docker ps overview workers'
  else
    record 'docker ps final'
    echo 'fixture-web Up'
  fi
elif [ "$1" = compose ] && [ "$2" = -p ]; then
  [ "$3" = yoshling ] && [ "$4" = -f ] && [ "$5" = "$FIXTURE_ROOT/docker-compose.yml" ] || exit 91
  compose=$(cat "$5")
  args=("$@")
  case "$*" in *'run --rm --no-deps -T --pull never --entrypoint node web -e '*) ;; *) exit 92 ;; esac
  case "$compose" in
    *fixture/web:current*) image=current; policy="$FIXTURE_CURRENT_POLICY" ;;
    *fixture/web:next*) image=next; policy="$FIXTURE_NEXT_POLICY" ;;
    *) exit 93 ;;
  esac
  record "docker compose policy web image=$image"
  # Compose run attaches stdin by default, even with -T. Model that consumption.
  if [ "$FIXTURE_STREAM" = 1 ]; then cat > /dev/null; fi
  # Run the actual embedded Node validator against the selected fixture Compose/image policy.
  WHITELIST_FILE="$policy" ALLOWED_DISCORD_IDS='' ALLOWED_DISCORD_USERS='' \\
    "$TEST_NODE" "\${args[\${#args[@]}-2]}" "\${args[\${#args[@]}-1]}"
elif [ "$1" = compose ] && [ "$2" = build ]; then
  if [ "$3" = minecraft-overview ]; then
    record 'docker compose build minecraft-overview'
    if [ "$FIXTURE_SCENARIO" = renderer-build-failed ]; then echo 'fixture renderer build failed' >&2; exit 43; fi
    exit 0
  fi
  [ "$3" = web ] || exit 94
  record 'docker compose build web'
  : > "$FIXTURE_BUILT"
  if [ "$FIXTURE_SCENARIO" = late-backup ] || [ "$FIXTURE_SCENARIO" = late-static-work ]; then /bin/mkdir -p "$FIXTURE_STAGING"; fi
  if [ "$FIXTURE_SCENARIO" = late-profile ]; then
    /bin/mkdir -p "$FIXTURE_ROOT/data/minecraft-profile-operations"
    printf '%s' fixture-private-operation-content > "$FIXTURE_ROOT/data/minecraft-profile-operations/.operation-switch-fixture.json"
  fi
  if [ "$FIXTURE_SCENARIO" = policy-change ]; then
    printf '["invalid-fixture-policy-name"]\\n' > "$FIXTURE_NEXT_POLICY"
  fi
elif [ "$1" = compose ] && [ "$2" = up ]; then
  [ "$*" = 'compose up -d --no-deps web' ] || exit 95
  record 'docker compose up -d --no-deps web'
elif [ "$1" = cp ]; then
  record 'docker cp database snapshot'
elif [ "$1" = exec ]; then
  [ "$*" = 'exec -i yoshling-web-1 node --input-type=module -' ] || exit 103
  record 'docker exec overview staging scanner'
  "$TEST_NODE" --input-type=module -
else
  record "docker unexpected operation:$1"
  echo 'unsupported fixture Docker operation' >&2
  exit 96
fi
`, { mode: 0o755 });

  await writeFile(path.join(bin, "git"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "git $*" >> "$FIXTURE_CALLS"
case "$1" in
  fetch|diff|clean) ;;
  checkout) printf 'services:\\n  web:\\n    image: fixture/web:next\\n' > "$FIXTURE_ROOT/docker-compose.yml" ;;
  rev-parse) echo audited-sha ;;
  *) echo 'unsupported fixture Git operation' >&2; exit 97 ;;
esac
`, { mode: 0o755 });

  await writeFile(path.join(bin, "find"), `#!/usr/bin/env bash
set -eu
phase=before
[ ! -f "$FIXTURE_BUILT" ] || phase=after
printf '%s\\n' "staging listing:$phase" >> "$FIXTURE_CALLS"
exec /usr/bin/find "$@"
`, { mode: 0o755 });

  await writeFile(path.join(bin, "du"), `#!/usr/bin/env bash
set -eu
[ "$2" = "$FIXTURE_STAGING" ] || exit 100
printf '%s\\n' "staging measure:$1" >> "$FIXTURE_CALLS"
if [ "$1" = -sh ]; then
  printf '100K\\t%s\\n' "$FIXTURE_STAGING"
elif [ "$1" = -sb ]; then
  size=100
  if [ "$FIXTURE_SCENARIO" = late-backup ]; then
    if [ -f "$FIXTURE_MEASURED" ]; then size=200; fi
    : > "$FIXTURE_MEASURED"
  fi
  printf '%s\\t%s\\n' "$size" "$FIXTURE_STAGING"
else
  exit 101
fi
`, { mode: 0o755 });

  await writeFile(path.join(bin, "sleep"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "sleep $*" >> "$FIXTURE_CALLS"\n', { mode: 0o755 });
  await writeFile(path.join(bin, "mkdir"), '#!/usr/bin/env bash\n[ "$*" = "-p $FIXTURE_ROOT/backup" ] || exit 102\n', { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TEST_NODE: process.execPath,
    FIXTURE_ROOT: root,
    FIXTURE_CALLS: callsFile,
    FIXTURE_SCENARIO: scenario,
    FIXTURE_STREAM: stream ? "1" : "0",
    FIXTURE_BUILT: path.join(root, "built"),
    FIXTURE_MEASURED: path.join(root, "measured"),
    FIXTURE_STAGING: staging,
    FIXTURE_CURRENT_POLICY: currentPolicy,
    FIXTURE_NEXT_POLICY: nextPolicy,
  };
  if (forceOps) env.FORCE_OPS = "1"; else delete env.FORCE_OPS;
  delete env.FORCE_COMPOSE;
  let failed = false;
  let output: string;
  try {
    const pending = run("bash", stream ? ["-s", "--", "web", "", "audited-sha"] : [path.join(root, "remote.sh"), "web", "", "audited-sha"], { env });
    if (stream) {
      const input = pending.child.stdin;
      if (!input) throw new Error("streamed deploy fixture requires piped stdin");
      input.end(remote);
    }
    const result = await pending;
    output = result.stdout + result.stderr;
  } catch (e) {
    failed = true;
    const failure = e as Error & { stdout?: string; stderr?: string };
    output = (failure.stdout || "") + (failure.stderr || "");
  }
  const calls = (await readFile(callsFile, "utf8").catch(() => "")).trim().split("\n");
  return { failed, output, calls };
}

describe("web deploy rechecks background work and the next invitation policy before recreation", () => {
  it.each([false, true])("checks twice in order and deploys only web with no dependency starts (streamed stdin: %s)", async stream => {
    const r = await deploy("normal", stream);
    expect(r.failed, r.output).toBe(false);
    const ordered = [
      "docker compose policy web image=current", "docker ps seeds:before",
      "git checkout -f -q -B main FETCH_HEAD", "docker compose build minecraft-overview", "docker compose build web",
      "docker compose policy web image=next", "docker ps seeds:after",
      "docker compose up -d --no-deps web",
    ];
    const positions = ordered.map(call => r.calls.indexOf(call));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(r.calls.filter(call => call.startsWith("docker compose policy"))).toHaveLength(2);
    expect(r.calls.filter(call => call.startsWith("docker compose up"))).toEqual(["docker compose up -d --no-deps web"]);
    expect(r.calls.filter(call => /create|unexpected|zomboid|minecraft|sevendtd/.test(call))).toEqual(["docker compose build minecraft-overview"]);
    expect(r.output.match(/invitation policy format verified/g)).toHaveLength(2);
    expect(r.calls).toContain("docker ps final");
  });

  it.each(["initial-seed", "initial-ps-error"] as const)("refuses %s before checkout or build", async scenario => {
    const r = await deploy(scenario);
    expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker ps seeds:before");
    expect(r.calls.some(call => call.startsWith("git checkout") || call.startsWith("docker compose build") || call.startsWith("docker compose up"))).toBe(false);
    if (scenario === "initial-seed") {
      expect(r.output).toContain("fixture-seed");
      expect(r.output).not.toContain("fixture-private-marker");
    }
  });

  it.each(["late-seed", "late-command-seed"] as const)("refuses %s that appears during the build and hides command text", async scenario => {
    const r = await deploy(scenario);
    expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker compose build web");
    expect(r.calls).toContain("docker compose policy web image=next");
    expect(r.calls).toContain("docker ps seeds:after");
    expect(r.calls).not.toContain("docker compose up -d --no-deps web");
    expect(r.output).toContain("fixture-seed");
    expect(r.output).not.toContain("fixture-private-marker");
  });

  it("refuses a failed post-build Docker ps inspection instead of treating it as no seeds", async () => {
    const r = await deploy("late-ps-error");
    expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker compose build web");
    expect(r.calls).toContain("docker ps seeds:after");
    expect(r.calls).not.toContain("docker compose up -d --no-deps web");
  });

  it("refuses a growing backup that begins during the build without enabling an override", async () => {
    const r = await deploy("late-backup");
    expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker compose build web");
    expect(r.calls).toContain("staging listing:after");
    expect(r.calls.filter(call => call === "staging measure:-sb")).toHaveLength(2);
    expect(r.output).toContain("a backup is copying right now");
    expect(r.output).toContain("grew 100 bytes");
    expect(r.output).not.toContain("FORCE_OPS=1 set");
    expect(r.calls).not.toContain("docker compose up -d --no-deps web");
  });

  it("runs the real next-image Node validator and refuses policy changes made during build", async () => {
    const r = await deploy("policy-change");
    expect(r.failed).toBe(true);
    expect(r.calls.filter(call => call.startsWith("docker compose policy"))).toEqual([
      "docker compose policy web image=current", "docker compose policy web image=next",
    ]);
    expect(r.calls).toContain("docker compose build web");
    expect(r.output).toContain("still contains legacy names");
    expect(r.output).not.toContain("invalid-fixture-policy-name");
    expect(r.calls).not.toContain("docker ps seeds:after");
    expect(r.calls).not.toContain("docker compose up -d --no-deps web");
  });

  it("refuses static backup staging before checkout or build because compression may still be active", async () => {
    const r = await deploy("static-work");
    expect(r.failed).toBe(true);
    expect(r.output).toContain("completion is unverified");
    expect(r.output).toContain("observed 100 then 100 bytes");
    expect(r.output).toContain("compression may still be running");
    expect(r.output).not.toContain("orphaned backup staging");
    expect(r.output).not.toContain("Safe to delete");
    expect(r.calls.filter(call => call === "staging measure:-sb")).toHaveLength(2);
    expect(r.calls.some(call => call.startsWith("git checkout") || call.startsWith("docker compose build") || call.startsWith("docker compose up"))).toBe(false);
    expect(r.output).not.toContain("FORCE_OPS=1 set");
  });

  it("refuses static backup staging that appears during build before recreating web", async () => {
    const r = await deploy("late-static-work");
    expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker compose build web");
    expect(r.calls).toContain("docker compose policy web image=next");
    expect(r.calls).toContain("staging listing:after");
    expect(r.output).toContain("completion is unverified");
    expect(r.output).toContain("observed 100 then 100 bytes");
    expect(r.output).toContain("compression may still be running");
    expect(r.output).not.toContain("orphaned backup staging");
    expect(r.output).not.toContain("Safe to delete");
    expect(r.calls.filter(call => call === "staging measure:-sb")).toHaveLength(2);
    expect(r.calls).not.toContain("docker compose up -d --no-deps web");
    expect(r.output).not.toContain("FORCE_OPS=1 set");
  });

  it.each(["initial-profile", "late-profile"] as const)("refuses %s operation markers without printing their contents", async scenario => {
    const r = await deploy(scenario);
    expect(r.failed).toBe(true); expect(r.output).toContain("profile lifecycle/preparation staging is active or unverified");
    expect(r.output).not.toContain("fixture-private-operation-content"); expect(r.calls).not.toContain("docker compose up -d --no-deps web");
    if (scenario === "initial-profile") expect(r.calls.some(call => call.startsWith("git checkout") || call.startsWith("docker compose build"))).toBe(false);
    else expect(r.calls).toContain("docker compose build web");
  });

  it("honors an explicitly reviewed profile interruption override", async () => {
    const r = await deploy("initial-profile", false, true);
    expect(r.failed, r.output).toBe(false); expect(r.output).toContain("FORCE_OPS=1 set — accepting interruption after review");
    expect(r.calls).toContain("docker compose up -d --no-deps web"); expect(r.output).not.toContain("fixture-private-operation-content");
  });
  it("refuses a failed renderer build before building or replacing web", async () => {
    const r = await deploy("renderer-build-failed"); expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker compose build minecraft-overview"); expect(r.calls).not.toContain("docker compose build web"); expect(r.calls).not.toContain("docker compose up -d --no-deps web");
    expect(r.output).toContain("overview renderer build failed; web has not been replaced");
  });
});
