import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { resolveSafeFilePath } from "../file-guard";

let temp: string;
let root: string;
let outside: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "yoshling-physical-path-"));
  root = path.join(temp, "world");
  outside = path.join(temp, "world-other");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, "local.txt"), "local");
  await writeFile(path.join(outside, "external.txt"), "external");
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("resolveSafeFilePath", () => {
  it("uses the canonical configured root, even when the root itself is a link", async () => {
    const alias = path.join(temp, "configured-root");
    await symlink(root, alias);
    expect(await resolveSafeFilePath(alias, "local.txt")).toBe(path.join(await realpath(root), "local.txt"));
    expect(await resolveSafeFilePath(alias, "")).toBe(await realpath(root));
  });

  it("rejects links to external files and directories", async () => {
    await symlink(path.join(outside, "external.txt"), path.join(root, "file.txt"));
    await symlink(outside, path.join(root, "directory"));
    expect(await resolveSafeFilePath(root, "file.txt")).toBeNull();
    expect(await resolveSafeFilePath(root, "directory/external.txt")).toBeNull();
  });

  it("rejects an external parent before admitting multiple missing path components", async () => {
    await symlink(outside, path.join(root, "directory"));
    expect(await resolveSafeFilePath(root, "directory/new/child.txt", { allowMissing: true })).toBeNull();
  });

  it("admits missing components only after a contained existing parent", async () => {
    await mkdir(path.join(root, "nested"));
    expect(await resolveSafeFilePath(root, "nested/new/child.txt", { allowMissing: true }))
      .toBe(path.join(await realpath(root), "nested/new/child.txt"));
    await expect(resolveSafeFilePath(root, "nested/new/child.txt"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks dangling links rather than treating them as missing new files", async () => {
    await symlink(path.join(outside, "absent"), path.join(root, "dangling"));
    expect(await resolveSafeFilePath(root, "dangling/new.txt", { allowMissing: true })).toBeNull();
    expect(await resolveSafeFilePath(root, "dangling", { allowMissing: true })).toBeNull();
  });

  it("refuses symlink loops", async () => {
    await symlink("loop", path.join(root, "loop"));
    expect(await resolveSafeFilePath(root, "loop", { allowMissing: true })).toBeNull();
  });

  it("preserves internal links for reads and creates using their canonical parent", async () => {
    await mkdir(path.join(root, "nested"));
    await symlink("nested", path.join(root, "alias"));
    expect(await resolveSafeFilePath(root, "alias/new.txt", { allowMissing: true }))
      .toBe(path.join(await realpath(root), "nested/new.txt"));
  });

  it("can remove a final contained link without removing its target", async () => {
    await symlink("local.txt", path.join(root, "alias"));
    expect(await resolveSafeFilePath(root, "alias"))
      .toBe(path.join(await realpath(root), "local.txt"));
    expect(await resolveSafeFilePath(root, "alias", { followFinalSymlink: false }))
      .toBe(path.join(await realpath(root), "alias"));
  });

  it("rejects both lexical and physical root aliases for mutations", async () => {
    await symlink(".", path.join(root, "root-alias"));
    for (const candidate of ["", ".", root, "root-alias"]) {
      expect(await resolveSafeFilePath(root, candidate, { allowRoot: false })).toBeNull();
    }
  });

  it("rejects the sibling prefix without accessing that tree", async () => {
    expect(await resolveSafeFilePath(root, outside)).toBeNull();
  });

  it("rejects malformed paths and preserves the existing lexical restrictions", async () => {
    for (const candidate of [null, 12, {}, ["local.txt"], "\0", "../world-other/external.txt", "~", "node_modules/x"]) {
      expect(await resolveSafeFilePath(root, candidate, { allowMissing: true })).toBeNull();
    }
  });

  it("propagates a genuine filesystem error rather than admitting it as a missing suffix", async () => {
    await expect(resolveSafeFilePath(root, "local.txt/new.txt", { allowMissing: true }))
      .rejects.toMatchObject({ code: "ENOTDIR" });
    expect((await lstat(path.join(root, "local.txt"))).isFile()).toBe(true);
  });
});
