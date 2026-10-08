import { isGameId } from "./games";
import type { OperationView, OperationsPayload } from "./operations-types";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const game = (value: unknown) => typeof value === "string" && isGameId(value);
const optional = (value: unknown, test: (input: unknown) => boolean) => value === undefined || test(value);
const count = (value: unknown) => object(value) && finite(value.done) && value.done >= 0 && optional(value.total, item => finite(item) && item >= 0) && text(value.noun);
const kinds = new Set(["power", "settings", "backup.create", "backup.restore", "backup.delete", "mods.apply", "mods.install", "mods.update", "world.upload", "world.reset", "game.update", "profile.prepare", "profile.adopt", "profile.switch", "profile.delete", "boot"]);
const outcomes = new Set(["ok", "partial", "nothing", "failed", "unverified"]);
const resources = new Set(["power", "files:minecraft", "files:7dtd", "files:zomboid", "auth:whitelist"]);

function operation(value: unknown): value is OperationView {
  if (!object(value) || !text(value.id) || !value.id || !text(value.kind) || !kinds.has(value.kind) ||
      !(value.game === null || game(value.game)) || !text(value.title) || !finite(value.startedAt) || !finite(value.heartbeatAt) ||
      !optional(value.endedAt, finite) || !optional(value.outcome, item => text(item) && outcomes.has(item)) ||
      !optional(value.summary, text) || !optional(value.action, item => text(item) && ["start", "stop", "restart"].includes(item)) ||
      !Array.isArray(value.resources) || !value.resources.every(item => text(item) && resources.has(item)) ||
      typeof value.holdsPower !== "boolean" || value.holdsPower !== value.resources.includes("power") ||
      !(value.startedBy === null || (object(value.startedBy) && text(value.startedBy.name))) ||
      !["preempted", "redacted", "synthetic", "stalled"].every(key => optional(value[key], item => typeof item === "boolean"))) return false;
  if (!Array.isArray(value.facts) || !value.facts.every(fact => object(fact) && text(fact.label) && text(fact.value) &&
      optional(fact.verdict, item => text(item) && ["ok", "warn", "bad"].includes(item)) && optional(fact.game, game))) return false;
  if (!Array.isArray(value.steps) || !value.steps.every(step => object(step) && text(step.id) && !!step.id && text(step.label) &&
      text(step.kind) && ["running", "done", "noop", "failed"].includes(step.kind) && finite(step.at) && optional(step.endedAt, finite) &&
      optional(step.game, game) && optional(step.detail, text) && optional(step.count, count))) return false;
  const progress = value.progress;
  return object(progress) && (progress.kind === "indeterminate" ||
    (progress.kind === "count" && count(progress) && finite(progress.total)) ||
    (progress.kind === "fraction" && finite(progress.percent)));
}

/** Only complete accepted network readings can confirm an explicit reconciliation. */
export function parseOperationsPoll(value: unknown): OperationsPayload | null {
  if (!object(value) || !finite(value.serverNow) || !Array.isArray(value.operations) || !Array.isArray(value.finished) ||
      !value.operations.every(operation) || !value.finished.every(item => operation(item) && finite(item.endedAt) && text(item.outcome) && outcomes.has(item.outcome)) ||
      ![value.operations, value.finished].every(rows => new Set(rows.map(row => row.id)).size === rows.length)) return null;
  return value as unknown as OperationsPayload;
}
