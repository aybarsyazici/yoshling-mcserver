import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * **The provenance migration, executed.**
 *
 * Production runs **no automatic migrations** — the SQL in `prisma/migrations/` is applied
 * by hand, and `CLAUDE.md` keeps the worked example of that going wrong: a migration headed
 * "Pending" two hundred lines above a Status section saying it was applied. So the file is
 * the only artefact, and until this test nothing anywhere executed it: a mutation that
 * deleted the whole backfill left every one of the 1346 tests green.
 *
 * Run against an **in-memory libSQL database** — the same client the production DB is read
 * through (`@libsql/client`), no Docker, no network, no file. The pre-migration table is
 * created from `20260519104842_init`'s own `InstalledMod` shape rather than a hand-written
 * approximation, because the thing under test is whether this statement applies to *that*
 * table.
 *
 * Two properties, and the second is the one worth having:
 *
 * 1. the two columns arrive, nullable;
 * 2. **the rows that were already there come out `'manual'`.** Omit that and the Installed
 *    page reads "source not recorded" for all three production mods — which is not wrong
 *    exactly, but it is a worse answer than the true one, and the true one is knowable:
 *    each of those three was installed on its own, before any pack had ever been applied.
 */

const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");

/** Statements, split on `;` with the `--` comment lines dropped. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migrationSql(name: string): Promise<string> {
  return readFile(path.join(MIGRATIONS, name, "migration.sql"), "utf-8");
}

/** The `CREATE TABLE "InstalledMod"` statement out of the initial migration. */
async function initialInstalledModTable(): Promise<string> {
  const sql = await migrationSql("20260519104842_init");
  const found = statements(sql).find((s) => /CREATE TABLE "InstalledMod"/.test(s));
  if (!found) throw new Error("the init migration no longer creates InstalledMod");
  return found;
}

async function migratedDb() {
  const db = createClient({ url: ":memory:" });
  await db.execute(await initialInstalledModTable());
  // Three rows, as production has: installed one at a time, before any pack existed.
  for (const [i, file] of [
    "fabric-api-0.149.1+26.1.2.jar",
    "xaerominimap-fabric-26.1.2-25.3.14.jar",
    "xaeroworldmap-fabric-26.1.2-1.40.18.jar",
  ].entries()) {
    await db.execute({
      sql: `INSERT INTO "InstalledMod"
              (id, modrinthId, slug, name, version, fileName, mcVersion, loader, installedBy, installedAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `row-${i}`,
        `proj-${i}`,
        `slug-${i}`,
        `Mod ${i}`,
        "1.0.0",
        file,
        "26.1.2",
        "fabric",
        "u1",
        "2026-10-01 00:00:00",
        "2026-10-01 00:00:00",
      ],
    });
  }

  for (const stmt of statements(
    await migrationSql("20261002143000_add_installed_mod_provenance")
  )) {
    await db.execute(stmt);
  }
  return db;
}

describe("20261002143000_add_installed_mod_provenance", () => {
  it("adds both columns and leaves them nullable", async () => {
    const db = await migratedDb();
    const cols = await db.execute(`PRAGMA table_info("InstalledMod")`);
    const byName = new Map(
      cols.rows.map((r) => [String(r.name), { notnull: Number(r.notnull), type: String(r.type) }])
    );
    expect(byName.get("source")).toEqual({ notnull: 0, type: "TEXT" });
    expect(byName.get("versionId")).toEqual({ notnull: 0, type: "TEXT" });
  });

  it("backfills every pre-existing row to manual", async () => {
    const db = await migratedDb();
    const rows = await db.execute(`SELECT fileName, source, versionId FROM "InstalledMod"`);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((r) => r.source)).toEqual(["manual", "manual", "manual"]);
    // And **not** `versionId`, which cannot be reconstructed: a version number is a
    // publisher's free text and does not identify a build. Inventing one would make
    // increment 5's pinning read a value nobody measured.
    expect(rows.rows.map((r) => r.versionId)).toEqual([null, null, null]);
  });

  it("writes a row with no source after it, so the column stays genuinely nullable", async () => {
    // The backfill is a one-off statement, not a DEFAULT: a row inserted afterwards with no
    // source has none. That is what makes "not recorded" a state the surface has to render
    // — a restore puts rows back from an archive that never carried provenance.
    const db = await migratedDb();
    await db.execute({
      sql: `INSERT INTO "InstalledMod"
              (id, modrinthId, slug, name, version, fileName, mcVersion, loader, installedBy, installedAt, updatedAt)
            VALUES ('later', 'p', 's', 'Later', '1', 'later.jar', '26.1.2', 'fabric', 'u1', '2026-10-02 00:00:00', '2026-10-02 00:00:00')`,
      args: [],
    });
    const row = await db.execute(`SELECT source FROM "InstalledMod" WHERE id = 'later'`);
    expect(row.rows[0].source).toBe(null);
  });

  it("is idempotent for the backfill, so a re-run cannot relabel a pack's rows", async () => {
    // The hand-apply is a human pasting SQL into a container, and the one that gets pasted
    // twice is the one that reads as having failed. `WHERE source IS NULL` is why a second
    // run is harmless; without it, re-running after the next pack apply would rewrite every
    // `'pack'` row to `'manual'` and silently undo the column's whole purpose.
    const db = await migratedDb();
    await db.execute(`UPDATE "InstalledMod" SET source = 'pack' WHERE id = 'row-0'`);
    for (const stmt of statements(
      await migrationSql("20261002143000_add_installed_mod_provenance")
    )) {
      // The two ALTERs now fail (duplicate column), which is expected of a re-run; the
      // UPDATE is the statement under test.
      await db.execute(stmt).catch(() => {});
    }
    const rows = await db.execute(`SELECT id, source FROM "InstalledMod" ORDER BY id`);
    expect(rows.rows.map((r) => [r.id, r.source])).toEqual([
      ["row-0", "pack"],
      ["row-1", "manual"],
      ["row-2", "manual"],
    ]);
  });
});
