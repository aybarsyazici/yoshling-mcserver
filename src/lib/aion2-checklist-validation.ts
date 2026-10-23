/** Pure schema checks; a valid document still requires a source review. */
export function validateAionChecklistManifest(value: unknown): string[] {
  const errors: string[] = [];
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const text = (item: unknown): item is string => typeof item === "string" && item.trim().length > 0;
  const instant = (item: unknown) => text(item) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item) && Number.isFinite(Date.parse(item));
  const url = (item: unknown) => { try { if (!text(item)) return false; const parsed = new URL(item); return parsed.protocol === "https:" && !parsed.username && !parsed.password; } catch { return false; } };
  if (!record(value)) return ["Checklist manifest must be an object"];
  if (!text(value.version)) errors.push("Checklist version is required");
  if (!instant(value.reviewedAt) || !instant(value.expiresAt) || Date.parse(String(value.expiresAt)) <= Date.parse(String(value.reviewedAt))) errors.push("Checklist review dates must be ordered instants");
  if (!Array.isArray(value.sources) || !value.sources.length) errors.push("Checklist sources are required");
  const sourceIds = new Set<string>();
  for (const source of Array.isArray(value.sources) ? value.sources : []) {
    if (!record(source)) { errors.push("Checklist source must be an object"); continue; }
    if (!text(source.id) || sourceIds.has(source.id)) errors.push("Checklist source IDs must be unique");
    else sourceIds.add(source.id);
    if (!text(source.title) || !url(source.url) || !url(source.fetchUrl) || !instant(source.reviewedAt) || !instant(source.expiresAt) || Date.parse(String(source.expiresAt)) <= Date.parse(String(source.reviewedAt))) errors.push("Checklist source needs a title, credential-free HTTPS URLs and ordered review dates");
    if (!["community-guide", "client-data-interpretation", "community-observation"].includes(String(source.kind))) errors.push("Checklist source kind must identify the reviewed evidence type");
    if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) errors.push("Checklist source needs a SHA-256 pin");
  }
  const references = (refs: unknown) => Array.isArray(refs) && refs.length > 0 && new Set(refs).size === refs.length && refs.every((id) => typeof id === "string" && sourceIds.has(id));
  if (!record(value.resets) || !record(value.resets.eu)) errors.push("Reviewed EU resets are required");
  else {
    const reset = value.resets.eu;
    if (reset.dailyHourUTC !== 7 || reset.weeklyHourUTC !== 7 || reset.weeklyDayUTC !== 3 || !references(reset.sourceIds)) errors.push("Checklist reset must use the reviewed daily 07:00 UTC / Wednesday 07:00 UTC model");
    if (Object.keys(value.resets).some((region) => region !== "eu")) errors.push("Additional region resets need implementation and review");
  }
  if (!Array.isArray(value.activities) || !value.activities.length || value.activities.length > 40) errors.push("Checklist needs 1–40 activities");
  const activityIds = new Set<string>();
  for (const activity of Array.isArray(value.activities) ? value.activities : []) {
    if (!record(activity)) { errors.push("Checklist activity must be an object"); continue; }
    if (!text(activity.id) || !/^[a-z][a-z0-9-]{0,79}$/.test(activity.id) || activityIds.has(activity.id)) errors.push("Checklist activity IDs must be unique stable IDs");
    else activityIds.add(activity.id);
    if (!text(activity.name) || !text(activity.instruction)) errors.push("Checklist activity name and instruction are required");
    if (!Number.isInteger(activity.minimumLevel) || Number(activity.minimumLevel) < 1 || Number(activity.minimumLevel) > 100) errors.push("Checklist activity needs a reviewed minimum level");
    if (activity.cadence !== "daily" && activity.cadence !== "weekly") errors.push("Checklist cadence must be daily or weekly");
    if (activity.scope !== "character" && activity.scope !== "server") errors.push("Checklist scope must be character or server");
    if (!Array.isArray(activity.regions) || activity.regions.length !== 1 || activity.regions[0] !== "eu") errors.push("Checklist activity must be reviewed for EU");
    if (!Array.isArray(activity.rewardTags) || !activity.rewardTags.length || !activity.rewardTags.every(text)) errors.push("Checklist activity reward tags must be nonempty strings");
    if (!references(activity.sourceIds)) errors.push("Checklist activity source references must exist");
  }
  return errors;
}
