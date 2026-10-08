import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMinecraftProfileOperationMarker } from "@/lib/minecraft-profile-operation-marker";
import { runOperation } from "@/lib/operations";
let root: string;
let operations: string;
let previousRoot: string | undefined;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "minecraft-operation-marker-")); operations = path.join(root, "private-operations"); vi.stubEnv("MC_PROFILE_OPERATIONS_DIR", operations); previousRoot = process.env.MC_SERVER_DIR; process.env.MC_SERVER_DIR = root; });
afterEach(async () => { vi.unstubAllEnvs(); if (previousRoot === undefined) delete process.env.MC_SERVER_DIR; else process.env.MC_SERVER_DIR = previousRoot; await rm(root, { recursive: true, force: true }); });

describe("private durable profile lifecycle markers", () => {
  it("writes a private verified marker before work and removes only its own marker afterward", async () => {
    await mkdir(operations, { mode: 0o755 });
    const existing = path.join(operations, ".operation-switch-old.json"); await writeFile(existing, "old unverified operation", { mode: 0o600 });
    const value = await runOperation({ kind: "profile.switch", game: "minecraft", title: "Selecting" }, async op => {
      return withMinecraftProfileOperationMarker(op, "switch", async () => {
        const markers = await readdir(operations); expect(markers).toHaveLength(2);
        const own = markers.find(name => name !== ".operation-switch-old.json")!;
        expect((await lstat(path.join(operations, own))).mode & 0o777).toBe(0o600);
        expect((await lstat(operations)).mode & 0o777).toBe(0o700);
        expect(JSON.parse(await readFile(path.join(operations, own), "utf8"))).toEqual({ formatVersion: 1, kind: "switch", operationId: op.id });
        return { value: "selected" };
      });
    });
    expect(value).toBe("selected");
    expect(await readdir(operations)).toEqual([".operation-switch-old.json"]);
    expect(await readFile(existing, "utf8")).toBe("old unverified operation");
  });

  it("clears its owned marker after a controlled failure without cleaning crash leftovers", async () => {
    await expect(runOperation({ kind: "profile.adopt", game: "minecraft", title: "Adopting" }, async op => {
      return withMinecraftProfileOperationMarker(op, "adopt", async () => { throw new Error("controlled refusal"); });
    })).rejects.toThrow(/controlled refusal/);
    expect(await readdir(operations)).toEqual([]);
  });

  it("does not remove a replaced marker or erase a verified work result", async () => {
    const value = await runOperation({ kind: "profile.switch", game: "minecraft", title: "Selecting" }, async op => {
      return withMinecraftProfileOperationMarker(op, "switch", async () => {
        const marker = (await readdir(operations))[0];
        const file = path.join(operations, marker);
        await rm(file); await writeFile(file, "replacement requires review", { mode: 0o600 });
        return { value: "world ready" };
      });
    });
    expect(value).toBe("world ready");
    const markers = await readdir(operations); expect(markers).toHaveLength(1);
    expect(await readFile(path.join(operations, markers[0]), "utf8")).toBe("replacement requires review");
  });

  it("refuses lifecycle work when private marker storage cannot be prepared", async () => {
    await writeFile(operations, "not a directory"); let ran = false;
    await expect(runOperation({ kind: "profile.switch", game: "minecraft", title: "Selecting" }, async op => {
      return withMinecraftProfileOperationMarker(op, "switch", async () => { ran = true; return { value: null }; });
    })).rejects.toThrow(/separate private directory/);
    expect(ran).toBe(false);
  });
});
