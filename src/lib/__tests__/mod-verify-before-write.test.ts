import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The guarantee this file pins: **a jar that fails its checksum never exists in the mods
 * directory.**
 *
 * Not "is deleted afterwards" — never written. The difference is the whole point: a
 * write-then-check leaves a corrupt jar on disk for as long as the check takes, and leaves
 * the cleanup on a path that can itself fail. The Minecraft server reads that directory on
 * boot and does not care what order our cleanup ran in.
 *
 * Checked by reading the source, for the same reason `permissions.test.ts` greps for
 * negated `hasPermission` gates rather than executing route handlers: these functions need
 * Prisma, `fetch`, a mods directory and a `NextRequest`, which is the
 * Docker-and-network line this suite does not cross. What a source guard buys is that the
 * ORDER cannot be reversed while every behavioural test stays green — and it would, because
 * the bytes on disk are identical in the passing case. That exact blind spot is recorded in
 * `docs/OPERATIONS.md`: the streaming upload's tests all passed when `pipeline()` was
 * replaced by the `ws.write()` loop its own header warns against, "because the bytes on disk
 * are identical and that is all they checked".
 */

const SRC = path.resolve(__dirname, "..", "..");

async function text(rel: string): Promise<string> {
  return readFile(path.join(SRC, rel), "utf-8");
}

