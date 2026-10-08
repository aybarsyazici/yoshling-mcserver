import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, readFile, rename, rm, lstat, writeFile, readdir, chmod, chown } from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { withMinecraftProfileOperationMarker } from "./minecraft-profile-operation-marker";
import { runOperation, assertFileWriteActive, type OpHandle } from "./operations";
import { getProject, getProjectVersions, getVersion, type ModrinthVersion } from "./modrinth";
import { planModpackInstall } from "./mod-plan";
import { serverSideFor } from "./mod-manager";
import { verifyRequiredDependencies } from "./mod-dependencies";
import { isLockedMcProperty, escapeMcValue } from "./mc-properties";
import { MINECRAFT_PROFILE_CREATION_KEYS, validateMinecraftProfileWorldSettings } from "./minecraft-profile-world-settings";
import { gameDataPath } from "./game-data-path";
import { readEnvMap } from "./compose";
import { requireMinecraftCopySpace } from "./minecraft-profile-copy";
import { minecraftProfilesRoot, minecraftProfilePath, minecraftProfileServerPath, minecraftStorageRoot } from "./minecraft-profile-path";
import { createProfileRecord, getMinecraftProfile, requiresMinecraftAdoption, requireMinecraftProfileSchema, assertMinecraftReservedProfileStorage, toMinecraftProfileDTO, updateProfileRecord, MinecraftProfileError, type MinecraftProfileRecord } from "./minecraft-profile-store";
import { resolveProfileTarget } from "./minecraft-profile-target";
import { downloadProfileFileToPath, inspectProfilePackArchiveFile, streamProfilePackOverride, writeVerifiedProfileStream, hashProfileFile, profileDownloadUrl, profilePackPath, PROFILE_PACK_LIMITS, PROFILE_PROPERTIES_LIMITS, type ProfileFileReceipt, type ProfilePackOverride } from "./minecraft-profile-pack";
import type { CreateMinecraftProfileInput, MinecraftProfileDTO, MinecraftProfileLoader, MinecraftProfileTarget } from "./minecraft-profile-types";

type FileSource = { kind: "download"; urls: string[]; expected: { size: number; sha1: string; sha512: string } } |
  { kind: "override"; archive: string; descriptor: ProfilePackOverride };
type ModIdentity = Pick<ModrinthVersion, "id" | "project_id" | "name" | "version_number">;
interface PreparedFile { name: string; size: number; source?: FileSource; registry?: ModIdentity; dependencyVersion?: ModrinthVersion; receipt?: ProfileFileReceipt }
interface Blueprint { target: MinecraftProfileTarget; sourceRef: string | null; sourceVersionId: string | null; sourceTitle: string; files: PreparedFile[]; skipped: number }

