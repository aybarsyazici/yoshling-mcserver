import { readOperationResponse, unconfirmedOperationMessage, UnconfirmedOperationResult } from "@/lib/operation-client";
/**
 * Shared pack apply handling. Counts come only from readable origin receipts, on
 * either HTTP path. Gateway/network ambiguity carries no invented counts or
 * execution claim. The legacy `still-running` tag now means result unconfirmed.
 * Known operation IDs stay attached; the shared ledger owns completion feedback.
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

export type ApplyOutcome = (
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
   * No usable apply receipt arrived. Execution and outcome are unknown.
   */
  | { kind: "still-running"; packName: string; operationId?: string }
  | { kind: "unconfirmed-import"; message: string }) & { operationId?: string };

/**
 * What the route's body means. Pure, so the arithmetic and the shape check are pinned by
 * unit tests rather than by reading a dialog.
 */
export function applyOutcomeOf(packName: string, body: unknown): ApplyOutcome {
  const data = (body ?? {}) as Record<string, unknown>;

  if (typeof data.installed !== "number" || typeof data.total !== "number") {
    if (typeof data.operationId === "string" && data.operationId) return { kind: "quiet" };
    return { kind: "error", message: typeof data.error === "string" ? data.error : "Failed to install modpack" };
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

/** POST the apply, retaining origin evidence or an explicitly uncertain result. */
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
    const body = await readOperationResponse(res);
    return { ...applyOutcomeOf(args.packName, body), ...(body.operationId ? { operationId: body.operationId } : {}) };
  } catch (error) {
    return { kind: "still-running", packName: args.packName, ...(error instanceof UnconfirmedOperationResult && error.operationId ? { operationId: error.operationId } : {}) };
  }
}

/**
 * Import a Modrinth pack and apply it, as one action.
 *
 * `/api/mods/install-modpack` takes a `modpackId`, so applying something found on Modrinth
 * is genuinely two writes: create the saved set, then apply it. Kept here beside the apply
 * rather than in the dialog so there is one definition of the order, and so the dialog's
 * copy can say that applying first saves a set. A lost import reply may leave that set
 * persisted; no apply is requested without its saved ID.
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
    const body = await readOperationResponse(res);
    if (res.ok && (typeof body.id !== "string" || !body.id)) return {
      kind: "unconfirmed-import", message: `The saved import receipt for "${args.packName}" is incomplete. No apply was requested; check Saved sets before importing again.`,
    };
    if (!res.ok) {
      return {
        kind: "error",
        message:
          typeof body.error === "string"
            ? body.error
            : `Couldn't confirm the import of "${args.packName}". No apply was requested.`,
      };
    }
    modpackId = body.id as string;
  } catch (error) {
    return { kind: "unconfirmed-import", message: unconfirmedOperationMessage(`import of "${args.packName}"`, error) + " No apply was requested; check Saved sets before importing again." };
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
