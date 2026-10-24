import manifest from "@/data/aion2/gear-priorities.json";
import { aionKnowledgeStatus } from "./aion2-knowledge";
import { validateAionGearPriorities } from "./aion2-gear-validation";
import type { AionEquipment, AionEvidenceSource, AionGearPriority, AionGearPriorityItem, AionGearPriorityReport, AionSnapshot } from "./aion2-types";

type Source = AionEvidenceSource & { id: string; expiresAt: string };
type Priority = AionGearPriority & { aliases?: string[]; when?: { skillId: number; belowLevel: number } };
type SlotRule = { id: string; className: string; slots: number[]; basis: string; mechanic: "soulbinding" | "arcana"; sourceIds: string[]; priorities: Priority[] };
type Pool = { itemId: number; slots: number[]; mechanic: "soulbinding" | "arcana" | "fixed"; capability: "random" | "fixed"; known: boolean; stats: { id: string; label: string; aliases?: string[] }[]; skills: { id: number; label: string }[]; sourceIds: string[] };
type Catalog = { version: string; reviewedAt: string; expiresAt: string; regions: string[]; classes: string[]; sources: Source[]; slotRules: SlotRule[]; itemPools: Pool[] };
const catalog = manifest as Catalog;
const validation = validateAionGearPriorities(catalog);
const label = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const reviewed = (value: { reviewedAt: string; expiresAt: string }, now: number) => Date.parse(value.reviewedAt) <= now && Date.parse(value.expiresAt) > now;

function observed(item: AionEquipment): AionGearPriorityItem["currentLines"] {
  return [...(item.details?.stats ?? []).map((stat) => ({ label: stat.name, value: stat.value, kind: "stat" as const, priorityRank: null })), ...(item.details?.skills ?? []).map((skill) => ({ label: skill.name, value: `+${skill.level}`, kind: "skill" as const, priorityRank: null }))];
}

/** Exact item-pool membership and explicit aliases only. Substring matching would
 * confuse Critical Attack/Damage and Weapon Damage Boost/Damage Boost. */
function statId(stat: NonNullable<AionEquipment["details"]>["stats"][number], pool: Pool): string | undefined {
  const named = pool.stats.filter((entry) => [entry.label, ...(entry.aliases ?? [])].some((name) => label(name) === label(stat.name)));
  const identified = stat.id ? pool.stats.find((entry) => entry.id === stat.id) : undefined;
  if (named.length > 1 || identified && named.length === 1 && named[0].id !== identified.id) return undefined;
  return identified?.id ?? named[0]?.id;
}

