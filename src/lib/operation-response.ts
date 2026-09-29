import { NextResponse } from "next/server";
import { assertResourceFree, ControlBusyError, OperationConflictError } from "@/lib/operations";
import type { GameId } from "@/lib/games";

/**
 * The one 409 body, replacing four hand-written variants that all worded it
 * differently.
 *
 * `busy` stays present for *power* conflicts so the existing `data.busy` readers keep
 * working; `conflict` is what a file-lane conflict carries, since there is no
 * truthful `ControlLock` verb for "creating a backup".
 */
export function conflictResponse(e: OperationConflictError): NextResponse {
  return NextResponse.json(
    {
      error: e.message,
      conflict: e.conflict,
      resource: e.resource,
      busy: e instanceof ControlBusyError ? e.lock : null,
    },
    { status: 409 }
  );
}

/** True for anything the registry refused to admit. Catch this, not `ControlBusyError`. */
export function isConflict(e: unknown): e is OperationConflictError {
  return e instanceof OperationConflictError;
}

/**
 * The 409 for a short write that would land on files an operation already holds, or
 * `null` to go ahead. For the config/settings writers, which have no record of their own.
 *
 * Returns rather than throws because these routes have no `catch` to land in: they are
 * straight-line handlers, and a thrown conflict would surface as a 500 with a message
 * about a lane nobody asked about.
 */
export function fileLaneBusy(game: GameId): NextResponse | null {
  try {
    assertResourceFree(`files:${game}`);
    return null;
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    throw e;
  }
}