function active(op: OpHandle): void {
  if (op.preempted) throw new Error("Profile preparation was interrupted before publication.");
  assertFileWriteActive();
}
function checkFiles(files: PreparedFile[]): void {
  let total = 0;
  const seen = new Set<string>();
  if (files.length > PROFILE_PACK_LIMITS.entries) throw new Error("Prepared profile contains too many files.");
  for (const file of files) {
    profilePackPath(file.name);
    if (seen.has(file.name)) throw new Error("Prepared profile contains conflicting file destinations.");
    seen.add(file.name);
    if (file.name === "server.properties" && file.size > PROFILE_PROPERTIES_LIMITS.bytes) throw new Error("server.properties exceeds its 1 MiB editor-safe limit.");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PROFILE_PACK_LIMITS.file || (total += file.size) > PROFILE_PACK_LIMITS.total) throw new Error("Prepared profile exceeds its byte limit.");
  }
  for (const name of seen) {
    const parts = name.split("/");
    for (let length = 1; length < parts.length; length++) if (seen.has(parts.slice(0, length).join("/"))) throw new Error("Prepared profile contains a file/directory collision.");
  }
}
function exactMod(version: ModrinthVersion): PreparedFile {
  const file = version.files.find(value => value.primary) ?? version.files[0];
  if (!file || !file.filename.endsWith(".jar") || path.basename(file.filename) !== file.filename ||
      !/^[a-f\d]{128}$/i.test(file.hashes?.sha512 ?? "") || !/^[a-f\d]{40}$/i.test(file.hashes?.sha1 ?? "")) throw new Error(`Build ${version.id} has no checksum-published jar.`);
  profileDownloadUrl(file.url);
  return { name: `mods/${file.filename}`, size: file.size, source: { kind: "download", urls: [file.url], expected: { size: file.size, ...file.hashes } }, registry: { id: version.id, project_id: version.project_id, name: version.name, version_number: version.version_number }, dependencyVersion: version };
}
async function writeSource(file: PreparedFile, destination: string, op: OpHandle): Promise<ProfileFileReceipt> {
  const assert = () => active(op), reserve = (remaining: number) => requireMinecraftCopySpace(minecraftStorageRoot(), remaining);
  if (!file.source) throw new Error("Prepared profile file has no verified source.");
  if (file.source.kind === "override") return streamProfilePackOverride(file.source.archive, file.source.descriptor, destination, assert, reserve);
  let failure: unknown;
  for (const url of file.source.urls) {
    try { return await downloadProfileFileToPath(url, destination, file.name === "server.properties" ? PROFILE_PROPERTIES_LIMITS.bytes : PROFILE_PACK_LIMITS.file, file.source.expected, assert, reserve); }
    catch (error) { failure = error; active(op); }
  }
  throw failure ?? new Error(`The pack file ${file.name} could not be downloaded.`);
}

/** Normalize configuration line by line, retaining neither the source file nor all its keys. */
async function writeProperties(source: string | undefined, destination: string, input: Record<string, string> | undefined, op: OpHandle): Promise<ProfileFileReceipt> {
  const updates = validateMinecraftProfileWorldSettings(input ?? {});
  updates["level-name"] = "world"; updates["online-mode"] = "true";
  let count = 0; const keys = new Set<string>();
  async function* lines() {
    if (source) {
      const stream = createReadStream(source), reader = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          active(op);
          if (++count > PROFILE_PROPERTIES_LIMITS.lines) throw new Error("server.properties exceeds its 4096-line editor-safe limit.");
          if (/^\s*[#!]/.test(line)) continue;
          const separator = line.indexOf("=");
          if (separator < 1) continue;
          const key = line.slice(0, separator).trim();
          keys.add(key);
          if (keys.size > PROFILE_PROPERTIES_LIMITS.keys) throw new Error("server.properties exceeds its 1024-key editor-safe limit.");
          if (!isLockedMcProperty(key) && !/[\s:\\]/.test(key) && !Object.hasOwn(updates, key)) yield Buffer.from(`${key}=${line.slice(separator + 1)}\n`);
        }
      } finally { reader.close(); stream.destroy(); }
    }
    for (const [key, value] of Object.entries(updates)) {
      keys.add(key);
      if (keys.size > PROFILE_PROPERTIES_LIMITS.keys || ++count > PROFILE_PROPERTIES_LIMITS.lines) throw new Error("server.properties exceeds its editor-safe key or line limit.");
      yield Buffer.from(`${key}=${escapeMcValue(value)}\n`);
    }
  }
  return writeVerifiedProfileStream(destination, lines(), PROFILE_PROPERTIES_LIMITS.bytes, undefined, () => active(op), remaining => requireMinecraftCopySpace(minecraftStorageRoot(), remaining));
}