/** A scoped comparison, not a reroll instruction or a calculated DPS optimum. */
export function aionGearPriorities(snapshot: AionSnapshot | null, now = new Date()): AionGearPriorityReport {
  const epoch = now.getTime();
  let status: AionGearPriorityReport["status"] = "current";
  let notice = "Reviewed Gladiator PvE keep/compare preferences. Equal ranks are alternatives; listed lines are not a promise that they can all coexist. Confirm the actual item screen before spending.";
  if (validation.length || !Number.isFinite(epoch) || !reviewed(catalog, epoch) || catalog.sources.some((source) => !reviewed(source, epoch)) || aionKnowledgeStatus(now).status !== "current") {
    status = "review-required"; notice = "Gear priorities need a current source review. Observed lines remain visible; ranked guidance is withheld.";
  } else if (!snapshot || !snapshot.coverage.equipment) {
    status = "unverified"; notice = "Current equipped items could not be verified. Refresh the character before comparing gear.";
  } else if (!catalog.regions.includes(snapshot.ref.region) || !catalog.classes.includes(snapshot.profile.className)) {
    status = "unsupported"; notice = "A reviewed gear-priority build is not available for this class or region. No Gladiator list is substituted.";
  } else {
    const age = epoch - Date.parse(snapshot.observedAt);
    if (!Number.isFinite(age) || age > 30 * 60_000 || age < -5 * 60_000) { status = "stale"; notice = "The character observation is too old or has an invalid time. Refresh it before using gear priorities."; }
  }
  const items = (snapshot?.equipment ?? []).map<AionGearPriorityItem>((item) => {
    const rule = catalog.slotRules.find((entry) => entry.className === snapshot?.profile.className && entry.slots.includes(item.slot));
    const pool = catalog.itemPools.find((entry) => entry.itemId === item.id && entry.slots.includes(item.slot));
    const sourceIds = [...new Set([...(rule?.sourceIds ?? []), ...(pool?.sourceIds ?? ["official-armory"])])];
    const sources = sourceIds.flatMap((id) => { const source = catalog.sources.find((entry) => entry.id === id); return source ? [{ title: source.title, url: source.url, kind: source.kind, reviewedAt: source.reviewedAt }] : []; });
    const result: AionGearPriorityItem = { slot: item.slot, slotName: item.slotName, itemId: item.id, itemName: item.name, basis: rule?.basis ?? "This item's fixed or unreviewed lines do not establish a randomized stat preference.", status: "unsupported", priorities: [], currentLines: observed(item), notices: [], sources };
    if (status !== "current") { result.notices.push(notice); return result; }
    const reference = (rule?.priorities ?? []).filter((priority) => {
      if (!priority.when) return true;
      const skill = snapshot?.coverage.skills && snapshot.skills.find((skill) => skill.id === priority.when!.skillId && skill.acquired);
      return !!skill && skill.level < priority.when.belowLevel;
    }).map(({ id, label, kind, rank, reason }) => ({ id, label, kind, rank, reason })).sort((a, b) => a.rank - b.rank);
    if (pool?.capability === "fixed" && item.details?.randomStats === true) {
      result.status = "unverified"; result.notices.push("The observed capability conflicts with the reviewed item metadata. Check this exact item in game; no reroll guidance is shown."); return result;
    }
    if (item.details?.randomStats === false || pool?.capability === "fixed") {
      result.status = "fixed";
      result.notices.push("This item has fixed lines. Do not Sync, Reset or reroll it. Keep the observed lines while comparing a separately reviewed replacement; the generic slot rule is not an editable roll on this item.");
      return result;
    }
    if (!rule) { result.notices.push("No reviewed priority exists for this equipment slot."); return result; }
    if (!pool?.known) {
      result.status = "slot-reference"; result.priorities = reference;
      result.notices.push("This exact item's allowed pool has not been reviewed. The slot reference does not establish that any listed line can roll here. Do not reroll from this list.");
      return result;
    }
    if (pool.mechanic !== rule.mechanic) {
      result.status = "unverified"; result.notices.push("The item mechanic does not match the reviewed slot rule. Check the exact item; no ranked guidance is shown."); return result;
    }
    result.priorities = reference.filter((priority) => priority.kind === "skill" ? pool.skills.some((entry) => String(entry.id) === priority.id) : pool.stats.some((entry) => entry.id === priority.id));
    if (item.details?.randomStats !== true) {
      result.status = "item-pool-reference";
      result.notices.push(pool.mechanic === "arcana"
        ? "This exact Arcana skill pool is reviewed, but current capability and lines were not returned. Compare useful cards only; this is not evidence of Sync/Reset capability and enhancement does not guarantee the desired skill."
        : "This exact item pool is reviewed, but current random/editable capability and lines were not returned. Compare only; confirm the item screen in game before Sync or any spending.");
      result.notices.push("Reference preferences do not establish current rolls, available line counts or affordability. No observed-line priority badges are assigned.");
      return result;
    }
    result.status = "item-pool-verified";
    result.currentLines = [
      ...(item.details.stats ?? []).map((stat) => ({ label: stat.name, value: stat.value, kind: "stat" as const, priorityRank: result.priorities.find((priority) => priority.kind === "stat" && priority.id === statId(stat, pool))?.rank ?? null })),
      ...(item.details.skills ?? []).map((skill) => ({ label: skill.name, value: `+${skill.level}`, kind: "skill" as const, priorityRank: result.priorities.find((priority) => priority.kind === "skill" && priority.id === String(skill.id))?.rank ?? null })),
    ];
    result.notices.push(pool.mechanic === "arcana" ? "Arcana have randomized skill rolls; this does not establish Sync/Reset capability. Compare or keep useful cards. Enhancement does not guarantee another level of the desired skill." : "This exact item has a reviewed potential pool and observed random lines. Keep useful existing rolls; a missing listed line is not an instruction to spend until it appears. Confirm current costs and a spending limit first.");
    result.notices.push("Rank describes the stated community/rarity basis, not a measured damage gain. Available line counts, thresholds and affordability must be checked in game.");
    return result;
  });
  return { version: catalog.version, status, notice, items };
}
