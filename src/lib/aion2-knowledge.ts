import manifest from "@/data/aion2/knowledge.json";
import timerManifest from "@/data/aion2/timers.json";
import checklistManifest from "@/data/aion2/checklist.json";
import gearManifest from "@/data/aion2/gear-priorities.json";
import type { AionKnowledgeStatus } from "./aion2-types";
import { validateAionKnowledge, validateAionChecklistLinks } from "./aion2-knowledge-validation";
import { validateAionTimers } from "./aion2-timer-validation";
import { validateAionChecklistManifest } from "./aion2-checklist-validation";
import { validateAionGearPriorities } from "./aion2-gear-validation";
import { createHash } from "node:crypto";

export const aionKnowledge = manifest;
const validationErrors = [...validateAionKnowledge(manifest), ...validateAionTimers(timerManifest), ...validateAionChecklistManifest(checklistManifest), ...validateAionChecklistLinks(manifest, checklistManifest), ...validateAionGearPriorities(gearManifest)];
const reviewVersion = `${manifest.version}:${timerManifest.version}:${checklistManifest.version}:${gearManifest.version}`;
const globals = globalThis as typeof globalThis & { __aionKnowledge?: { version: string; checkedAt: number; attemptedAt: number; changed: boolean; reason: string | null; error: string | null; pending?: Promise<AionKnowledgeStatus> } };
if (globals.__aionKnowledge?.version !== reviewVersion) globals.__aionKnowledge = { version: reviewVersion, checkedAt: 0, attemptedAt: 0, changed: false, reason: null, error: null };
const state = globals.__aionKnowledge!;
const CHECK_MS = 30 * 60_000;

export function aionKnowledgeStatus(now = new Date()): AionKnowledgeStatus {
  const expires = (value: string) => Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  const expired = [manifest, timerManifest, checklistManifest, gearManifest, ...manifest.sources, ...manifest.rules, ...manifest.activities, ...timerManifest.sources, ...checklistManifest.sources, ...gearManifest.sources].some((source) => now.getTime() >= expires(source.expiresAt));
  const status = validationErrors.length ? "review-required" : expired ? "expired" : state.changed ? "review-required" : !state.checkedAt || now.getTime() - state.checkedAt > CHECK_MS * 2 ? "unverified" : "current";
  return {
    version: manifest.version, reviewedAt: manifest.reviewedAt, expiresAt: manifest.expiresAt, status,
    checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
    supportedClasses: [...new Set(manifest.rules.flatMap((rule) => rule.classes))],
    notices: [
      ...(validationErrors.length ? ["The knowledge configuration is invalid. Recommendations are withheld until it is repaired."] : []),
      ...(status === "expired" ? ["Guidance has reached its review date. Recommendations are withheld until the knowledge base is reviewed."] : []),
      ...(status === "review-required" && !validationErrors.length ? [state.reason ?? "NCSOFT published or revised patch notes after this knowledge review. Recommendations are withheld pending review."] : []),
      ...(status === "unverified" ? ["Current patch notes could not yet be verified. Saved character observations remain available; recommendations are withheld."] : []),
      ...(state.error ? [state.error] : []), ...manifest.limitations,
    ],
  };
}

export function refreshAionKnowledgeStatus(options: { maximumCheckAgeMs?: number } = {}): Promise<AionKnowledgeStatus> {
  if (validationErrors.length) return Promise.resolve(aionKnowledgeStatus());
  const now = Date.now();
  if (state.pending) return state.pending;
  const requestedAge = options.maximumCheckAgeMs;
  const interval = typeof requestedAge === "number" && Number.isFinite(requestedAge) ? Math.max(5 * 60_000, Math.min(CHECK_MS, requestedAge)) : CHECK_MS;
  if (state.attemptedAt && now - state.attemptedAt < (state.error ? 60_000 : interval)) return Promise.resolve(aionKnowledgeStatus());
  state.attemptedAt = now;
  const promise = (async () => {
    try {
      const signal = AbortSignal.timeout(8000);
      const reads = new Map<string, Promise<Buffer>>();
      const read = (url: string) => {
        const previous = reads.get(url); if (previous) return previous;
        const request = readSource(url, signal); reads.set(url, request); return request;
      };
      const text = (await read(manifest.patchFeed)).toString("utf8");
      const data = JSON.parse(text) as { contentList?: { id?: unknown; timestamps?: { updatedAt?: unknown } }[] };
      if (!Array.isArray(data.contentList) || !data.contentList.length) throw new Error("Official patch-note response could not be verified.");
      const latest = data.contentList[0];
      let changed = latest.id !== manifest.patches[0].id || manifest.patches.some((reviewed) => {
        const article = data.contentList!.find((item) => item.id === reviewed.id);
        return !article || article.timestamps?.updatedAt !== reviewed.updatedAt;
      });
      const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
      const checks = await Promise.all([
        ...manifest.patches.map(async (patch) => {
          const detail = JSON.parse((await read(`https://api-global-community.plaync.com/aion2_global/board/update_en/article/${patch.id}`)).toString("utf8"));
          const body = detail.article?.content?.content;
          if (typeof body !== "string") throw new Error("Unverified patch body");
          return hash(body.replace(/\r\n/g, "\n").trim()) !== patch.bodySha256;
        }),
        ...[...manifest.sources, ...timerManifest.sources, ...checklistManifest.sources, ...gearManifest.sources].filter((source) => "fetchUrl" in source).map(async (source) => {
          if (!("fetchUrl" in source) || !source.fetchUrl) return false;
          return hash(await read(source.fetchUrl)) !== source.sha256;
        }),
      ]);
      changed ||= checks.some(Boolean);
      // A stale upstream replica cannot clear a review that was already required.
      // Only a reviewed knowledge version resets this process's latch.
      state.changed ||= changed;
      if (state.changed) state.reason = "Official patch notes, a pinned guide, timer, checklist or gear source changed after review. Recommendations are withheld until the knowledge base is reviewed.";
      state.checkedAt = Date.now(); state.error = null;
    } catch { state.error = "A patch, guide, timer, checklist or gear source check failed. Its last verified result is retained for at most one hour."; }
    return aionKnowledgeStatus();
  })().finally(() => { state.pending = undefined; });
  state.pending = promise; return promise;
}

async function readSource(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { headers: { Accept: "application/json, text/plain, text/html", "User-Agent": "Mozilla/5.0" }, cache: "no-store", redirect: url.startsWith("https://docs.google.com/") ? "follow" : "error", signal });
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 2_000_000) throw new Error("Unverified knowledge source");
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty knowledge source");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2_000_000) throw new Error("Knowledge source too large"); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
