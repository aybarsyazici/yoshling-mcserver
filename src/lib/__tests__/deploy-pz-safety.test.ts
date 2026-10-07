import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const scratch: string[] = [];
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

afterEach(async () => { await Promise.all(scratch.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

/** Run the real remote shell body against isolated Docker/Git command fakes. */
async function deploy(options: { service?: string; running?: string; afterBuild?: string; inspectFails?: boolean; startsOnCreate?: boolean; wrongImage?: boolean; wrongLabel?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yoshling-deploy-test-"));
  scratch.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const log = path.join(root, "calls");
  const script = await readFile(path.resolve(__dirname, "../../../scripts/deploy.sh"), "utf8");
  const body = script.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/)?.[1];
  if (!body) throw new Error("remote deploy body missing");
  const remote = body.replace("cd /opt/yoshling", `cd ${quote(root)}`).replaceAll("/tmp/deploy-build.log", path.join(root, "build.log"));
  await writeFile(path.join(root, "remote.sh"), remote);
  await writeFile(path.join(bin, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "docker $*" >> "$AUDIT_CALLS"
if [ "$1" = inspect ]; then
  if [ "$AUDIT_INSPECT_FAIL" = 1 ]; then exit 1; fi
  case "$3" in
    *State.Running*)
      if [ -f "$AUDIT_CREATED" ] && [ "$AUDIT_STARTS_ON_CREATE" = 1 ]; then echo true
      elif [ -f "$AUDIT_BUILT" ]; then echo "$AUDIT_AFTER_BUILD"
      else echo "$AUDIT_RUNNING"; fi ;;
    *Config.Labels*) echo "$AUDIT_LABEL" ;;
    *Image*) echo "$AUDIT_CONTAINER_IMAGE" ;;
  esac
elif [ "$1" = image ]; then echo sha256:built
elif [ "$1" = compose ] && [ "$2" = build ]; then touch "$AUDIT_BUILT"
elif [ "$1" = compose ] && [ "$2" = create ]; then touch "$AUDIT_CREATED"
fi
`, { mode: 0o755 });
  await writeFile(path.join(bin, "git"), '#!/usr/bin/env bash\nif [ "$1" = rev-parse ]; then echo audited-sha; fi\n', { mode: 0o755 });
  // No remote backup directory, sleep or real host volume listing is needed.
  for (const command of ["mkdir", "sleep", "ls"]) await writeFile(path.join(bin, command), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  let failed = false;
  let output = "";
  try {
    const result = await execFileAsync("bash", [path.join(root, "remote.sh"), options.service || "zomboid", "", "audited-sha"], {
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, AUDIT_CALLS: log,
        AUDIT_CREATED: path.join(root, "created"), AUDIT_BUILT: path.join(root, "built"),
        AUDIT_RUNNING: options.running || "false", AUDIT_AFTER_BUILD: options.afterBuild || options.running || "false",
        AUDIT_INSPECT_FAIL: options.inspectFails ? "1" : "0", AUDIT_STARTS_ON_CREATE: options.startsOnCreate ? "1" : "0",
        AUDIT_LABEL: options.wrongLabel ? "other" : "zomboid", AUDIT_CONTAINER_IMAGE: options.wrongImage ? "sha256:old" : "sha256:built",
      },
    });
    output = result.stdout + result.stderr;
  } catch (e) {
    failed = true;
    const failure = e as Error & { stdout?: string; stderr?: string };
    output = (failure.stdout || "") + (failure.stderr || "");
  }
  return { failed, output, calls: await readFile(log, "utf8").catch(() => "") };
}

describe("PZ deploy uses stopped container recreation", () => {
  it("refuses a running PZ before any build or compose mutation", async () => {
    const r = await deploy({ running: "true" });
    expect(r.failed).toBe(true);
    expect(r.output).toContain("dashboard first");
    expect(r.calls).not.toContain("docker compose");
  });
  it("refuses an unknown state", async () => {
    const r = await deploy({ running: "unknown" });
    expect(r.failed).toBe(true);
    expect(r.calls).not.toContain("docker compose");
  });
  it("refuses failed inspection", async () => {
    const r = await deploy({ inspectFails: true });
    expect(r.failed).toBe(true);
    expect(r.output).toContain("cannot verify");
    expect(r.calls).not.toContain("docker compose");
  });
  it("rechecks after the build to protect a game powered on meanwhile", async () => {
    const r = await deploy({ afterBuild: "true" });
    expect(r.failed).toBe(true);
    expect(r.calls).toContain("docker compose build zomboid");
    expect(r.calls).not.toContain("docker compose create");
    expect(r.calls).not.toContain("docker compose up");
  });
  it("creates a stopped PZ and proves actual image and compose identity", async () => {
    const r = await deploy();
    expect(r.failed).toBe(false);
    expect(r.calls).toContain("docker compose create --force-recreate zomboid");
    expect(r.calls).not.toContain("docker compose up");
    expect(r.calls).toContain("docker image inspect");
    expect(r.calls).toContain("com.docker.compose.service");
    expect(r.output).toContain("container verified stopped");
  });
  it.each([{ startsOnCreate: true }, { wrongImage: true }, { wrongLabel: true }])("refuses an unverified recreation %j", async options => {
    const r = await deploy(options);
    expect(r.failed).toBe(true);
    expect(r.output).not.toContain("container verified stopped");
  });
  it("keeps web deployment independent of the running game", async () => {
    const r = await deploy({ service: "web", running: "true" });
    expect(r.failed).toBe(false);
    expect(r.calls).toContain("docker compose up -d --no-deps web");
    expect(r.calls).not.toContain("docker compose create");
  });
});
