import { createHash } from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const semanticHash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");

/** Index only reviewed, authored game facts. Never accept player/account/env input. */
export function aionEvidenceCorpus(knowledge) {
  const chunks = [];
  for (const rule of knowledge.rules) {
    const context = `${rule.classes.length ? rule.classes.join(", ") : "All classes"}. Global PvE. ${rule.id}.`;
    chunks.push({ id: `rule:${rule.id}`, ruleId: rule.id, kind: "rule", classes: rule.classes, sourceIds: rule.sourceIds, text: `${context} ${rule.evidence} ${rule.action}` });
    for (const step of rule.steps ?? []) chunks.push({ id: `step:${rule.id}:${step.id}`, ruleId: rule.id, kind: "step", classes: rule.classes, sourceIds: [step.sourceId], text: `${context} ${step.title}. ${step.instruction} ${step.reason ?? ""}` });
  }
  for (const activity of knowledge.activities) chunks.push({ id: `activity:${activity.id}`, ruleId: null, kind: "activity", classes: [], sourceIds: activity.sourceIds, text: `${activity.name}. Global. Character level ${activity.minimumLevel}, Gear Score ${activity.minimumGearScore}. Each normal reward claim costs ${activity.odylePerClaim} Odyle; energy is not the entry ticket and reward charges must also be available.` });
  for (const preset of knowledge.boardPresets ?? []) for (const target of preset.targets) chunks.push({ id: `board:${preset.id}:${target.effect}`, ruleId: null, kind: "board", classes: [preset.className], sourceIds: preset.sourceIds, text: `${preset.className} PvE Daevanion. ${target.effect}. ${target.reason} Preserve already unlocked nodes and pay for connecting nodes as well as the target.` });
  return chunks.map((chunk) => ({ ...chunk, textHash: semanticHash(chunk.text) }));
}

export function unitVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Embedding shape could not be verified");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || !norm) throw new Error("Embedding norm must be finite and nonzero");
  return vector.map((value) => Math.round(value / norm * 1e7) / 1e7);
}

export function cosine(a, b) {
  if (a.length !== b.length || !a.length) throw new Error("Embedding dimensions differ");
  return Math.max(-1, Math.min(1, a.reduce((total, value, index) => total + value * b[index], 0)));
}

function compatible(a, b) { return !a.classes.length || !b.classes.length || a.classes.some((name) => b.classes.includes(name)); }

export function relatedEvidence(chunks, query, count = 6) {
  return chunks.filter((chunk) => compatible(chunk, query)).map((chunk) => ({ id: chunk.id, score: cosine(chunk.vector, query.vector) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, count);
}

/** Similarity groups are a review aid, never a truth/confidence classification. */
export function evidenceClusters(chunks, threshold = 0.78) {
  const remaining = new Set(chunks.map((_, index) => index)), clusters = [];
  while (remaining.size) {
    const first = remaining.values().next().value, group = [], queue = [first]; remaining.delete(first);
    while (queue.length) {
      const index = queue.shift(); group.push(chunks[index].id);
      for (const candidate of remaining) if ([...chunks[index].classes].sort().join() === [...chunks[candidate].classes].sort().join() && cosine(chunks[index].vector, chunks[candidate].vector) >= threshold) { remaining.delete(candidate); queue.push(candidate); }
    }
    clusters.push({ id: `cluster-${clusters.length + 1}`, chunkIds: group });
  }
  return clusters;
}

export function validSemanticIndex(index, knowledgeDigest, expectedVersion) {
  const strings = (value, empty = true) => Array.isArray(value) && (empty || value.length > 0) && value.length <= 30 && value.every((item) => typeof item === "string" && item.trim() && item.length <= 128) && new Set(value).size === value.length;
  const identifier = (value) => typeof value === "string" && !!value.trim() && value.length <= 256;
  if (!index || index.schemaVersion !== 1 || index.knowledgeDigest !== knowledgeDigest || expectedVersion !== undefined && index.knowledgeVersion !== expectedVersion || !Number.isSafeInteger(index.dimensions) || index.dimensions < 1 || index.dimensions > 4096 || !Array.isArray(index.chunks) || !index.chunks.length || !Array.isArray(index.queries) || !index.queries.length) return false;
  const ids = new Set();
  try {
    for (const chunk of index.chunks) {
      if (!identifier(chunk.id) || ids.has(chunk.id) || typeof chunk.text !== "string" || !chunk.text || chunk.text.length > 12000 || chunk.textHash !== semanticHash(chunk.text) || !strings(chunk.sourceIds, false) || !strings(chunk.classes)) return false;
      unitVector(chunk.vector, index.dimensions); if (Math.abs(Math.hypot(...chunk.vector) - 1) > 0.001) return false; ids.add(chunk.id);
    }
    const queryIds = new Set();
    for (const query of index.queries) {
      unitVector(query.vector, index.dimensions);
      if (!identifier(query.id) || queryIds.has(query.id) || ids.has(query.id) || !identifier(query.ruleId) || !strings(query.classes) || typeof query.text !== "string" || !query.text || query.textHash !== semanticHash(query.text) || Math.abs(Math.hypot(...query.vector) - 1) > 0.001 || !Array.isArray(query.matches) || !query.matches.length || new Set(query.matches.map((match) => match.id)).size !== query.matches.length || query.matches.some((match) => !ids.has(match.id) || !Number.isFinite(match.score) || Math.abs(match.score) > 1)) return false;
      queryIds.add(query.id);
    }
  } catch { return false; }
  return true;
}
