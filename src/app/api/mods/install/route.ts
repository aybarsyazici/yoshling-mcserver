import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { installMod, serverSideFor } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import { CLIENT_ONLY_CONSEQUENCE } from "@/lib/mod-admission";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { runOperation } from "@/lib/operations";
import { refuseIfPreemptedEarly } from "@/lib/backup-archive";
import { db } from "@/lib/db";
import { getModsDir } from "@/lib/server-manager";
import { verifyRequiredDependencies } from "@/lib/mod-dependencies";
import { requireMinecraftProfileContext, assertMinecraftProfileCurrent, minecraftInventoryWhere, MinecraftActiveProfileError } from "@/lib/minecraft-active-profile";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "mods.install")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  const { modrinthId, slug, name, versionId, allowClientOnly } = body as Record<string, unknown>;
  if (typeof modrinthId !== "string" || !modrinthId || typeof slug !== "string" || !slug ||
      typeof name !== "string" || !name ||
      (versionId !== undefined && versionId !== null && (typeof versionId !== "string" || !versionId))) {
    return NextResponse.json({ error: "Missing or invalid required fields" }, { status: 400 });
  }

  let operationId: string | undefined;
  try {
    const context = await requireMinecraftProfileContext(request);
    return await runOperation<NextResponse>({
      kind: "mods.install", game: "minecraft", resources: ["files:minecraft"],
      title: `Installing ${name}`, startedBy: session.user.name ? { name: session.user.name } : null,
    }, async (op) => {
      operationId = op.id;
      await assertMinecraftProfileCurrent(context);
      op.step("Checking the mod and its required dependencies");
      const serverConfig = await db.serverConfig.findUnique({ where: { id: "main" } });
      refuseIfPreemptedEarly(op, "the mod install");
      if (!serverConfig) throw new Error("Server not configured");

      const versions = await getProjectVersions(modrinthId, {
        loaders: [serverConfig.modLoader], game_versions: [serverConfig.mcVersion],
      });
      refuseIfPreemptedEarly(op, "the mod install");
      const selectedVersion = versionId ? versions.find((version) => version.id === versionId) : versions[0];
      if (!selectedVersion) {
        const message = `No compatible version found for Minecraft ${serverConfig.mcVersion} with ${serverConfig.modLoader}. Ask an Admin to change the server version, or choose a different mod version.`;
        op.reject(message);
        return { value: NextResponse.json({
          operationId: op.id, error: "incompatible", message, serverVersion: serverConfig.mcVersion, serverLoader: serverConfig.modLoader,
        }, { status: 409 }) };
      }

      const existing = await db.installedMod.findFirst({ where: { modrinthId, ...minecraftInventoryWhere(context) } });
      refuseIfPreemptedEarly(op, "the mod install");
      if (existing) {
        op.reject("Mod is already installed");
        return { value: NextResponse.json({ operationId: op.id, error: "Mod is already installed", installed: existing }, { status: 409 }) };
      }

      // Preserve the shared side decision and its explicit client-only override.
      const side = await serverSideFor(selectedVersion, modrinthId);
      refuseIfPreemptedEarly(op, "the mod install");
      if (!side.install && allowClientOnly !== true) {
        const refusal = `${name} is ${side.reason}, and ${CLIENT_ONLY_CONSEQUENCE}. Nothing was installed.`;
        op.reject(refusal);
        return { value: NextResponse.json({
          operationId: op.id, error: "client-only", message: `${refusal} Send allowClientOnly to install it anyway.`,
          refusal, serverSide: side.declared, decidedBy: side.basis,
        }, { status: 409 }) };
      }

      const needsPreflight = !Array.isArray(selectedVersion.dependencies) || selectedVersion.dependencies.some(
        (dependency) => !dependency || dependency.dependency_type === "required" ||
          !["optional", "incompatible", "embedded"].includes(dependency.dependency_type)
      );
      const installed = needsPreflight ? await db.installedMod.findMany({
        where: minecraftInventoryWhere(context),
        select: { modrinthId: true, name: true, fileName: true, versionId: true },
      }) : [];
      refuseIfPreemptedEarly(op, "the mod install");
      const dependencies = needsPreflight ? await verifyRequiredDependencies({
        version: selectedVersion, mcVersion: serverConfig.mcVersion, loader: serverConfig.modLoader,
        modsDir: await getModsDir(), boundaryRoot: context.root, installed,
      }) : { checked: [], issues: [] };
      refuseIfPreemptedEarly(op, "the mod install");
      if (dependencies.issues.length) {
        const named = dependencies.issues.map((issue) => `${issue.name}: ${issue.reason}`).join(" ");
        const message = `Required dependencies could not be verified. ${named} Nothing was installed.`;
        op.reject(message);
        return { value: NextResponse.json({ operationId: op.id, error: "dependency-preflight", message, dependencies: dependencies.issues }, { status: 409 }) };
      }
      op.settle("Checked the mod and required dependencies");
      op.fact({ label: "Dependencies", value: dependencies.checked.length ? `${dependencies.checked.length} verified` : "none required" });

      op.step(`Downloading and writing ${name}`);
      const check = await installMod({
        modrinthId, slug, name, version: selectedVersion, userId: session.user.id, source: "manual",
        // Synchronous, after final path admission and directly before publication.
        beforeWrite: () => refuseIfPreemptedEarly(op, "the mod install"),
      });
      op.settle(`Wrote and read back ${name}`, { count: { done: 1, total: 1, noun: "mod" } });
      op.fact({ label: "Installed", value: `${name} ${selectedVersion.version_number}` });
      op.fact({ label: "Integrity", value: check.checked ?? "No published checksum", ...(check.checked === null ? { verdict: "warn" as const } : {}) });

      return { value: NextResponse.json({
        operationId: op.id, success: true, verified: check.checked, dependencies: dependencies.checked,
        message: `Mod installed` +
          (check.checked === null ? ` (no checksum was published, so it could not be verified)` : ``) +
          `. Restart server to activate.` +
          (!side.install ? ` It is client-only — ${CLIENT_ONLY_CONSEQUENCE}.` : ``),
      }) };
    });
  } catch (error) {
    if (isConflict(error)) return conflictResponse(error);
    return NextResponse.json({ ...(operationId ? { operationId } : {}), error: error instanceof Error ? error.message : "Mod install failed" }, { status: error instanceof MinecraftActiveProfileError ? 409 : 500 });
  }
}
