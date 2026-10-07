import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { modFilePath } from "./mod-path";
import { checkIntegrity, type ObservedArtefact } from "./mod-admission";
import { getProject, getProjectVersions, getVersion, type ModrinthVersion } from "./modrinth";

interface InstalledDependency {
  modrinthId: string;
  name: string;
  fileName: string;
  versionId?: string | null;
}

export interface DependencyIssue {
  name: string;
  reason: string;
}

interface Registry {
  getProject: typeof getProject;
  getVersion: typeof getVersion;
  getProjectVersions: typeof getProjectVersions;
}

interface Requirement {
  projectId: string | null;
  versionId: string | null;
}

function requiredBy(version: ModrinthVersion): Requirement[] {
  if (!Array.isArray(version.dependencies)) throw new Error("The required dependency list could not be read.");
  const requirements: Requirement[] = [];
  for (const dependency of version.dependencies) {
    if (!dependency || !["required", "optional", "incompatible", "embedded"].includes(dependency.dependency_type)) {
      throw new Error("An unrecognized dependency requirement could not be verified.");
    }
    if (dependency.dependency_type !== "required") continue;
    const projectId = typeof dependency.project_id === "string" && dependency.project_id ? dependency.project_id : null;
    const versionId = typeof dependency.version_id === "string" && dependency.version_id ? dependency.version_id : null;
    if (!projectId && !versionId) {
      const name = typeof dependency.file_name === "string" ? ` ${dependency.file_name}` : "";
      throw new Error(`Required dependency${name} has no verifiable project or version identity.`);
    }
    requirements.push({ projectId, versionId });
  }
  return requirements;
}

async function jarDigests(file: string): Promise<ObservedArtefact> {
  const sha512 = createHash("sha512");
  const sha1 = createHash("sha1");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    sha512.update(chunk);
    sha1.update(chunk);
    size += chunk.length;
  }
  return { size, sha512: sha512.digest("hex"), sha1: sha1.digest("hex") };
}

/**
 * Read-only admission for the single-mod installer. A DB row or version label is
 * insufficient: the dependency's contained jar must match a compatible registry
 * build. Null legacy version ids can therefore be checked without inventing a pin.
 * No jar is installed or row changed while resolving the dependency closure.
 */
