import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");

async function script(name: string): Promise<string> {
  return readFile(path.join(ROOT, "scripts", name), "utf-8");
}

/**
 * The script with its comment lines removed.
 *
 * Needed because the fix for this bug is documented *in* the script, and the comment quotes the
 * broken form verbatim — so the first version of these tests matched their own explanation of
 * what they forbid and failed against a correct script. A guard that cannot tell code from prose
 * fires on the description of the thing it is guarding against.
 */
async function code(name: string): Promise<string> {
  return (await script(name))
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/**
 * **`scripts/deploy.sh --verify` is the one check standing between "the checkout is right" and
 * "the running image is right", and for its entire existence it could not fail.**
 *
 * It was `if docker exec … sh -c "grep -rql -- '$VERIFY' /app/.next/server | head -1"`. A
 * pipeline's exit status is its *last* command's, and `head -1` exits 0 on empty input — so the
 * `if` succeeded whether or not grep matched anything. Measured on the live box 2026-10-02: the
 * invented string `zzzz_definitely_not_present_9f3a` reported `found`.
 *
 * That is this project's named defect class — reporting success after checking nothing — sitting
 * inside the single script written to prevent it, and it had quietly certified every deploy for
 * weeks. CLAUDE.md describes this script's purpose as catching exactly the case it could not
 * catch: "a correct checkout can sit in front of a stale container and `git rev-parse` looks
 * identical either way."
 *
 * A shell script has no unit tests, so this is a source assertion. It is narrow on purpose: it
 * does not try to understand the script, only to refuse the two mistakes that produced the bug.
 */
describe("deploy.sh --verify can actually fail", () => {
  it("tests grep's own exit status, with nothing piped after it", async () => {
    const s = await code("deploy.sh");
    const line = s.split("\n").find((l) => l.includes("grep -rqF") && l.includes("if "));
    expect(line, "the verify should use `grep -rqF` inside the `if`").toBeTruthy();
    // The whole bug in one assertion: no pipe may follow the grep, because then the `if` tests
    // whatever is downstream instead.
    expect(line).not.toContain("|");
  });

  it("uses -q, so the exit status is the answer rather than the output", async () => {
    const s = await code("deploy.sh");
    expect(s).toMatch(/grep -rqF?/);
    // `-l` prints filenames and exits 0 on a match, which is what invited a pipe in the first
    // place. `-q` prints nothing and says yes-or-no, so there is nothing to trim.
    expect(s).not.toMatch(/grep -rql/);
  });

  /**
   * `-F` is not pedantry. A verify string is a literal taken from the command line, and the
   * ones actually used contain regex metacharacters — `modsDirRefusal(plan, modpack.mods.length)`
   * has parentheses and dots. Read as a pattern, `.` matches any character, so a near-miss in the
   * bundle would satisfy a check for text that is not there.
   */
  it("treats the verify string as a literal", async () => {
    expect(await code("deploy.sh")).toMatch(/grep -r[a-z]*F/);
  });

  /**
   * The same shape anywhere else in the script would be the same bug. `grep … | head` is the
   * specific combination to refuse; other pipes are fine.
   */
  it("has no grep-piped-into-head anywhere, which is the shape that hid this", async () => {
    const s = await code("deploy.sh");
    expect(s).not.toMatch(/grep[^\n|]*\|\s*head/);
  });
});
