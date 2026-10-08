/** Existing transport/archive suites isolate legacy I/O. Profile admission has its own suites. */
import type { NextResponse } from "next/server";

export function legacyMinecraftContextMock(root: () => string) {
  class MinecraftActiveProfileError extends Error { readonly status = 409; }
  const context = async () => ({ profileId: null, revision: "0", token: "legacy@0", root: root(), schemaReady: false });
  type LegacyContext = Awaited<ReturnType<typeof context>>;
  return {
    MINECRAFT_CONTEXT_HEADER: "X-Minecraft-Context",
    MinecraftActiveProfileError,
    minecraftActiveContext: context,
    requireMinecraftProfileContext: context,
    assertMinecraftProfileCurrent: async () => {},
    minecraftInventoryWhere: () => ({}),
    withMinecraftContext: <T extends Response>(response: T) => { response.headers.set("X-Minecraft-Context", "legacy@0"); return response; },
    withMinecraftProfileRead: async (work: (context: LegacyContext) => Promise<NextResponse>) => {
      const response = await work(await context());
      if (response.ok) response.headers.set("X-Minecraft-Context", "legacy@0");
      return response;
    },
    withMinecraftProfileFileWrite: async (request: { headers: Headers }, work: (context: LegacyContext) => Promise<NextResponse>, file?: (context: LegacyContext) => Promise<string>) => {
      const snapshot = await context();
      const { withGameFileWrite } = await import("@/lib/operation-response");
      return withGameFileWrite("minecraft", async () => {
        const response = await work(snapshot);
        if (response.ok) response.headers.set("X-Minecraft-Context", "legacy@0");
        return response;
      }, file ? { request, file: () => file(snapshot) } : undefined);
    },
  };
}
