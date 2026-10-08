import type { MinecraftProfileOverviewDTO } from "@/lib/minecraft-profile-overview-types";
export const overviewHash = "a".repeat(64);
export const overviewFixture = (id = "p1", over: Partial<MinecraftProfileOverviewDTO> = {}): MinecraftProfileOverviewDTO => ({
  state: "ready", imageUrl: `/api/minecraft/profiles/${id}/overview/image?revision=${overviewHash}`, revision: overviewHash,
  generatedAt: "2026-10-09T12:00:00Z", snapshotAt: "2026-10-09T11:55:00Z", sourceSavedAt: "2026-10-09T11:50:00Z",
  operationId: null, reason: null, dimension: "overworld", renderer: { name: "Fixture renderer", version: "1.0" },
  source: { kind: "saved-copy", id: "fixture-copy", sha256: "b".repeat(64) }, ...over,
});
export const waitingOverview = (over: Partial<MinecraftProfileOverviewDTO> = {}): MinecraftProfileOverviewDTO => ({ state: "waiting", imageUrl: null, revision: null, generatedAt: null, snapshotAt: null, sourceSavedAt: null, operationId: null, reason: "No saved chunks yet. Waiting for the first world save.", dimension: "overworld", renderer: null, source: null, ...over });
