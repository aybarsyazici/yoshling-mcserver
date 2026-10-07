import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { digestsOf } from "@/lib/mod-admission";
import { assertResourceFree, listFinished, listOperations, OperationConflictError, runOperation } from "@/lib/operations";
import type { ModrinthVersion } from "@/lib/modrinth";

const context = vi.hoisted(() => ({ mods: "", pathCalls: 0, recoverDuringPath: false, creates: [] as Record<string, unknown>[], activities: [] as Record<string, unknown>[] }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "actor", name: "Operator", role: "ADMIN", games: ["minecraft"] } }) }));
vi.mock("@/lib/server-manager", () => ({ getModsDir: () => context.mods }));
vi.mock("@/lib/db", () => ({ db: {
  serverConfig: { findUnique: async () => ({ mcVersion: "26.1.2", modLoader: "fabric" }) },
  installedMod: {
    findFirst: async () => null, findMany: async () => [],
    create: async ({ data }: { data: Record<string, unknown> }) => { context.creates.push(data); },
  },
  activity: { create: async ({ data }: { data: Record<string, unknown> }) => { context.activities.push(data); } },
} }));
// All actual filesystem admission runs. The wrapper admits recovery only at the
// final preparatory await to prove the publication hook follows that await.
vi.mock("@/lib/mod-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mod-path")>();
  return { ...actual, modFilePath: async (...args: Parameters<typeof actual.modFilePath>) => {
    const file = await actual.modFilePath(...args);
    context.pathCalls++;
    if (context.pathCalls === 2 && context.recoverDuringPath) {
      await runOperation({ kind: "power", game: "minecraft", title: "Recovering Minecraft" }, async () => ({ value: null }));
    }
    return file;
  } };
});
const { POST } = await import("@/app/api/mods/install/route");
const JAR = Buffer.from("PK\x03\x04 ordinary single mod fixture");
const selected: ModrinthVersion = {
  id: "version-1", project_id: "selected", name: "Selected mod", version_number: "1.0", game_versions: ["26.1.2"], loaders: ["fabric"],
  downloads: 1, date_published: "2026-10-01", environment: "client_and_server", dependencies: [],
  files: [{ filename: "selected.jar", primary: true, size: JAR.length, hashes: digestsOf(JAR), url: "https://cdn.modrinth.test/fixture.jar" }],
};
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
let root: string;
let metadataHold: ReturnType<typeof gate> | null;
let downloadHold: ReturnType<typeof gate> | null;
let metadataReached: ReturnType<typeof gate>;
let downloadReached: ReturnType<typeof gate>;
let inFlight: Promise<{ status: number; body: { success?: boolean; error?: string } }> | null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "single-mod-operation-"));
  context.mods = path.join(root, "mods");
  await mkdir(context.mods);
  context.pathCalls = 0; context.recoverDuringPath = false; context.creates = []; context.activities = [];
  metadataHold = null; downloadHold = null; metadataReached = gate(); downloadReached = gate(); inFlight = null;
  vi.stubEnv("MC_SERVER_DIR", root);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (new URL(url).pathname === "/v2/project/selected/version") {
      metadataReached.resolve();
      if (metadataHold) await metadataHold.promise;
      return Response.json([selected]);
    }
    if (url === selected.files[0].url) {
      downloadReached.resolve();
      if (downloadHold) await downloadHold.promise;
      return new Response(new Uint8Array(JAR));
    }
    throw new Error("Unexpected registry request");
  }));
});
afterEach(async () => {
  metadataHold?.resolve(); downloadHold?.resolve();
  await inFlight?.catch(() => {});
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
function install() {
  inFlight = (async () => {
    const response = await POST(new NextRequest("http://localhost/api/mods/install", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modrinthId: "selected", slug: "selected", name: "Selected mod" }),
    }));
    return { status: response.status, body: await response.json() };
  })();
  return inFlight;
}

describe("the real single-mod route owns and narrates its complete I/O interval", () => {
  it("holds Minecraft files while metadata is pending", async () => {
    metadataHold = gate();
    const request = install();
    await metadataReached.promise;
    const operation = listOperations().find((entry) => entry.kind === "mods.install")!;
    expect(operation.resources).toEqual(["files:minecraft"]);
    expect(operation.holdsPower).toBe(false);
    expect(operation.steps.at(-1)?.label).toContain("required dependencies");
    expect(() => assertResourceFree("files:minecraft")).toThrow(OperationConflictError);
    metadataHold.resolve();
    const result = await request;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operationId: operation.id });
  });

  it("holds the same file resource throughout download and publishes verified bytes", async () => {
    downloadHold = gate();
    const request = install();
    await downloadReached.promise;
    const operation = listOperations().find((entry) => entry.kind === "mods.install")!;
    expect(operation.steps.at(-1)?.label).toContain("Downloading");
    expect(() => assertResourceFree("files:minecraft")).toThrow(OperationConflictError);
    downloadHold.resolve();
    expect((await request).status).toBe(200);
    expect(await readFile(path.join(context.mods, "selected.jar"))).toEqual(JAR);
    expect(context.creates[0]).toMatchObject({ source: "manual", versionId: "version-1" });
    const finished = listFinished().find((entry) => entry.id === operation.id)!;
    expect(finished.outcome).toBe("ok");
    expect(finished.facts).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Installed", value: "Selected mod 1.0" })]));
  });

  it("power preemption during download prevents any publication or success record", async () => {
    downloadHold = gate();
    const request = install();
    await downloadReached.promise;
    const operation = listOperations().find((entry) => entry.kind === "mods.install")!;
    await runOperation({ kind: "power", game: "minecraft", title: "Recovering Minecraft" }, async () => ({ value: null }));
    downloadHold.resolve();
    const result = await request;
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ operationId: operation.id });
    expect(result.body.success).not.toBe(true);
    await expect(readFile(path.join(context.mods, "selected.jar"))).rejects.toThrow();
    expect(context.creates).toEqual([]); expect(context.activities).toEqual([]);
    expect(listFinished().find((entry) => entry.id === operation.id)?.outcome).toBe("failed");
  });

  it("checks preemption after final path admission rather than before its awaits", async () => {
    context.recoverDuringPath = true;
    const result = await install();
    expect(context.pathCalls).toBe(2);
    expect(result.status).toBe(500);
    await expect(readFile(path.join(context.mods, "selected.jar"))).rejects.toThrow();
    expect(context.creates).toEqual([]); expect(context.activities).toEqual([]);
  });

  it("rejects a second file operation while the installer owns the lane", async () => {
    metadataHold = gate();
    const request = install();
    await metadataReached.promise;
    await expect(runOperation({ kind: "mods.apply", game: "minecraft", title: "Applying a pack" }, async () => ({ value: null }))).rejects.toBeInstanceOf(OperationConflictError);
    metadataHold.resolve();
    expect((await request).status).toBe(200);
  });
});
