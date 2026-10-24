/** Pure validation shared by runtime, tests and the knowledge maintenance CLI. */
export function validateAionKnowledge(value: unknown): string[] {
  const errors: string[] = [];
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const data = object(value);
  const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const period = (row: Record<string, unknown>, label: string) => {
    if (!date(row.reviewedAt) || !date(row.expiresAt) || row.reviewedAt >= row.expiresAt) errors.push(`${label}: valid reviewedAt < expiresAt dates are required`);
  };
  const text = (v: unknown) => typeof v === "string" && !!v.trim();
  const url = (v: unknown) => { try { return typeof v === "string" && new URL(v).protocol === "https:"; } catch { return false; } };
  const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (data.schemaVersion !== 1 || !text(data.version)) errors.push("Knowledge schemaVersion/version is invalid");
  period(data, "Knowledge");
  const regions = ["eu", "nae", "naw", "la", "as"];
  if (!Array.isArray(data.regions) || !data.regions.length || data.regions.some((v) => !regions.includes(v))) errors.push("Knowledge regions must name supported Global shards");
  if (typeof data.patchFeed !== "string" || !data.patchFeed.startsWith("https://api-global-community.plaync.com/aion2_global/board/update_en/article/")) errors.push("Use the official Global patch feed");
  if (!Array.isArray(data.patches) || !data.patches.length || data.patches.some((v) => { const p = object(v); return typeof p.id !== "string" || !/^[a-f0-9]{24}$/.test(p.id) || typeof p.updatedAt !== "string" || !Number.isFinite(Date.parse(p.updatedAt)) || typeof p.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.bodySha256); })) errors.push("Reviewed patch IDs, timestamps and body hashes are required");
  const sourceIds = new Set<string>();
  if (!Array.isArray(data.sources) || !data.sources.length) errors.push("At least one source is required");
  else for (const value of data.sources) {
    const source = object(value), id = String(source.id ?? "");
    if (!/^[a-z][a-z0-9-]+$/.test(id) || sourceIds.has(id)) errors.push(`Invalid/duplicate source: ${id}`);
    sourceIds.add(id); period(source, `Source ${id}`);
    if (!url(source.url) || !text(source.title) || !["official-data", "official-patch", "community-guide", "client-data"].includes(String(source.kind))) errors.push(`Source ${id}: title, HTTPS URL and evidence kind are required`);
    if (source.fetchUrl !== undefined && (!url(source.fetchUrl) || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256))) errors.push(`Source ${id}: fetchUrl requires a SHA-256 baseline`);
    if (source.hashScope !== undefined && (source.hashScope !== "html-main-v1" || source.fetchUrl !== "https://aion2.gg/database/skills/overhead-slam-11170000")) errors.push(`Source ${id}: hashScope is not reviewed for this exact fetch URL`);
  }
  const ids = new Set<string>();
  const activityIds = new Set<string>();
  if (!Array.isArray(data.activities)) errors.push("Reviewed activities are required");
  else for (const value of data.activities) {
    const activity = object(value), id = String(activity.id ?? ""); period(activity, `Activity ${id}`);
    if (!text(activity.id) || activityIds.has(id) || !text(activity.name) || !positive(activity.minimumLevel) || !positive(activity.minimumGearScore) || !positive(activity.odylePerClaim) || !Array.isArray(activity.sourceIds) || !activity.sourceIds.length || activity.sourceIds.some((id) => !sourceIds.has(id))) errors.push(`Activity ${id}: scope, entry, reward cost and sources are required`);
    activityIds.add(id);
  }
  // Available enhancement headroom is a capability, not an investment strategy.
  const strategies = ["skill-target", "arcana-slots", "starter-guard", "fixed-weapon", "amulet-scrolls", "belt-scrolls"];
  if (!Array.isArray(data.rules) || !data.rules.length) errors.push("At least one reviewed rule is required");
  else for (const value of data.rules) {
    const rule = object(value), id = String(rule.id ?? ""); period(rule, `Rule ${id}`);
    if (!/^[a-z][a-z0-9-]+$/.test(id) || ids.has(id)) errors.push(`Invalid/duplicate rule: ${id}`); ids.add(id);
    if (!strategies.includes(String(rule.strategy)) || !["high", "medium", "low"].includes(String(rule.priority)) || !positive(rule.minimumLevel) || !text(rule.action) || !text(rule.evidence)) errors.push(`Rule ${id}: strategy, priority, level, evidence and action are required`);
    if (!Array.isArray(rule.classes) || rule.classes.some((v) => !text(v))) errors.push(`Rule ${id}: explicit class scope is required (empty means all classes)`);
    if (!Array.isArray(rule.sourceIds) || !rule.sourceIds.length || rule.sourceIds.some((id) => !sourceIds.has(id))) errors.push(`Rule ${id}: every source must exist`);
    if (rule.strategy === "skill-target" && (!positive(rule.target) || !positive(rule.skillId) || !Array.isArray(rule.classes) || !rule.classes.length)) errors.push(`Rule ${id}: skill target needs a skill ID, target and class scope`);
    if (rule.milestones !== undefined && (!Array.isArray(rule.milestones) || !rule.milestones.length || rule.milestones.some((value, index, values) => !positive(value) || Number(value) > Number(rule.target) || index > 0 && Number(value) <= Number(values[index - 1])) || rule.milestones.at(-1) !== rule.target)) errors.push(`Rule ${id}: milestones must increase to the final target`);
    if (rule.strategy === "arcana-slots" && (!positive(rule.target) || !positive(rule.minimumGearScore))) errors.push(`Rule ${id}: Arcana requires an explicit card target and entry assumption`);
    if (["amulet-scrolls", "belt-scrolls"].includes(String(rule.strategy)) && (!Array.isArray(rule.itemIds) || !rule.itemIds.length || rule.itemIds.some((v) => !positive(v)))) errors.push(`Rule ${id}: item-specific scroll advice needs verified item IDs`);
    if (["starter-guard", "fixed-weapon"].includes(String(rule.strategy)) && (!Array.isArray(rule.itemIds) || !rule.itemIds.length || rule.itemIds.some((v) => !positive(v)))) errors.push(`Rule ${id}: replacement advice needs verified source item IDs`);
    if (rule.strategy === "fixed-weapon" && (!Array.isArray(rule.classes) || !rule.classes.length)) errors.push(`Rule ${id}: a weapon-specific recipe needs explicit class scope`);
    if (rule.strategy === "starter-guard" && rule.target !== 10) errors.push(`Rule ${id}: the reviewed temporary guard stopping point is 10`);
    if (rule.steps !== undefined) {
      if (!Array.isArray(rule.steps) || !rule.steps.length) errors.push(`Rule ${id}: a plan needs ordered steps`);
      else for (const entry of rule.steps) {
        const step = object(entry), cost = object(step.cost);
        if (!text(step.id) || !text(step.title) || !text(step.instruction) || !sourceIds.has(String(step.sourceId))) errors.push(`Rule ${id}: every step needs an instruction and known source`);
        if (step.cost !== undefined && (cost.resource !== "odyle" || !positive(cost.amount))) errors.push(`Rule ${id}: invalid step cost`);
        if (step.activityId !== undefined && !activityIds.has(String(step.activityId))) errors.push(`Rule ${id}: unknown activity`);
        if (step.checklistActivityIds !== undefined && (!Array.isArray(step.checklistActivityIds) || !step.checklistActivityIds.length || new Set(step.checklistActivityIds).size !== step.checklistActivityIds.length || step.checklistActivityIds.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]+$/.test(id)))) errors.push(`Rule ${id}: checklist activity references must be unique stable IDs`);
        if (step.when !== undefined && !["boards-incomplete", "transcendence-eligible", "urugugu-eligible", "random-ring", "ring-materials-needed", "below-first-milestone", "at-least-first-milestone", "energy-not-confirmed", "rage-burst-missing", "shattered-pool-missing", "deus-pool-missing", "starter-guard-below-target", "starter-guard-below-cap"].includes(String(step.when))) errors.push(`Rule ${id}: unknown step condition`);
      }
    }
  }
  if (data.boardPresets !== undefined) {
    if (!Array.isArray(data.boardPresets)) errors.push("Board presets must be an array");
    else {
      const presetIds = new Set<string>();
      for (const value of data.boardPresets) {
        const preset = object(value), id = String(preset.id ?? ""); period(preset, `Board preset ${id}`);
        if (!/^[a-z][a-z0-9-]+$/.test(id) || presetIds.has(id)) errors.push(`Invalid/duplicate board preset: ${id}`); presetIds.add(id);
        if (!text(preset.className) || !text(preset.label)) errors.push(`Board preset ${id}: an explicit class and label are required`);
        if (!Array.isArray(preset.boardIds) || !preset.boardIds.length || preset.boardIds.some((boardId) => ![11, 12, 13, 14].includes(boardId)) || new Set(preset.boardIds).size !== preset.boardIds.length) errors.push(`Board preset ${id}: boardIds must explicitly name reviewed whiteboards 11 to 14 without duplicates`);
        if (!Array.isArray(preset.sourceIds) || !preset.sourceIds.length || preset.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) errors.push(`Board preset ${id}: every source must exist`);
        if (!Array.isArray(preset.targets) || !preset.targets.length) errors.push(`Board preset ${id}: reviewed target effects are required`);
        else {
          const effects = new Set<string>();
          for (const entry of preset.targets) {
            const target = object(entry), effect = typeof target.effect === "string" ? target.effect.trim().toLowerCase() : "";
            if (!text(target.effect) || !text(target.reason) || effects.has(effect)) errors.push(`Board preset ${id}: target effects need unique names and reasons`);
            effects.add(effect);
          }
        }
        if (preset.pathModel !== undefined) {
          const model = object(preset.pathModel), costs = object(model.nodeCosts);
          if (model.adjacency !== "orthogonal-grid" || model.startKind !== "Start" || typeof model.sourceId !== "string" || !sourceIds.has(model.sourceId)) errors.push(`Board preset ${id}: pathModel needs the reviewed orthogonal graph, free Start node and known source`);
          const reviewedCosts: Record<string, number> = { Common: 1, Rare: 2, Legend: 3, Epic: 3, Unique: 4 };
          if (costs.Common !== 1 || costs.Rare !== 2 || costs.Legend !== 3 || costs.Unique !== 4 || Object.entries(costs).some(([grade, cost]) => reviewedCosts[grade] !== cost)) errors.push(`Board preset ${id}: pathModel needs reviewed Common 1, Rare 2, Legend/Epic 3 and Unique 4 crystal costs`);
        }
      }
    }
  }
  if (!Array.isArray(data.limitations) || !data.limitations.length || data.limitations.some((v) => !text(v))) errors.push("Knowledge limitations must be explicit");
  return errors;
}

/** Cross-manifest references are checked before either catalog is published. */
export function validateAionChecklistLinks(knowledge: unknown, checklist: unknown): string[] {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const k = object(knowledge), c = object(checklist);
  const ids = new Set(Array.isArray(c.activities) ? c.activities.map(activity => object(activity).id).filter(id => typeof id === "string") : []);
  const errors: string[] = [];
  for (const value of Array.isArray(k.rules) ? k.rules : []) {
    const rule = object(value);
    for (const entry of Array.isArray(rule.steps) ? rule.steps : []) {
      const step = object(entry);
      if (Array.isArray(step.checklistActivityIds) && step.checklistActivityIds.some(id => !ids.has(id))) errors.push(`Rule ${String(rule.id)}: checklist activity does not exist`);
    }
  }
  return errors;
}
