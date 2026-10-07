import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { NextRequest } from "next/server";
import type { OpHandle, OperationKind } from "@/lib/operations";
import { escapeXml, parseSdtdXmlProperties } from "@/lib/sdtd-xml";

// Real archives, extraction, XML validation, filesystem writes, gates and operation
// registry. Docker's stop/start boundary and journal are the only fabricated work.
const f = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const root = `${base}/yoshling-sdtd-backups-${process.pid}-${Date.now()}`;
  return { root, game: `${root}/game`, backups: `${root}/backups`, xml: `${root}/config/sdtdserver.xml`,
    corruptWrite: false, running: false, starts: 0, policy: true, journal: [] as Record<string, unknown>[],
  };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", name: "Tester", role: "MOD", games: "7dtd" } })) }));
vi.mock("@/lib/backup-create", () => ({
  SDTD_DIR: f.game, SDTD_XML_PATH: f.xml, createBackup: vi.fn(async () => { throw new Error("create is outside this suite"); }),
}));
vi.mock("@/lib/backup-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backup-store")>(),
  BACKUP_DIRS: { minecraft: `${f.root}/mc-backups`, "7dtd": f.backups, zomboid: `${f.root}/pz-backups` },
}));
vi.mock("@/lib/backup-log", () => ({
  readJournal: vi.fn(async () => []),
  recordBackupEvent: vi.fn(async (_game: string, _event: string, _actor: unknown, event: Record<string, unknown>) => { f.journal.push(event); }),
}));
vi.mock("@/lib/game-manager", () => ({
  withGameStopped: vi.fn(async (_game: string, _action: string, fn: (op: OpHandle) => Promise<void>, options: { kind: OperationKind; title: string; startedBy?: string; restartOnFailure: boolean }) => {
    f.policy = options.restartOnFailure;
    const { runOperation } = await import("@/lib/operations");
    return runOperation({ kind: options.kind, game: "7dtd", title: options.title, startedBy: { name: options.startedBy ?? "" } }, async (op) => {
      await fn(op);
      if (f.running) f.starts++;
      return { value: { restarted: f.running } };
    });
  }),
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    if (f.corruptWrite && String(args[0]) === await actual.realpath(f.xml)) {
      f.corruptWrite = false;
      args[1] = String(args[1]).replace(/(name="TelnetPassword" value=")[^"]*(")/, '$1BROKEN$2');
    }
    return actual.writeFile(...args);
  }) };
});

