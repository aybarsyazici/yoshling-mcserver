import { describe, expect, it } from "vitest";
import { isPathSafe, resolveWithin } from "@/lib/file-paths";

/**
 * Containment for the file browser.
 *
 * These trees hold `server.properties`, `sdtdserver.xml` and `yoshling.ini` — i.e. the
 * live `TelnetPassword` and `RCONPassword` — which is why the routes gate reads behind
 * `settings.edit` at all. The check used to be three private copies (one per game route,
 * with a different argument list in the Minecraft one), all comparing with a bare
 * `resolved.startsWith(baseDir)`.
 *
 * The real roots are what makes that wrong: 7 Days to Die's two roots are `/sevendtd`
 * (saves) and `/sevendtd-config` (config), and `"/sevendtd-config".startsWith("/sevendtd")`
 * is true. `..` was blocked separately as a substring, so an *absolute* sibling path was
 * the way through.
 */

// The production roots, verbatim from the three routes' defaults.
const SDTD_SAVES = "/sevendtd";
const SDTD_CONFIG = "/sevendtd-config";
const PZ_ALL = "/zomboid";
const MC = "/minecraft";

describe("a request may not leave the root it named", () => {
  it("refuses a sibling directory whose name merely starts with the root's", () => {
    // The separator-less prefix bug. With `startsWith(baseDir)` and no separator this
    // resolved to `/sevendtd-config/sdtdserver.xml`, passed the check, and read a file
    // outside the root the request asked for.
    expect(isPathSafe(SDTD_SAVES, "/sevendtd-config/sdtdserver.xml")).toBe(false);
    expect(isPathSafe(SDTD_SAVES, "/sevendtd-config")).toBe(false);
    // Same shape on the other two games.
    expect(isPathSafe(PZ_ALL, "/zomboid-workshop/appworkshop_108600.acf")).toBe(false);
    expect(isPathSafe(MC, "/minecraft-backups/anything")).toBe(false);
  });

  it("still allows the config root to read its own file", () => {
    // The fix must not cost the legitimate case: `/sevendtd-config` reached as itself.
    expect(isPathSafe(SDTD_CONFIG, "sdtdserver.xml")).toBe(true);
    expect(resolveWithin(SDTD_CONFIG, "sdtdserver.xml")).toBe("/sevendtd-config/sdtdserver.xml");
  });

  it("refuses an absolute path elsewhere on the filesystem", () => {
    expect(isPathSafe(PZ_ALL, "/etc/passwd")).toBe(false);
    expect(isPathSafe(MC, "/root/.ssh/id_rsa")).toBe(false);
    expect(isPathSafe(MC, "/proc/self/environ")).toBe(false);
  });

  it("refuses traversal out of the root", () => {
    expect(isPathSafe(PZ_ALL, "../etc/passwd")).toBe(false);
    expect(isPathSafe(PZ_ALL, "Server/../../etc/passwd")).toBe(false);
    expect(isPathSafe(PZ_ALL, "..")).toBe(false);
    // A traversal that happens to land back inside is still refused — the substring rule
    // is deliberately blunt, and being blunt here costs nothing.
    expect(isPathSafe(PZ_ALL, "Server/../Saves")).toBe(false);
  });

  it("refuses a home-directory expansion and node_modules", () => {
    expect(isPathSafe(MC, "~/.ssh/id_rsa")).toBe(false);
    expect(isPathSafe(MC, "node_modules/.bin/x")).toBe(false);
  });

  it("refuses an encoded separator that decodes to a traversal", () => {
    // The route reads `searchParams.get("path")`, which is already percent-decoded, so the
    // decoded form is what arrives. Both spellings are checked because a future caller
    // reading a raw query string would hand over the encoded one.
    expect(isPathSafe(PZ_ALL, decodeURIComponent("%2e%2e%2fetc%2fpasswd"))).toBe(false);
    expect(isPathSafe(PZ_ALL, decodeURIComponent("Server%2F..%2F..%2Fetc"))).toBe(false);
    // Still-encoded text is not a traversal at all: it is a (silly) filename, and it must
    // resolve inside the root rather than out of it.
    const enc = resolveWithin(PZ_ALL, "%2e%2e%2fetc");
    expect(enc).toBe("/zomboid/%2e%2e%2fetc");
  });

  it("allows the root itself and paths genuinely beneath it", () => {
    expect(isPathSafe(PZ_ALL, "")).toBe(true);
    expect(isPathSafe(PZ_ALL, ".")).toBe(true);
    expect(isPathSafe(PZ_ALL, "Server/yoshling.ini")).toBe(true);
    expect(isPathSafe(PZ_ALL, "Saves/Multiplayer/yoshling")).toBe(true);
    expect(resolveWithin(PZ_ALL, "Server/yoshling.ini")).toBe("/zomboid/Server/yoshling.ini");
  });

  it("is not fooled by a root written with a trailing separator", () => {
    // A root spelled `/zomboid/` would otherwise compare against `/zomboid//`, which
    // nothing matches — or, worse, let the bare prefix test pass for everything.
    expect(isPathSafe("/zomboid/", "Server/yoshling.ini")).toBe(true);
    expect(isPathSafe("/zomboid/", "/zomboid-workshop/x")).toBe(false);
    expect(resolveWithin("/zomboid/", "Server")).toBe("/zomboid/Server");
  });

  it("resolveWithin returns null for exactly the paths isPathSafe refuses", () => {
    // The two must not be able to disagree: the routes used to check one path and then
    // re-derive another a few lines later.
    for (const p of [
      "/sevendtd-config/sdtdserver.xml",
      "../etc/passwd",
      "/etc/passwd",
      "~/x",
      "..",
    ]) {
      expect(isPathSafe(SDTD_SAVES, p)).toBe(false);
      expect(resolveWithin(SDTD_SAVES, p)).toBeNull();
    }
    for (const p of ["", "Saves", "Saves/world/map_0_0.bin"]) {
      expect(isPathSafe(SDTD_SAVES, p)).toBe(true);
      expect(resolveWithin(SDTD_SAVES, p)).not.toBeNull();
    }
  });
});
