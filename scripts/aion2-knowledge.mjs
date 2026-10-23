import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateAionKnowledge, validateAionChecklistLinks } from "../src/lib/aion2-knowledge-validation.ts";
import { validateAionTimers } from "../src/lib/aion2-timer-validation.ts";
import { validateAionChecklistManifest } from "../src/lib/aion2-checklist-validation.ts";

const knowledge = JSON.parse(await readFile(new URL("../src/data/aion2/knowledge.json", import.meta.url), "utf8"));
const errors = validateAionKnowledge(knowledge);
const timers = JSON.parse(await readFile(new URL("../src/data/aion2/timers.json", import.meta.url), "utf8"));
errors.push(...validateAionTimers(timers));
const checklist = JSON.parse(await readFile(new URL("../src/data/aion2/checklist.json", import.meta.url), "utf8"));
errors.push(...validateAionChecklistManifest(checklist));
errors.push(...validateAionChecklistLinks(knowledge, checklist));
if (new Date() >= new Date(checklist.expiresAt)) errors.push("Checklist source review has expired");
if (new Date() >= new Date(`${timers.expiresAt}T00:00:00Z`)) errors.push("Timer source review has expired");
if (new Date() >= new Date(`${knowledge.expiresAt}T00:00:00Z`)) errors.push("Knowledge review has expired");
if (errors.length) {
  console.error(errors.join("\n")); process.exitCode = 1;
} else {
  console.log(`Knowledge ${knowledge.version}: structure valid; review due ${knowledge.expiresAt}.`);
  console.log(`Timers ${timers.version}: structure valid; review due ${timers.expiresAt}.`);
  console.log(`Checklist ${checklist.version}: structure valid; review due ${checklist.expiresAt}.`);
  if (process.argv.includes("--check-sources")) {
    async function get(url) {
      const response = await fetch(url, { headers: { Accept: "application/json, text/plain, text/html", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader(), chunks = []; let total = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > 2_000_000) throw new Error("Response is too large"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks).toString("utf8");
    }
    const digest = (text) => createHash("sha256").update(text).digest("hex");
    try {
      const feed = JSON.parse(await get(knowledge.patchFeed));
      if (feed.contentList?.[0]?.id !== knowledge.patches[0].id) errors.push("New official patch: review its effect on every rule");
      for (const patch of knowledge.patches) {
        const listed = feed.contentList?.find((entry) => entry.id === patch.id);
        if (listed?.timestamps?.updatedAt !== patch.updatedAt) errors.push(`Patch ${patch.id}: publication changed or missing`);
        const detail = JSON.parse(await get(`https://api-global-community.plaync.com/aion2_global/board/update_en/article/${patch.id}`));
        const body = detail.article?.content?.content;
        if (typeof body !== "string" || digest(body.replace(/\r\n/g, "\n").trim()) !== patch.bodySha256) errors.push(`Patch ${patch.id}: body changed`);
      }
      for (const source of [...knowledge.sources, ...timers.sources, ...checklist.sources]) if (source.fetchUrl) {
        if (digest(await get(source.fetchUrl)) !== source.sha256) errors.push(`Source ${source.id}: contents changed; review supported claims before updating its baseline`);
      }
      if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
      else console.log("Reviewed patch revisions, patch bodies, pinned guides, timers and checklist sources match. This checks for change; it does not validate a strategy automatically.");
    } catch (error) { console.error(`Source check is unverified: ${error.message}`); process.exitCode = 1; }
  }
}
