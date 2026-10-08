import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { digestsOf, serverSideVerdict } from "@/lib/mod-admission";
import type { ModrinthVersion } from "@/lib/modrinth";
import { listFinished, runOperation } from "@/lib/operations";

const context = vi.hoisted(() => ({
  dir: "", role: "ADMIN", access: ["minecraft"],
  installed: [] as { modrinthId: string; name: string; fileName: string; versionId: string | null }[],
  installs: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "user-1", role: context.role, games: context.access } }) }));
vi.mock("@/lib/db", () => ({ db: {
  serverConfig: { findUnique: async () => ({ mcVersion: "26.1.2", modLoader: "fabric" }) },
  installedMod: { findFirst: async () => null, findMany: async () => context.installed },
} }));
vi.mock("@/lib/server-manager", () => ({ getModsDir: () => context.dir }));
vi.mock("@/lib/mod-manager", () => ({
  installMod: async (input: Record<string, unknown>) => {
    context.installs.push(input);
    return { ok: true, checked: "sha512", reason: "" };
  },
  serverSideFor: async (version: { environment?: string }) => serverSideVerdict({ environment: version.environment }),
}));

const { POST } = await import("@/app/api/mods/install/route");
const JAR = Buffer.from("PK\x03\x04 fabricated jar fixture");
const HASHES = digestsOf(JAR);
const required = (project: string | null = "dependency", pin: string | null = null) => ({ project_id: project, version_id: pin, dependency_type: "required" as const });
function build(id: string, project: string, over: Partial<ModrinthVersion> = {}): ModrinthVersion {
  return {
    id, project_id: project, name: `${project} build`, version_number: "1.0", game_versions: ["26.1.2"], loaders: ["fabric"],
    date_published: "2026-10-01", downloads: 1, environment: "client_and_server", dependencies: [],
    files: [{ primary: true, filename: `${project}.jar`, size: JAR.length, hashes: HASHES, url: "https://cdn.modrinth.test/fixture.jar" }],
    ...over,
  };
}
let selected: ModrinthVersion;
let builds: Map<string, ModrinthVersion>;
let projectStatus: number;
let versionStatus: number;
let preemptOnProjectRead: boolean;
let registryReads: string[];

