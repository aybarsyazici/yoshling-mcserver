import type { AionEquipment, AionGearPriorityReport } from "./aion2-types";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 2000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const uniqueStrings = (value: unknown, empty = false): value is string[] => Array.isArray(value) && (empty || value.length > 0) && value.length <= 100 && value.every((item) => text(item, 200)) && new Set(value).size === value.length;
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const approvedHosts = ["docs.google.com", "aion2.plaync.com", "aion2.gg", "aion2data.com", "api-global-community.plaync.com"];
function sourceUrl(value: unknown): value is string {
  try { if (typeof value !== "string") return false; const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && approvedHosts.includes(url.hostname); } catch { return false; }
}

/** Pure manifest checks shared by the CLI/runtime. Shape is not strategy proof. */
export function validateAionGearPriorities(input: unknown): string[] {
  if (!object(input)) return ["Gear priorities must be an object"];
  const errors: string[] = [];
  const period = (value: Record<string, unknown>, label: string) => { if (!date(value.reviewedAt) || !date(value.expiresAt) || value.reviewedAt >= value.expiresAt) errors.push(`${label}: ordered review dates are required`); };
  if (input.schemaVersion !== 1 || !text(input.version, 100)) errors.push("Gear priority version is invalid");
  period(input, "Gear priorities");
  if (!uniqueStrings(input.regions) || input.regions.some((region) => !["eu", "nae", "naw", "la", "as"].includes(region))) errors.push("Gear priority regions must be explicit supported Global shards");
  const supportedClasses = ["Gladiator", "Cleric"];
  if (!uniqueStrings(input.classes) || input.classes.some(className => !supportedClasses.includes(className))) errors.push("Gear priorities must explicitly name reviewed Gladiator or Cleric classes");
  const classDeclared = (value: unknown) => typeof value === "string" && Array.isArray(input.classes) && input.classes.includes(value) && supportedClasses.includes(value);
  const sources = new Set<string>();
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 100) errors.push("Gear priority sources are required");
  for (const source of Array.isArray(input.sources) ? input.sources : []) {
    if (!object(source)) { errors.push("Gear source must be an object"); continue; }
    if (!text(source.id, 100) || sources.has(source.id)) errors.push("Gear source IDs must be unique"); else sources.add(source.id);
    period(source, `Gear source ${String(source.id)}`);
    if (!text(source.title, 300) || !sourceUrl(source.url) || !["official-data", "official-patch", "community-guide", "client-data"].includes(String(source.kind))) errors.push("Gear source needs a title, approved HTTPS URL and evidence kind");
    if (source.fetchUrl !== undefined && (!sourceUrl(source.fetchUrl) || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256))) errors.push("Gear source fetch URL needs an approved origin and SHA-256 pin");
  }
  const references = (value: unknown) => uniqueStrings(value) && value.every((id) => sources.has(id));
  const slots = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every((slot) => positive(slot) && slot <= 1000) && new Set(value).size === value.length;
  const ruleIds = new Set<string>(), usedSlots = new Set<string>();
  if (!Array.isArray(input.slotRules) || !input.slotRules.length || input.slotRules.length > 50) errors.push("Reviewed slot rules are required");
  for (const rule of Array.isArray(input.slotRules) ? input.slotRules : []) {
    if (!object(rule)) { errors.push("Gear slot rule must be an object"); continue; }
    if (!text(rule.id, 100) || ruleIds.has(rule.id)) errors.push("Gear slot rule IDs must be unique"); else ruleIds.add(rule.id);
    if (!classDeclared(rule.className) || !slots(rule.slots) || !text(rule.basis) || !["soulbinding", "arcana"].includes(String(rule.mechanic)) || !references(rule.sourceIds)) errors.push("Gear slot rules need explicit class, slots, basis, mechanic and known sources");
    for (const slot of Array.isArray(rule.slots) ? rule.slots : []) { const key = `${String(rule.className)}:${slot}`; if (usedSlots.has(key)) errors.push("Gear slot rules cannot overlap for one class"); usedSlots.add(key); }
    const priorityIds = new Set<string>();
    if (!Array.isArray(rule.priorities) || !rule.priorities.length || rule.priorities.length > 60) errors.push("A gear slot rule needs reviewed priorities");
    for (const priority of Array.isArray(rule.priorities) ? rule.priorities : []) {
      if (!object(priority)) { errors.push("Gear priority must be an object"); continue; }
      const identity = `${String(priority.kind)}:${String(priority.id)}`;
      if (!text(priority.id, 100) || priorityIds.has(identity) || !["stat", "skill"].includes(String(priority.kind)) || !text(priority.label, 200) || !positive(priority.rank) || priority.rank > 50 || !text(priority.reason)) errors.push("Gear priorities need unique IDs, ordered ranks and reasons");
      priorityIds.add(identity);
      if (priority.kind === "skill" && (typeof priority.id !== "string" || !/^[1-9]\d*$/.test(priority.id))) errors.push("Gear skill priorities need exact decimal skill IDs");
      if (priority.focus !== undefined && (priority.kind !== "skill" || !["group", "solo"].includes(String(priority.focus)))) errors.push("Gear skill priority focus must be group or solo; common stats have no focus");
      if (priority.aliases !== undefined && !uniqueStrings(priority.aliases, true)) errors.push("Gear stat aliases must be explicit unique labels");
      if (priority.when !== undefined && (!object(priority.when) || !positive(priority.when.skillId) || !positive(priority.when.belowLevel) || priority.when.belowLevel > 100)) errors.push("Gear priority conditions need a verified skill and level milestone");
    }
  }
  const itemScopes = new Set<string>();
  if (!Array.isArray(input.itemPools) || !input.itemPools.length || input.itemPools.length > 200) errors.push("Reviewed item pools are required");
  for (const pool of Array.isArray(input.itemPools) ? input.itemPools : []) {
    if (!object(pool)) { errors.push("Gear item pool must be an object"); continue; }
    if (!positive(pool.itemId)) errors.push("Gear item pool IDs must be exact positive item IDs");
    const classes = pool.classes === undefined ? ["Gladiator"] : pool.classes;
    if (!uniqueStrings(classes) || classes.some(className => !classDeclared(className))) errors.push("Gear item pools require declared classes; legacy pools are Gladiator only");
    for (const className of Array.isArray(classes) ? classes : []) for (const slot of Array.isArray(pool.slots) ? pool.slots : []) {
      const key = `${String(className)}:${String(pool.itemId)}:${String(slot)}`;
      if (itemScopes.has(key)) errors.push("Gear item pools cannot overlap for the same class, exact item and slot"); itemScopes.add(key);
    }
    if (!slots(pool.slots) || !["soulbinding", "arcana", "fixed"].includes(String(pool.mechanic)) || !["random", "fixed"].includes(String(pool.capability)) || typeof pool.known !== "boolean" || !references(pool.sourceIds)) errors.push("Gear item pools need explicit slots, capability, mechanic, known state and sources");
    if ((pool.mechanic === "fixed") !== (pool.capability === "fixed")) errors.push("Fixed item capability must match its fixed mechanic");
    const statIds = new Set<string>(), skillIds = new Set<number>();
    if (!Array.isArray(pool.stats) || pool.stats.length > 100 || !Array.isArray(pool.skills) || pool.skills.length > 100) errors.push("Gear item pool lines must be bounded arrays");
    for (const stat of Array.isArray(pool.stats) ? pool.stats : []) {
      if (!object(stat) || !text(stat.id, 100) || statIds.has(stat.id) || !text(stat.label, 200) || stat.aliases !== undefined && !uniqueStrings(stat.aliases, true)) errors.push("Gear item stat pools need unique IDs and exact labels");
      if (object(stat) && typeof stat.id === "string") statIds.add(stat.id);
    }
    for (const skill of Array.isArray(pool.skills) ? pool.skills : []) {
      if (!object(skill) || !positive(skill.id) || skillIds.has(skill.id) || !text(skill.label, 200)) errors.push("Gear item skill pools need unique numeric IDs and labels");
      if (object(skill) && typeof skill.id === "number") skillIds.add(skill.id);
    }
  }
  return errors;
}

