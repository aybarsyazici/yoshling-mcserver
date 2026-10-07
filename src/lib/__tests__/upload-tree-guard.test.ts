import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { checkUploadTree } from "../upload-tree-guard";

let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(path.join(os.tmpdir(), "yoshling-tree-")); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

describe("extracted upload tree admission", () => {
  it("admits regular files and nested directories", async () => {
    await mkdir(path.join(scratch, "nested"));
    await writeFile(path.join(scratch, "nested", "dtm.raw"), "terrain");
    expect(await checkUploadTree(scratch)).toEqual({ ok: true });
  });

  it("rejects a dangling link without following it", async () => {
    await symlink(path.join(scratch, "missing"), path.join(scratch, "notes.txt"));
    expect(await checkUploadTree(scratch)).toEqual({ ok: false, entry: "notes.txt", kind: "symbolic link" });
  });

  it("rejects an internal link too", async () => {
    await writeFile(path.join(scratch, "dtm.raw"), "terrain");
    await symlink("dtm.raw", path.join(scratch, "another.raw"));
    expect(await checkUploadTree(scratch)).toMatchObject({ ok: false, kind: "symbolic link" });
  });

  it("rejects a FIFO instead of opening or preserving a special file", async () => {
    await promisify(execFile)("mkfifo", [path.join(scratch, "pipe")]);
    expect(await checkUploadTree(scratch)).toEqual({ ok: false, entry: "pipe", kind: "special file" });
  });

  it("does not claim an unreadable or disappeared tree passed", async () => {
    await expect(checkUploadTree(path.join(scratch, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
