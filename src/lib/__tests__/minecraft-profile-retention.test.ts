import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, rm, readdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
const f = vi.hoisted(() => ({ root: `${process.env.TMPDIR || "/tmp"}/profile-retention-${process.pid}-${Date.now()}` }));
vi.mock("../game-manager", () => ({ RUNTIME: { minecraft: { dir: f.root }, "7dtd": { dir: f.root }, zomboid: { dir: f.root } }, containerIsRunning: vi.fn() }));
vi.mock("../backup-store", async original => ({ ...await original<typeof import("../backup-store")>(), BACKUP_DIRS: { minecraft: f.root, "7dtd": f.root, zomboid: f.root } }));
const { sealArchive } = await import("../backup-create");
const op = { step: vi.fn(), settle: vi.fn(), fact: vi.fn(), preempted: false } as never;
beforeEach(async () => { await rm(f.root, { recursive: true, force: true }); await mkdir(f.root, { recursive: true }); vi.stubEnv("BACKUP_KEEP_MINECRAFT", "1"); vi.stubEnv("BACKUP_MAX_AGE_DAYS_MINECRAFT", "1"); });
afterEach(async () => { await rm(f.root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe("profile-local archive retention", () => {
  it("prunes only the namespace whose new archive was sealed", async () => {
    const own = path.join(f.root, "profiles", "profile-b"); await mkdir(own, { recursive: true });
    const old = new Date(Date.now() - 10 * 86400_000);
    for (const file of [path.join(f.root, "legacy-old.tar.gz"), path.join(f.root, "legacy-new.tar.gz"), path.join(own, "b-old.tar.gz")]) {
      await writeFile(file, "old fixture"); await utimes(file, old, old);
    }
    const target = path.join(own, "b-new.tar.gz"); await writeFile(target, "new fixture");
    const result = await sealArchive(op, { game: "minecraft", filename: "b-new.tar.gz", target, manifest: { createdAt: new Date().toISOString(), minecraftProfileId: "profile-b" } });
    expect(result.pruned).toEqual(["b-old.tar.gz"]);
    expect(await readdir(f.root)).toEqual(expect.arrayContaining(["legacy-old.tar.gz", "legacy-new.tar.gz"]));
    expect(await readdir(own)).toEqual(expect.arrayContaining(["b-new.tar.gz", "b-new.tar.gz.manifest.json"]));
    expect(await readdir(own)).not.toContain("b-old.tar.gz");
  });
});
