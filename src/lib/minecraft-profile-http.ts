import { NextResponse } from "next/server";
import { gameGate, type GameGate } from "./game-gate";
import { hasPermission } from "./permissions";
import { MinecraftProfileError, toMinecraftProfileDTO, type MinecraftProfileRecord } from "./minecraft-profile-store";
import { minecraftProfileId, minecraftProfileServerPath } from "./minecraft-profile-path";
import { activeModJars } from "./mc-mod-replacement";
import { conflictResponse, isConflict } from "./operation-response";
import type { MinecraftProfileCapabilities, MinecraftProfileDTO, MinecraftProfileRuntimeDTO, CreateMinecraftProfileInput } from "./minecraft-profile-types";
import { MINECRAFT_JAVA_VARIANTS, MINECRAFT_PROFILE_LOADERS } from "./minecraft-profile-types";
import { validateMinecraftProfileWorldSettings } from "./minecraft-profile-world-settings";
import { FileRevisionConflictError } from "./file-revision";
import { FileWriteInterruptedError } from "./operations";

export async function minecraftProfileGate(manage = false): Promise<GameGate> {
  const gate = await gameGate("minecraft");
  if (!gate.ok) return gate;
  if (manage && !hasPermission(gate.session.user.role, "settings.edit")) return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return gate;
}

export function minecraftProfileCapabilities(role: "ADMIN" | "MOD" | "MEMBER"): MinecraftProfileCapabilities {
  return { read: true, manage: hasPermission(role, "settings.edit"), start: hasPermission(role, "server.start"), switch: hasPermission(role, "server.start") && hasPermission(role, "settings.edit") };
}

export function profileIdentifier(value: unknown): string {
  try { return minecraftProfileId(value); }
  catch { throw new MinecraftProfileError("Invalid Minecraft profile ID", 400, "invalid_profile"); }
}

export function profileRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new MinecraftProfileError("The current profile revision is required", 400, "invalid_revision");
  return value;
}

export async function boundedProfileBody(request: Request, maximum = 32_768): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new MinecraftProfileError("Request is too large", 413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maximum) { await reader.cancel(); throw new MinecraftProfileError("Request is too large", 413, "request_too_large"); }
    chunks.push(result.value);
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function profileJSON(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await boundedProfileBody(request))); }
  catch (error) { if (error instanceof MinecraftProfileError) throw error; throw new MinecraftProfileError("Expected a JSON object", 400, "invalid_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MinecraftProfileError("Expected a JSON object", 400, "invalid_request");
  return body as Record<string, unknown>;
}

export function rejectProfileKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new MinecraftProfileError("The request contains unsupported fields", 400, "invalid_request");
}

export function createMinecraftProfileInput(body: Record<string, unknown>): CreateMinecraftProfileInput {
  rejectProfileKeys(body, ["name", "description", "source", "javaVariant", "settings"]);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80 || /[\x00-\x1f\x7f]/.test(body.name) || (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000))) throw new MinecraftProfileError("Invalid profile name or description", 400, "invalid_profile");
  if (body.javaVariant !== undefined && !MINECRAFT_JAVA_VARIANTS.includes(body.javaVariant as never)) throw new MinecraftProfileError("Invalid Java variant", 400, "invalid_profile");
  if (!body.source || typeof body.source !== "object" || Array.isArray(body.source)) throw new MinecraftProfileError("A profile source is required", 400, "invalid_profile");
  const source = body.source as Record<string, unknown>;
  if (source.kind === "vanilla") {
    rejectProfileKeys(source, ["kind", "mcVersion", "loader", "loaderVersion"]);
    if (typeof source.mcVersion !== "string" || !/^[0-9][A-Za-z0-9._-]{0,63}$/.test(source.mcVersion) ||
        (source.loader !== undefined && !MINECRAFT_PROFILE_LOADERS.includes(source.loader as never))) throw new MinecraftProfileError("An exact Minecraft version and supported loader are required", 400, "invalid_profile");
  } else if (source.kind === "saved-set" || source.kind === "modrinth") {
    rejectProfileKeys(source, source.kind === "saved-set" ? ["kind", "ref", "loaderVersion"] : ["kind", "ref", "versionId"]);
    if (typeof source.ref !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(source.ref) ||
        (source.versionId !== undefined && (typeof source.versionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(source.versionId)))) throw new MinecraftProfileError("Invalid source identity", 400, "invalid_profile");
  } else throw new MinecraftProfileError("Unsupported profile source", 400, "invalid_profile");
  if (source.loaderVersion !== undefined && (typeof source.loaderVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(source.loaderVersion))) throw new MinecraftProfileError("Invalid loader version", 400, "invalid_profile");
  const settings = body.settings === undefined ? undefined : validateMinecraftProfileWorldSettings(body.settings);
  return { name: body.name.trim(), ...(body.description === undefined ? {} : { description: body.description as string }), source: source as unknown as CreateMinecraftProfileInput["source"],
    ...(body.javaVariant === undefined ? {} : { javaVariant: body.javaVariant as CreateMinecraftProfileInput["javaVariant"] }), ...(settings === undefined ? {} : { settings }) };
}

export function requireInactiveMinecraftProfile(runtime: MinecraftProfileRuntimeDTO, id: string): void {
  if (!runtime.verified || runtime.state === "unknown") throw new MinecraftProfileError("The active Minecraft profile could not be verified; reload before editing");
  if (runtime.selectedProfileId === id || runtime.appliedProfileId === id) throw new MinecraftProfileError("Use the active Minecraft settings page for the selected profile");
}

export async function minecraftProfileDTO(record: MinecraftProfileRecord): Promise<MinecraftProfileDTO> {
  const dto = toMinecraftProfileDTO(record);
  const { readMinecraftProfileOverview } = await import("./minecraft-profile-overview-queue");
  dto.overview = await readMinecraftProfileOverview(record);
  try {
    const root = await minecraftProfileServerPath(record.id, "", { allowMissing: false });
    dto.modCount = (await activeModJars(await minecraftProfileServerPath(record.id, "mods"), root)).length;
  } catch { /* Unknown physical inventory is never a guessed zero. */ }
  return dto;
}

export async function minecraftProfileResponse(work: () => Promise<NextResponse>): Promise<NextResponse> {
  try { return await work(); }
  catch (error) {
    const tagged = error && typeof error === "object" ? error as { operationId?: unknown; profileId?: unknown; status?: unknown } : null;
    const receipt = tagged && typeof tagged.operationId === "string" && tagged.operationId.length > 0 ? {
      operationId: tagged.operationId,
      ...(typeof tagged.profileId === "string" ? { profileId: tagged.profileId } : {}),
    } : {};
    if (isConflict(error)) return conflictResponse(error);
    if (error instanceof FileRevisionConflictError) return NextResponse.json({ error: error.message, stale: true }, { status: 409 });
    if (error instanceof FileWriteInterruptedError) return NextResponse.json({ error: error.message, interrupted: true }, { status: 409 });
    if (error instanceof MinecraftProfileError) return NextResponse.json({ error: error.message, code: error.code, ...receipt, ...(error.code === "profile_stale" ? { stale: true } : {}) }, { status: error.status });
    if ("operationId" in receipt) return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 500) : "Profile preparation failed", ...receipt }, { status: typeof tagged?.status === "number" && Number.isInteger(tagged.status) && tagged.status >= 400 && tagged.status <= 599 ? tagged.status : 502 });
    return NextResponse.json({ error: "Minecraft profile data could not be verified", code: "profile_unavailable" }, { status: 503 });
  }
}
