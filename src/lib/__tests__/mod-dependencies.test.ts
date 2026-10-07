import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestsOf } from "@/lib/mod-admission";
import { verifyRequiredDependencies } from "@/lib/mod-dependencies";
import type { ModrinthDependency, ModrinthProject, ModrinthVersion } from "@/lib/modrinth";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const JAR = Buffer.from("fabricated dependency jar bytes");
const HASHES = digestsOf(JAR);
const required = (project: string | null = "dependency", pin: string | null = null) => ({ project_id: project, version_id: pin, dependency_type: "required" as const });

function build(id: string, project = "dependency", over: Partial<ModrinthVersion> = {}): ModrinthVersion {
  return {
    id, project_id: project, name: `${project} build`, version_number: "1.0.0", game_versions: ["26.1.2"], loaders: ["fabric"],
    date_published: "2026-10-01", downloads: 1, environment: "client_and_server", dependencies: [],
    files: [{ filename: `${project}.jar`, primary: true, size: JAR.length, hashes: HASHES, url: "https://cdn.modrinth.test/fixture.jar" }],
    ...over,
  };
}

async function fixture(dependencies: ModrinthDependency[] = [required()]) {
  const modsDir = await mkdtemp(path.join(tmpdir(), "mod-dependencies-"));
  roots.push(modsDir);
  const builds = new Map<string, ModrinthVersion>([["dependency-build", build("dependency-build")]]);
  const registry = {
    getProject: vi.fn(async (id: string) => ({ id, project_id: id, title: `Name of ${id}` }) as ModrinthProject),
    getVersion: vi.fn(async (id: string) => {
      const version = builds.get(id);
      if (!version) throw new Error("Registry build unavailable");
      return version;
    }),
    getProjectVersions: vi.fn(async (id: string) => [...builds.values()].filter((version) => version.project_id === id)),
  };
  const input = {
    version: build("selected-build", "selected", { dependencies }), mcVersion: "26.1.2", loader: "fabric", modsDir,
    installed: [] as { modrinthId: string; name: string; fileName: string; versionId: string | null }[],
  };
  const add = async (version = builds.get("dependency-build")!, versionId: string | null = version.id) => {
    await writeFile(path.join(modsDir, version.files[0].filename), JAR);
    input.installed.push({ modrinthId: version.project_id, name: `Name of ${version.project_id}`, fileName: version.files[0].filename, versionId });
  };
  const verify = () => verifyRequiredDependencies(input, registry);
  return { input, registry, builds, add, verify };
}

