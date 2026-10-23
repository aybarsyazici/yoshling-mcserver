export function validateAionTimers(input: unknown): string[] {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const data = object(input), errors: string[] = [];
  const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const reviewed = (value: Record<string, unknown>) => date(value.reviewedAt) && date(value.expiresAt) && value.reviewedAt < value.expiresAt;
  const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
  const integer = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const numbers = (value: unknown, max: number) => Array.isArray(value) && value.length > 0 && value.every((item) => integer(item, max)) && new Set(value).size === value.length;
  if (data.schemaVersion !== 1 || !text(data.version) || !reviewed(data)) errors.push("Timer schema/version/review dates are invalid");
  if (!Array.isArray(data.regions) || !data.regions.length || data.regions.some((value) => !["eu", "nae", "naw", "la", "as"].includes(value))) errors.push("Timer region scope is invalid");
  const ids = new Set<string>(), pinned = new Set<string>();
  if (!Array.isArray(data.sources) || !data.sources.length) errors.push("Timer sources are required");
  else for (const value of data.sources) {
    const source = object(value); let url = false;
    try { url = typeof source.url === "string" && new URL(source.url).protocol === "https:"; } catch { /* Refuse an invalid source. */ }
    if (!text(source.id) || ids.has(String(source.id)) || !text(source.label) || !url || !reviewed(source)) errors.push("Timer source identity/URL/review is invalid");
    if (source.fetchUrl !== undefined || source.sha256 !== undefined) {
      let fetchUrl = false;
      try { const url = new URL(String(source.fetchUrl)); fetchUrl = url.protocol === "https:" && !url.username && !url.password; } catch { /* Refuse an invalid pin. */ }
      if (!fetchUrl || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) errors.push("Timer source fetch URL/hash is invalid");
      else if (text(source.id)) pinned.add(source.id);
    }
    if (text(source.id)) ids.add(source.id);
  }
  const events = new Set<string>();
  if (!Array.isArray(data.events) || !data.events.length || data.events.length > 40) errors.push("Reviewed timer events are required");
  else for (const value of data.events) {
    const event = object(value), id = String(event.id ?? "");
    if (!text(event.id) || events.has(id) || !text(event.name) || !text(event.description) || !["scheduled", "reset", "manual"].includes(String(event.kind)) || !["high", "medium"].includes(String(event.priority))) errors.push(`Timer ${id}: event identity/type is invalid`);
    events.add(id);
    if (!Array.isArray(event.sourceIds) || !event.sourceIds.length || event.sourceIds.some((id) => !ids.has(id))) errors.push(`Timer ${id}: a reviewed source is required`);
    if (event.kind === "manual") {
      if (event.timeZone !== null || !Array.isArray(event.hours) || event.hours.length || event.entryMinutes !== 0 || event.activityMinutes !== 0) errors.push(`Timer ${id}: an observed boss cannot have an invented fixed schedule`);
      continue;
    }
    if (!Array.isArray(event.sourceIds) || !event.sourceIds.some((id) => pinned.has(id))) errors.push(`Timer ${id}: a stable pinned schedule source is required`);
    let zone = false;
    try { if (typeof event.timeZone === "string") { new Intl.DateTimeFormat("en", { timeZone: event.timeZone }); zone = true; } } catch { /* Unknown IANA zone. */ }
    if (!zone || !numbers(event.hours, 23) || !integer(event.minute, 59) || !numbers(event.weekdays, 6) || !integer(event.entryMinutes, 180) || !integer(event.activityMinutes, 180)) errors.push(`Timer ${id}: time zone, recurrence or window is invalid`);
  }
  return errors;
}
