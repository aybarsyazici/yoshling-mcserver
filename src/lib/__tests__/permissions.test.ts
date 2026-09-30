import { describe, it, expect } from "vitest";
import { readFile, readdir } from "fs/promises";
import path from "path";
import {
  ALL_GAMES,
  PERMISSION_KEYS,
  canAccessGame,
  gameAccess,
  hasPermission,
  serializeGameAccess,
  type Permission,
  type Role,
} from "../permissions";

/**
 * `permissions.ts` is pure, and it is the only file that decides what anybody may do,
 * so it is the cheapest place in the repo to put a tripwire.
 *
 * These assertions deliberately pin the **model** rather than the table. The model is
 * the thing written down in `CLAUDE.md` — "MOD has the same capabilities as ADMIN and
 * differs only in scope; the one exception is `users.manage`" — and the table is one
 * expression of it that drifted away twice:
 *
 *   - Five keys once sat here that nothing checked (`server.version`, `server.loader`,
 *     `mods.update`, `mods.browse`, `mods.request`), so the table read like a policy
 *     while the routes enforced something else.
 *   - Thirteen handlers in twelve files compared `session.user.role !== "ADMIN"` by
 *     hand, which enforced *a different model than this file states* and could not be
 *     found by looking at this file at all.
 *
 * So the tests below iterate `PERMISSION_KEYS` instead of listing capabilities. A key
 * added later is covered the moment it is added, and adding one that breaks the model
 * fails here rather than in six months on a support report.
 */

const ROLES: Role[] = ["ADMIN", "MOD", "MEMBER"];

/**
 * The capabilities ADMIN holds and MOD does not — i.e. the exceptions to "MOD equals
 * ADMIN". Declared here, once, so that **changing the model stays a one-line edit** and
 * not an argument with the test suite.
 *
 * If you are adding a key to this list, that is a real policy decision and it belongs
 * in `CLAUDE.md`'s "Roles & per-world access" section in the same change — the point of
 * this list is to make the two impossible to drift apart, not to freeze today's answer.
 * Today's answer is one key, and its justification is escalation: a MOD who could edit
 * world access could grant themselves the worlds they were kept out of. No other
 * capability has that shape, which is why no other capability is here.
 */
const ADMIN_ONLY: Permission[] = ["users.manage"];

/**
 * The only capabilities a MEMBER is allowed to hold.
 *
 * MEMBER is the read-only role (browse + activity). This is an explicit allowlist, not
 * a derived one: if a future change grants MEMBER something, that is a policy widening
 * and it should have to be typed out here on purpose. A test that asked "does MEMBER
 * hold what MEMBER currently holds" would pin the bug instead of the property.
 */
const MEMBER_MAY: Permission[] = ["activity.view"];

