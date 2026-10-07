import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { parseSdtdXmlProperties } from "@/lib/sdtd-xml";
import { listOperations, runOperation } from "@/lib/operations";

const execFileAsync = promisify(execFile);
const f = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || "/tmp"}/yoshling-reset-${process.pid}-${Date.now()}`;
  process.env.SDTD_CONFIG_DIR = `${root}/config`;
  return {
    root,
    saves: `${root}/saves`,
    backups: `${root}/backups`,
    role: "ADMIN",
    failReadback: false,
    failInspection: false,
    skipStop: false,
    exitAfterStart: false,
    failAfterStart: false,
    powers: [] as boolean[],
    inspectionHook: null as null | (() => Promise<void>),
    peerAtSaveCheck: false,
    games: ["7dtd"],
    running: new Set<string>(),
    starts: vi.fn(async () => {
      f.powers.push(listOperations().some(op => op.kind === "world.reset" && op.holdsPower));
      f.running.add("7dtd");
      if (f.exitAfterStart) f.running.delete("7dtd");
      if (f.failAfterStart) f.failInspection = true;
    }),
    stops: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "reset-owner", name: "Operator", role: f.role, games: f.games } })),
}));
vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof import("fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args);
      if (f.peerAtSaveCheck) {
        f.peerAtSaveCheck = false;
        f.running.add("zomboid");
      }
      return result;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (f.failReadback && path.resolve(String(args[0])) === await actual.realpath(path.join(f.root, "config", "sdtdserver.xml")) &&
          typeof result === "string" && result.includes('value="Fresh3"')) {
        return result.replace('value="Fresh3"', 'value="Fresh2"');
      }
      return result;
    },
  };
});
vi.mock("@/lib/db", () => ({ db: { activity: { create: vi.fn(async () => ({})) } } }));
vi.mock("@/lib/game-manager", () => ({
  RUNTIME: { "7dtd": { dir: f.saves } },
  gameContainerState: vi.fn(async (game: string) => {
    if (f.inspectionHook) await f.inspectionHook();
    if (f.failInspection) throw new Error("Docker inspection failed");
    return f.running.has(game) ? "running" : "exited";
  }),
  startGameForOperation: f.starts,
  stopGameForOperation: vi.fn(async () => {
    await f.stops();
    if (!f.skipStop) f.running.delete("7dtd");
    return !f.skipStop;
  }),
}));
vi.mock("@/lib/backup-store", async (original) => ({
  ...await original<typeof import("@/lib/backup-store")>(),
  BACKUP_DIRS: { minecraft: `${f.root}/mc-backups`, "7dtd": f.backups, zomboid: `${f.root}/pz-backups` },
}));

const { GET, POST } = await import("@/app/api/7dtd/reset/route");
const xmlPath = path.join(f.root, "config", "sdtdserver.xml");
const snapshots = path.join(f.backups, "presreset");

beforeEach(async () => {
  await rm(f.root, { recursive: true, force: true });
  await mkdir(path.join(f.saves, "Saves", "Alpha", "Fresh2"), { recursive: true });
  await mkdir(path.dirname(xmlPath), { recursive: true });
  await mkdir(snapshots, { recursive: true });
  await writeFile(path.join(f.saves, "Saves", "Alpha", "Fresh2", "progress.txt"), "real progress before reset");
  await writeFile(xmlPath, '<ServerSettings><property name="GameWorld" value="Alpha"/><property name="GameName" value="Fresh2"/></ServerSettings>');
  f.running.clear();
  f.starts.mockClear();
  f.stops.mockClear();
  f.role = "ADMIN";
  f.failReadback = false;
  f.failInspection = false;
  f.skipStop = false;
  f.exitAfterStart = false;
  f.failAfterStart = false;
  f.powers.length = 0;
  f.inspectionHook = null;
  f.peerAtSaveCheck = false;
  f.games = ["7dtd"];
});
afterAll(async () => { await rm(f.root, { recursive: true, force: true }); });

describe("7DTD reset safety", () => {
  it("does not claim a restart when terminal inspection fails after the save was reset", async () => {
    f.failAfterStart = true;
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("final server state could not be verified") });
    expect(await readFile(xmlPath, "utf8")).toContain('value="Fresh3"');
    expect(f.starts).toHaveBeenCalledOnce();
  });

  it("reports a completed reset and failed start honestly when the container exits before terminal readback", async () => {
    f.exitAfterStart = true;
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("The save was reset") });
    expect(await readFile(xmlPath, "utf8")).toContain('value="Fresh3"');
    expect(f.starts).toHaveBeenCalledOnce();
    expect(await stat(path.join(f.saves, "Saves", "Alpha")).catch(() => null)).toBeNull();
    expect((await readdir(snapshots)).some(n => n.startsWith("presreset-Alpha-"))).toBe(true);
  });

  it("refuses external XML aliases for preview and reset before creating safety copies", async () => {
    const external = path.join(f.root, "external.xml");
    const before = await readFile(xmlPath, "utf-8");
    await writeFile(external, before);
    await rm(xmlPath);
    await symlink(external, xmlPath);
    expect((await GET()).status).toBe(500);
    expect((await POST()).status).toBe(500);
    expect(await readFile(external, "utf-8")).toBe(before);
    expect(await readdir(snapshots)).toEqual([]);
    expect(f.starts).not.toHaveBeenCalled();
  });

  it("refuses an escaping Saves parent before tar, stop or deletion", async () => {
    const external = path.join(f.root, "external-saves");
    await mkdir(path.join(external, "Alpha"), { recursive: true });
    await writeFile(path.join(external, "Alpha", "fixture.txt"), "external fixture");
    await rm(path.join(f.saves, "Saves"), { recursive: true });
    await symlink(external, path.join(f.saves, "Saves"));
    expect((await POST()).status).toBe(500);
    expect(await readFile(path.join(external, "Alpha", "fixture.txt"), "utf-8")).toBe("external fixture");
    expect(await readdir(snapshots)).toEqual([]);
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.stops).not.toHaveBeenCalled();
  });

  it("retains actual safety-copy data and canonical writes through contained aliases", async () => {
    const contained = path.join(f.saves, "contained-save");
    await mkdir(path.join(contained, "Fresh2"), { recursive: true });
    await writeFile(path.join(contained, "Fresh2", "progress.txt"), "contained fixture");
    await rm(path.join(f.saves, "Saves", "Alpha"), { recursive: true });
    await symlink("../contained-save", path.join(f.saves, "Saves", "Alpha"));
    const containedXml = path.join(path.dirname(xmlPath), "contained.xml");
    await writeFile(containedXml, await readFile(xmlPath, "utf-8"));
    await rm(xmlPath);
    await symlink("contained.xml", xmlPath);
    expect((await POST()).status).toBe(200);
    const copy = (await readdir(snapshots)).find(n => n.endsWith(".tar.gz"))!;
    expect((await execFileAsync("tar", ["-xzOf", path.join(snapshots, copy), "Alpha/Fresh2/progress.txt"])).stdout).toBe("contained fixture");
    expect(await readFile(path.join(contained, "Fresh2", "progress.txt"), "utf-8")).toBe("contained fixture");
    await mkdir(path.join(f.saves, "Saves", "Alpha", "Fresh3"), { recursive: true });
    await writeFile(path.join(f.saves, "Saves", "Alpha", "Fresh3", "progress.txt"), "fresh selected save");
    expect(await readFile(path.join(contained, "Fresh2", "progress.txt"), "utf-8")).toBe("contained fixture");
    expect(await readFile(containedXml, "utf-8")).toContain('value="Fresh3"');
    expect(f.powers).toEqual([true]);
  });

  it("leaves an unrelated live backup unpreempted when co-residency refuses reset", async () => {
    let release!: () => void;
    let backupOp!: import("@/lib/operations").OpHandle;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const backup = runOperation({ kind: "backup.create", game: "zomboid", title: "Fixture backup" }, async op => {
      backupOp = op;
      await blocked;
      return { value: undefined };
    });
    try {
      f.running.add("zomboid");
      expect((await POST()).status).toBe(409);
      expect(backupOp.preempted).toBe(false);
      expect(Boolean(listOperations().find(op => op.id === backupOp.id)?.preempted)).toBe(false);
    } finally {
      release();
      await backup;
    }
  });

  it("claims power before reset work and refuses a preempted preflight", async () => {
    let release!: () => void;
    let recovery: Promise<unknown> | null = null;
    f.inspectionHook = async () => {
      f.inspectionHook = null;
      const held = new Promise<void>(resolve => { release = resolve; });
      recovery = runOperation({ kind: "power", game: "7dtd", title: "Fixture recovery", action: "stop" }, async () => {
        await held;
        return { value: undefined };
      });
    };
    try {
      expect((await POST()).status).toBe(500);
      expect(await readdir(snapshots)).toEqual([]);
      expect(f.starts).not.toHaveBeenCalled();
    } finally {
      release();
      if (recovery) await recovery;
    }
  });

  it("rechecks peers after claiming power when another world started during file preflight", async () => {
    f.peerAtSaveCheck = true;
    const before = await readFile(xmlPath, "utf-8");
    expect((await POST()).status).toBe(409);
    expect(await readdir(snapshots)).toEqual([]);
    expect(await readFile(xmlPath, "utf-8")).toBe(before);
    expect(f.starts).not.toHaveBeenCalled();
  });

  it("keeps and verifies the current world's safety copy despite older alphabetically later worlds", async () => {
    for (const [name, date] of [
      ["presreset-Zulu-2026-01-01T00-00-00.tar.gz", "2026-01-01"],
      ["presreset-Zulu-2026-01-02T00-00-00.tar.gz", "2026-01-02"],
    ]) {
      const p = path.join(snapshots, name);
      await writeFile(p, "older unrelated world snapshot");
      await utimes(p, new Date(date), new Date(date));
    }
    const response = await POST();
    expect(response.status).toBe(200);
    const names = await readdir(snapshots);
    expect(names).toHaveLength(2);
    const current = names.find(n => n.startsWith("presreset-Alpha-"));
    expect(current, "the copy promised before the wipe must still exist").toBeTruthy();
    const { stdout } = await execFileAsync("tar", ["-xzOf", path.join(snapshots, current!), "Alpha/Fresh2/progress.txt"]);
    expect(stdout).toBe("real progress before reset");
    expect(names).toContain("presreset-Zulu-2026-01-02T00-00-00.tar.gz");
    expect(names).not.toContain("presreset-Zulu-2026-01-01T00-00-00.tar.gz");
    expect(await stat(path.join(f.saves, "Saves", "Alpha")).catch(() => null)).toBeNull();
    expect(await readFile(xmlPath, "utf8")).toContain('value="Fresh3"');
    expect(f.starts).toHaveBeenCalledOnce();
  });

  it("refuses before creating a copy, writing config or wiping anything when PZ is running", async () => {
    f.running.add("zomboid");
    const before = await readFile(xmlPath, "utf8");
    const response = await POST();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ conflict: "coresidency", running: ["zomboid"] });
    expect(await readFile(path.join(f.saves, "Saves", "Alpha", "Fresh2", "progress.txt"), "utf8")).toBe("real progress before reset");
    expect(await readFile(xmlPath, "utf8")).toBe(before);
    expect(await readdir(snapshots)).toEqual([]);
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.stops).not.toHaveBeenCalled();
  });

  it("still resets and starts the requested world when it is the sole running game", async () => {
    f.running.add("7dtd");
    const response = await POST();
    expect(response.status).toBe(200);
    expect(f.stops).toHaveBeenCalledOnce();
    expect(f.starts).toHaveBeenCalledOnce();
  });

  it("does not expose a reset to a moderator granted only another world", async () => {
    f.role = "MOD";
    f.games = ["zomboid"];
    const response = await POST();
    expect(response.status).toBe(403);
    expect(f.starts).not.toHaveBeenCalled();
    expect(await readdir(snapshots)).toEqual([]);
  });

  it("updates the actual game name literally, ignoring comments and accepting quoted XML attributes", async () => {
    await writeFile(xmlPath, '<ServerSettings><!-- <property name="GameName" value="Example"/> --><property name="GameWorld" value="Alpha"/><property value=\'Trade$$&amp;1\' name=\'GameName\'/></ServerSettings>');
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ newGameName: "Trade$$&2" });
    const xml = await readFile(xmlPath, "utf8");
    expect(parseSdtdXmlProperties(xml).get("GameName")).toBe("Trade$$&2");
    expect(xml).toContain('value="Example"');
  });

  it("refuses a missing game name before copying or wiping save data", async () => {
    await writeFile(xmlPath, '<ServerSettings><property name="GameWorld" value="Alpha"/></ServerSettings>');
    const response = await POST();
    expect(response.status).toBe(400);
    expect(f.starts).not.toHaveBeenCalled();
    expect(await readdir(snapshots)).toEqual([]);
    expect(await readFile(path.join(f.saves, "Saves", "Alpha", "Fresh2", "progress.txt"), "utf8")).toBe("real progress before reset");
  });

  it("does not report success or restart when the stored new name cannot be verified", async () => {
    f.failReadback = true;
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("could not be verified") });
    expect(f.starts).not.toHaveBeenCalled();
    const current = (await readdir(snapshots)).find(n => n.startsWith("presreset-Alpha-"));
    expect(current).toBeTruthy();
    const { stdout } = await execFileAsync("tar", ["-xzOf", path.join(snapshots, current!), "Alpha/Fresh2/progress.txt"]);
    expect(stdout).toBe("real progress before reset");
  });

  it("does not touch a save or config when Docker cannot establish the current state", async () => {
    f.running.add("7dtd"); f.failInspection = true;
    const before = await readFile(xmlPath, "utf8");
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await readdir(snapshots)).toEqual([]);
    expect(await readFile(xmlPath, "utf8")).toBe(before);
    expect(await readFile(path.join(f.saves, "Saves", "Alpha", "Fresh2", "progress.txt"), "utf8")).toBe("real progress before reset");
    expect(f.starts).not.toHaveBeenCalled();
  });

  it("refuses the destructive swap when a stop returned without stopping the game", async () => {
    f.running.add("7dtd"); f.skipStop = true;
    const before = await readFile(xmlPath, "utf8");
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await readFile(xmlPath, "utf8")).toBe(before);
    expect(await readFile(path.join(f.saves, "Saves", "Alpha", "Fresh2", "progress.txt"), "utf8")).toBe("real progress before reset");
    expect((await readdir(snapshots)).some(n => n.startsWith("presreset-Alpha-"))).toBe(true);
    expect(f.starts).not.toHaveBeenCalled();
  });
});