describe("required mod dependency admission over real jar files", () => {
  it("needs no registry/filesystem reads when no dependency is required", async () => {
    const f = await fixture([]);
    await expect(f.verify()).resolves.toEqual({ checked: [], issues: [] });
    expect(f.registry.getProject).not.toHaveBeenCalled();
    expect(f.registry.getVersion).not.toHaveBeenCalled();
  });

  it("names a required project missing from inventory", async () => {
    const f = await fixture();
    const result = await f.verify();
    expect(result.issues).toEqual([{ name: "Name of dependency", reason: expect.stringContaining("No tracked installed jar") }]);
  });

  it("accepts an installed compatible dependency only after matching its jar digest", async () => {
    const f = await fixture();
    await f.add();
    expect(await f.verify()).toEqual({ checked: [{ name: "Name of dependency", versionId: "dependency-build" }], issues: [] });
  });

  it("resolves a version-only required dependency to its project", async () => {
    const f = await fixture([required(null, "dependency-build")]);
    await f.add();
    expect((await f.verify()).issues).toEqual([]);
    expect(f.registry.getVersion).toHaveBeenCalledWith("dependency-build");
    expect(f.registry.getProject).toHaveBeenCalledWith("dependency");
  });

  it("does not treat a DB row whose jar was deleted as installed", async () => {
    const f = await fixture();
    await f.add();
    await rm(path.join(f.input.modsDir, "dependency.jar"));
    expect((await f.verify()).issues).toHaveLength(1);
  });

  it("refuses a jar whose bytes disagree with the recorded registry build", async () => {
    const f = await fixture();
    await f.add();
    await writeFile(path.join(f.input.modsDir, "dependency.jar"), Buffer.alloc(JAR.length, 65));
    expect((await f.verify()).issues[0].reason).toContain("does not match");
  });

  it("refuses an empty file or a directory in place of a dependency jar", async () => {
    const f = await fixture();
    await f.add();
    await writeFile(path.join(f.input.modsDir, "dependency.jar"), "");
    expect((await f.verify()).issues).toHaveLength(1);
    await rm(path.join(f.input.modsDir, "dependency.jar"));
    await mkdir(path.join(f.input.modsDir, "dependency.jar"));
    expect((await f.verify()).issues).toHaveLength(1);
  });

  it("refuses a jar linked outside the mods directory", async () => {
    const f = await fixture();
    await f.add();
    const outside = await mkdtemp(path.join(tmpdir(), "mod-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "outside.jar"), JAR);
    await rm(path.join(f.input.modsDir, "dependency.jar"));
    await symlink(path.join(outside, "outside.jar"), path.join(f.input.modsDir, "dependency.jar"));
    expect((await f.verify()).issues[0].reason).toContain("outside its configured directory");
  });

  it("refuses an installed different pinned build even when the version label matches", async () => {
    const f = await fixture([required("dependency", "dependency-build")]);
    await f.add(undefined, "other-build");
    expect((await f.verify()).issues[0].reason).toContain("installed row records other-build");
  });

  it("proves a legacy null versionId satisfies an exact pin by matching its published digest", async () => {
    const f = await fixture([required("dependency", "dependency-build")]);
    await f.add(undefined, null);
    expect((await f.verify()).issues).toEqual([]);
  });

  it("does not certify a legacy null versionId when the pinned bytes differ", async () => {
    const f = await fixture([required("dependency", "dependency-build")]);
    await f.add(undefined, null);
    await writeFile(path.join(f.input.modsDir, "dependency.jar"), Buffer.alloc(JAR.length, 66));
    expect((await f.verify()).issues).toHaveLength(1);
  });

  it("finds a compatible checksum-matching build for an unpinned legacy row", async () => {
    const f = await fixture();
    await f.add(undefined, null);
    expect((await f.verify()).issues).toEqual([]);
    expect(f.registry.getProjectVersions).toHaveBeenCalledWith("dependency", { loaders: ["fabric"], game_versions: ["26.1.2"] });
  });

  it.each([
    { game_versions: ["1.21.1"] }, { loaders: ["forge"] }, { project_id: "different-project" },
  ])("refuses incompatible/wrong-project recorded build %o", async (over) => {
    const f = await fixture();
    await f.add();
    f.builds.set("dependency-build", build("dependency-build", "dependency", over));
    expect((await f.verify()).issues).toHaveLength(1);
  });

  it("refuses a pinned dependency advertised under the wrong project", async () => {
    const f = await fixture([required("different-project", "dependency-build")]);
    await f.add();
    expect((await f.verify()).issues[0].reason).toContain("different project");
  });

  it("refuses mismatched registry version/project identities", async () => {
    const f = await fixture([required("dependency", "dependency-build")]);
    await f.add();
    f.registry.getVersion.mockResolvedValueOnce(build("wrong-build"));
    expect((await f.verify()).issues[0].reason).toContain("identity");
    f.registry.getProject.mockResolvedValueOnce({ id: "wrong-project", title: "Dependency" } as ModrinthProject);
    expect((await f.verify()).issues[0].reason).toContain("identity");
  });

  it("refuses a size-only match when no registry checksum identifies the build", async () => {
    const f = await fixture();
    await f.add();
    const version = f.builds.get("dependency-build")!;
    version.files[0].hashes = { sha512: "", sha1: "" };
    expect((await f.verify()).issues).toHaveLength(1);
  });

  it("fails closed with the dependency's recorded name when the registry is unavailable", async () => {
    const f = await fixture();
    await f.add();
    f.registry.getProject.mockRejectedValueOnce(new Error("Registry unavailable"));
    expect((await f.verify()).issues).toEqual([{ name: "Name of dependency", reason: "Registry unavailable" }]);
  });

  it("checks required dependencies of the verified installed dependency too", async () => {
    const f = await fixture();
    await f.add();
    f.builds.get("dependency-build")!.dependencies = [required("transitive")];
    expect((await f.verify()).issues).toEqual([{ name: "Name of transitive", reason: expect.stringContaining("No tracked installed jar") }]);
  });

  it("terminates a satisfied cycle back to the mod being installed", async () => {
    const f = await fixture();
    await f.add();
    f.builds.get("dependency-build")!.dependencies = [required("selected")];
    expect((await f.verify()).issues).toEqual([]);
  });

  it("refuses a cycle requiring a different build of the requested mod", async () => {
    const f = await fixture();
    await f.add();
    f.builds.set("other-selected", build("other-selected", "selected"));
    f.builds.get("dependency-build")!.dependencies = [required("selected", "other-selected")];
    expect((await f.verify()).issues[0].reason).toContain("different build of the mod being installed");
  });

  it("ignores recognized optional/embedded/incompatible declarations", async () => {
    const f = await fixture(["optional", "embedded", "incompatible"].map((type) => ({ ...required("absent"), dependency_type: type as ModrinthDependency["dependency_type"] })));
    expect((await f.verify()).issues).toEqual([]);
    expect(f.registry.getProject).not.toHaveBeenCalled();
  });

  it("checks repeated requirements once without consuming the distinct-dependency budget", async () => {
    const f = await fixture(Array.from({ length: 70 }, () => required()));
    await f.add();
    expect((await f.verify()).issues).toEqual([]);
    expect(f.registry.getProject).toHaveBeenCalledTimes(1);
    expect(f.registry.getVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses a graph it cannot completely verify within its dependency budget", async () => {
    const f = await fixture(Array.from({ length: 65 }, (_, index) => required(`dependency-${index}`)));
    const result = await f.verify();
    expect(result.issues.at(-1)?.reason).toContain("More than 64");
    expect(f.registry.getProject).toHaveBeenCalledTimes(64);
  });

  it.each([
    undefined, [{ ...required(), project_id: null, version_id: null }], [{ ...required(), dependency_type: "new-type" }], [null],
  ])("refuses unreadable or unidentified requirements %o", async (dependencies) => {
    const f = await fixture();
    f.input.version.dependencies = dependencies as unknown as ModrinthVersion["dependencies"];
    expect((await f.verify()).issues).toHaveLength(1);
  });
});
