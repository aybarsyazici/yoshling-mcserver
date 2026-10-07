/** Only typed fields leave an unknown thrown value; keep Node/error-object details. */
export function errorCode(error: unknown): string | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function errorMessage(error: unknown): string | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