export async function verifyRequiredDependencies(input: {
  version: ModrinthVersion;
  mcVersion: string;
  loader: string;
  modsDir: string;
  boundaryRoot?: string;
  installed: InstalledDependency[];
}, registry: Registry = {
  getProject: (id) => getProject(id),
  getVersion: (id) => getVersion(id),
  getProjectVersions: (id, filters) => getProjectVersions(id, filters),
}): Promise<{ checked: { name: string; versionId: string }[]; issues: DependencyIssue[] }> {
  const checked: { name: string; versionId: string }[] = [];
  const issues: DependencyIssue[] = [];
  let pending: Requirement[];
  try {
    pending = requiredBy(input.version);
  } catch (error) {
    return { checked, issues: [{ name: input.version.name || "Selected mod", reason: error instanceof Error ? error.message : "Dependencies could not be read." }] };
  }

  const visited = new Set<string>();
  const traversed = new Set([input.version.id]);
  const projects = new Map<string, ReturnType<Registry["getProject"]>>();
  const versions = new Map<string, ReturnType<Registry["getVersion"]>>();
  const compatible = new Map<string, ReturnType<Registry["getProjectVersions"]>>();
  const digests = new Map<string, Promise<ObservedArtefact>>();
  const versionById = (id: string) => {
    if (!versions.has(id)) versions.set(id, registry.getVersion(id));
    return versions.get(id)!;
  };
  const fits = (version: ModrinthVersion, projectId: string) =>
    version && typeof version.id === "string" && version.id.length > 0 && version.project_id === projectId &&
    Array.isArray(version.game_versions) && version.game_versions.includes(input.mcVersion) &&
    Array.isArray(version.loaders) && version.loaders.includes(input.loader.toLowerCase()) &&
    Array.isArray(version.files);

  for (let index = 0; index < pending.length; index++) {
    const requirement = pending[index];
    const key = `${requirement.projectId ?? ""}:${requirement.versionId ?? ""}`;
    if (visited.has(key)) continue;
    // Bound an unexpected registry graph instead of partially checking it.
    if (visited.size >= 64) {
      issues.push({ name: "Dependency list", reason: "More than 64 required dependencies need verification. Stage and apply a complete pack instead." });
      break;
    }
    visited.add(key);
    let label = input.installed.find((row) => row.modrinthId === requirement.projectId)?.name ||
      requirement.projectId || requirement.versionId || "Required dependency";
    try {
      let projectId = requirement.projectId;
      let pin: ModrinthVersion | undefined;
      if (requirement.versionId) {
        pin = await versionById(requirement.versionId);
        if (!pin || pin.id !== requirement.versionId || typeof pin.project_id !== "string" || !pin.project_id) {
          throw new Error("The pinned build's identity could not be verified.");
        }
        if (projectId && pin.project_id !== projectId) throw new Error("The pinned build belongs to a different project.");
        projectId = pin.project_id;
      }
      if (!projectId) throw new Error("The dependency's project could not be resolved.");
      if (!projects.has(projectId)) projects.set(projectId, registry.getProject(projectId));
      const project = await projects.get(projectId)!;
      label = typeof project?.title === "string" && project.title ? project.title : projectId;
      if (!project || (project.id ?? project.project_id) !== projectId) throw new Error("The dependency's project identity could not be verified.");
      if (pin && !fits(pin, projectId)) throw new Error(`The pinned build is incompatible with Minecraft ${input.mcVersion} / ${input.loader}.`);

      // A backwards edge to the mod being admitted is fulfilled by this planned
      // install only when it names the same build (or has no build pin).
      if (projectId === input.version.project_id) {
        if (pin && pin.id !== input.version.id) throw new Error("Requires a different build of the mod being installed.");
        continue;
      }

      const rows = input.installed.filter((row) => row.modrinthId === projectId);
      if (!rows.length) throw new Error("No tracked installed jar identifies this dependency. Install it first, or add the complete set to a pack.");
      let satisfied: ModrinthVersion | undefined;
      let failure = "No installed jar could be verified.";
      for (const row of rows) {
        try {
          if (pin && row.versionId && row.versionId !== pin.id) throw new Error(`Requires build ${pin.id}; the installed row records ${row.versionId}.`);
          if (typeof row.fileName !== "string" || path.basename(row.fileName) !== row.fileName || !row.fileName.endsWith(".jar") || row.fileName.includes("\\")) {
            throw new Error("The recorded jar filename is unsafe or invalid.");
          }
          const filePath = await modFilePath(input.modsDir, row.fileName, { boundaryRoot: input.boundaryRoot });
          const fileStat = await stat(filePath);
          if (!fileStat.isFile() || fileStat.size === 0) throw new Error("The recorded jar is missing, empty or not a regular file.");
          let candidates: ModrinthVersion[];
          if (pin) candidates = [pin];
          else if (row.versionId) {
            const recorded = await versionById(row.versionId);
            if (!recorded || recorded.id !== row.versionId) throw new Error("The recorded build's identity could not be verified.");
            candidates = [recorded];
          } else {
            if (!compatible.has(projectId)) compatible.set(projectId, registry.getProjectVersions(projectId, {
              loaders: [input.loader.toLowerCase()], game_versions: [input.mcVersion],
            }));
            candidates = await compatible.get(projectId)!;
          }
          if (!Array.isArray(candidates)) throw new Error("Compatible dependency builds could not be read.");
          for (const candidate of candidates) {
            if (!fits(candidate, projectId)) continue;
            const files = candidate.files.filter((file) => file && file.filename === row.fileName &&
              (/^[a-f\d]{128}$/i.test(file.hashes?.sha512 ?? "") || /^[a-f\d]{40}$/i.test(file.hashes?.sha1 ?? "")));
            for (const file of files) {
              if (!digests.has(filePath)) digests.set(filePath, jarDigests(filePath));
              const check = checkIntegrity({ hashes: file.hashes, size: file.size }, await digests.get(filePath)!);
              if (check.ok && (check.checked === "sha512" || check.checked === "sha1")) {
                satisfied = candidate;
                break;
              }
            }
            if (satisfied) break;
          }
          if (satisfied) break;
          failure = "The installed jar does not match a checksum-published, compatible build of this dependency.";
        } catch (error) {
          failure = error instanceof Error ? error.message : "The installed jar could not be read.";
        }
      }
      if (!satisfied) throw new Error(failure);
      checked.push({ name: label, versionId: satisfied.id });
      if (!traversed.has(satisfied.id)) {
        traversed.add(satisfied.id);
        pending = [...pending, ...requiredBy(satisfied)];
      }
    } catch (error) {
      issues.push({ name: label, reason: error instanceof Error ? error.message : "This required dependency could not be verified." });
    }
  }
  return { checked, issues };
}
