/** Client-safe generated covers. Custom covers and numeric profile revisions are independent. */
export type MinecraftProfileOverviewState = "waiting" | "queued" | "rendering" | "ready" | "stale" | "failed" | "unsupported" | "unverified";
export interface MinecraftProfileOverviewSource {
  kind: "saved-copy" | "checkpoint" | "backup";
  id: string;
  sha256: string;
}
export interface MinecraftProfileOverviewDTO {
  state: MinecraftProfileOverviewState;
  imageUrl: string | null;
  /** SHA-256 of the published PNG; unrelated to MinecraftProfile.revision. */
  revision: string | null;
  generatedAt: string | null;
  snapshotAt: string | null;
  sourceSavedAt: string | null;
  operationId: string | null;
  reason: string | null;
  dimension: "overworld";
  renderer: { name: string; version: string } | null;
  source: MinecraftProfileOverviewSource | null;
}
export interface MinecraftProfileOverviewRequestReceipt {
  profileId: string;
  jobId: string | null;
  operationId: string;
  overview: MinecraftProfileOverviewDTO;
}