/**
 * The body of a named top-level function, so "before" and "after" mean inside one function
 * rather than anywhere in the file. Sliced from the declaration to the next top-level
 * `export`, which is enough for these files and does not need a brace matcher.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^export (?:async )?(?:function|class) ${name}\\b`, "m"));
  if (start < 0) throw new Error(`no top-level export named ${name} — the guard is pointing at nothing`);
  const after = source.slice(start + 1);
  const end = after.search(/^export /m);
  return end < 0 ? after : after.slice(0, end);
}

describe("a corrupt jar is never written to the mods directory", () => {
  it("hashes the download before it hands back a buffer, and throws in between", async () => {
    const body = functionBody(await text("lib/mod-manager.ts"), "downloadVerifiedJar");

    const gotBytes = body.indexOf("arrayBuffer()");
    const checked = body.indexOf("checkIntegrity(");
    const threw = body.indexOf("throw new ModIntegrityError");
    const returned = body.indexOf("return {");

    // Sanity-check the markers before trusting the verdict. A guard whose anchors have
    // been renamed away finds nothing out of order and passes, which is the failure mode
    // that makes a green suite mean nothing.
    expect([gotBytes, checked, threw, returned].every((i) => i >= 0)).toBe(true);

    expect(checked).toBeGreaterThan(gotBytes);
    expect(threw).toBeGreaterThan(checked);
    expect(returned).toBeGreaterThan(threw);

    // And the helper must not write anything itself: it returns bytes, the caller writes
    // them. A `writeFile` in here would put a file on disk before the caller has even seen
    // the verdict.
    expect(body).not.toMatch(/writeFile\(/);
  });

  /**
   * One verified download path, not two. `installMod` and `updateMod` each had their own
   * `fetch` → `arrayBuffer` → `writeFile` sequence, which is how both came to be missing
   * the same check — the power control in this repo drifted into three copies and two of
   * them missed a fix, and that is the standing argument against a second copy.
   */
  it("gives installMod and updateMod no way to fetch bytes of their own", async () => {
    const source = await text("lib/mod-manager.ts");
    for (const fn of ["installMod", "updateMod"]) {
      const body = functionBody(source, fn);
      expect(body, fn).toContain("downloadVerifiedJar(");
      // The raw primitives, which are what an unverified download is made of.
      expect(body, fn).not.toContain("arrayBuffer()");
      expect(body, fn).not.toMatch(/await fetch\(/);
      // It still writes — this is the function that puts the jar on disk — and the write
      // has to come after the verified download it got the buffer from.
      expect(body.indexOf("writeFile("), fn).toBeGreaterThan(body.indexOf("downloadVerifiedJar("));
    }
  });

  /**
   * The modpack installer's direct-download (Technic/Solder) branch does not go through
   * `installMod`, so it is a third writer and needs the same order. It publishes no
   * checksum today, so the check currently answers "nothing to compare against" — the
   * branch exists so that the day a direct source does publish one, a bad file is refused
   * rather than written.
   */
  it("checks the direct-download branch before writing it too", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");

    const gotBytes = source.indexOf("arrayBuffer()");
    const checked = source.indexOf("checkIntegrity(");
    const wrote = source.indexOf("writeFile(path.join(getModsDir()");

    expect([gotBytes, checked, wrote].every((i) => i >= 0)).toBe(true);
    expect(checked).toBeGreaterThan(gotBytes);
    expect(wrote).toBeGreaterThan(checked);

    // There is exactly one place in this route that writes into the mods directory. A
    // second one would not be covered by the ordering asserted above.
    expect(source.split("writeFile(").length - 1).toBe(1);
  });

  /**
   * The empty-plan refusal must stay an `op.reject`.
   *
   * `tests/operations-outcome.test.ts` pins what the registry concludes from each possible
   * marking — `reject` → `failed` with the reason in the summary, a `noop` count → `partial`
   * summarising untried client-only mods as "45 failed", a plain `done` settle →
   * `unverified`. None of those tests can see which one this route picks, so the choice
   * itself needs a guard or it regresses silently and the request still answers 409.
   */
  it("marks the all-client-only refusal as a rejection, not a settled step", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");
    const reason = "No mod in this pack runs on a server";
    expect(source).toContain(reason);
    // The reason string must be the argument to `op.reject`, not to a settle.
    expect(source).toMatch(new RegExp(`op\\.reject\\(\\s*\`${reason}\``));
  });

  /**
   * The plan step must settle `done` even when it planned fewer mods than the pack holds.
   *
   * The highest-stakes line in the whole change and the one with no behavioural test
   * reachable from here: `concludeOperation` turns ANY `noop` step into outcome `partial`,
   * so a `kind: "noop"` on this step would make every correct apply of every real pack
   * amber — a large pack is 30-50% client mods — and summarise a flawless install as
   * something having gone wrong. Exactly the backup regression this repo's suite was
   * created over. A request-level test cannot see it (the HTTP response is unchanged and
   * still 200), so the guard reads the call.
   */
  it("settles the plan step done, never noop, when mods were skipped", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");
    const from = source.indexOf("`Checked which mods run on a server —");
    expect(from).toBeGreaterThan(0);
    const rest = source.slice(from);
    const to = rest.indexOf("op.step(");
    expect(to).toBeGreaterThan(0);
    // Comments stripped first: the explanation inside this very call uses the word "noop",
    // and matching it would make the guard fail on the correct code — a guard that cannot
    // pass is deleted rather than fixed.
    const call = rest.slice(0, to).replace(/\/\/.*$/gm, "");
    expect(call).toContain('noun: "to install"'); // the right call was captured
    expect(call).not.toContain("noop");
    expect(call).not.toContain("kind:");
  });

  /**
   * The client/server filter must be one decision shared by both installers, for the same
   * reason as the download: the single-mod route and the 166-mod route deciding
   * differently about the same jar is the drift this codebase keeps paying for.
   */
  it("routes both installers through the one server-side decision", async () => {
    for (const rel of ["app/api/mods/install/route.ts", "app/api/mods/install-modpack/route.ts"]) {
      const source = await text(rel);
      expect(source, rel).toMatch(/serverSideFor\(/);
      // Neither route may reimplement the enum. Matched on the COMPARISON, not on the
      // token: a comment that mentions `client_only` is fine and useful, while
      // `version.environment === "client_only"` in a route is a second copy of the
      // mapping — which is how `client_only_server_optional`, the value that reads like a
      // skip and is not one, gets "simplified" into one.
      expect(source, rel).not.toMatch(/environment\s*[=!]==/);
      expect(source, rel).not.toMatch(/[=!]==\s*["']client_/);
      expect(source, rel).not.toMatch(/["']client_[a-z_]*["']\s*\.includes|includes\(\s*["']client/);
    }
  });
});
