import { getMinecraftDataRoot, readMinecraftRuntime, MinecraftProfileError } from "./minecraft-profile-store";
import { NextResponse } from "next/server";
import { withGameFileWrite } from "./operation-response";

export const MINECRAFT_CONTEXT_HEADER = "X-Minecraft-Context";
export interface MinecraftActiveContext { profileId: string | null; revision: string; token: string; root: string; schemaReady: boolean }
export class MinecraftActiveProfileError extends Error {
  readonly status = 409;
  constructor(message: string) { super(message); this.name = "MinecraftActiveProfileError"; }
}

/** A reader snapshots identity as well as bytes; identity is not a permission grant. */
export async function minecraftActiveContext(): Promise<MinecraftActiveContext> {
  const read = await readMinecraftRuntime();
  const runtime = read.runtime;
  const profileId = runtime?.selectedProfileId ?? null;
  const revision = runtime?.revision ?? "0";
  const root = await getMinecraftDataRoot();
  const checked = await readMinecraftRuntime();
  if ((checked.runtime?.selectedProfileId ?? null) !== profileId || (checked.runtime?.revision ?? "0") !== revision) {
    throw new MinecraftActiveProfileError("The Minecraft profile changed while this page was being read. Reload it before continuing.");
  }
  return { profileId, revision, token: `${profileId ?? "legacy"}@${revision}`, root, schemaReady: read.schemaReady };
}
export function withMinecraftContext<T extends Response>(response: T, context: MinecraftActiveContext): T {
  response.headers.set(MINECRAFT_CONTEXT_HEADER, context.token);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/** Call again inside the file/power lease, before preparatory reads or mutations. */
export async function assertMinecraftProfileCurrent(context: MinecraftActiveContext, verifyRuntime = true): Promise<void> {
  const current = await minecraftActiveContext();
  if (current.token !== context.token || current.root !== context.root) throw new MinecraftActiveProfileError("The Minecraft profile changed. Reload this page before editing.");
  if (verifyRuntime && current.profileId) {
    const { getMinecraftProfileRuntimeStatus } = await import("./minecraft-profile-activation");
    const applied = await getMinecraftProfileRuntimeStatus();
    if (!applied.verified || applied.appliedProfileId !== current.profileId || applied.state === "unknown") {
      throw new MinecraftActiveProfileError(applied.reason || "The selected Minecraft profile does not match the server. Changes are blocked until its runtime is verified.");
    }
  }
}

/** Legacy clients remain compatible only while no profile has been selected. */
export async function requireMinecraftProfileContext(request: { headers: Headers }): Promise<MinecraftActiveContext> {
  const context = await minecraftActiveContext();
  const expected = request.headers?.get(MINECRAFT_CONTEXT_HEADER) ?? null;
  if ((context.profileId && expected !== context.token) || (expected && expected !== context.token)) {
    throw new MinecraftActiveProfileError("The Minecraft profile changed or this page has no verified profile context. Reload before editing.");
  }
  return context;
}

/** A legacy database has no profileId column yet; avoid querying it before migration. */
export function minecraftInventoryWhere(context: MinecraftActiveContext): { profileId?: string | null } {
  return context.schemaReady ? { profileId: context.profileId } : {};
}

function profileError(error: unknown): NextResponse | null {
  if (error instanceof MinecraftActiveProfileError || error instanceof MinecraftProfileError) {
    return NextResponse.json({ error: error.message, staleProfile: error.status === 409 }, { status: error.status });
  }
  return null;
}

/** Snapshot one profile for a complete read; discard mixed reads across a selection change. */
export async function withMinecraftProfileRead(
  work: (context: MinecraftActiveContext) => Promise<NextResponse>,
  options: { verifyRuntime?: boolean } = {}
): Promise<NextResponse> {
  try {
    const context = await minecraftActiveContext();
    await assertMinecraftProfileCurrent(context, options.verifyRuntime !== false);
    const response = await work(context);
    await assertMinecraftProfileCurrent(context, options.verifyRuntime !== false);
    // Recovery logs remain readable under drift, but cannot bootstrap command readiness.
    return response.ok && options.verifyRuntime !== false ? withMinecraftContext(response, context) : response;
  } catch (error) {
    return profileError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "Minecraft profile read failed" }, { status: 500 });
  }
}

/** Check the rendered identity before admission, then again under the complete write lease. */
export async function withMinecraftProfileFileWrite(
  request: { headers: Headers },
  work: (context: MinecraftActiveContext) => Promise<NextResponse>,
  revisionFile?: (context: MinecraftActiveContext) => Promise<string>
): Promise<NextResponse> {
  let context: MinecraftActiveContext;
  try { context = await requireMinecraftProfileContext(request); }
  catch (error) { return profileError(error) ?? NextResponse.json({ error: error instanceof Error ? error.message : "Minecraft profile request failed" }, { status: 500 }); }
  return withGameFileWrite("minecraft", async () => {
    try {
      await assertMinecraftProfileCurrent(context);
      const response = await work(context);
      return response.ok ? withMinecraftContext(response, context) : response;
    } catch (error) {
      const response = profileError(error);
      if (response) return response;
      throw error;
    }
  }, revisionFile ? { request, file: () => revisionFile(context) } : undefined);
}