describe("the role model", () => {
  it("gives ADMIN every capability", () => {
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission("ADMIN", key), key).toBe(true);
    }
  });

  it("gives MOD exactly what ADMIN has, outside the declared exceptions", () => {
    // The property, not a list: MOD differs from ADMIN in *scope* (`User.games`),
    // never in capability. Scope is enforced separately, by `gameAccess` below and by
    // `game-gate.ts` in every route. A new capability is therefore covered the moment
    // it is added — which is what the thirteen hand-written `role !== "ADMIN"`
    // comparisons escaped for months.
    for (const key of PERMISSION_KEYS) {
      if (ADMIN_ONLY.includes(key)) continue;
      expect(hasPermission("MOD", key), key).toBe(hasPermission("ADMIN", key));
    }
  });

  it("withholds every declared ADMIN-only capability from MOD and MEMBER", () => {
    for (const key of ADMIN_ONLY) {
      expect(hasPermission("ADMIN", key), key).toBe(true);
      expect(hasPermission("MOD", key), key).toBe(false);
      expect(hasPermission("MEMBER", key), key).toBe(false);
    }
  });

  it("still has users.manage among the ADMIN-only set, whatever else changes", () => {
    // Named explicitly as well as iterated: this is the one exception with a stated
    // reason (escalation — a MOD editing world access could grant itself the worlds it
    // was kept out of), so deleting it from `ADMIN_ONLY` must break something.
    expect(ADMIN_ONLY).toContain("users.manage");
  });

  it("keeps MEMBER read-only", () => {
    const held = PERMISSION_KEYS.filter((k) => hasPermission("MEMBER", k));
    expect(held.sort()).toEqual([...MEMBER_MAY].sort());
  });

  it("grants nothing to a role that is not one of the three", () => {
    // `session.user.role` comes out of a JWT claim, so a stale or hand-edited token
    // can carry a string the union does not contain. `hasPermission` must answer
    // "no" for it rather than throwing (a throw in a route is a 500, and a 500 on an
    // auth check is indistinguishable from the server being broken).
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission("GUEST" as Role, key), key).toBe(false);
      expect(hasPermission("" as Role, key), key).toBe(false);
    }
  });

  it("answers false rather than throwing for a capability that is not in the table", () => {
    // Same reason: a typo'd key must deny, not crash. TypeScript catches this at the
    // call sites; nothing catches it in a JS consumer or after a bad refactor.
    expect(hasPermission("ADMIN", "server.explode" as Permission)).toBe(false);
  });
});

/**
 * The dead-key guard.
 *
 * A capability nobody checks is a claim the model does not keep — the table says
 * `mods.request` is a MEMBER right, and there is no request feature. Five such keys
 * were deleted from this file; nothing stopped them being added, and nothing would
 * stop the next one. This does.
 *
 * The match is anchored on `hasPermission(` deliberately. Grepping for the bare string
 * `"mods.update"` finds plenty of hits — but every one of them is the `OperationKind`
 * of the same name, which is a completely different thing, and that near-miss is
 * exactly what made the five dead keys look alive.
 */