const { POST } = await import("@/app/api/7dtd/backups/route");
const { listFinished } = await import("@/lib/operations");
const run = promisify(execFile);
const PASSWORD = 'current$$<&"';
const CURRENT: Record<string, string> = {
  GameWorld: "LiveWorld", GameName: "Current", ServerName: "Current name", ServerPassword: "current join", ServerMaxPlayerCount: "8", SandboxCode: "",
  TelnetPassword: PASSWORD, TelnetPort: "8081", TelnetEnabled: "true", AdminFileName: "serveradmin.xml", UserDataFolder: "/current/game-data",
  ServerPort: "26900", WebDashboardPort: "8080",
};
const ARCHIVED: Record<string, string> = {
  ...CURRENT, GameWorld: "ArchivedWorld", GameName: "ArchivedGame", ServerName: 'Archived$$ $& <&"', ServerPassword: 'archived$$ $& <&"',
  ServerMaxPlayerCount: "12", SandboxCode: "ABCD", TelnetPassword: "obsolete control", TelnetPort: "9000", TelnetEnabled: "false",
  AdminFileName: "obsolete-admin.xml", UserDataFolder: "/obsolete/game-data", ServerPort: "27000", WebDashboardPort: "9999",
};
function xml(properties: Record<string, string>) {
  return '<ServerSettings>\n<!-- Archived comments survive -->\n' + Object.entries(properties).map(([name, value]) => `<property name="${name}" value="${escapeXml(value)}"/>`).join("\n") + '\n</ServerSettings>';
}
async function put(relative: string, contents: string) {
  const target = path.join(f.game, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}
beforeEach(async () => {
  vi.clearAllMocks();
  f.corruptWrite = false; f.running = false; f.starts = 0; f.policy = true; f.journal.length = 0;
  await rm(f.root, { recursive: true, force: true });
  await mkdir(f.backups, { recursive: true });
  await mkdir(path.dirname(f.xml));
  await put("Saves/LiveWorld/Current/main.ttw", "live progress");
  await put("GeneratedWorlds/ArchivedWorld/dtm.raw", "previous terrain");
  await writeFile(f.xml, xml(CURRENT));
  vi.stubEnv("SDTD_TELNET_PASSWORD", PASSWORD);
  vi.stubEnv("SDTD_TELNET_PORT", "8081");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(f.root, { recursive: true, force: true }); });

async function archive(options: { savedXml?: string | null; manifest?: Record<string, unknown>; map?: boolean; links?: Record<string, string> } = {}) {
  const source = path.join(f.root, "archive-source");
  await mkdir(path.join(source, "Saves", "ArchivedWorld", "ArchivedGame"), { recursive: true });
  await writeFile(path.join(source, "Saves", "ArchivedWorld", "ArchivedGame", "main.ttw"), "archived progress");
  if (options.map !== false) {
    await mkdir(path.join(source, "GeneratedWorlds", "ArchivedWorld"), { recursive: true });
    await writeFile(path.join(source, "GeneratedWorlds", "ArchivedWorld", "dtm.raw"), "archived terrain");
  }
  if (options.savedXml !== null) await writeFile(path.join(source, "sdtdserver.xml"), options.savedXml ?? xml(ARCHIVED));
  const manifest = { createdAt: new Date().toISOString(), gameWorld: "ArchivedWorld", includesWorldMap: true, ...options.manifest };
  await writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  for (const [entry, target] of Object.entries(options.links ?? {})) {
    await rm(path.join(source, entry), { recursive: true, force: true });
    await symlink(target, path.join(source, entry));
  }
  const name = "7dtd-ArchivedWorld-2026-10-06T00-00-00.tar.gz";
  await run("tar", ["-czf", path.join(f.backups, name), "-C", source, "."]);
  await writeFile(path.join(f.backups, `${name}.manifest.json`), JSON.stringify(manifest));
  return name;
}
async function restore(name: string) {
  const response = await POST(new NextRequest("https://yoshling.test/api/7dtd/backups", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "restore", backupName: name }),
  }));
  return { status: response.status, body: await response.json() };
}
async function unchanged() {
  expect(await readFile(path.join(f.game, "Saves", "LiveWorld", "Current", "main.ttw"), "utf8")).toBe("live progress");
  expect(await readFile(path.join(f.game, "GeneratedWorlds", "ArchivedWorld", "dtm.raw"), "utf8")).toBe("previous terrain");
  expect(await readFile(f.xml, "utf8")).toBe(xml(CURRENT));
}

