import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import path from "path";
import type { NextRequest } from "next/server";

// Real filesystem trees: mocking fs would merely repeat the guard's assumptions.
// Configured roots are links too, so the tests exercise legitimate root aliases.
const DIRS = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || "/tmp"}/yoshling-file-routes-${process.pid}-${Date.now()}`;
  return {
    root,
    mc: `${root}/minecraft`,
    sdtdConfig: `${root}/sevendtd-config`,
    sdtdSaves: `${root}/sevendtd`,
    pz: `${root}/zomboid`,
    outside: `${root}/outside`,
  };
});

let signedIn = true;
let role = "MOD";
let games = "minecraft,7dtd,zomboid";
const activityCreate = vi.fn(async () => ({}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => signedIn ? { user: { id: "tester", role, games } } : null),
}));
vi.mock("@/lib/db", () => ({ db: { activity: { create: activityCreate } } }));
vi.mock("@/lib/zomboid", () => ({ PZ_DIR: DIRS.pz }));

process.env.MC_SERVER_DIR = DIRS.mc;
process.env.SDTD_CONFIG_DIR = DIRS.sdtdConfig;
process.env.SDTD_SERVER_DIR = DIRS.sdtdSaves;

// Permissions, game gates, file guard, operations lane and fs run unmocked.
const minecraft = await import("@/app/api/server/files/route");
const sdtd = await import("@/app/api/7dtd/files/route");
const zomboid = await import("@/app/api/zomboid/files/route");

const CASES = [
  { game: "minecraft", root: undefined, dir: DIRS.mc, handlers: minecraft },
  { game: "7dtd", root: "config", dir: DIRS.sdtdConfig, handlers: sdtd },
  { game: "7dtd", root: "saves", dir: DIRS.sdtdSaves, handlers: sdtd },
  { game: "zomboid", root: "config", dir: path.join(DIRS.pz, "Server"), handlers: zomboid },
  { game: "zomboid", root: "saves", dir: path.join(DIRS.pz, "Saves"), handlers: zomboid },
  { game: "zomboid", root: "all", dir: DIRS.pz, handlers: zomboid },
];
type FileCase = (typeof CASES)[number];

async function request(
  context: FileCase,
  method: "GET" | "PUT" | "DELETE",
  relativePath: unknown,
  action = "read",
  content = "replacement"
) {
  const url = new URL(`http://localhost/api/${context.game}/files`);
  if (context.root) url.searchParams.set("root", context.root);
  if (method !== "PUT") {
    url.searchParams.set("path", String(relativePath));
    url.searchParams.set("action", action);
  }
  const req = new Request(url, {
    method,
    ...(method === "PUT" ? {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relativePath, root: context.root, content }),
    } : {}),
  }) as NextRequest;
  const response = await context.handlers[method](req);
  return { status: response.status, body: await response.json() };
}

const SECRET = "fabricated-control-credential=outside-the-granted-world\n";
const outsideFile = path.join(DIRS.outside, "control.txt");

beforeEach(async () => {
  vi.clearAllMocks();
  signedIn = true;
  role = "MOD";
  games = "minecraft,7dtd,zomboid";
  await rm(DIRS.root, { recursive: true, force: true });
  await mkdir(DIRS.outside, { recursive: true });
  await writeFile(outsideFile, SECRET);

  for (const [alias, name] of [
    [DIRS.mc, "minecraft"],
    [DIRS.sdtdConfig, "sevendtd-config"],
    [DIRS.sdtdSaves, "sevendtd"],
    [DIRS.pz, "zomboid"],
  ]) {
    const physical = path.join(DIRS.root, "trees", name);
    await mkdir(physical, { recursive: true });
    await symlink(physical, alias);
  }
  await mkdir(path.join(DIRS.pz, "Server"));
  await mkdir(path.join(DIRS.pz, "Saves"));
});

afterEach(async () => {
  await rm(DIRS.root, { recursive: true, force: true });
});

