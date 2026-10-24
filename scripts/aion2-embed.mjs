import { readFile, writeFile, rename, rm, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateAionKnowledge, validateAionChecklistLinks } from "../src/lib/aion2-knowledge-validation.ts";
import { validateAionChecklistManifest } from "../src/lib/aion2-checklist-validation.ts";
import { validateAionGearPriorities } from "../src/lib/aion2-gear-validation.ts";
import { aionEvidenceCorpus, semanticHash, semanticKnowledgeDigest, unitVector, relatedEvidence, evidenceClusters, validSemanticIndex } from "./aion2-semantic-core.mjs";
import { embeddingArguments, embeddingAwsConfiguration } from "./aion2-embedding-aws.mjs";

const execute = promisify(execFile), options = embeddingArguments(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knowledge = JSON.parse(await readFile(path.join(root, "src/data/aion2/knowledge.json"), "utf8"));
const checklist = JSON.parse(await readFile(path.join(root, "src/data/aion2/checklist.json"), "utf8"));
const gear = JSON.parse(await readFile(path.join(root, "src/data/aion2/gear-priorities.json"), "utf8"));
const failures = [...validateAionKnowledge(knowledge), ...validateAionChecklistManifest(checklist), ...validateAionChecklistLinks(knowledge, checklist), ...validateAionGearPriorities(gear)];
if (failures.length || Date.now() >= Date.parse(`${knowledge.expiresAt}T00:00:00Z`) || Date.now() >= Date.parse(checklist.expiresAt) || Date.now() >= Date.parse(`${gear.expiresAt}T00:00:00Z`)) throw new Error("Review and validate the knowledge base before building its semantic index");
const chunks = aionEvidenceCorpus(knowledge, gear);
const queries = knowledge.rules.map((rule) => ({ id: `query:${rule.id}`, ruleId: rule.id, classes: rule.classes, text: `${rule.classes.join(" ")} ${rule.id} ${rule.evidence} ${rule.action}`, textHash: "" }));
for (const query of queries) query.textHash = semanticHash(query.text);
if (chunks.length + queries.length > 128 || [...chunks, ...queries].some((item) => item.text.length > 12000)) throw new Error("Embedding batch exceeds the reviewed 128-item/12000-character limits");
const destination = path.join(root, "src/data/aion2/semantic-index.json");
if (!options.build) {
  console.log(JSON.stringify({ dryRun: true, chunks: chunks.length, queries: queries.length, model: "amazon.titan-embed-text-v2:0", dimensions: 512, sendsOnly: "Reviewed authored game facts, never character snapshots or credentials" }));
  process.exit(0);
}

const model = "amazon.titan-embed-text-v2:0", dimensions = 512;
let previous = null;
try { previous = JSON.parse(await readFile(destination, "utf8")); } catch { /* First build. */ }
const cache = new Map(previous?.model === model && previous?.dimensions === dimensions && validSemanticIndex(previous, previous.knowledgeDigest) ? [...previous.chunks, ...previous.queries].map((item) => [item.textHash, item.vector]) : []);
const awsConfiguration = embeddingAwsConfiguration({ root, options, execute });
let region = options.region ?? previous?.region ?? "us-west-2";
const temporary = await mkdtemp(path.join(os.tmpdir(), "yoshling-aion2-embed-"));
let invoked = 0, reused = 0, tokens = 0, cursor = 0, failure = null;
async function embed(item, index) {
  const cached = cache.get(item.textHash);
  if (cached) { reused++; return unitVector(cached, dimensions); }
  const aws = await awsConfiguration();
  region = aws.region;
  const request = path.join(temporary, `request-${index}.json`), response = path.join(temporary, `response-${index}.json`);
  await writeFile(request, JSON.stringify({ inputText: item.text, dimensions, normalize: true }), { mode: 0o600 });
  try {
    await execute("aws", ["bedrock-runtime", "invoke-model", ...aws.profileArgs, "--region", aws.region, "--model-id", model, "--content-type", "application/json", "--accept", "application/json", "--body", `fileb://${request}`, "--no-cli-pager", response], { env: aws.env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    const code = String(error.stderr ?? "").match(/\(([A-Za-z0-9_.-]+)\) when calling/)?.[1] ?? "BedrockRequestFailed";
    throw new Error(`Embedding stopped: ${code}. Existing published index was preserved.`);
  }
  const result = JSON.parse(await readFile(response, "utf8")); invoked++; tokens += Number(result.inputTextTokenCount) || 0;
  return unitVector(result.embedding, dimensions);
}
try {
  const work = [...chunks, ...queries];
  await Promise.all([0, 1].map(async () => {
    while (!failure && cursor < work.length) {
      const index = cursor++, item = work[index];
      try { item.vector = await embed(item, index); }
      catch (error) { failure = error; return; }
    }
  }));
  if (failure) throw failure;
  for (const query of queries) query.matches = relatedEvidence(chunks, query, 6);
  const index = { schemaVersion: 1, knowledgeVersion: knowledge.version, knowledgeDigest: semanticKnowledgeDigest(knowledge, gear), generatedAt: new Date().toISOString(), model, region, dimensions, chunks, queries, clusters: evidenceClusters(chunks), build: { invoked, reused, inputTokens: tokens } };
  if (!validSemanticIndex(index, semanticKnowledgeDigest(knowledge, gear), knowledge.version)) throw new Error("The generated semantic index did not pass readback validation");
  const currentKnowledge = JSON.parse(await readFile(path.join(root, "src/data/aion2/knowledge.json"), "utf8"));
  const currentGear = JSON.parse(await readFile(path.join(root, "src/data/aion2/gear-priorities.json"), "utf8"));
  if (semanticKnowledgeDigest(currentKnowledge, currentGear) !== index.knowledgeDigest) throw new Error("Knowledge changed during embedding. The existing index was preserved; rebuild against the new review.");
  const text = JSON.stringify(index), staging = `${destination}.${process.pid}.tmp`;
  await writeFile(staging, text, { mode: 0o644 });
  if (await readFile(staging, "utf8") !== text) throw new Error("Embedding index write could not be verified");
  await rename(staging, destination);
  if (!validSemanticIndex(JSON.parse(await readFile(destination, "utf8")), semanticKnowledgeDigest(knowledge, gear), knowledge.version)) throw new Error("Published embedding index could not be verified");
  console.log(JSON.stringify({ ok: true, model, region, dimensions, chunks: chunks.length, queries: queries.length, clusters: index.clusters.length, invoked, reused, inputTokens: tokens, output: "src/data/aion2/semantic-index.json" }));
} finally { await rm(temporary, { recursive: true, force: true }); }
