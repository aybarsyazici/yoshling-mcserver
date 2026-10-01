import { NextRequest, NextResponse } from "next/server";
import { gameGate } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { fileLaneBusy } from "@/lib/operation-response";
import { db } from "@/lib/db";
import {
  SandboxStructureError,
  CREATION_ONLY_NOTE,
  VERSION_KEY,
  isCreationOnly,
  isPresetOnly,
  sandboxGroupOf,
  scopeOf,
  type SandboxScope,
} from "@/lib/sandbox-lua";
import { readSandboxOptions, updateSandbox } from "@/lib/zomboid-sandbox";

/**
 * Project Zomboid's sandbox options — `Server/<name>_SandboxVars.lua`.
 *
 * The one real feature gap the settings audit found: the dashboard exposed the ~138
 * keys of the `.ini` and none of the 742 options in this file (counted on production
 * 2026-10-01), so zombie count, speed and strength, loot rarity, XP rate, day length
 * and the water/electricity shutoff were editable only as raw Lua in the file browser.
 *
 * Same request/response shape as `/api/zomboid/config` and `/api/7dtd/config`, so
 * `config-panel.tsx` renders it:
 *
 *   GET  ?scope=world|mods → { properties: [{ name, value, help, group, min, max, choices }] }
 *   PUT                    ← { updates: { name: value } } → { applied: string[] }
 *
 * `group`, `min`, `max` and `choices` are extra fields on each property. The panel
 * itself does not read them — it takes grouping as a `groupOf` prop and dropdowns as
 * `selects`/`loadDynamicSelects`, which is how `zomboid-sandbox.tsx` feeds them back
 * in. They are returned anyway because they are facts about the option that only this
 * route can see, and `min`/`max` are what the PUT refuses on.
 *
 * ## Two things this route will not do
 *
 * - **It never writes `VERSION`.** That is the game's own serialiser version.
 * - **It does not expose the preset keys** `Zombies`, `ZombieRespawn`, `ZombieMigrate`.
 *   Nothing in the game reads them; the simulation reads the advanced `ZombieConfig`
 *   block, which is exposed. The forensics are in `sandbox-lua.ts`. Showing both as
 *   independent controls is how you ship a setting that saves and does nothing.
 */

function parseScope(request: NextRequest): SandboxScope {
  return request.nextUrl.searchParams.get("scope") === "mods" ? "mods" : "world";
}

export async function GET(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;

  // Gated on `settings.read` like the `.ini` panel beside it, though this file holds
  // no secrets of its own (checked on production: no password, token or key in all
  // 742 options). The reason is symmetry, not confidentiality — a MEMBER handed a
  // 742-field form whose Save button 403s is the "unexplained Forbidden" the power
  // buttons already got reported for.
  if (!hasPermission(gate.session.user.role, "settings.read")) {
    // `config-panel.tsx` toasts `data.error` verbatim.
    return NextResponse.json(
      { error: "Changing the world's sandbox options needs the admin or moderator role." },
      { status: 403 }
    );
  }

  const scope = parseScope(request);
  try {
    const options = await readSandboxOptions();
    const properties = options
      .filter((o) => o.name !== VERSION_KEY && !isPresetOnly(o.name) && scopeOf(o) === scope)
      .map((o) => ({
        name: o.name,
        value: o.value,
        help: isCreationOnly(o.name)
          ? [o.help, CREATION_ONLY_NOTE].filter(Boolean).join(" ")
          : o.help,
        group: sandboxGroupOf(o.name),
        ...(o.min !== undefined ? { min: o.min, max: o.max } : {}),
        ...(o.choices ? { choices: o.choices } : {}),
      }));
    return NextResponse.json({ properties, scope });
  } catch {
    return NextResponse.json(
      {
        properties: [],
        warning:
          "Project Zomboid hasn't written its sandbox file yet — start the server once to generate it.",
      },
      { status: 200 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const gate = await gameGate("zomboid");
  if (!gate.ok) return gate.response;
  const session = gate.session;
  if (!hasPermission(session.user.role, "settings.edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Same guard as the .ini writer: a restore holds this world's files for minutes and
  // would overwrite whatever was saved through it while the page toasted "Saved".
  const laneBusy = fileLaneBusy("zomboid");
  if (laneBusy) return laneBusy;

  const body = await request.json().catch(() => null);
  const raw: Record<string, unknown> = body?.updates ?? {};
  const updates: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) updates[name] = String(value);
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No settings provided" }, { status: 400 });
  }

  let outcome;
  try {
    outcome = await updateSandbox(updates);
  } catch (e) {
    // Three different failures used to collapse into one sentence that was false in both
    // halves. `updateSandbox` reads, validates, writes a temp file, renames, and reads back —
    // so a bare catch answered "Couldn't read the sandbox file — start Project Zomboid once
    // first." for an ENOSPC on the temp write, an EXDEV on the rename, or a failed read-back
    // **after the file had already been replaced**, with no activity row. Telling someone to
    // start the server when the real problem is a full disk, and implying nothing was
    // written when it was, is the defect class with the sign flipped.
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return NextResponse.json(
        { error: "There is no sandbox file yet — start Project Zomboid once so it writes one." },
        { status: 404 }
      );
    }
    if (err instanceof SandboxStructureError) {
      // The guard that refuses to rewrite a partial read. Nothing was written.
      return NextResponse.json(
        {
          error:
            `The sandbox file did not look complete, so nothing was written (${err.message}). ` +
            `This usually means the server was rewriting it at that moment — try again.`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error:
          `Saving the sandbox file failed: ${err.message}. The file may be unchanged or ` +
          `partly written — check Server/ in the file browser, and the .bak beside it.`,
      },
      { status: 500 }
    );
  }

  // A refusal means nothing was written, so say what was wrong rather than returning a
  // partial `applied` the panel would have to narrate. `config-panel.tsx` shows
  // `data.error` as-is on a non-2xx and leaves the form's pending edits alone.
  if (outcome.rejected.length > 0) {
    return NextResponse.json(
      {
        error: `Nothing was saved. ${outcome.rejected.map((r) => r.error).join(" ")}`,
        rejected: outcome.rejected,
      },
      { status: 400 }
    );
  }

  // Written, then read back, and the read-back disagreed. That should be impossible —
  // it means something else rewrote the file between the two — so it is a 500 naming
  // the options rather than a success message that happens to be false.
  if (outcome.unlanded.length > 0) {
    return NextResponse.json(
      {
        error: `The file was written but ${outcome.unlanded
          .map((u) => `${u.name} reads back as ${u.found}, not ${u.wanted}`)
          .join("; ")}. Check Server/<name>_SandboxVars.lua before trying again.`,
        applied: outcome.applied,
        unlanded: outcome.unlanded,
      },
      { status: 500 }
    );
  }

  try {
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "edit_file",
        details: JSON.stringify({
          game: "zomboid",
          file: "SandboxVars.lua",
          count: outcome.applied.length,
        }),
      },
    });
  } catch {}

  return NextResponse.json({ success: true, applied: outcome.applied });
}