describe("7DTD backup restore preserves deployment control", () => {
  it("refuses an escaping current XML alias before replacing saves or config", async () => {
    const name = await archive();
    const external = path.join(f.root, "external.xml");
    await rename(f.xml, external);
    await symlink(external, f.xml);
    const result = await restore(name);
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/outside the configured game volume/);
    await unchanged();
    expect(f.starts).toBe(0);
  });

  it.each(["Saves", "GeneratedWorlds"])("refuses an escaping %s parent before either live replacement", async parent => {
    const name = await archive();
    const external = path.join(f.root, `external-${parent}`);
    await rename(path.join(f.game, parent), external);
    await symlink(external, path.join(f.game, parent));
    const result = await restore(name);
    expect(result.status).toBe(500);
    await unchanged();
    expect(f.starts).toBe(0);
  });

  it("restores actual contents through contained save/map/XML aliases", async () => {
    const name = await archive();
    for (const parent of ["Saves", "GeneratedWorlds"]) {
      await rename(path.join(f.game, parent), path.join(f.game, `contained-${parent}`));
      await symlink(`contained-${parent}`, path.join(f.game, parent));
    }
    await rename(f.xml, path.join(path.dirname(f.xml), "contained.xml"));
    await symlink("contained.xml", f.xml);
    expect((await restore(name)).status).toBe(200);
    expect(await readFile(path.join(f.game, "contained-Saves", "ArchivedWorld", "ArchivedGame", "main.ttw"), "utf-8")).toBe("archived progress");
    expect(await readFile(path.join(f.game, "contained-GeneratedWorlds", "ArchivedWorld", "dtm.raw"), "utf-8")).toBe("archived terrain");
    expect(parseSdtdXmlProperties(await readFile(f.xml, "utf-8")).get("TelnetPassword")).toBe(PASSWORD);
  });

  it("refuses an escaping staged XML link before reading it or changing live files", async () => {
    const external = path.join(f.root, "external.xml");
    await writeFile(external, xml(ARCHIVED));
    const name = await archive({ links: { "sdtdserver.xml": external } });
    expect((await restore(name)).status).toBe(500);
    expect(await readFile(external, "utf-8")).toBe(xml(ARCHIVED));
    await unchanged();
  });

  it("restores actual saves/map/gameplay settings and keeps all current locked/pinned settings", async () => {
    f.running = true;
    const result = await restore(await archive());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, restoredWorld: "ArchivedWorld", restarted: true });
    const written = await readFile(f.xml, "utf8");
    const settings = Object.fromEntries(parseSdtdXmlProperties(written));
    expect(settings).toEqual({ ...ARCHIVED,
      ...Object.fromEntries(["TelnetPassword", "TelnetPort", "TelnetEnabled", "AdminFileName", "UserDataFolder", "ServerPort", "WebDashboardPort"].map((name) => [name, CURRENT[name]])),
    });
    expect(written).toContain("<!-- Archived comments survive -->");
    expect(await readFile(path.join(f.game, "Saves", "ArchivedWorld", "ArchivedGame", "main.ttw"), "utf8")).toBe("archived progress");
    expect(await readFile(path.join(f.game, "GeneratedWorlds", "ArchivedWorld", "dtm.raw"), "utf8")).toBe("archived terrain");
    expect(f.starts).toBe(1);
    expect(f.policy).toBe(false);
    expect(listFinished()[0].facts.find((fact) => fact.label === "Server config")?.value).toMatch(/read back.*control settings preserved/);
    expect((await readdir(f.backups)).filter((name) => name.startsWith(".restore-"))).toEqual([]);
  });

  it("adds current control settings when an older XML omitted them", async () => {
    const properties = { ...ARCHIVED };
    for (const name of ["TelnetPassword", "TelnetPort", "TelnetEnabled", "AdminFileName", "UserDataFolder"]) delete properties[name];
    expect((await restore(await archive({ savedXml: xml(properties) }))).status).toBe(200);
    const restored = parseSdtdXmlProperties(await readFile(f.xml, "utf8"));
    expect(restored.get("TelnetPassword")).toBe(PASSWORD);
    expect(restored.get("ServerPassword")).toBe(ARCHIVED.ServerPassword);
    expect(restored.get("UserDataFolder")).toBe(CURRENT.UserDataFolder);
  });

  it("keeps legacy bundles without XML usable without changing current credentials", async () => {
    expect((await restore(await archive({ savedXml: null }))).status).toBe(200);
    expect(await readFile(f.xml, "utf8")).toBe(xml(CURRENT));
    expect(await readFile(path.join(f.game, "Saves", "ArchivedWorld", "ArchivedGame", "main.ttw"), "utf8")).toBe("archived progress");
  });

  it.each([
    xml(ARCHIVED).replace("</ServerSettings>", ""),
    xml(ARCHIVED).replace("</ServerSettings>", '<property name="TelnetPassword" value="duplicate"/></ServerSettings>'),
    xml({ ...ARCHIVED, GameName: "../escape" }),
  ])("rejects malformed/duplicate/unsafe archived XML before replacing live data", async (savedXml) => {
    const result = await restore(await archive({ savedXml }));
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/save files were not replaced/);
    await unchanged();
    expect(f.starts).toBe(0);
    expect(f.journal[0].outcome).toBe("failed");
  });

  it.each([
    { map: false },
    { manifest: { gameWorld: "../escape" } },
    { savedXml: xml({ ...ARCHIVED, GameWorld: "DifferentWorld" }) },
  ])("rejects inconsistent map or world identities before replacing live saves: %j", async (options) => {
    const result = await restore(await archive(options));
    expect(result.status).toBe(400);
    await unchanged();
  });

  it.each(["password", "port", "enabled"])("refuses a broken current telnet %s configuration before deleting any saves", async (setting) => {
    const name = await archive();
    if (setting === "password") vi.stubEnv("SDTD_TELNET_PASSWORD", "different web credential");
    if (setting === "port") vi.stubEnv("SDTD_TELNET_PORT", "9000");
    if (setting === "enabled") await writeFile(f.xml, xml({ ...CURRENT, TelnetEnabled: "false" }));
    const before = await readFile(f.xml, "utf8");
    const result = await restore(name);
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/Cannot preserve telnet control.*save files were not replaced/);
    expect(await readFile(path.join(f.game, "Saves", "LiveWorld", "Current", "main.ttw"), "utf8")).toBe("live progress");
    expect(await readFile(f.xml, "utf8")).toBe(before);
    expect(f.starts).toBe(0);
  });

  it("refuses success and restart when actual persisted XML fails its readback", async () => {
    const name = await archive();
    f.running = true;
    f.corruptWrite = true;
    const result = await restore(name);
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/did not match.*remains stopped/);
    expect(f.starts).toBe(0);
    expect(f.policy).toBe(false);
    expect(f.journal[0].outcome).toBe("failed");
  });
});