/** Optional enrichment uses streamed disk hashes. Unknown registry identity is explicit. */
async function identifyPackJars(files: PreparedFile[], op: OpHandle): Promise<void> {
  const jars = files.filter(file => /^mods\/[^/]+\.jar$/.test(file.name));
  let identified = 0;
  for (let start = 0; start < jars.length; start += 500) {
    active(op);
    const batch = jars.slice(start, start + 500), hashes = batch.map(file => file.receipt!.sha512);
    try {
      const response = await fetch("https://api.modrinth.com/v2/version_files", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "minecraft-yoshling/1.0.0" }, body: JSON.stringify({ hashes, algorithm: "sha512" }), signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok || !response.body) throw new Error("Registry file identity lookup failed.");
      const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; active(op); bytes += next.value.byteLength;
          if (bytes > 8 * 1024 ** 2) throw new Error("Registry inventory response exceeds its limit."); chunks.push(Buffer.from(next.value)); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const versions = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as Record<string, ModrinthVersion>;
      for (const [index, file] of batch.entries()) {
        const version = versions[hashes[index]];
        if (version?.id && version.project_id && typeof version.name === "string" && typeof version.version_number === "string" &&
            version.files?.some(artifact => artifact.hashes?.sha512?.toLowerCase() === hashes[index] && artifact.filename === path.basename(file.name))) { file.registry = { id: version.id, project_id: version.project_id, name: version.name, version_number: version.version_number }; identified++; }
      }
    } catch { active(op); /* Complete pack files survive an optional registry lookup failure. */ }
  }
  if (identified < jars.length) op.fact({ label: "Mod inventory", value: `${jars.length - identified} pack jars have no verified Modrinth inventory identity; filenames remain visible in Installed mods`, verdict: "warn" });
}

async function blueprint(input: CreateMinecraftProfileInput, op: OpHandle, sourceDirectory: string): Promise<Blueprint> {
  op.step("Resolving the profile source and exact target");
  if (input.source.kind === "vanilla") {
    const target = await resolveProfileTarget({ mcVersion: input.source.mcVersion, loader: input.source.loader ?? "vanilla", loaderVersion: input.source.loaderVersion, javaVariant: input.javaVariant });
    return { target, sourceRef: null, sourceVersionId: null, sourceTitle: target.loader === "vanilla" ? "Vanilla" : `${target.loader} server`, files: [], skipped: 0 };
  }
  if (input.source.kind === "saved-set") {
    const set = await db.modpack.findUnique({ where: { id: input.source.ref }, include: { mods: true } });
    if (!set?.targetMcVersion || !set.targetLoader || !["fabric", "forge", "neoforge", "quilt"].includes(set.targetLoader.toLowerCase())) throw new MinecraftProfileError("The saved set needs a recorded Minecraft version and supported mod loader.", 400);
    const target = await resolveProfileTarget({ mcVersion: set.targetMcVersion, loader: set.targetLoader.toLowerCase() as MinecraftProfileLoader, loaderVersion: input.source.loaderVersion || undefined, javaVariant: input.javaVariant });
    const plan = await planModpackInstall({ mods: set.mods, target, resolvePinnedVersion: getVersion,
      resolveVersions: id => getProjectVersions(id, { loaders: [target.loader], game_versions: [target.mcVersion] }), sideFor: serverSideFor });
    if (plan.errors.length || plan.items.some(item => item.kind === "direct")) throw new MinecraftProfileError(plan.errors.join(" ") || "Direct-download saved sets need published checksums before profile preparation.", 400);
    const files = plan.items.map(item => { if (item.kind !== "modrinth") throw new Error("Unverified direct download cannot be prepared."); return exactMod(item.version); });
    checkFiles(files);
    return { target, sourceRef: set.id, sourceVersionId: null, sourceTitle: set.name, files, skipped: plan.skipped.length };
  }
  const project = await getProject(input.source.ref), projectId = project.id ?? project.project_id;
  if (project.project_type !== "modpack" || !projectId) throw new MinecraftProfileError("Choose a published Modrinth modpack.", 400);
  const version = input.source.versionId ? await getVersion(input.source.versionId) : (await getProjectVersions(projectId))[0];
  if (!version || version.project_id !== projectId || (input.source.versionId && version.id !== input.source.versionId)) throw new MinecraftProfileError("The published pack build could not be identified.", 400);
  const artifact = version.files.find(file => file.primary && file.filename.endsWith(".mrpack")) ?? version.files.find(file => file.filename.endsWith(".mrpack"));
  if (!artifact || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > PROFILE_PACK_LIMITS.archive || !/^[a-f\d]{128}$/i.test(artifact.hashes?.sha512 ?? "") || !/^[a-f\d]{40}$/i.test(artifact.hashes?.sha1 ?? "")) throw new MinecraftProfileError("This pack does not publish a verified .mrpack archive.", 400);
  const archive = await gameDataPath(sourceDirectory, "pack.mrpack");
  await downloadProfileFileToPath(artifact.url, archive, PROFILE_PACK_LIMITS.archive, { size: artifact.size, ...artifact.hashes }, () => active(op), remaining => requireMinecraftCopySpace(minecraftStorageRoot(), remaining));
  const pack = await inspectProfilePackArchiveFile(archive, () => active(op));
  const target = await resolveProfileTarget({ ...pack.index.target, javaVariant: input.javaVariant });
  const files = new Map<string, PreparedFile>(); let skipped = 0;
  for (const file of pack.index.files) {
    if (file.env?.server === "unsupported") { skipped++; continue; }
    if (!pack.overrides.has(file.path)) files.set(file.path, { name: file.path, size: file.fileSize, source: { kind: "download", urls: file.downloads, expected: { size: file.fileSize, ...file.hashes } } });
  }
  for (const [name, descriptor] of pack.overrides) files.set(name, { name, size: descriptor.size, source: { kind: "override", archive, descriptor } });
  checkFiles([...files.values()]);
  return { target, sourceRef: projectId, sourceVersionId: version.id, sourceTitle: project.title, files: [...files.values()], skipped };
}

