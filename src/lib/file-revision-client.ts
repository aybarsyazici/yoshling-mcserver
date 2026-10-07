/** File revisions are opaque validators from successful server reads. */
export function fileRevision(response: Response): string | null {
  const revision = response.headers?.get("X-File-Revision") || response.headers?.get("ETag") || null;
  // A proxy may weaken an ETag after recompressing JSON. The source token is unchanged.
  return revision?.replace(/^W\//, "") ?? null;
}
export function revisionHeaders(revision: string | null): Record<string, string> {
  return revision ? { "X-Expected-File-Revision": revision, "If-Match": revision } : {};
}
