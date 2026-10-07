import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { admitZipExpansion, declaredZipExpansion, runBoundedExtraction, UploadExpansionError } from "@/lib/upload-expansion";

let freeBytes: bigint | null = null;
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: async (...args: Parameters<typeof actual.statfs>) => freeBytes === null
    ? actual.statfs(...args)
    : { bavail: freeBytes, bsize: BigInt(1) } };
});
let root = "";
beforeEach(async () => { freeBytes = null; root = await mkdtemp(path.join(tmpdir(), "yoshling-expanded-budget-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const limits = { maxBytes: 64, maxEntries: 4, reserveBytes: 10 };
function listing(bytes: number, count = 1) {
  return ["Archive: fixture.zip", ...Array.from({ length: count }, (_, n) => ` ${n ? 0 : bytes}  10-06-2026  00:00  f${n}`), ` ${bytes} ${count} files`].join("\n");
}
const writer = (dir: string, body: string) => ["-e", `const fs=require('fs'),path=require('path');const dir=${JSON.stringify(dir)};${body}`];

describe("ZIP expansion admission and cancellation", () => {
  it("reads individual declared entries and checks their totals", () => {
    expect(declaredZipExpansion(listing(32, 3))).toEqual({ bytes: 32, entries: 3 });
    expect(() => declaredZipExpansion(listing(32, 3).replace("32 3 files", "31 3 files"))).toThrow(/could not be verified/);
    expect(() => declaredZipExpansion("Archive: fixture.zip\n dtm.raw")).toThrow(/could not be verified/);
  });
  it("refuses declared bytes and counts before starting extraction", async () => {
    await expect(admitZipExpansion(listing(65), root, limits)).rejects.toBeInstanceOf(UploadExpansionError);
    await expect(admitZipExpansion(listing(1, 5), root, limits)).rejects.toThrow(/entry-count/);
    expect(await readdir(root)).toEqual([]);
  });
  it("requires declared output plus working disk headroom, refusing unknown disk space", async () => {
    freeBytes = BigInt(73);
    await expect(admitZipExpansion(listing(64), root, limits)).rejects.toMatchObject({ status: 507 });
    freeBytes = BigInt(74);
    expect(await admitZipExpansion(listing(64), root, limits)).toEqual({ bytes: 64, entries: 1 });
    freeBytes = BigInt(-1);
    await expect(admitZipExpansion(listing(1), root, limits)).rejects.toThrow(/could not be read/);
  });
  it("kills an actual extraction process when observed output exceeds declared admission", async () => {
    const final = path.join(root, "continued.txt");
    await expect(runBoundedExtraction(process.execPath, writer(root,
      "fs.writeFileSync(path.join(dir,'inflated.bin'),Buffer.alloc(65));setTimeout(()=>{fs.writeFileSync(path.join(dir,'continued.txt'),'must not happen');process.exit(0)},500);"
    ), { workDir: root, limits, pollMs: 5 })).rejects.toThrow(/Actual extracted bytes/);
    expect((await readFile(path.join(root, "inflated.bin"))).length).toBe(65);
    expect(await readFile(final).catch(() => null)).toBeNull();
  });
  it("also checks actual file count and final output after an immediate process exit", async () => {
    await expect(runBoundedExtraction(process.execPath, writer(root,
      "for(let n=0;n<5;n++)fs.writeFileSync(path.join(dir,'f'+n),'x');"
    ), { workDir: root, limits, pollMs: 1_000 })).rejects.toThrow(/Actual extracted entries/);
  });
  it("cancels extraction when disk reserve is consumed during the subprocess", async () => {
    freeBytes = BigInt(100);
    const task = runBoundedExtraction(process.execPath, writer(root,
      "fs.writeFileSync(path.join(dir,'started'),'x');setTimeout(()=>{fs.writeFileSync(path.join(dir,'continued'),'x');process.exit(0)},500);"
    ), { workDir: root, limits, pollMs: 5 });
    for (let n = 0; n < 200 && !(await readFile(path.join(root, "started")).catch(() => null)); n++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    freeBytes = BigInt(9);
    await expect(task).rejects.toMatchObject({ status: 507 });
    expect(await readFile(path.join(root, "continued")).catch(() => null)).toBeNull();
  });
  it("cancels a running subprocess when power preempts the upload", async () => {
    let interrupted = false;
    const task = runBoundedExtraction(process.execPath, writer(root,
      "fs.writeFileSync(path.join(dir,'started'),'x');setTimeout(()=>{fs.writeFileSync(path.join(dir,'continued'),'x');process.exit(0)},500);"
    ), { workDir: root, limits, pollMs: 5, checkInterrupted: () => { if (interrupted) throw new Error("Upload interrupted; outcome needs inspection"); } });
    for (let n = 0; n < 200 && !(await readFile(path.join(root, "started")).catch(() => null)); n++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    interrupted = true;
    await expect(task).rejects.toThrow(/Upload interrupted/);
    expect(await readFile(path.join(root, "continued")).catch(() => null)).toBeNull();
  });
  it("reads the actual successful output and closes a clean process", async () => {
    await mkdir(path.join(root, "nested"));
    const result = await runBoundedExtraction(process.execPath, writer(root,
      "fs.writeFileSync(path.join(dir,'nested','fixture.txt'),'actual bytes');"
    ), { workDir: root, limits });
    expect(result).toEqual({ stderr: "", bytes: 12, entries: 2 });
    expect(await readFile(path.join(root, "nested", "fixture.txt"), "utf-8")).toBe("actual bytes");
  });
});
