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
/**
 * Line and block comments removed, so a guard can forbid a phrase that the *explanation* of
 * the fix legitimately quotes. Several comments in these files quote the wrong sentence they
 * replaced — which is the most useful thing a comment can do here and must not be what makes
 * a guard red on correct code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

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
   * `installMod`, so it is a third writer and needs the same order.
   *
   * It must also check against something **real**. It used to pass a literal `{}` to
   * `checkIntegrity`, which can only answer `{ok: true}` — so the refusal below it was
   * unreachable code, on the one path with no registry hashes at all, carrying a comment
   * claiming it was "unreachable today, live tomorrow". `declaredFromHeaders` reads the
   * response's `Content-Length`, which is the declaration that was available the whole
   * time; `mod-admission.test.ts` drives that comparison end to end.
   */
  it("checks the direct-download branch against the response, before writing it", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");

    const gotBytes = source.indexOf("arrayBuffer()");
    const checked = source.indexOf("checkIntegrity(");
    const admitted = source.indexOf("await modFilePath(getModsDir(), fileName)");
    const wrote = source.indexOf("writeFile(filePath, buffer)");
    const readBack = source.indexOf("readFile(filePath)");
    const recorded = source.indexOf("await db.installedMod.create(");

    expect([gotBytes, checked, admitted, wrote, readBack, recorded].every((i) => i >= 0)).toBe(true);
    expect(checked).toBeGreaterThan(gotBytes);
    expect(wrote).toBeGreaterThan(checked);
    expect(wrote).toBeGreaterThan(admitted);
    expect(readBack).toBeGreaterThan(wrote);
    expect(recorded).toBeGreaterThan(readBack);

    // The declaration comes off the response, not from a literal. `checkIntegrity({}, …)`
    // is the dead-guard shape and must not come back.
    expect(source).toMatch(/checkIntegrity\(declaredFromHeaders\(response\.headers\)/);
    expect(source).not.toMatch(/checkIntegrity\(\{\}/);

    // There is exactly one place in this route that writes into the mods directory. A
    // second one would not be covered by the ordering asserted above.
    const direct = source.slice(source.indexOf('if (item.kind === "direct")'));
    expect(direct.split("writeFile(").length - 1).toBe(1);
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
  it("routes the empty-plan refusal through op.reject, not a settled step", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");
    // The wording moved into `modsDirRefusal` (tested behaviourally in mod-plan.test.ts)
    // precisely so that a recheck could not silence the guard by editing an inline `if`.
    // What has to hold *here* is that whatever it returns becomes a rejection: `op.reject`
    // gives outcome `failed`, while a settle would make a refused apply read as a completed
    // one with a count of zero.
    expect(source).toContain("modsDirRefusal(plan, modpack.mods.length)");
    expect(source).toMatch(/op\.reject\(\s*refusal\s*\)/);
    // **The guard expression itself, verbatim.** Asserting only that the pieces are present
    // is not enough: `if (false && refusal)` keeps every string this test looks for and
    // passed all 1102 tests when tried. The condition has to be exactly the refusal, with
    // nothing conjoined that could switch it off.
    expect(source).toMatch(/\n {2}if \(refusal\) \{\n/);
    // And it must be decided before anything is backed up or deleted.
    //
    // The landmark is the backup phase's **first** act — the probe for what there is to
    // archive — rather than its `op.step`, which used to be the literal
    // `op.step("Backing the world up first")` and is now built from the members found.
    // `indexOf` answers -1 for a string that is not there, and -1 is less than everything,
    // so a landmark that stops existing silently satisfies both of these: the `>= 0` check
    // is what makes that a failure instead.
    const refusalAt = source.indexOf("modsDirRefusal");
    const probedAt = source.indexOf("archiveMembersPresent(MC_DIR)");
    const removedAt = source.indexOf('op.step("Removing the current mods")');
    expect([refusalAt, probedAt, removedAt].every((i) => i >= 0)).toBe(true);
    expect(refusalAt).toBeLessThan(probedAt);
    expect(refusalAt).toBeLessThan(removedAt);
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
   *
   * `/api/mods/install` calls `serverSideFor` directly; `install-modpack` hands it to
   * `planModpackInstall` as the `sideFor` dependency. Either way the decision is the one in
   * `mod-manager.ts`, and neither route may reimplement the enum.
   */
  it("routes both installers through the one server-side decision", async () => {
    for (const rel of ["app/api/mods/install/route.ts", "app/api/mods/install-modpack/route.ts"]) {
      const source = await text(rel);
      expect(source, rel).toMatch(/\bserverSideFor\b/);
      // Matched on the COMPARISON, not on the token: a comment that mentions `client_only`
      // is fine and useful, while `version.environment === "client_only"` in a route is a
      // second copy of the mapping — which is how `client_only_server_optional`, the value
      // that reads like a skip and is not one, gets "simplified" into one.
      expect(source, rel).not.toMatch(/environment\s*[=!]==/);
      expect(source, rel).not.toMatch(/[=!]==\s*["']client_/);
      expect(source, rel).not.toMatch(/["']client_[a-z_]*["']\s*\.includes|includes\(\s*["']client/);
    }
  });

  /**
   * **The plan pass lives in a module a test can reach, and the route must keep using it.**
   *
   * These decisions were inline in the route, where nothing could execute them, and an
   * adversarial review turned that into two surviving mutants in minutes: `if (false &&
   * !side.install)` deleted the whole client-only filter and `serverModTotal(…)` →
   * `plan.length` substituted the denominator the route's own comment calls the one that
   * "hides failures". Both passed 762 tests. `src/lib/__tests__/mod-plan.test.ts` asserts
   * the behaviour; this asserts the route has not grown a second copy of it, because a test
   * on an extracted module is worth nothing if the caller stops calling it.
   */
  it("keeps the modpack installer's plan in the module the tests can drive", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");
    expect(source).toMatch(/await planModpackInstall\(\{/);
    // The denominator comes off the plan, not recomputed here — one definition, and the
    // plan's own tests pin it.
    expect(source).toMatch(/const total = plan\.total;/);
    expect(source).not.toMatch(/serverModTotal\(/);
    // And the route does not re-derive a total from the plan's length, which is the
    // substitution that reads "163 of 163 — complete" with three failures beside it.
    expect(source).not.toMatch(/total\s*=\s*plan\.items\.length/);
  });

  /**
   * **Client-only skips must not enter the amber warning channel.**
   *
   * They did, *and* they were returned in `skipped`, so the same correct decision rendered
   * twice in `modpacks.tsx` — once in `chart-5` (the warning colour) and once in the world's
   * accent under a heading saying nothing went wrong. The colour is a claim.
   * `mod-admission.test.ts` pins that `applyReport` leaves `warnings` empty for a
   * skip-only shortfall; this pins that the route does not go around it.
   */
  it("does not push the skip sentence into the route's warnings", async () => {
    const source = await text("app/api/mods/install-modpack/route.ts");
    expect(source).not.toMatch(/warnings\.push\(\s*skippedSentence/);
    // The helper is still used — as the operation fact, which is plain-toned. A guard that
    // only forbade the push would also pass if the skips stopped being reported at all.
    expect(source).toMatch(/skippedSentence\(skipped, 5\)/);
  });

  /**
   * **`/api/mods/install` answers twice about a client-only mod, and the two answers must
   * say the same thing.**
   *
   * They did not. The 409 refusal warned that such a jar may "stop the server from starting";
   * the success message returned when `allowClientOnly` forces it through said it "will not
   * do anything on a server" — the reassuring version, on the one path where the warning
   * matters, since that caller has just overridden the refusal.
   *
   * Both now read `CLIENT_ONLY_CONSEQUENCE`. The guard is that the route never spells the
   * consequence out for itself, so the two cannot drift apart again: a softer paraphrase in
   * either place either drops a use of the constant or reintroduces the literal.
   */
  it("gives the same client-only consequence in both of its answers", async () => {
    const source = await text("app/api/mods/install/route.ts");
    // The import plus one use in the refusal and one in the success message.
    expect((source.match(/CLIENT_ONLY_CONSEQUENCE/g) ?? []).length).toBeGreaterThanOrEqual(3);

    // Comments stripped before the negative assertions, because the comment on the fixed
    // line *quotes the old wrong sentence* — which is worth keeping and would otherwise make
    // this guard fail on the correct code. Same reason the plan-step guard above strips
    // them: a guard that cannot pass gets deleted rather than fixed.
    const code = stripComments(source);
    // The wording lives in the constant, not here — the only way the two can be guaranteed
    // identical. A literal copy is drift waiting to happen even when it starts out correct.
    expect(code).not.toMatch(/stop the server from starting/);
    // And the sentence that was wrong cannot come back under any phrasing of the branch.
    expect(code).not.toMatch(/will not do anything on a server/);
  });
});
