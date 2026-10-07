import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  xmlPath: "",
  corruptWrite: false,
  dbRow: { serverName: "Current", password: "current join", maxPlayers: 8, sandboxCode: "" } as Record<string, string | number>,
  upsert: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", name: "Tester", role: "MOD", games: "7dtd" } })) }));
vi.mock("@/lib/db", () => ({ db: {
  sevenDaysConfig: {
    findUnique: vi.fn(async () => state.dbRow),
    upsert: vi.fn(async ({ update }: { update: Record<string, string | number> }) => {
      Object.assign(state.dbRow, update);
      state.upsert(update);
      return state.dbRow;
    }),
  },
  activity: { create: vi.fn(async () => ({})) },
} }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    if (state.corruptWrite && String(args[0]) === await actual.realpath(state.xmlPath)) {
      state.corruptWrite = false;
      args[1] = String(args[1]).replace(/(name="ServerName" value=")[^"]*(")/, '$1WRONG$2');
    }
    return actual.writeFile(...args);
  }) };
});

let scratch: string;
let quick: typeof import("@/app/api/7dtd/config/route");
let all: typeof import("@/app/api/7dtd/config/all/route");
const INITIAL = '<ServerSettings>\n<!-- Keep this comment and a fake <property name="ServerDescription" value="comment"/> -->\n<property name="ServerName" value="Current"/>\n<property name="ServerPassword" value="current join"/>\n<property name="ServerMaxPlayerCount" value="8"/>\n<property name="SandboxCode" value=""/>\n<property name="ServerDescription" value="description"/>\n<property name="TelnetPassword" value="control"/>\n<property name="ServerPort" value="26900"/>\n</ServerSettings>';

beforeEach(async () => {
  vi.clearAllMocks();
  state.corruptWrite = false;
  state.dbRow = { serverName: "Current", password: "current join", maxPlayers: 8, sandboxCode: "" };
  scratch = await mkdtemp(path.join(os.tmpdir(), "yoshling-config-"));
  state.xmlPath = path.join(scratch, "config", "sdtdserver.xml");
  await mkdir(path.dirname(state.xmlPath));
  await writeFile(state.xmlPath, INITIAL);
  vi.stubEnv("SDTD_CONFIG_DIR", path.dirname(state.xmlPath));
  vi.resetModules();
  quick = await import("@/app/api/7dtd/config/route");
  all = await import("@/app/api/7dtd/config/all/route");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(scratch, { recursive: true, force: true }); });

