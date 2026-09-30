import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading and writing `/opt/yoshling/.env` — the file the dashboard now owns.
 *
 * ## Why this file exists at all
 *
 * The round that moved the memory card and the Minecraft settings page off
 * `docker-compose.yml` and onto `.env` fixed the deploy-reverts-your-setting problem and
 * created a worse one nobody had before: compose is tracked in git, so clobbering it was
 * recoverable with `git checkout`, whereas `.env` is gitignored and is the **only** copy
 * of `AUTH_SECRET`, `DATABASE_URL`, `DISCORD_CLIENT_SECRET`, `RCON_PASSWORD`,
 * `SDTD_TELNET_PASSWORD`, `PZ_RCON_PASSWORD`, `PZ_ADMIN_PASSWORD` and `STEAM_API_KEY`.
 * Read on the box 2026-09-30: 903 bytes, `-rw-------`, 25 lines, and the only other copy
 * anywhere is one ad-hoc `.env.bak-telnet-rotate-*` from an unrelated rotation.
 *
 * Two defects followed from that, both fixed and both pinned here:
 *
 * - `readEnvFile` was `try { … } catch { return "" }`, so EACCES/EIO/EISDIR read as "no
 *   file yet". Its one caller reads, patches and writes straight back, so one failed read
 *   would have replaced every secret on the box with a 4-line file — and the read-back
 *   guard runs *after* the write, so the operator would have been told the setting failed
 *   while the damage was already done.
 * - `writeEnvFile` was a plain `writeFile`, i.e. truncate-then-write. The web container
 *   has a `mem_limit` and the compose comment plans for the kernel killing it; a kill
 *   inside that window leaves `.env` empty or short.
 *
 * These are properties, not current behaviour: "a read error is never mistaken for an
 * empty file" and "`.env` is never observable as a partial file" are what must stay true
 * however the implementation changes.
 */

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yoshling-env-"));
  envPath = path.join(dir, ".env");
  vi.resetModules();
  process.env.COMPOSE_ENV_FILE = envPath;
});

afterEach(() => {
  delete process.env.COMPOSE_ENV_FILE;
  rmSync(dir, { recursive: true, force: true });
});

/** `ENV_FILE` is resolved at module load, so each case needs a fresh import. */
async function compose() {
  return import("@/lib/compose");
}

describe("readEnvFile", () => {
  it("answers \"\" for a file that does not exist", async () => {
    const { readEnvFile } = await compose();
    await expect(readEnvFile()).resolves.toBe("");
  });

  it("returns the file's contents when it exists", async () => {
    writeFileSync(envPath, "AUTH_SECRET=abc\n", "utf-8");
    const { readEnvFile } = await compose();
    await expect(readEnvFile()).resolves.toBe("AUTH_SECRET=abc\n");
  });

  /**
   * The distinction the old bare `catch` destroyed. A directory where a file is expected
   * yields EISDIR, which stands in for any non-ENOENT error: the point is that the
   * function must not answer "" — because the caller would then overwrite the real file
   * with a patched version of that "".
   */
  it("rethrows an error that is not ENOENT rather than reporting an empty file", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(envPath);
    const { readEnvFile } = await compose();
    await expect(readEnvFile()).rejects.toThrow();
  });
});

describe("writeEnvFile", () => {
  it("writes the text", async () => {
    const { writeEnvFile } = await compose();
    await writeEnvFile("A=1\nB=2\n");
    expect(readFileSync(envPath, "utf-8")).toBe("A=1\nB=2\n");
  });

  /**
   * The atomicity property, expressed as the thing you can actually observe from
   * outside: the new bytes arrive by `rename`, so no intermediate state of `.env` is ever
   * a short file. Asserting "the temp file is gone and the target is whole" is the
   * closest a single-process test can get to it; a `writeFile`-in-place implementation
   * leaves no `.env.tmp` either, so this pairs with the next case, which is the one that
   * actually reddens on a truncating write.
   */
  it("leaves no temp file behind", async () => {
    const { writeEnvFile } = await compose();
    await writeEnvFile("A=1\n");
    expect(() => statSync(`${envPath}.tmp`)).toThrow();
  });

  /**
   * A truncate-in-place write cannot do this: the previous bytes are gone before the new
   * ones land, so there is nothing left to copy. Keeping one prior version matters
   * because the read-back guard downstream can only *detect* a bad write, and there is no
   * other backup of this file on the box.
   */
  it("keeps the previous contents as .env.bak", async () => {
    writeFileSync(envPath, "AUTH_SECRET=old\n", "utf-8");
    const { writeEnvFile } = await compose();
    await writeEnvFile("AUTH_SECRET=new\n");
    expect(readFileSync(envPath, "utf-8")).toBe("AUTH_SECRET=new\n");
    expect(readFileSync(`${envPath}.bak`, "utf-8")).toBe("AUTH_SECRET=old\n");
  });

  it("does not write a backup when there was no previous file", async () => {
    const { writeEnvFile } = await compose();
    await writeEnvFile("A=1\n");
    expect(() => statSync(`${envPath}.bak`)).toThrow();
  });

  /** A file of secrets must not be created 0644, and must not be widened if it was 0600. */
  it("leaves the file owner-only, whether it is new or replaced", async () => {
    const { writeEnvFile } = await compose();
    await writeEnvFile("A=1\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    chmodSync(envPath, 0o644);
    await writeEnvFile("A=2\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${envPath}.bak`).mode & 0o777).toBe(0o600);
  });

  /**
   * The whole point of a `.tmp`-and-rename is that a crash leaves a stale temp file; the
   * next write must not inherit its mode or refuse because of it.
   */
  it("overwrites a stale temp file left by an earlier crash", async () => {
    writeFileSync(`${envPath}.tmp`, "GARBAGE\n", { encoding: "utf-8", mode: 0o666 });
    const { writeEnvFile } = await compose();
    await writeEnvFile("A=1\n");
    expect(readFileSync(envPath, "utf-8")).toBe("A=1\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });
});