async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the generated Prisma client (large, and never a caller) and the test
      // trees — a key that is only mentioned by its own test is still dead.
      if (entry.name === "generated" || entry.name === "__tests__") continue;
      await sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("every capability is actually checked somewhere", () => {
  it("finds a hasPermission() call site in src/ for each key in the table", async () => {
    const root = path.resolve(__dirname, "..", "..");
    const files = (await sourceFiles(root)).filter(
      (f) => path.resolve(f) !== path.resolve(root, "lib", "permissions.ts")
    );

    const checked = new Set<string>();
    for (const file of files) {
      // Newlines folded to spaces so a call split across lines by a formatter still
      // matches. Without this the guard would silently pass a key whose only call
      // site happened to wrap.
      const text = (await readFile(file, "utf-8")).replace(/\s+/g, " ");
      for (const m of text.matchAll(/hasPermission\(\s*[^()]*?,\s*["']([^"']+)["']\s*\)/g)) {
        checked.add(m[1]);
      }
    }

    // Sanity-check the regex itself before trusting its verdict: a pattern that
    // matched nothing would make this test pass by finding no keys to miss, which is
    // the failure mode that lets a green suite mean nothing.
    expect(checked.size).toBeGreaterThan(0);

    const unreachable = PERMISSION_KEYS.filter((k) => !checked.has(k));
    expect(unreachable).toEqual([]);
  });

  it("does not count a key that only appears outside a hasPermission() call", async () => {
    // Proves the anchoring above is real. `mods.update` was removed from the table
    // precisely because its remaining hits are `OperationKind`s; if this regex matched
    // a bare string literal, the dead-key guard would be decorative.
    const text = 'const kind = "mods.update"; runOperation({ kind: "mods.update" });'.replace(
      /\s+/g,
      " "
    );
    const hits = [...text.matchAll(/hasPermission\(\s*[^()]*?,\s*["']([^"']+)["']\s*\)/g)];
    expect(hits).toEqual([]);
  });

  /**
   * The stronger property, and the reason the guard above is not enough on its own.
   *
   * "The key appears in a `hasPermission()` call" is satisfied by a call whose RESULT is
   * discarded. Demonstrated: keeping `hasPermission(session.user.role, "settings.read")` in
   * `/api/7dtd/config` and replacing the `if` that consumed it with `if (false)` handed the
   * live `ServerPassword` back to any MEMBER with 7DTD access — and left all tests green,
   * because the guard was satisfied by the call's presence. The report then read as though
   * route-level enforcement were covered.
   *
   * So every key must additionally appear **negated** — `!hasPermission(…, "key")` — with a
   * 403 within the next few lines. That is the only shape any of these keys is ever meant
   * to be used in, so requiring it costs nothing and closes the discard. It is still a grep
   * rather than an execution of the handler: route handlers need `auth()`, Prisma and a
   * `NextRequest`, which is the Docker-and-network line this suite does not cross. What it
   * buys is that a refusal cannot be deleted while its key looks checked.
   */
  it("finds each key used as a negated gate that returns 403", async () => {
    const root = path.resolve(__dirname, "..", "..");
    const files = (await sourceFiles(root)).filter(
      (f) => path.resolve(f) !== path.resolve(root, "lib", "permissions.ts")
    );

    const gated = new Set<string>();
    for (const file of files) {
      const raw = await readFile(file, "utf-8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // The negation and the key, on one line or wrapped across two.
        const window = lines.slice(i, i + 3).join(" ").replace(/\s+/g, " ");
        const m = /!hasPermission\(\s*[^()]*?,\s*["']([^"']+)["']\s*\)/.exec(window);
        if (!m) continue;
        // The refusal itself, within the block that opens here.
        const body = lines.slice(i, i + 10).join(" ");
        if (/\b403\b/.test(body)) gated.add(m[1]);
      }
    }

    expect(gated.size).toBeGreaterThan(0);
    const ungated = PERMISSION_KEYS.filter((k) => !gated.has(k));
    expect(ungated).toEqual([]);
  });

  /**
   * Per-ROUTE, not per-key — because the guard above is satisfied by any one call site.
   *
   * `settings.read` is gated in three places, so deleting the refusal from one of them (the
   * demonstrated mutant: keep `hasPermission(role, "settings.read")`, replace the `if` with
   * `if (false)`, and `/api/7dtd/config` hands the live `ServerPassword` to any MEMBER with
   * 7DTD access) leaves the key still "reachable" and the suite still green. The three
   * routes are therefore named here individually.
   *
   * These are the handlers that serialise a file or a row containing a **secret**:
   * `SevenDaysConfig.password` is `ServerPassword` from `sdtdserver.xml` (verified
   * non-empty on production 2026-09-30), and PZ's `.ini` carries `Password` and
   * `DiscordToken`. The pattern to remember is the one that produced this finding: fixing
   * one reader of a secrets-bearing file does not fix the others — `/api/{server,7dtd,zomboid}/files`
   * had already been fixed for the same leak while these three still had it.
   *
   * A fourth such route is not covered, which is the same limitation every drift guard in
   * this repo has; the list is the place to add it.
   */
  it("keeps the negated settings.read gate in every route that serialises a secret", async () => {
    const root = path.resolve(__dirname, "..", "..");
    const routes = [
      "app/api/7dtd/config/route.ts",
      "app/api/7dtd/config/all/route.ts",
      "app/api/zomboid/config/route.ts",
    ];
    for (const rel of routes) {
      const lines = (await readFile(path.join(root, rel), "utf-8")).split("\n");
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        const window = lines.slice(i, i + 3).join(" ").replace(/\s+/g, " ");
        if (!/!hasPermission\(\s*[^()]*?,\s*["']settings\.read["']\s*\)/.test(window)) continue;
        if (/\b403\b/.test(lines.slice(i, i + 10).join(" "))) found = true;
      }
      expect(found, `${rel} must refuse with 403 when settings.read is absent`).toBe(true);
    }
  });
});

describe("gameAccess", () => {
  it("gives ADMIN every world regardless of the column", () => {
    // The column is ignored for ADMIN on purpose, which is why the Crew page shows
    // admin rows with all chips lit and locked. An empty string is the value a fresh
    // row carries, so this is the case that matters in practice.
    for (const stored of ["", null, undefined, "zomboid", "nonsense"]) {
      expect(gameAccess("ADMIN", stored)).toEqual(ALL_GAMES);
    }
  });

  it("resolves the CSV for MOD and MEMBER", () => {
    expect(gameAccess("MOD", "zomboid")).toEqual(["zomboid"]);
    expect(gameAccess("MEMBER", "minecraft,7dtd")).toEqual(["minecraft", "7dtd"]);
  });

  it("returns canonical GAME_LIST order, not the order the column happens to be in", () => {
    // The sidebar world switcher and the landing cards render this list directly, so
    // a column written back in a different order would reshuffle the dashboard.
    expect(gameAccess("MOD", "zomboid,minecraft")).toEqual(gameAccess("MOD", "minecraft,zomboid"));
    expect(gameAccess("MOD", "zomboid,7dtd,minecraft")).toEqual(ALL_GAMES);
  });

  it("drops unknown ids and tolerates whitespace and duplicates", () => {
    expect(gameAccess("MOD", " minecraft , wolfenstein ,minecraft ")).toEqual(["minecraft"]);
    expect(gameAccess("MOD", ",,")).toEqual([]);
  });

  it("gives a MEMBER with no worlds nothing", () => {
    // This is the default for every account after the first, and the "No worlds yet"
    // landing depends on it being empty rather than everything.
    expect(gameAccess("MEMBER", "")).toEqual([]);
    expect(gameAccess("MEMBER", null)).toEqual([]);
  });

  it("accepts an already-resolved array as well as the raw column", () => {
    // `session.user.games` is a resolved `GameId[]`; the DB column is a CSV. Both
    // reach this function, and a route that fed it the wrong one used to be a
    // silently empty access list.
    expect(gameAccess("MOD", ["zomboid", "minecraft"])).toEqual(["minecraft", "zomboid"]);
    expect(gameAccess("MOD", [])).toEqual([]);
  });
});

describe("canAccessGame", () => {
  it("agrees with gameAccess for every role and world", () => {
    // One derived from the other, so the property is agreement — not two lists that
    // can drift. `denyGame`/`gameGate` call `canAccessGame`, while the UI filters on
    // `gameAccess`; if these two ever disagree the API and the UI disagree.
    for (const role of ROLES) {
      for (const stored of ["", "minecraft", "zomboid,7dtd", "minecraft,7dtd,zomboid"]) {
        const resolved = gameAccess(role, stored);
        for (const game of ALL_GAMES) {
          expect(canAccessGame(role, stored, game), `${role}/${stored}/${game}`).toBe(
            resolved.includes(game)
          );
        }
      }
    }
  });
});

describe("serializeGameAccess", () => {
  it("round-trips through gameAccess", () => {
    for (const list of [[], ["minecraft"], ["zomboid", "minecraft"], ALL_GAMES]) {
      expect(gameAccess("MOD", serializeGameAccess(list))).toEqual(gameAccess("MOD", list));
    }
  });

  it("normalises order and drops junk, so the stored column is always canonical", () => {
    expect(serializeGameAccess(["zomboid", "minecraft"])).toBe("minecraft,zomboid");
    expect(serializeGameAccess(["minecraft", "minecraft"])).toBe("minecraft");
    expect(serializeGameAccess(["doom", 7, null])).toBe("");
  });

  it("stores nothing for a non-array, rather than coercing it into an entry", () => {
    // The Crew page PUTs whatever it is holding. `String({})` is "[object Object]",
    // which as a stored value is an access grant that can never match a world and is
    // indistinguishable from a typo when someone later reads the row.
    expect(serializeGameAccess(undefined)).toBe("");
    expect(serializeGameAccess("minecraft")).toBe("");
    expect(serializeGameAccess({})).toBe("");
  });
});