/** Validate the complete projection, including its canonical item/slot identity. */
export function isAionGearPriorityReport(value: unknown, equipment: Pick<AionEquipment, "id" | "slot">[]): value is AionGearPriorityReport {
  if (!object(value) || !text(value.version, 100) || !["current", "review-required", "stale", "unsupported", "unverified"].includes(String(value.status)) || !text(value.notice) || !Array.isArray(value.items) || value.items.length > 100) return false;
  const identities = new Set<string>();
  for (const row of value.items) {
    if (!object(row) || !positive(row.slot) || !positive(row.itemId) || !text(row.slotName, 100) || !text(row.itemName, 300) || !text(row.basis) || !["fixed", "item-pool-verified", "item-pool-reference", "slot-reference", "unverified", "unsupported"].includes(String(row.status))) return false;
    const key = `${row.slot}:${row.itemId}`;
    if (identities.has(key) || !equipment.some((item) => item.slot === row.slot && item.id === row.itemId)) return false; identities.add(key);
    if (!Array.isArray(row.priorities) || row.priorities.length > 60 || !Array.isArray(row.currentLines) || row.currentLines.length > 100 || !Array.isArray(row.notices) || !row.notices.every((notice) => text(notice)) || !Array.isArray(row.sources) || row.sources.length > 30) return false;
    let lastRank = 0; const priorityIds = new Set<string>();
    for (const priority of row.priorities) {
      if (!object(priority) || !text(priority.id, 100) || !text(priority.label, 200) || !["stat", "skill"].includes(String(priority.kind)) || !positive(priority.rank) || priority.rank < lastRank || priority.rank > 50 || !text(priority.reason)) return false;
      if (priority.focus !== undefined && (priority.kind !== "skill" || !["group", "solo"].includes(String(priority.focus)))) return false;
      const id = `${priority.kind}:${priority.id}`; if (priorityIds.has(id)) return false; priorityIds.add(id); lastRank = priority.rank;
    }
    for (const line of row.currentLines) if (!object(line) || !text(line.label, 200) || typeof line.value !== "string" || line.value.length > 300 || !["stat", "skill"].includes(String(line.kind)) || !(line.priorityRank === null || positive(line.priorityRank) && row.status === "item-pool-verified" && value.status === "current" && row.priorities.some((priority) => object(priority) && priority.rank === line.priorityRank))) return false;
    if (row.sources.some((source) => !object(source) || !text(source.title, 300) || !sourceUrl(source.url) || !["official-data", "official-patch", "community-guide", "client-data"].includes(String(source.kind)) || typeof source.reviewedAt !== "string" || !Number.isFinite(Date.parse(source.reviewedAt)))) return false;
    if (value.status !== "current" && row.priorities.length) return false;
    if (["fixed", "unsupported", "unverified"].includes(String(row.status)) && row.priorities.length) return false;
  }
  return true;
}