function put(body: object) {
  return new NextRequest("https://yoshling.test/api/7dtd/config", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function shown(name: string) {
  const response = await all.GET();
  return (await response.json()).properties.find((property: { name: string; value: string }) => property.name === name)?.value;
}

describe("7DTD XML settings route round trips", () => {
  it.each(["quick", "all"])("%s settings refuse an external XML alias before reading or saving", async (route) => {
    const external = path.join(scratch, "external.xml");
    await writeFile(external, INITIAL);
    await rm(state.xmlPath);
    await symlink(external, state.xmlPath);
    const handler = route === "quick" ? quick : all;
    expect((await handler.GET()).status).toBe(500);
    const response = await handler.PUT(put(route === "quick"
      ? { serverName: "replacement" }
      : { updates: { ServerName: "replacement" } }));
    expect(response.status).toBe(500);
    expect(await readFile(external, "utf-8")).toBe(INITIAL);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it.each(["quick", "all"])("%s settings read/write contained XML aliases", async (route) => {
    const contained = path.join(path.dirname(state.xmlPath), "contained.xml");
    await writeFile(contained, INITIAL);
    await rm(state.xmlPath);
    await symlink("contained.xml", state.xmlPath);
    const handler = route === "quick" ? quick : all;
    expect((await handler.GET()).status).toBe(200);
    expect((await handler.PUT(put(route === "quick"
      ? { serverName: "contained replacement" }
      : { updates: { ServerName: "contained replacement" } }))).status).toBe(200);
    expect(await readFile(contained, "utf-8")).toContain('value="contained replacement"');
  });

  it.each(['pa$$word', '$& $1 $` $\' \\"<&>'])('quick settings persist literal password %j and return the same value', async (password) => {
    const response = await quick.PUT(put({ password, serverName: 'name $$ $& <&"' }));
    expect(response.status).toBe(200);
    expect((await response.json()).stored.password).toBe(password);
    expect(await shown("ServerPassword")).toBe(password);
    expect(await shown("ServerName")).toBe('name $$ $& <&"');
    expect(await readFile(state.xmlPath, "utf8")).toContain('<!-- Keep this comment');
  });

  it("generic edits keep dollar sequences literal and leave commented properties alone", async () => {
    const value = 'description $$ $& $1 $` $\' <&"';
    const response = await all.PUT(put({ updates: { ServerDescription: value, ServerPassword: value } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, applied: ["ServerDescription", "ServerPassword"] });
    expect(await shown("ServerDescription")).toBe(value);
    expect(await shown("ServerPassword")).toBe(value);
    expect(await readFile(state.xmlPath, "utf8")).toContain('fake <property name="ServerDescription" value="comment"/>');
  });

  it("reports a missing property and a locked property rather than manufacturing writes", async () => {
    const response = await all.PUT(put({ updates: { NoSuchKey: "x", TelnetPassword: "new control", ServerDescription: "edited" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: ["ServerDescription"], ignored: ["NoSuchKey"], locked: ["TelnetPassword"] });
    expect(await readFile(state.xmlPath, "utf8")).toContain('name="TelnetPassword" value="control"');
  });

  it("accepts an unchanged pinned port in valid reordered/single-quoted XML", async () => {
    await writeFile(state.xmlPath, INITIAL.replace('<property name="ServerPort" value="26900"/>', '<property value=\'26900\' name="ServerPort"/>'));
    const response = await all.PUT(put({ updates: { ServerPort: "26900", ServerDescription: "edited" } }));
    expect(response.status).toBe(200);
    expect(await shown("ServerPort")).toBe("26900");
    expect(await shown("ServerDescription")).toBe("edited");
  });

  it("reads all quick fields from XML and preserves them on a partial save after a restore", async () => {
    const restored = INITIAL
      .replace('value="Current"', 'value="Archived name"')
      .replace('value="current join"', () => 'value="archived$$password"')
      .replace('value="8"', 'value="12"')
      .replace('name="SandboxCode" value=""', 'name="SandboxCode" value="ABCD"');
    await writeFile(state.xmlPath, restored);
    const read = await quick.GET();
    expect(await read.json()).toMatchObject({ serverName: "Archived name", password: "archived$$password", maxPlayers: 12, sandboxCode: "ABCD" });
    expect((await quick.PUT(put({ serverName: "New name" }))).status).toBe(200);
    expect(await shown("ServerPassword")).toBe("archived$$password");
    expect(await shown("ServerMaxPlayerCount")).toBe("12");
    expect(await shown("SandboxCode")).toBe("ABCD");
  });

  it("rejects an invalid XML character before changing the DB recovery copy or file", async () => {
    const response = await quick.PUT(put({ password: "invalid\u0000password" }));
    expect(response.status).toBe(400);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(await readFile(state.xmlPath, "utf8")).toBe(INITIAL);
  });

  it.each(["quick", "all"])("%s settings refuse a malformed existing XML before writing it", async (route) => {
    const invalid = INITIAL.replace("</ServerSettings>", "");
    await writeFile(state.xmlPath, invalid);
    const response = route === "quick"
      ? await quick.PUT(put({ serverName: "changed" }))
      : await all.PUT(put({ updates: { ServerName: "changed" } }));
    expect(response.status).toBe(500);
    expect(await readFile(state.xmlPath, "utf8")).toBe(invalid);
    const read = route === "quick" ? await quick.GET() : await all.GET();
    expect(read.status).toBe(500);
    expect((await read.json()).error).toMatch(/could not be read or validated/);
  });

  it.each(["quick", "all"])("%s settings refuse success when the real persisted bytes differ", async (route) => {
    state.corruptWrite = true;
    const response = route === "quick"
      ? await quick.PUT(put({ serverName: "intended" }))
      : await all.PUT(put({ updates: { ServerName: "intended" } }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/did not match/);
    expect(await shown("ServerName")).toBe("WRONG");
  });
});
