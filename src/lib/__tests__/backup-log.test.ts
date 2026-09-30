import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The durable backup journal, and specifically **who a line says did the thing**.
 *
 * The journal exists because `Activity.userId` is a required FK, so the scheduler — which
 * has no user — cannot write an `Activity` row. `actor: null` therefore carries a
 * meaning: nobody asked, the timer did. The backups page renders it as "the scheduler".
 *
 * Which makes an empty string the dangerous value. The three routes build their actor as
 * `{userId, name: session.user.name ?? ""}`, and a Discord account with no display name
 * really does produce `""` — `createBackup` says so in as many words one file away, and
 * handles it (`startedBy: actor?.name ? {name: actor.name} : null`). `recordBackupEvent`
 * used `?? null`, which does not collapse `""`, so a person's prune, delete or restore
 * was journalled as `actor: ""` and rendered as "the scheduler pruned 2 old backups".
 *
 * The property, which is what these pin: **a recorded absence of an actor and a
 * recorded-but-blank actor must not produce the same sentence.** A log that attributes a
 * deletion to a timer nobody can question is worse than one with a gap in it.
 */

let dir: string;
let journal: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yoshling-journal-"));
  journal = path.join(dir, "backup-journal.jsonl");
  vi.resetModules();
  process.env.BACKUP_JOURNAL_FILE = journal;
});

afterEach(() => {
  delete process.env.BACKUP_JOURNAL_FILE;
  rmSync(dir, { recursive: true, force: true });
});

/** `JOURNAL_FILE` is resolved at module load, so each case needs a fresh import. */
async function log() {
  return import("@/lib/backup-log");
}

describe("recordBackupEvent — attribution", () => {
  it("records a named actor verbatim", async () => {
    const { recordBackupEvent, readJournal } = await log();
    await recordBackupEvent("zomboid", "create", { userId: "u1", name: "Aybars" }, {
      outcome: "ok",
      name: "zomboid-x.tar.gz",
    });
    const [entry] = await readJournal("zomboid");
    expect(entry.actor).toBe("Aybars");
  });

  /** The scheduler's own path: no actor at all, and no `Activity` row is even possible. */
  it("records null for the scheduler", async () => {
    const { recordBackupEvent, readJournal } = await log();
    await recordBackupEvent("zomboid", "create", null, { outcome: "ok" });
    const [entry] = await readJournal("zomboid");
    expect(entry.actor).toBeNull();
  });

  /**
   * The defect. An actor with an empty display name is still a person; the line must not
   * be indistinguishable from the scheduler's. `null` is the right recording because the
   * renderer's "the scheduler" branch is keyed on `null` — so the alternative would be to
   * keep `""` and teach every reader to special-case it, which is how one of these two
   * stores ended up disagreeing with the other in the first place.
   */
  it("does not record an empty display name as if a person had been named", async () => {
    const { recordBackupEvent, readJournal } = await log();
    await recordBackupEvent("zomboid", "prune", { userId: "u1", name: "" }, {
      outcome: "ok",
      names: ["a.tar.gz", "b.tar.gz"],
    });
    const [entry] = await readJournal("zomboid");
    expect(entry.actor).not.toBe("");
    expect(entry.actor).toBeNull();
  });
});

describe("readJournal", () => {
  it("returns newest first and filters by world", async () => {
    const { journalBackup, readJournal } = await log();
    await journalBackup({ game: "minecraft", event: "create", outcome: "ok", actor: "a" });
    await journalBackup({ game: "zomboid", event: "create", outcome: "ok", actor: "b" });
    await journalBackup({ game: "minecraft", event: "delete", outcome: "ok", actor: "c" });
    expect((await readJournal("minecraft")).map((e) => e.actor)).toEqual(["c", "a"]);
    expect((await readJournal(null)).map((e) => e.actor)).toEqual(["c", "b", "a"]);
  });

  /**
   * A container killed mid-append leaves a torn last line. Dropping it must not take the
   * history with it — the whole point of an append-only file is that the past is still
   * readable after the present went wrong.
   */
  it("drops an unparseable line rather than throwing", async () => {
    const { journalBackup, readJournal } = await log();
    await journalBackup({ game: "zomboid", event: "create", outcome: "ok", actor: "a" });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(journal, '{"at":"2026-09-30T00:00:00.000Z","ga', "utf-8");
    const entries = await readJournal("zomboid");
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe("a");
  });

  it("answers [] when there is no journal yet", async () => {
    const { readJournal } = await log();
    await expect(readJournal(null)).resolves.toEqual([]);
  });
});
