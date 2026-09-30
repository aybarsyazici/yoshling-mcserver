import { describe, expect, it } from "vitest";
import { pluralNoun, pluralise } from "@/lib/format";

/**
 * Pins the actual production wrong answer.
 *
 * The Workshop watcher's summary read **"1 mods updated"** on 2026-09-30 — recorded in
 * `/api/operations` as `"Finished in 53s. 1 mods updated, the server is back up."`. The
 * noun comes from `op.progress({noun: "mods"})`, which is correct for the progress line
 * ("3 of 6 mods") and wrong the moment the count lands on one.
 *
 * Small, but the summary sentence is the one thing a person reads about an operation, and
 * the whole point of `summarize()` is that the app does not say things that are not so.
 */
describe("pluralNoun — a count's noun, for a noun that arrives already plural", () => {
  it("makes a plural noun singular at exactly one", () => {
    expect(pluralNoun(1, "mods")).toBe("mod");
    expect(pluralNoun(1, "files")).toBe("file");
    expect(pluralNoun(1, "MB")).toBe("MB"); // no trailing s: left alone
  });

  it("leaves it plural for zero and for many", () => {
    // Zero is plural in English ("0 mods"), which is the case a naive `n > 1` gets wrong.
    expect(pluralNoun(0, "mods")).toBe("mods");
    expect(pluralNoun(2, "mods")).toBe("mods");
    expect(pluralNoun(166, "mods")).toBe("mods");
  });

  it("handles an -ies plural", () => {
    expect(pluralNoun(1, "entries")).toBe("entry");
    expect(pluralNoun(3, "entries")).toBe("entries");
  });

  it("reproduces the exact production sentence, fixed", () => {
    const count = { done: 1, noun: "mods" };
    expect(`${count.done} ${pluralNoun(count.done, count.noun)} updated`).toBe("1 mod updated");
    const many = { done: 6, noun: "mods" };
    expect(`${many.done} ${pluralNoun(many.done, many.noun)} updated`).toBe("6 mods updated");
  });
});

describe("pluralise — a count with a singular noun", () => {
  it("adds s only past one", () => {
    expect(pluralise(1, "backup")).toBe("1 backup");
    expect(pluralise(0, "backup")).toBe("0 backups");
    expect(pluralise(5, "backup")).toBe("5 backups");
  });

  it("takes an explicit plural where s is wrong", () => {
    expect(pluralise(1, "entry", "entries")).toBe("1 entry");
    expect(pluralise(4, "entry", "entries")).toBe("4 entries");
  });
});
