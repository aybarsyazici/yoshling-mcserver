import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";

const f = vi.hoisted(() => ({ branch: "stable" as string | null, ok: true, fails: false, build: "10" as unknown }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "reader", role: "MEMBER", games: "7dtd" } }) }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/compose", () => ({ readCompose: async () => "fixture", readServiceEnv: () => f.branch }));
vi.mock("child_process", () => ({ exec: (_command: string, callback: (e: null, result: { stdout: string }) => void) => {
  callback(null, { stdout: JSON.stringify(["VERSION=latest_experimental"]) });
} }));
let root = "";
let manifest = "";
let get: typeof import("@/app/api/7dtd/update/route").GET;
beforeEach(async () => {
  vi.resetModules(); f.branch = "stable"; f.ok = true; f.fails = false; f.build = "10";
  root = await mkdtemp(path.join(tmpdir(), "yoshling-build-lookup-"));
  await mkdir(path.join(root, "steamapps"));
  manifest = path.join(root, "steamapps", "appmanifest_294420.acf");
  await writeFile(manifest, '"buildid" "10"');
  vi.stubEnv("SDTD_CONFIG_DIR", root);
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (f.fails) throw new Error("fixture upstream failure");
    return { ok: f.ok, status: f.ok ? 200 : 503, json: async () => ({ data: { "294420": { depots: { branches: { public: { buildid: f.build } } } } } }) };
  }));
  ({ GET: get } = await import("@/app/api/7dtd/update/route"));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("7DTD checked/unknown Steam comparison", () => {
  it("maps stable to public and reports checked equality only with both build IDs", async () => {
    expect(await (await get()).json()).toMatchObject({ branch: "stable", resolvedBranch: "public", lookupStatus: "checked", updateAvailable: false, latestBuildId: "10", checkError: null });
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("reports a verified available update", async () => {
    f.build = "20";
    expect(await (await get()).json()).toMatchObject({ lookupStatus: "checked", updateAvailable: true, latestBuildId: "20" });
  });
  it.each(["http", "network", "shape", "installed", "branch"])("keeps %s failure unknown rather than up to date", async kind => {
    if (kind === "http") f.ok = false;
    if (kind === "network") f.fails = true;
    if (kind === "shape") f.build = {};
    if (kind === "installed") await rm(manifest);
    if (kind === "branch") f.branch = null;
    const body = await (await get()).json();
    expect(body).toMatchObject({ lookupStatus: "unknown", updateAvailable: null });
    expect(body.checkError).toBeTruthy();
  });
});
