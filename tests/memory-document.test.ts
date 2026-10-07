import { describe, expect, it } from "vitest";
import { readFile, stat } from "fs/promises";
import path from "path";

const root = path.resolve(__dirname, "..");

describe("current project memory stays bounded", () => {
  it("fits the documented line budget instead of accumulating incident history", async () => {
    const memory = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(memory.trimEnd().split("\n").length).toBeLessThanOrEqual(220);
    expect(memory.trim().split(/\s+/).length).toBeLessThanOrEqual(2400);
    expect(memory.length).toBeLessThanOrEqual(18000);
    expect(memory).not.toMatch(/^>.*Corrected \d{4}-\d{2}-\d{2}/m);
    expect(memory).not.toMatch(/^###? .*closed.*\d{4}-\d{2}-\d{2}/im);
  });

  it("routes readers to existing current and historical documents", async () => {
    const memory = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(memory).toContain("docs/MEMORY-HISTORY.md");
    expect(memory).toContain("docs/CLOSED.md");
    expect(memory).toContain("## Current remediation status");
    for (const match of memory.matchAll(/\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
      expect((await stat(path.join(root, match[1]))).isFile(), match[1]).toBe(true);
    }
  });
});
