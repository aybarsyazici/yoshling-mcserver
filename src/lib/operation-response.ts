import { NextResponse } from "next/server";
import { assertResourceFree, ControlBusyError, FileWriteInterruptedError, OperationConflictError, runFileWrite } from "@/lib/operations";
import type { GameId } from "@/lib/games";
import { FileRevisionConflictError, withFileRevision, withRevisionRead } from "@/lib/file-revision";

/** The shared409shape for power and file-resource conflicts. */
export function conflictResponse(e: OperationConflictError): NextResponse {
  return NextResponse.json({
    error: e.message,
    conflict: e.conflict,
    resource: e.resource,
    busy: e instanceof ControlBusyError ? e.lock : null,
  }, { status: 409 });
}

/** True for anything the registry refused to admit. */
export function isConflict(e: unknown): e is OperationConflictError {
  return e instanceof OperationConflictError;
}

/** Read-only compatibility check. Short mutations use withGameFileWrite. */
export function fileLaneBusy(game: GameId): NextResponse | null {
  try {
    assertResourceFree(`files:${game}`);
    return null;
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    throw e;
  }
}

/** Reserve a short handler's complete read/write interval and preserve its response. */
export async function withGameFileWrite(game: GameId, fn: () => Promise<NextResponse>, revision?: { request: Pick<Request, "headers">; file: () => Promise<string> }): Promise<NextResponse> {
  try {
    return await runFileWrite(game, () => revision ? withFileRevision(revision.request, revision.file, fn) : fn());
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    if (e instanceof FileWriteInterruptedError) {
      return NextResponse.json({ error: e.message, interrupted: true }, { status: 409 });
    }
    if (e instanceof FileRevisionConflictError) return NextResponse.json({ error: e.message, stale: true }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "File write failed" }, { status: 500 });
  }
}

export async function revisionRead(file: () => Promise<string>, work: () => Promise<NextResponse>): Promise<NextResponse> {
  try { return await withRevisionRead(file, work); }
  catch (e) {
    if (e instanceof FileRevisionConflictError) return NextResponse.json({ error: e.message, stale: true }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "File read failed" }, { status: 500 });
  }
}
