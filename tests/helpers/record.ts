import { listFinished, runOperation, type OperationView } from "@/lib/operations";
import type { OpHandle, OpSuccess } from "@/lib/operations";

/**
 * Run an operation to completion and hand back the record the registry concluded.
 *
 * Deliberately driven through the real `runOperation` rather than by calling
 * `concludeOperation`/`summarize` directly (they are module-private, and exporting them
 * for the tests would mean testing a path production does not take). This exercises the
 * actual sequence — the handle, the step settling, the pre-emption fact, the conclusion
 * and the summary — and it needs no Docker, no network and no server, because
 * `operations.ts` imports only `games.ts` and `operations-types.ts`.
 *
 * A thrown operation is caught here: several of the properties under test are about what
 * the registry says when the work FAILED, and `runOperation` rethrows by contract.
 */
export async function record(
  spec: Parameters<typeof runOperation>[0],
  fn: (op: OpHandle) => Promise<OpSuccess<unknown>>
): Promise<OperationView> {
  let id = "";
  try {
    await runOperation(spec, async (op) => {
      id = op.id;
      return fn(op);
    });
  } catch {
    // Expected for the failure cases. The record is what is being asserted on.
  }
  const found = listFinished().find((r) => r.id === id);
  if (!found) throw new Error(`no finished record for ${id || "an operation that never started"}`);
  return found;
}

/** `{ value: … }` with nothing else — the shape a clean callback returns. */
export const done: OpSuccess<null> = { value: null };