describe.each(CASES)("$game files, $root root", (context) => {
  it("refuses to read a final symlink to another tree", async () => {
    await symlink(outsideFile, path.join(context.dir, "ordinary.txt"));
    const result = await request(context, "GET", "ordinary.txt");
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain(SECRET.trim());
    expect(await readFile(outsideFile, "utf-8")).toBe(SECRET);
  });

  it("refuses to list an external directory reached through a link", async () => {
    await symlink(DIRS.outside, path.join(context.dir, "external"));
    const result = await request(context, "GET", "external", "list");
    expect(result.status).toBe(400);
    expect(result.body.items).toBeUndefined();
  });

  it("refuses to overwrite an external file reached through a final link", async () => {
    await symlink(outsideFile, path.join(context.dir, "ordinary.txt"));
    expect((await request(context, "PUT", "ordinary.txt")).status).toBe(400);
    expect(await readFile(outsideFile, "utf-8")).toBe(SECRET);
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("refuses creation through a linked parent even when the new file is absent", async () => {
    await symlink(DIRS.outside, path.join(context.dir, "external"));
    expect((await request(context, "PUT", "external/new.txt")).status).toBe(400);
    await expect(lstat(path.join(DIRS.outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("refuses to delete another tree's file through a linked parent", async () => {
    await symlink(DIRS.outside, path.join(context.dir, "external"));
    expect((await request(context, "DELETE", "external/control.txt")).status).toBe(400);
    expect(await readFile(outsideFile, "utf-8")).toBe(SECRET);
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("refuses an escaping final link on DELETE", async () => {
    const link = path.join(context.dir, "ordinary.txt");
    await symlink(outsideFile, link);
    expect((await request(context, "DELETE", "ordinary.txt")).status).toBe(400);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(outsideFile, "utf-8")).toBe(SECRET);
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("refuses a dangling external link rather than creating its destination", async () => {
    const outsideNew = path.join(DIRS.outside, "new.txt");
    await symlink(outsideNew, path.join(context.dir, "ordinary.txt"));
    expect((await request(context, "PUT", "ordinary.txt")).status).toBe(400);
    await expect(lstat(outsideNew)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists link metadata without statting its external destination", async () => {
    const link = path.join(context.dir, "ordinary.txt");
    await symlink(outsideFile, link);
    const result = await request(context, "GET", "", "list");
    expect(result.status).toBe(200);
    const entry = result.body.items.find((item: { name: string }) => item.name === "ordinary.txt");
    expect(entry.size).toBe((await lstat(link)).size);
  });

  it("refuses deletion of the selected root by dot, absolute path or internal alias", async () => {
    await writeFile(path.join(context.dir, "keep.txt"), "keep");
    await symlink(".", path.join(context.dir, "root-alias"));
    for (const rootPath of [".", context.dir, "root-alias"]) {
      expect((await request(context, "DELETE", rootPath)).status).toBe(400);
      expect(await readFile(path.join(context.dir, "keep.txt"), "utf-8")).toBe("keep");
    }
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("reads, edits, creates and deletes ordinary contained files", async () => {
    await writeFile(path.join(context.dir, "local.txt"), "before");
    expect((await request(context, "GET", "local.txt")).body.content).toBe("before");
    expect((await request(context, "PUT", "local.txt")).status).toBe(200);
    expect(await readFile(path.join(context.dir, "local.txt"), "utf-8")).toBe("replacement");
    expect((await request(context, "PUT", "new.txt")).status).toBe(200);
    expect(await readFile(path.join(context.dir, "new.txt"), "utf-8")).toBe("replacement");
    expect((await request(context, "DELETE", "new.txt")).status).toBe(200);
    await expect(lstat(path.join(context.dir, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(activityCreate).toHaveBeenCalledTimes(3);
  });

  it("keeps contained links usable and unlinks the alias without deleting its target", async () => {
    await writeFile(path.join(context.dir, "local.txt"), "before");
    const link = path.join(context.dir, "local-link.txt");
    await symlink("local.txt", link);
    expect((await request(context, "GET", "local-link.txt")).body.content).toBe("before");
    expect((await request(context, "PUT", "local-link.txt")).status).toBe(200);
    expect(await readFile(path.join(context.dir, "local.txt"), "utf-8")).toBe("replacement");
    expect((await request(context, "DELETE", "local-link.txt")).status).toBe(200);
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(context.dir, "local.txt"), "utf-8")).toBe("replacement");
  });

  it("refuses the actual sibling-prefix escape on every verb", async () => {
    const sibling = `${context.dir}-sibling`;
    await mkdir(sibling);
    await writeFile(path.join(sibling, "keep.txt"), "keep");
    expect((await request(context, "GET", sibling, "list")).status).toBe(400);
    expect((await request(context, "PUT", path.join(sibling, "keep.txt"))).status).toBe(400);
    expect((await request(context, "DELETE", sibling)).status).toBe(400);
    expect(await readFile(path.join(sibling, "keep.txt"), "utf-8")).toBe("keep");
  });

  it("handles malformed write paths as a refusal", async () => {
    expect((await request(context, "PUT", { name: "local.txt" })).status).toBe(400);
    expect(activityCreate).not.toHaveBeenCalled();
  });
});

describe.each([CASES[0], CASES[1], CASES[3]])("$game gates stay enforced", (context) => {
  it("refuses unauthenticated requests before reading or changing files", async () => {
    const file = path.join(context.dir, "local.txt");
    await writeFile(file, "keep");
    signedIn = false;
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect((await request(context, method, "local.txt")).status).toBe(401);
      expect(await readFile(file, "utf-8")).toBe("keep");
    }
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("refuses a moderator without the selected world", async () => {
    const file = path.join(context.dir, "local.txt");
    await writeFile(file, "keep");
    games = "";
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect((await request(context, method, "local.txt")).status).toBe(403);
      expect(await readFile(file, "utf-8")).toBe("keep");
    }
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("refuses a read-only member on every verb", async () => {
    const file = path.join(context.dir, "local.txt");
    await writeFile(file, "keep");
    role = "MEMBER";
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect((await request(context, method, "local.txt")).status).toBe(403);
      expect(await readFile(file, "utf-8")).toBe("keep");
    }
    expect(activityCreate).not.toHaveBeenCalled();
  });
});

describe.each([CASES[3], CASES[4]])("PZ $root shortcut stays inside the data mount", (context) => {
  it("refuses a shortcut directory replaced by an external symlink on every verb", async () => {
    await rm(context.dir, { recursive: true });
    await symlink(DIRS.outside, context.dir);
    expect((await request(context, "GET", "control.txt")).status).toBe(400);
    expect((await request(context, "PUT", "control.txt")).status).toBe(400);
    expect((await request(context, "DELETE", "control.txt")).status).toBe(400);
    expect(await readFile(outsideFile, "utf-8")).toBe(SECRET);
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("retains a shortcut directory link whose destination is inside the trusted mount", async () => {
    const internal = path.join(DIRS.pz, "internal-shortcut");
    await mkdir(internal);
    await writeFile(path.join(internal, "local.txt"), "inside");
    await rm(context.dir, { recursive: true });
    await symlink(internal, context.dir);
    expect((await request(context, "GET", "local.txt")).body.content).toBe("inside");
    expect((await request(context, "PUT", "local.txt")).status).toBe(200);
    expect(await readFile(path.join(internal, "local.txt"), "utf-8")).toBe("replacement");
  });
});