beforeEach(async () => {
  context.dir = await mkdtemp(path.join(tmpdir(), "mod-dependency-route-"));
  context.role = "ADMIN";
  context.access = ["minecraft"];
  context.installed = [];
  context.installs = [];
  selected = build("selected-build", "selected", { dependencies: [required()] });
  builds = new Map([["dependency-build", build("dependency-build", "dependency")]]);
  projectStatus = 200;
  versionStatus = 200;
  preemptOnProjectRead = false;
  registryReads = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const pathname = new URL(url).pathname;
    registryReads.push(pathname);
    if (pathname === "/v2/project/selected/version") return Response.json([selected]);
    const versions = pathname.match(/^\/v2\/project\/([^/]+)\/version$/);
    if (versions) return Response.json([...builds.values()].filter((version) => version.project_id === versions[1]));
    const project = pathname.match(/^\/v2\/project\/([^/]+)$/);
    if (project) {
      if (preemptOnProjectRead) {
        await runOperation({ kind: "power", game: "minecraft", title: "Recovering Minecraft" }, async () => ({ value: null }));
      }
      return Response.json({ id: project[1], title: `Name of ${project[1]}`, server_side: "required" }, { status: projectStatus });
    }
    const version = pathname.match(/^\/v2\/version\/([^/]+)$/);
    if (version) return Response.json(builds.get(version[1]) ?? null, { status: versionStatus });
    throw new Error(`Unexpected registry request: ${pathname}`);
  }));
});
afterEach(async () => {
  await rm(context.dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function add(versionId: string | null = "dependency-build") {
  await writeFile(path.join(context.dir, "dependency.jar"), JAR);
  context.installed.push({ modrinthId: "dependency", name: "Dependency", fileName: "dependency.jar", versionId });
}
async function install(extra: Record<string, unknown> = {}) {
  const response = await POST(new NextRequest("http://localhost/api/mods/install", {
    method: "POST", body: JSON.stringify({ modrinthId: "selected", slug: "selected", name: "Selected mod", ...extra }),
    headers: { "Content-Type": "application/json" },
  }));
  return { status: response.status, body: await response.json() };
}

describe("single-mod route required dependency preflight", () => {
  it("names all missing declared projects and installs nothing", async () => {
    selected.dependencies = [required("library-a"), required("library-b"), required("library-c")];
    const result = await install();
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("Nothing was installed");
    expect(result.body.dependencies.map((issue: { name: string }) => issue.name)).toEqual(["Name of library-a", "Name of library-b", "Name of library-c"]);
    expect(context.installs).toEqual([]);
  });

  it("installs the requested mod after proving the installed dependency's real jar", async () => {
    await add();
    const result = await install();
    expect(result.status).toBe(200);
    expect(result.body.dependencies).toEqual([{ name: "Name of dependency", versionId: "dependency-build" }]);
    expect(context.installs).toHaveLength(1);
    expect(context.installs[0]).toMatchObject({ modrinthId: "selected", version: selected, source: "manual" });
  });

  it("refuses a recorded dependency whose real jar is missing", async () => {
    await add();
    await rm(path.join(context.dir, "dependency.jar"));
    expect((await install()).status).toBe(409);
    expect(context.installs).toEqual([]);
  });

  it("refuses wrong bytes even when the inventory records the expected version id", async () => {
    await add();
    await writeFile(path.join(context.dir, "dependency.jar"), Buffer.alloc(JAR.length, 65));
    expect((await install()).status).toBe(409);
    expect(context.installs).toEqual([]);
  });

  it("resolves a version-only pin through the real getVersion API wrapper", async () => {
    selected.dependencies = [required(null, "dependency-build")];
    await add();
    expect((await install()).status).toBe(200);
    expect(registryReads).toContain("/v2/version/dependency-build");
    expect(registryReads).toContain("/v2/project/dependency");
  });

  it("refuses the wrong installed pin instead of trusting the version label", async () => {
    selected.dependencies = [required("dependency", "dependency-build")];
    await add("old-build");
    expect((await install()).status).toBe(409);
    expect(context.installs).toEqual([]);
  });

  it("can certify a legacy null pin using the exact required build's digest", async () => {
    selected.dependencies = [required(null, "dependency-build")];
    await add(null);
    expect((await install()).status).toBe(200);
  });

  it("fails closed on a project metadata HTTP error", async () => {
    await add();
    projectStatus = 503;
    const result = await install();
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("Dependency");
    expect(result.body.message).toContain("503");
    expect(context.installs).toEqual([]);
  });

  it("fails closed on a pinned-build metadata HTTP error", async () => {
    selected.dependencies = [required(null, "dependency-build")];
    await add();
    versionStatus = 503;
    const result = await install();
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("503");
    expect(context.installs).toEqual([]);
  });

  it("also refuses a missing transitive required dependency", async () => {
    await add();
    builds.get("dependency-build")!.dependencies = [required("transitive")];
    const result = await install();
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("Name of transitive");
    expect(context.installs).toEqual([]);
  });

  it("does not certify unknown dependency declarations", async () => {
    selected.dependencies = undefined as unknown as ModrinthVersion["dependencies"];
    expect((await install()).status).toBe(409);
    expect(context.installs).toEqual([]);
  });

  it("observes real power preemption after dependency reads", async () => {
    await add();
    preemptOnProjectRead = true;
    const result = await install();
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("power operation");
    expect(context.installs).toEqual([]);
  });

  it("records named input refusal in the operation ledger", async () => {
    const result = await install();
    expect(result.status).toBe(409);
    const failed = listFinished().find((entry) => entry.kind === "mods.install")!;
    expect(failed.outcome).toBe("failed");
    expect(failed.summary).toContain("Name of dependency");
  });

  it("does not let the client-only override bypass dependency admission", async () => {
    selected.environment = "client_only";
    expect((await install({ allowClientOnly: true })).status).toBe(409);
    expect(context.installs).toEqual([]);
  });

  it("still installs a dependency-free mod without registry/project reads", async () => {
    selected.dependencies = [];
    expect((await install()).status).toBe(200);
    expect(context.installs).toHaveLength(1);
    expect(registryReads).toEqual(["/v2/project/selected/version"]);
  });
});

vi.mock("@/lib/minecraft-active-profile", async () => {
  const { legacyMinecraftContextMock } = await import("./fixtures/legacy-minecraft-context");
  return legacyMinecraftContextMock(() => context.dir);
});
