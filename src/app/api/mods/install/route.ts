import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { installMod, serverSideFor } from "@/lib/mod-manager";
import { getProjectVersions } from "@/lib/modrinth";
import { CLIENT_ONLY_CONSEQUENCE } from "@/lib/mod-admission";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "minecraft");
  if (denied) return denied;

  if (!hasPermission(session.user.role, "mods.install")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Refuse while an operation holds this world's files.
  //
  // `mods.apply` deletes **every** installed jar and then downloads its replacements, and
  // it holds `files:minecraft` for the whole of that. Without this check a single-mod
  // install could land a jar in the middle of that window: it is not in the apply's plan,
  // so it survives the wipe and then loads alongside the pack — the "a jar that survives
  // this loads alongside the new pack" case `install-modpack` already names, reached from
  // the other side. The install is sub-second and needs no record of its own; it needs the
  // lane. Same `fileLaneBusy` the config/settings writers use.
  const laneBusy = fileLaneBusy("minecraft");
  if (laneBusy) return laneBusy;

  const body = await request.json();
  const { modrinthId, slug, name, versionId, allowClientOnly } = body;

  if (!modrinthId || !slug || !name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const serverConfig = await db.serverConfig.findUnique({
    where: { id: "main" },
  });

  if (!serverConfig) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const versions = await getProjectVersions(modrinthId, {
    loaders: [serverConfig.modLoader],
    game_versions: [serverConfig.mcVersion],
  });

  const selectedVersion = versionId
    ? versions.find((v) => v.id === versionId)
    : versions[0];

  if (!selectedVersion) {
    return NextResponse.json(
      {
        error: "incompatible",
        message: `No compatible version found for Minecraft ${serverConfig.mcVersion} with ${serverConfig.modLoader}. Ask an Admin to change the server version, or choose a different mod version.`,
        serverVersion: serverConfig.mcVersion,
        serverLoader: serverConfig.modLoader,
      },
      { status: 409 }
    );
  }

  const existing = await db.installedMod.findFirst({
    where: { modrinthId },
  });

  if (existing) {
    return NextResponse.json(
      { error: "Mod is already installed", installed: existing },
      { status: 409 }
    );
  }

  // The same client/server filter the modpack installer runs, through the same helper —
  // one decision, so the single-mod and the 166-mod path can never disagree about the
  // same jar. (This comment used to say the route had **no UI caller**, which was true and
  // was the argument for hardening it anyway. It has one since 2026-10-02: the Install
  // button on every search result in `mod-card.tsx`, with the 409 below rendered as a named
  // dialog. See `docs/MINECRAFT.md`.)
  //
  // A refusal rather than a warning, because the consequence is not cosmetic: a jar with
  // no server entrypoint can abort Fabric Loader, and the symptom is a container stuck in
  // "Starting…" with the cause nowhere on screen. `allowClientOnly` is the way through,
  // which exists for the same reason the version guard's confirm does — a refusal with no
  // exit is just a control that is broken in a new way.
  const side = await serverSideFor(selectedVersion, modrinthId);
  if (!side.install && !allowClientOnly) {
    // `refusal` is `message` without the "send allowClientOnly" instruction, and it exists
    // so the dialog that offers the override can state the consequence **verbatim** instead
    // of writing its own copy of it. `CLIENT_ONLY_CONSEQUENCE` cannot be imported into a
    // client component — `mod-admission.ts` pulls in `node:crypto` — so the alternative was
    // a second hand-written sentence in `mod-card.tsx`, which is exactly the drift that
    // constant was created to end (this route used to contradict itself about what a
    // client-only jar does). One sentence, composed here, rendered there.
    const refusal =
      `${name} is ${side.reason}, and ${CLIENT_ONLY_CONSEQUENCE}. Nothing was installed.`;
    return NextResponse.json(
      {
        error: "client-only",
        message: `${refusal} Send allowClientOnly to install it anyway.`,
        refusal,
        serverSide: side.declared,
        decidedBy: side.basis,
      },
      { status: 409 }
    );
  }

  // `installMod` verifies the download against Modrinth's sha512 before it writes, and
  // returns which hash it compared. `checked: null` means nothing was published to
  // compare against, so the response says "not verified" rather than implying it was —
  // the alternative is the success-after-doing-the-wrong-thing shape this repo keeps
  // paying for.
  const check = await installMod({
    modrinthId,
    slug,
    name,
    version: selectedVersion,
    userId: session.user.id,
  });

  return NextResponse.json({
    success: true,
    verified: check.checked,
    message:
      `Mod installed` +
      (check.checked === null ? ` (no checksum was published, so it could not be verified)` : ``) +
      `. Restart server to activate.` +
      // The same sentence the 409 above uses, from the same constant — not a softer
      // paraphrase. This used to read "it will not do anything on a server", which the
      // refusal in this very file contradicted. See `CLIENT_ONLY_CONSEQUENCE`.
      (!side.install ? ` It is client-only — ${CLIENT_ONLY_CONSEQUENCE}.` : ``),
  });
}
