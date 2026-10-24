import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import knowledge from "@/data/aion2/knowledge.json";
import gear from "@/data/aion2/gear-priorities.json";
import realIndex from "@/data/aion2/semantic-index.json";
import { semanticHash, semanticKnowledgeDigest, aionEvidenceCorpus, unitVector, cosine, relatedEvidence, evidenceClusters, validSemanticIndex } from "../scripts/aion2-semantic-core.mjs";

type Chunk = { id: string; ruleId: string | null; kind: string; classes: string[]; sourceIds: string[]; text: string; textHash: string; vector: number[]; focus?: string };
type CorpusChunk = Omit<Chunk, "vector">;
type Query = { id: string; ruleId: string; classes: string[]; text: string; textHash: string; vector: number[]; matches: { id: string; score: number }[] };
type Index = { schemaVersion: number; knowledgeVersion: string; knowledgeDigest: string; generatedAt: string; model: string; region: string; dimensions: number; chunks: Chunk[]; queries: Query[] };

const digest = semanticHash({ version: "review-1", publicFacts: ["Arcana", "Daevanion"] });
function basis(axis = 0): number[] { const values = Array<number>(512).fill(0); values[axis] = 1; return values; }
function chunk(id: string, classes: string[], vector: number[] = [1, 0]): Chunk {
  const text = `${id}: reviewed game fact`;
  return { id, ruleId: id, kind: "rule", classes, sourceIds: ["reviewed-source"], text, textHash: semanticHash(text), vector };
}
function index(): Index {
  const chunks = [chunk("general", [], basis()), chunk("glad", ["Gladiator"], basis()), chunk("cleric", ["Cleric"], basis(1))];
  const text = "Gladiator reviewed progression";
  const query: Query = { id: "query:glad", ruleId: "glad", classes: ["Gladiator"], text, textHash: semanticHash(text), vector: basis(), matches: [] };
  query.matches = relatedEvidence(chunks, query, 6);
  return { schemaVersion: 1, knowledgeVersion: "review-1", knowledgeDigest: digest, generatedAt: "2026-10-23T13:00:00Z", model: "amazon.titan-embed-text-v2:0", region: "us-west-2", dimensions: 512, chunks, queries: [query] };
}

afterEach(() => vi.restoreAllMocks());

