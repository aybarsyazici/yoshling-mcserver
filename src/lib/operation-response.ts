import { NextResponse } from "next/server";
import { ControlBusyError, OperationConflictError } from "@/lib/operations";

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
