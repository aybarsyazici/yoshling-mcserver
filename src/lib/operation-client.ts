/** A proxy response cannot prove whether admitted work finished on the origin. */
export interface OperationReceipt {
  operationId?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}
export class UnconfirmedOperationResult extends Error {
  constructor(readonly operationId?: string) { super("The operation result is unconfirmed"); }
}
export async function readOperationResponse(res: Response): Promise<OperationReceipt> {
  const headerId = res.headers?.get("X-Operation-Id") || undefined;
  let raw: unknown;
  try { raw = await res.json(); } catch { throw new UnconfirmedOperationResult(headerId); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UnconfirmedOperationResult(headerId);
  const body = raw as OperationReceipt;
  const operationId = typeof body.operationId === "string" && body.operationId.trim() ? body.operationId : headerId;
  if ([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527].includes(res.status) && !operationId) {
    throw new UnconfirmedOperationResult();
  }
  return { ...body, error: typeof body.error === "string" ? body.error : undefined,
    message: typeof body.message === "string" ? body.message : undefined, ...(operationId ? { operationId } : {}) };
}
export function unconfirmedOperationMessage(label: string, error?: unknown): string {
  const id = error instanceof UnconfirmedOperationResult ? error.operationId : undefined;
  return `The ${label} result is unconfirmed.${id ? ` Operation ${id}.` : ""} The work may still be running. Check the operation strip before retrying.`;
}