describe("semantic corpus and fingerprints", () => {
  it("hashes objects canonically while preserving meaningful array order and string content", () => {
    expect(semanticHash({ b: 2, a: { z: 3, x: [1, 2] } })).toBe(semanticHash({ a: { x: [1, 2], z: 3 }, b: 2 }));
    expect(semanticHash([1, 2])).not.toBe(semanticHash([2, 1]));
    expect(semanticHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(semanticHash("fact")).not.toBe(semanticHash("fact "));
  });

  it("builds only reviewed manifest chunks with unique IDs and known sources", () => {
    const chunks = aionEvidenceCorpus(knowledge);
    const knownSources = new Set(knowledge.sources.map((source) => source.id));
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((value: CorpusChunk) => value.id)).size).toBe(chunks.length);
    for (const value of chunks) {
      expect(value.textHash).toBe(semanticHash(value.text));
      expect(value.text.length).toBeLessThanOrEqual(12000);
      expect(value.sourceIds.length).toBeGreaterThan(0);
      expect(new Set(value.sourceIds).size).toBe(value.sourceIds.length);
      expect(value.sourceIds.every((id: string) => knownSources.has(id))).toBe(true);
    }
    for (const rule of knowledge.rules) {
      expect(chunks.find((value: CorpusChunk) => value.id === `rule:${rule.id}`)?.classes).toEqual(rule.classes);
      for (const step of rule.steps ?? []) expect(chunks.find((value: CorpusChunk) => value.id === `step:${rule.id}:${step.id}`)?.sourceIds).toEqual([step.sourceId]);
    }
  });

  it("does not inspect account/character/environment inputs or read files while deriving a corpus", () => {
    const input = structuredClone(knowledge);
    for (const name of ["characters", "character", "account", "environment", "env"]) {
      Object.defineProperty(input, name, { enumerable: true, get() { throw new Error(`Private field ${name} must never be inspected`); } });
    }
    const readSync = vi.spyOn(fs, "readFileSync"), readAsync = vi.spyOn(fsPromises, "readFile"), fetch = vi.spyOn(globalThis, "fetch");
    const result = aionEvidenceCorpus(input);
    expect(result.length).toBeGreaterThan(0);
    expect(readSync).not.toHaveBeenCalled(); expect(readAsync).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(result.map((value: CorpusChunk) => value.text).join(" ")).not.toMatch(/Yoshiane|NGez0OkmLm4ARHzxujw|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
  });

  it("keeps caller data unchanged and invalidates the digest when reviewed knowledge changes", () => {
    const input = structuredClone(knowledge), before = JSON.stringify(input);
    aionEvidenceCorpus(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(semanticHash({ ...input, version: `${input.version}.next` })).not.toBe(semanticHash(input));
    input.rules[0].action += " Reviewed correction.";
    expect(semanticHash(input)).not.toBe(semanticHash(knowledge));
  });

  it("binds gear priorities and exact item pools into the release digest", () => {
    const current = semanticKnowledgeDigest(knowledge, gear), changed = structuredClone(gear);
    expect(current).not.toBe(semanticKnowledgeDigest(knowledge));
    changed.slotRules[0].priorities[0].rank += 1;
    expect(semanticKnowledgeDigest(knowledge, changed)).not.toBe(current);
    const pool = structuredClone(gear);
    pool.itemPools[0].stats[0].label += " reviewed correction";
    expect(semanticKnowledgeDigest(knowledge, pool)).not.toBe(current);
  });

  it("embeds only authored gear rules and pools with scoped source IDs", () => {
    const input = structuredClone(gear);
    Object.defineProperty(input, "characters", { get() { throw new Error("Player data must not be read"); } });
    const chunks = aionEvidenceCorpus(knowledge, input).filter((value: CorpusChunk) => value.kind.startsWith("gear-"));
    const sources = new Set(gear.sources.map(source => `gear:${source.id}`));
    expect(chunks).toHaveLength(gear.slotRules.length + gear.itemPools.length);
    expect(new Set(chunks.map((value: CorpusChunk) => value.id)).size).toBe(chunks.length);
    expect(chunks.every((value: CorpusChunk) => value.sourceIds.every(id => sources.has(id)))).toBe(true);
    expect(chunks.map((value: CorpusChunk) => value.text).join(" ")).not.toMatch(/Yoshiane|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
  });

  it("keeps gear pool similarity from displacing a progression rule's related steps", () => {
    const gearChunk = { ...chunk("gear-rule:fixture", ["Gladiator"], [1, 0]), kind: "gear-priority", ruleId: null };
    const step = { ...chunk("step:glad:fixture", ["Gladiator"], [0.8, 0.6]), kind: "step" };
    expect(relatedEvidence([gearChunk, step], { ruleId: "glad", classes: ["Gladiator"], vector: [1, 0] }, 1)).toEqual([{ id: step.id, score: 0.8 }]);
  });

  it("keeps duplicate item pools separated by their reviewed class scope", () => {
    const legacy = structuredClone(gear.itemPools[0]);
    const cleric = { ...structuredClone(legacy), classes: ["Cleric"] };
    const candidate = { ...gear, classes: ["Gladiator", "Cleric"], itemPools: [legacy, cleric] };
    const pools = aionEvidenceCorpus(knowledge, candidate).filter((value: CorpusChunk) => value.kind === "gear-pool");
    expect(pools.map((value: CorpusChunk) => value.classes)).toEqual([["Gladiator"], ["Cleric"]]);
    expect(new Set(pools.map((value: CorpusChunk) => value.id)).size).toBe(2);
    expect(pools[0].id).toBe(`gear-pool:${legacy.itemId}`);
    expect(pools[1].id).not.toBe(pools[0].id);
  });

  it("carries authored role focus into rule, step and board evidence", () => {
    const rule = { ...knowledge.rules[0], id: "focus-fixture", classes: ["Cleric"], focus: "group" };
    const preset = { ...knowledge.boardPresets[0], id: "focus-board-fixture", className: "Cleric", focus: "group" };
    const rows = aionEvidenceCorpus({ ...knowledge, rules: [rule], boardPresets: [preset] });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.filter((value: CorpusChunk) => value.kind !== "activity")) {
      expect(row.focus).toBe("group");
      expect(row.text).toContain("Group healing");
    }
  });
});

describe("embedding normalization and class-safe retrieval", () => {
  it("rejects unknown role metadata in saved chunks and queries", () => {
    const chunkRole = index(); Object.assign(chunkRole.chunks[0], { focus: "unknown" });
    expect(validSemanticIndex(chunkRole, digest)).toBe(false);
    const queryRole = index(); Object.assign(queryRole.queries[0], { focus: "unknown" });
    expect(validSemanticIndex(queryRole, digest)).toBe(false);
  });
  it("filters an explicitly selected role without excluding common evidence", () => {
    const rows = [{ ...chunk("group", ["Cleric"]), focus: "group" }, { ...chunk("solo", ["Cleric"]), focus: "solo" }, chunk("common", ["Cleric"])];
    const matches = relatedEvidence(rows, { classes: ["Cleric"], focus: "group", vector: [1,0] }, 6);
    expect(matches.map((value: { id: string }) => value.id)).toEqual(["common", "group"]);
    expect(relatedEvidence(rows, { classes: ["Cleric"], vector: [1,0] }, 6)).toHaveLength(3);
  });
  it("normalizes finite nonzero vectors without mutating the source", () => {
    const values = [3, 4], normalized = unitVector(values, 2);
    expect(normalized).toEqual([0.6, 0.8]); expect(values).toEqual([3, 4]);
    expect(Math.hypot(...normalized)).toBeCloseTo(1, 6);
    expect(cosine(normalized, normalized)).toBeCloseTo(1, 6);
    expect(cosine(normalized, normalized.map((value: number) => -value))).toBeCloseTo(-1, 6);
  });

  it.each([
    { vector: [0, 0], dimensions: 2 }, { vector: [1], dimensions: 2 }, { vector: [NaN, 0], dimensions: 2 },
    { vector: [Infinity, 0], dimensions: 2 }, { vector: ["1", 0], dimensions: 2 }, { vector: null, dimensions: 2 },
    { vector: [Number.MAX_VALUE, Number.MAX_VALUE], dimensions: 2 }, { vector: [], dimensions: 0 },
  ])("refuses malformed, zero or overflowing vectors: %j", ({ vector, dimensions }) => {
    expect(() => unitVector(vector, dimensions)).toThrow();
  });

  it("rejects incompatible cosine dimensions and supports negative similarity", () => {
    expect(() => cosine([1, 0], [1])).toThrow(); expect(() => cosine([], [])).toThrow();
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
  });

  it("never retrieves Cleric-specific chunks for a Gladiator query even when they have the best vector", () => {
    const chunks = [chunk("cleric-perfect", ["Cleric"], [1, 0]), chunk("glad-supported", ["Gladiator"], [0.8, 0.6]), chunk("all-classes", [], [0.6, 0.8])];
    const result = relatedEvidence(chunks, { classes: ["Gladiator"], vector: [1, 0] }, 6);
    expect(result.map((value: { id: string }) => value.id)).toEqual(["glad-supported", "all-classes"]);
    expect(result[0].score).toBeCloseTo(0.8);
  });

  it("keeps a shared multi-class chunk only when the query class is included", () => {
    const chunks = [chunk("shared", ["Gladiator", "Templar"]), chunk("cleric", ["Cleric"])];
    expect(relatedEvidence(chunks, { classes: ["Gladiator"], vector: [1, 0] }, 6).map((value: { id: string }) => value.id)).toEqual(["shared"]);
  });

  it("sorts ties by ID and honors explicit retrieval limits", () => {
    const chunks = [chunk("z", []), chunk("a", []), chunk("m", [])];
    expect(relatedEvidence(chunks, { classes: [], vector: [1, 0] }, 2).map((value: { id: string }) => value.id)).toEqual(["a", "m"]);
    expect(relatedEvidence(chunks, { classes: [], vector: [1, 0] }, 0)).toEqual([]);
  });

  it("does not let a general chunk bridge Gladiator and Cleric similarity clusters", () => {
    const chunks = [chunk("glad", ["Gladiator"]), chunk("general", []), chunk("cleric", ["Cleric"]), chunk("glad-two", ["Gladiator"])];
    const groups = evidenceClusters(chunks, 0.78).map((value: { chunkIds: string[] }) => [...value.chunkIds].sort());
    expect(groups).toEqual([["glad", "glad-two"], ["general"], ["cleric"]]);
  });

  it("uses connected similarity groups within the same exact class scope", () => {
    const chunks = [chunk("a", ["Gladiator"], [1, 0]), chunk("b", ["Gladiator"], [0.8, 0.6]), chunk("c", ["Gladiator"], [0.28, 0.96])];
    expect(cosine(chunks[0].vector, chunks[2].vector)).toBeLessThan(0.78);
    expect(evidenceClusters(chunks, 0.78)).toMatchObject([{ chunkIds: ["a", "b", "c"] }]);
  });
});

describe("published semantic index validation", () => {
  it("validates the generated real index against the exact current reviewed knowledge", () => {
    expect(validSemanticIndex(realIndex, semanticKnowledgeDigest(knowledge, gear), knowledge.version)).toBe(true);
    const corpus = aionEvidenceCorpus(knowledge, gear);
    expect(realIndex.chunks.map((value) => value.id).sort()).toEqual(corpus.map((value: CorpusChunk) => value.id).sort());
    for (const query of realIndex.queries) {
      for (const match of query.matches) {
        const item = realIndex.chunks.find((value) => value.id === match.id)!;
        expect(!query.classes.length || !item.classes.length || item.classes.some((name) => query.classes.includes(name))).toBe(true);
      }
    }
  });

  it("accepts a complete normalized synthetic index and rejects schema/version/digest mismatches", () => {
    expect(validSemanticIndex(index(), digest, "review-1")).toBe(true);
    expect(validSemanticIndex({ ...index(), schemaVersion: 2 }, digest, "review-1")).toBe(false);
    expect(validSemanticIndex(index(), semanticHash("changed knowledge"), "review-1")).toBe(false);
    expect(validSemanticIndex(index(), digest, "review-2")).toBe(false);
  });

  it.each(["zero-dimensions", "negative-dimensions", "oversized-dimensions", "empty-chunks", "empty-queries", "duplicate-chunks", "duplicate-queries", "missing-query-id", "missing-rule-id", "unknown-match", "duplicate-match", "invalid-score", "infinite-score", "changed-text", "wrong-vector-size", "nonunit-vector", "zero-vector", "malformed-classes", "duplicate-classes", "missing-sources", "malformed-sources", "duplicate-sources"])("rejects malformed index case %s", (kind) => {
    const value = index();
    if (kind === "zero-dimensions") value.dimensions = 0;
    else if (kind === "negative-dimensions") value.dimensions = -1;
    else if (kind === "oversized-dimensions") value.dimensions = 4097;
    else if (kind === "empty-chunks") value.chunks = [];
    else if (kind === "empty-queries") value.queries = [];
    else if (kind === "duplicate-chunks") value.chunks.push(structuredClone(value.chunks[0]));
    else if (kind === "duplicate-queries") value.queries.push(structuredClone(value.queries[0]));
    else if (kind === "missing-query-id") value.queries[0].id = "";
    else if (kind === "missing-rule-id") value.queries[0].ruleId = "";
    else if (kind === "unknown-match") value.queries[0].matches[0].id = "not-in-the-corpus";
    else if (kind === "duplicate-match") value.queries[0].matches.push(structuredClone(value.queries[0].matches[0]));
    else if (kind === "invalid-score") value.queries[0].matches[0].score = 1.01;
    else if (kind === "infinite-score") value.queries[0].matches[0].score = Infinity;
    else if (kind === "changed-text") value.chunks[0].text += " Unreviewed correction.";
    else if (kind === "wrong-vector-size") value.chunks[0].vector.pop();
    else if (kind === "nonunit-vector") value.chunks[0].vector = Array(512).fill(1);
    else if (kind === "zero-vector") value.chunks[0].vector = Array(512).fill(0);
    else if (kind === "malformed-classes") value.chunks[0].classes = [null as unknown as string];
    else if (kind === "duplicate-classes") value.chunks[0].classes = ["Gladiator", "Gladiator"];
    else if (kind === "missing-sources") value.chunks[0].sourceIds = [];
    else if (kind === "malformed-sources") value.chunks[0].sourceIds = [42 as unknown as string];
    else value.chunks[0].sourceIds = ["reviewed-source", "reviewed-source"];
    expect(validSemanticIndex(value, digest, "review-1")).toBe(false);
  });

  it("refuses non-object or truncated index values", () => {
    for (const value of [null, undefined, true, "index", {}, { schemaVersion: 1 }]) expect(validSemanticIndex(value, digest, "review-1")).toBe(false);
  });
});

describe("runtime evidence serving", () => {
  async function loadEvidence(stale = false) {
    vi.resetModules();
    vi.doMock("@/lib/aion2-knowledge", () => ({ aionKnowledge: structuredClone(knowledge), aionKnowledgeStatus: () => ({ status: "current" }) }));
    vi.doMock("@/data/aion2/semantic-index.json", () => ({ default: { ...structuredClone(realIndex), ...(stale ? { knowledgeDigest: semanticHash("older knowledge") } : {}) } }));
    return import("@/lib/aion2-semantic-evidence");
  }

  afterEach(() => {
    vi.doUnmock("@/lib/aion2-knowledge"); vi.doUnmock("@/data/aion2/semantic-index.json"); vi.resetModules();
  });

  it("serves a Cleric only active general steps from the same progression goal", async () => {
    const { aionPlanEvidence } = await loadEvidence();
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = aionPlanEvidence("amulet", "Cleric", ["monolith", "amulet-menu"]);
    expect(result.relatedEvidence?.map((value) => value.id).sort()).toEqual(["step:amulet:amulet-menu", "step:amulet:monolith"]);
    const applicable = new Set(knowledge.rules.find((rule) => rule.id === "amulet")!.sourceIds);
    const sourceUrls = new Set(knowledge.sources.filter((source) => applicable.has(source.id)).map((source) => source.url));
    expect(result.evidenceSources?.length).toBeGreaterThan(0);
    for (const value of result.relatedEvidence ?? []) {
      expect(value.id.startsWith("step:amulet:")).toBe(true);
      expect(value.sources.length).toBeGreaterThan(0);
      expect(value.sources.every((source) => sourceUrls.has(source.url))).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps reviewed source links but withholds semantic snippets for an obsolete knowledge digest", async () => {
    const { aionPlanEvidence } = await loadEvidence(true);
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = aionPlanEvidence("amulet", "Cleric", ["monolith", "amulet-menu"]);
    expect(result.relatedEvidence).toEqual([]);
    const ids = knowledge.rules.find((rule) => rule.id === "amulet")!.sourceIds;
    expect(result.evidenceSources?.map((value) => value.url)).toEqual(ids.map((id) => knowledge.sources.find((source) => source.id === id)!.url));
    expect(fetch).not.toHaveBeenCalled();
  });
});
