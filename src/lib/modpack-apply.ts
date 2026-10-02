/**
 * **Applying a pack to the server, from the browser — one copy.**
 *
 * There are two places a pack gets applied now: **Change pack** at the top of
 * `/minecraft/mods` (search Modrinth, review, apply) and **Install to Server** on a saved
 * set. The decision about what the response *means* is subtle enough that two copies of it
 * would drift, and this repo's standing example of that is the power control, which reached
 * three copies and two of them missed a fix.
 *
 * Three things the response handling has to get right, each of which was wrong once:
 *
 * - **`res.ok` is not the verdict.** The route answers non-2xx when it could not install
 *   every mod, so the counts have to be read on both paths. Trusting `res.ok` is what
 *   reported *"Installed 0/166 mods"* in a **green** toast for every pack whose rows carry
 *   no download source.
 * - **A body with no counts is not an apply report.** A 403, or a 500 raised outside the
 *   operation, has no `installed`/`total` — and opening the report on it renders
 *   "Installed undefined of undefined mods".
 * - **A request that gave up is not a failed apply.** Up to 166 sequential Modrinth
 *   fetches runs far past Cloudflare's ~100 s origin timeout, so a perfectly successful
 *   166-mod apply ends with the browser's `fetch` rejecting while the work continues on the
 *   server. `modpacks.tsx` substituted `{installed: 0, total: 0}` there, which the report
 *   dialog rendered as a **destructive-red "Installed 0 of 0 mods"** — a failure headline
 *   for an apply that had not failed, on the longest and most expensive runs. That is this
 *   project's named defect class with the sign flipped: reporting a failure that did not
 *   happen costs the same to chase as a real one.
 *
 * So the outcome is a discriminated union and `still-running` is its own case, with no
 * counts in it to render.
 */

/** One mod the installer declined to put on a server, with the signal that decided. */
export interface SkippedModView {
  name: string;
  reason: string;
}

/** Everything the report dialog renders, when the route answered with counts. */
export interface ApplyReportView {
  packName: string;
  installed: number;
  total: number;
  errors: string[];
  warnings: string[];
  /**
   * Mods held back as client-only. Separate from `errors` because a skip is the installer
   * working — a large pack is 30-50% client mods, and listing them among the failures makes
   * every correct apply look broken — and separate from `warnings` because they have names
   * worth one row each.
   */
  skipped: SkippedModView[];
  /** The route's own headline sentence, where it sent one (the 409s do). */
  error?: string;
}

export type ApplyOutcome =
  /** Counts came back and there is something worth showing. */
  | { kind: "report"; report: ApplyReportView }
  /**
   * Counts came back, every mod that belonged on this server is installed, and nothing was
   * skipped, warned about or failed. **Deliberately silent**: the operation's own completion
   * toast already carries the sentence, and a dialog on every success is how a report
   * teaches people to dismiss it unread.
   */
  | { kind: "quiet" }
  /** The response was not an apply report. The message is the route's, never a paraphrase. */
  | { kind: "error"; message: string }
  /**
   * The request gave up before the apply did. **Not a failure, and not reportable as
   * counts** — nothing here knows how far it got.
   */
  | { kind: "still-running"; packName: string };

/**
 * What the route's body means. Pure, so the arithmetic and the shape check are pinned by
 * unit tests rather than by reading a dialog.
 */
export function applyOutcomeOf(packName: string, body: unknown): ApplyOutcome {
  const data = (body ?? {}) as Record<string, unknown>;

  if (typeof data.installed !== "number" || typeof data.total !== "number") {
    return {
      kind: "error",
      message: typeof data.error === "string" ? data.error : "Failed to install modpack",
    };
  }

  const errors = stringList(data.errors);
  const warnings = stringList(data.warnings);
  const skipped = skipList(data.skipped);
  const missing = data.total - data.installed;

  // `skipped.length` opens it too, and that disjunct is load-bearing: a clean apply of a
  // real pack is exactly the case where `missing`, `errors` and `warnings` are all empty
  // and 40 mods were nonetheless held back — so without it the one outcome the client-only
  // filter exists to report becomes the one outcome that reports nothing.
  if (missing > 0 || errors.length > 0 || warnings.length > 0 || skipped.length > 0) {
    return {
      kind: "report",
      report: {
        packName,
        installed: data.installed,
        total: data.total,
        errors,
        warnings,
        skipped,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
      },
    };
  }
  return { kind: "quiet" };
}

/**
 * POST the apply and say what came back.
 *
 * The `catch` is the whole reason this is a function and not an inline `fetch`: a rejected
 * request on this endpoint overwhelmingly means the apply outlived the proxy, not that it
 * failed, and the one thing that must not happen is inventing counts to fill a report with.
 */
export async function applyModpackToServer(args: {
  modpackId: string;
  packName: string;
}): Promise<ApplyOutcome> {
  try {
    const res = await fetch("/api/mods/install-modpack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modpackId: args.modpackId }),
    });
    const body = await res.json().catch(() => ({}));
    return applyOutcomeOf(args.packName, body);
  } catch {
    return { kind: "still-running", packName: args.packName };
  }
}

/**
 * Import a Modrinth pack and apply it, as one action.
 *
 * `/api/mods/install-modpack` takes a `modpackId`, so applying something found on Modrinth
 * is genuinely two writes: create the saved set, then apply it. Kept here beside the apply
 * rather than in the dialog so there is one definition of the order, and so the dialog's
 * copy can honestly say that applying also saves the pack — which it does, and which is why
 * production has nine `Modpack` rows.
 */
export async function importAndApply(args: {
  modrinthId: string;
  packName: string;
}): Promise<ApplyOutcome> {
  let modpackId: string;
  try {
    const res = await fetch("/api/modpacks/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modrinthId: args.modrinthId, name: args.packName }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.id !== "string") {
      return {
        kind: "error",
        message:
          typeof body.error === "string"
            ? body.error
            : `Couldn't read "${args.packName}" from Modrinth, so nothing was changed.`,
      };
    }
    modpackId = body.id;
  } catch {
    // Nothing has been applied — the import is the first write and it never landed. Said
    // explicitly, because "nothing was changed" is the fact that decides whether to retry.
    return {
      kind: "error",
      message: `Couldn't reach the server to read "${args.packName}". Nothing was changed.`,
    };
  }
  return applyModpackToServer({ modpackId, packName: args.packName });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function skipList(value: unknown): SkippedModView[] {
  if (!Array.isArray(value)) return [];
  const out: SkippedModView[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== "string") continue;
    out.push({ name: s.name, reason: typeof s.reason === "string" ? s.reason : "" });
  }
  return out;
}