/** A tracked preparation never claims power or changes the selected server. */
export async function createPreparedMinecraftProfile(input: CreateMinecraftProfileInput, actor: { userId: string; name?: string | null }): Promise<{ profile: MinecraftProfileDTO; operationId: string }> {
  let created: MinecraftProfileRecord | undefined, operationId: string | undefined;
  try {
    return await runOperation({ kind: "profile.prepare", game: "minecraft", title: `Preparing Minecraft profile ${input.name}`, startedBy: actor.name ? { name: actor.name } : null }, async op => {
      operationId = op.id;
      return withMinecraftProfileOperationMarker(op, "prepare", async () => {
        await requireMinecraftProfileSchema();
        await assertMinecraftReservedProfileStorage();
        if (await requiresMinecraftAdoption()) throw new MinecraftProfileError("Adopt the existing Minecraft server before creating another profile.");
        validateMinecraftProfileWorldSettings(input.settings ?? {});
        const profilesRoot = await minecraftProfilesRoot();
        active(op); await mkdir(profilesRoot, { recursive: true, mode: 0o700 });
        const sourceDirectory = await gameDataPath(profilesRoot, `.source-${randomUUID()}`);
        active(op); await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
        let stage: string | undefined;
        try {
          const plan = await blueprint(input, op, sourceDirectory);
          active(op);
          if (plan.files.some(file => file.name.startsWith("world/")) && MINECRAFT_PROFILE_CREATION_KEYS.some(key => Object.hasOwn(input.settings ?? {}, key))) throw new MinecraftProfileError("This pack supplies world data. Its seed and generation settings cannot be replaced; create the profile without those overrides.", 400);
          if (!plan.files.some(file => file.name === "server.properties")) plan.files.push({ name: "server.properties", size: 0 });
          checkFiles(plan.files);
          await requireMinecraftCopySpace(minecraftStorageRoot(), plan.files.reduce((sum, file) => sum + file.size, 0));
          if (await requiresMinecraftAdoption()) throw new MinecraftProfileError("Adopt the existing Minecraft server before creating another profile.");
          created = await createProfileRecord({ id: randomUUID(), name: input.name, description: input.description, ...plan.target, status: "preparing",
            sourceKind: input.source.kind, sourceRef: plan.sourceRef, sourceVersionId: plan.sourceVersionId, sourceTitle: plan.sourceTitle, createdBy: actor.userId });
          stage = await minecraftProfilePath(created.id, `.prepare-${randomUUID()}`);
          const destination = await minecraftProfileServerPath(created.id);
          active(op); await mkdir(stage, { recursive: true, mode: 0o700 });
          op.step("Streaming and reading back the complete profile");
          let publishedBytes = 0;
          for (const [index, file] of plan.files.entries()) {
            active(op); op.detail(file.name);
            const target = await gameDataPath(stage, file.name);
            await mkdir(path.dirname(target), { recursive: true });
            if (file.name === "server.properties") {
              let previous: string | undefined;
              if (file.source) { previous = await gameDataPath(sourceDirectory, "server.properties"); await writeSource(file, previous, op); }
              file.receipt = await writeProperties(previous, target, input.settings, op);
            } else file.receipt = await writeSource(file, target, op);
            publishedBytes += file.receipt.bytes;
            if (publishedBytes > PROFILE_PACK_LIMITS.total) throw new Error("Prepared profile exceeds its total byte limit.");
            active(op); await chmod(target, 0o644);
            op.progress({ kind: "count", done: index + 1, total: plan.files.length, noun: "files" });
          }
          if (input.source.kind === "modrinth") await identifyPackJars(plan.files, op);
          const rows = plan.files.filter(file => file.registry).map(file => {
            const version = file.registry!;
            return { profileId: created!.id, modrinthId: version.project_id, slug: version.project_id, name: version.name, version: version.version_number,
              fileName: path.basename(file.name), mcVersion: plan.target.mcVersion, loader: plan.target.loader, source: "pack", versionId: version.id, installedBy: actor.userId };
          });
          if (input.source.kind === "saved-set") for (const file of plan.files.filter(file => file.dependencyVersion)) {
            const result = await verifyRequiredDependencies({ version: file.dependencyVersion!, mcVersion: plan.target.mcVersion, loader: plan.target.loader, modsDir: path.join(stage, "mods"), boundaryRoot: stage, installed: rows });
            if (result.issues.length) throw new Error(result.issues.map(issue => `${issue.name}: ${issue.reason}`).join(" "));
            delete file.dependencyVersion;
          }
          const receipt = JSON.stringify({ formatVersion: 1, profileId: created.id, source: { kind: input.source.kind, ref: plan.sourceRef, versionId: plan.sourceVersionId }, target: plan.target,
            files: plan.files.map(file => ({ path: file.name, bytes: file.receipt!.bytes, sha512: file.receipt!.sha512, versionId: file.registry?.id ?? null })) });
          const receiptPath = await minecraftProfilePath(created.id, "preparation.json");
          active(op); await writeFile(receiptPath, receipt, { flag: "wx", mode: 0o600 });
          if (await readFile(receiptPath, "utf8") !== receipt) throw new Error("Profile preparation receipt readback failed.");
          try { await lstat(destination); throw new Error("The profile server directory already exists."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          active(op); await rename(stage, destination);
          if (!await lstat(destination).then(info => info.isDirectory() && !info.isSymbolicLink())) throw new Error("Profile directory publication failed.");
          if (rows.length) {
            await db.installedMod.createMany({ data: rows });
            const stored = await db.installedMod.findMany({ where: { profileId: created.id } });
            if (stored.length !== rows.length || rows.some(row => !stored.some(value => value.fileName === row.fileName && value.versionId === row.versionId))) throw new Error("Prepared mod inventory readback failed.");
          }
          active(op); created = await updateProfileRecord(created.id, created.revision, { status: "ready", preparationError: null });
          const { notifyMinecraftProfileOverviewReady } = await import("./minecraft-profile-overview-queue");
          await notifyMinecraftProfileOverviewReady(created.id, op);
          op.fact({ label: "Profile", value: created.name }); op.fact({ label: "Files", value: `${plan.files.length} published and read back` });
          op.fact({ label: "Target", value: `${plan.target.mcVersion} / ${plan.target.loader}${plan.target.loaderVersion ? ` ${plan.target.loaderVersion}` : ""} / ${plan.target.javaVariant}` });
          if (plan.skipped) op.fact({ label: "Client files", value: `${plan.skipped} excluded from the server` });
          return { value: { profile: toMinecraftProfileDTO(created), operationId: op.id } };
        } catch (error) {
          if (!op.preempted && created?.status === "preparing") created = await updateProfileRecord(created.id, created.revision, { status: "failed", preparationError: error instanceof Error ? error.message.slice(0, 500) : "Preparation failed" });
          throw error;
        } finally {
          if (stage) await rm(stage, { recursive: true, force: true });
          await rm(sourceDirectory, { recursive: true, force: true });
        }
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && operationId) Object.assign(error, { operationId, ...(created ? { profileId: created.id } : {}) });
    throw error;
  }
}

/** Ready profiles retain their current files; selecting never fetches a new pack build. */
export async function prepareMinecraftProfile(id: string, op: OpHandle): Promise<MinecraftProfileRecord> {
  active(op);
  const profile = await getMinecraftProfile(id);
  if (!profile || profile.status !== "ready") throw new MinecraftProfileError(profile?.preparationError || "This profile is not ready to start.");
  const root = await minecraftProfileServerPath(id);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The profile server directory is missing or unsafe.");
  const names = await readdir(root);
  if (!names.includes("server.properties")) throw new Error("The profile server configuration is missing.");
  await gameDataPath(root, "server.properties");
  return profile;
}

function javaProperty(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/^ /, "\\ ").replace(/:/g, "\\:");
}

/** Refresh only deployment control settings while the chosen profile is stopped. */
export async function prepareMinecraftProfileControlSettings(id: string, op: OpHandle): Promise<void> {
  active(op);
  const env = await readEnvMap();
  const password = env.RCON_PASSWORD ?? process.env.RCON_PASSWORD;
  if (!password) throw new Error("The deployment RCON credential is missing; the profile was not started.");
  const file = await minecraftProfileServerPath(id, "server.properties");
  const previousStat = await lstat(file);
  if (previousStat.size > PROFILE_PROPERTIES_LIMITS.bytes) throw new Error("server.properties exceeds its 1 MiB editor-safe limit.");
  const control = { "enable-rcon": "true", "rcon.password": javaProperty(password), "rcon.port": "25575", "server-port": "25565", "server-ip": "", "level-name": "world", "management-server-enabled": "false" };
  const temporary = await minecraftProfileServerPath(id, `.properties-${randomUUID()}`);
  async function* configuration() {
    const stream = createReadStream(file), reader = createInterface({ input: stream, crlfDelay: Infinity });
    let keptLine = false, count = 0; const keys = new Set<string>();
    try {
      for await (const line of reader) {
        active(op);
        if (++count > PROFILE_PROPERTIES_LIMITS.lines) throw new Error("server.properties exceeds its 4096-line editor-safe limit.");
        const match = /^\s*([^#!=:\s]+)\s*[=:]/.exec(line);
        if (match) keys.add(match[1]);
        if (keys.size > PROFILE_PROPERTIES_LIMITS.keys) throw new Error("server.properties exceeds its 1024-key editor-safe limit.");
        if (!match || !isLockedMcProperty(match[1])) { keptLine = true; yield Buffer.from(`${line}\n`); }
      }
    } finally { reader.close(); stream.destroy(); }
    if (!keptLine) yield Buffer.from("\n");
    for (const [key, value] of Object.entries(control)) {
      keys.add(key);
      if (keys.size > PROFILE_PROPERTIES_LIMITS.keys || ++count > PROFILE_PROPERTIES_LIMITS.lines) throw new Error("server.properties exceeds its editor-safe key or line limit.");
      yield Buffer.from(`${key}=${value}\n`);
    }
  }
  try {
    active(op);
    const receipt = await writeVerifiedProfileStream(temporary, configuration(), PROFILE_PROPERTIES_LIMITS.bytes, undefined, () => active(op), remaining => requireMinecraftCopySpace(minecraftStorageRoot(), remaining));
    const staged = await lstat(temporary);
    if (staged.uid !== previousStat.uid || staged.gid !== previousStat.gid) await chown(temporary, previousStat.uid, previousStat.gid);
    await chmod(temporary, previousStat.mode & 0o777);
    active(op); await rename(temporary, file);
    if (JSON.stringify(await hashProfileFile(file, () => active(op))) !== JSON.stringify(receipt)) throw new Error("Profile control configuration publication failed readback.");
    const published = await lstat(file);
    if (published.uid !== previousStat.uid || published.gid !== previousStat.gid || (published.mode & 0o777) !== (previousStat.mode & 0o777)) throw new Error("Profile control file permissions failed readback.");
  } finally { await rm(temporary, { force: true }); }
}
