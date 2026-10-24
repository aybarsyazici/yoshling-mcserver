import { aionKnowledge, aionKnowledgeStatus } from "./aion2-knowledge";
import type { AionBoardComparison, AionBoardNode, AionSnapshot } from "./aion2-types";
import { aionWhiteBoardIds } from "./aion2-knowledge-validation";

type BoardTarget = { effect: string; reason: string };
type PathModel = {
  adjacency: "orthogonal-grid";
  nodeCosts: Record<string, number>;
  startKind: "Start";
  sourceId: string;
};
type BoardPreset = {
  id: string; className: string; label: string; sourceIds: string[];
  focus?: "group" | "solo";
  reviewedAt: string; expiresAt: string; boardIds: number[]; targets: BoardTarget[]; pathModel?: PathModel;
};
type Source = { id: string; url: string; reviewedAt: string; expiresAt: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function reviewed(value: { reviewedAt?: unknown; expiresAt?: unknown }, now: number): boolean {
  if (typeof value.reviewedAt !== "string" || typeof value.expiresAt !== "string") return false;
  const start = Date.parse(`${value.reviewedAt}T00:00:00Z`), end = Date.parse(`${value.expiresAt}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now && start < end;
}

function preset(value: unknown, now: number): BoardPreset | null {
  const data = record(value);
  if (data.focus !== undefined && data.focus !== "group" && data.focus !== "solo") return null;
  if (typeof data.id !== "string" || typeof data.className !== "string" || typeof data.label !== "string" || !Array.isArray(data.sourceIds) || !data.sourceIds.length || data.sourceIds.some((id) => typeof id !== "string") || !reviewed(data, now) || !Array.isArray(data.targets) || !data.targets.length || !Array.isArray(data.boardIds) || !data.boardIds.length || data.boardIds.some((id) => !aionWhiteBoardIds(data.className as string).includes(id)) || new Set(data.boardIds).size !== data.boardIds.length) return null;
  if (data.targets.some((value) => { const target = record(value); return typeof target.effect !== "string" || !target.effect.trim() || typeof target.reason !== "string" || !target.reason.trim(); })) return null;
  return data as unknown as BoardPreset;
}

function matches(node: AionBoardNode, target: BoardTarget): boolean {
  const effect = target.effect.trim().toLowerCase();
  return node.name.trim().toLowerCase() === effect || node.effects.some((value) => value.trim().toLowerCase().startsWith(`${effect} +`));
}

type Graph = { nodes: Map<number, AionBoardNode>; neighbors: Map<number, number[]>; costs: Map<number, number>; roots: Set<number> };

/** Only the explicitly reviewed model can turn coordinates into links and costs. */
function graph(nodes: AionBoardNode[], candidate: unknown, sources: Source[], now: number): Graph | null {
  const model = record(candidate), prices = record(model.nodeCosts);
  if (model.adjacency !== "orthogonal-grid" || model.startKind !== "Start" || typeof model.sourceId !== "string" || !sources.some((source) => source.id === model.sourceId && reviewed(source, now))) return null;
  const active = nodes.filter((node) => node.kind !== "None"), nodeMap = new Map<number, AionBoardNode>(), positions = new Map<string, number>();
  const costs = new Map<number, number>(), roots = new Set<number>();
  if (!active.length || active.filter((node) => node.kind === "Start").length !== 1) return null;
  for (const node of active) {
    if (!Number.isSafeInteger(node.id) || !Number.isSafeInteger(node.row) || !Number.isSafeInteger(node.col) || !["Start", "Stat", "SkillLevel"].includes(node.kind) || nodeMap.has(node.id) || positions.has(`${node.row}:${node.col}`)) return null;
    const free = node.unlocked || node.kind === "Start";
    const cost = free ? 0 : prices[node.grade];
    if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0 || !free && cost === 0) return null;
    nodeMap.set(node.id, node); positions.set(`${node.row}:${node.col}`, node.id); costs.set(node.id, cost);
    if (free) roots.add(node.id);
  }
  const neighbors = new Map<number, number[]>();
  for (const node of active) {
    const adjacent = [[-1, 0], [0, -1], [0, 1], [1, 0]].map(([row, col]) => positions.get(`${node.row + row}:${node.col + col}`)).filter((id): id is number => id !== undefined).sort((a, b) => a - b);
    neighbors.set(node.id, adjacent);
  }
  return { nodes: nodeMap, neighbors, costs, roots };
}

/** Shortest additional cost to one target; already owned/selected nodes cost zero. */
function cheapestPath(model: Graph, selected: Set<number>, target: number): number[] | null {
  const distance = new Map<number, number>(), previous = new Map<number, number>();
  const remaining = new Set(model.nodes.keys());
  for (const id of selected) distance.set(id, 0);
  for (;;) {
    let next: number | undefined, best = Infinity;
    for (const id of remaining) {
      const value = distance.get(id) ?? Infinity;
      if (value < best || value === best && value !== Infinity && (next === undefined || id < next)) { next = id; best = value; }
    }
    if (next === undefined) return null;
    if (next === target) {
      const path: number[] = [];
      let current = target;
      while (!selected.has(current)) {
        path.push(current);
        const parent = previous.get(current);
        if (parent === undefined) return null;
        current = parent;
      }
      return path.reverse();
    }
    remaining.delete(next);
    for (const neighbor of model.neighbors.get(next) ?? []) {
      if (!remaining.has(neighbor)) continue;
      const candidate = best + (selected.has(neighbor) ? 0 : model.costs.get(neighbor)!);
      if (candidate < (distance.get(neighbor) ?? Infinity)) { distance.set(neighbor, candidate); previous.set(neighbor, next); }
    }
  }
}

export function aionBoardPlan(snapshot: AionSnapshot): AionBoardComparison[] {
  const now = Date.now(), age = now - Date.parse(snapshot.observedAt);
  if (aionKnowledgeStatus().status !== "current" || !snapshot.coverage.boards || !aionKnowledge.regions.includes(snapshot.ref.region) || !Number.isFinite(age) || age > 30 * 60_000 || age < -5 * 60_000) return [];
  const data = aionKnowledge as typeof aionKnowledge & { boardPresets?: unknown };
  if (!Array.isArray(data.boardPresets)) return [];
  const sources = aionKnowledge.sources as Source[];
  const result: AionBoardComparison[] = [];
  for (const value of data.boardPresets) {
    const baseline = preset(value, now);
    if (!baseline || baseline.className !== snapshot.profile.className) continue;
    const reviewedSources = baseline.sourceIds.map((id) => sources.find((source) => source.id === id));
    if (reviewedSources.some((source) => !source || !reviewed(source, now))) continue;
    for (const board of snapshot.boards) {
      if (!baseline.boardIds.includes(board.id)) continue;
      const nodes = board.nodes;
      if (!nodes?.length || nodes.length > 1000 || new Set(nodes.map((node) => node.id)).size !== nodes.length) continue;
      const targets = new Map<number, string>();
      for (const target of baseline.targets) {
        for (const node of [...nodes].sort((a, b) => a.id - b.id)) {
          if (node.kind === "None" || node.kind === "Start" || !matches(node, target)) continue;
          const previous = targets.get(node.id);
          targets.set(node.id, previous && previous !== target.reason ? `${previous} ${target.reason}` : target.reason);
        }
      }
      if (!targets.size) continue;
      const missingNodeIds = [...targets.keys()].filter((id) => !nodes.find((node) => node.id === id)!.unlocked);
      let pathNodeIds: number[] = [], cost: number | null = missingNodeIds.length ? null : 0;
      let nodeCosts: { nodeId: number; cost: number }[] = [];
      const notices = ["Reviewed PvE baseline; existing unlocked nodes are preserved. This is not a universal optimum or a respec plan."];
      if (missingNodeIds.length) {
        const model = graph(nodes, baseline.pathModel, sources, now);
        if (model) {
          const selected = new Set(model.roots), additions: number[] = [];
          let total = 0, complete = true;
          // Follow the reviewed target priority, reusing any connecting nodes selected
          // for earlier targets. This is not a global multi-target optimization claim.
          for (const target of missingNodeIds) {
            const path = cheapestPath(model, selected, target);
            if (!path) { complete = false; break; }
            for (const id of path) { total += model.costs.get(id)!; selected.add(id); additions.push(id); }
          }
          if (complete) { pathNodeIds = additions; cost = total; nodeCosts = additions.map((nodeId) => ({ nodeId, cost: model.costs.get(nodeId)! })); }
          else notices.push("A target could not be connected using the reviewed model. Check its route and cost in game.");
          notices.push("Routes and Daevanion Crystal costs are estimates from the reviewed community model. Each target uses a shortest additional path in preset order; the combined route is not guaranteed globally optimal.");
        } else notices.push("Node links or costs are unverified. Missing target nodes are identified, but connecting paths and crystal costs need an in-game check.");
        notices.push("Your available Daevanion Crystals and allocation limits are not public. Compare the estimated cost with your in-game balance before unlocking nodes.");
      }
      result.push({ boardId: board.id, label: baseline.label, ...(baseline.focus ? { focus: baseline.focus } : {}), source: reviewedSources[0]!.url, targets: [...targets].map(([nodeId, reason]) => ({ nodeId, reason })), pathNodeIds, missingNodeIds, cost, nodeCosts, notices });
    }
  }
  return result;
}
