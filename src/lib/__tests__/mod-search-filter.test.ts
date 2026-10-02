import { describe, expect, it } from "vitest";
import { searchFilterParams } from "@/lib/mod-search-filter";

/**
 * **Which version facet the mod browser asks for**, stated as a rule rather than reached
 * through a combobox.
 *
 * The default here is an **omission**, and that is the part worth pinning: the browser does
 * not send the server's version, it sends nothing and lets `/api/mods/search` apply the
 * server's own. Copying the value into the query would be a second copy to drift, and this
 * app has the scar — `ServerConfig.mcVersion` said 26.1.2 while compose said 1.21.4 for
 * weeks.
 */
describe("the default is to send nothing and let the route use the server's version", () => {
  it("sends neither version nor loader", () => {
    expect(searchFilterParams({ pack: undefined, allVersions: false })).toEqual({});
  });
});

describe("widening sends the literal the route reads as any", () => {
  it("sends any for both axes", () => {
    expect(searchFilterParams({ pack: undefined, allVersions: true })).toEqual({
      version: "any",
      loader: "any",
    });
  });
});

describe("a selected modpack's target outranks a widen", () => {
  /**
   * The precedence, and the reason it exists: `allVersions` is sticky state, so a user who
   * widened and then picked a 1.21.1 pack would otherwise have searched every version while
   * the badge beside the control said MC 1.21.1. The filter and the label have to agree.
   */
  it("sends the pack's version and loader even while widened", () => {
    expect(
      searchFilterParams({
        pack: { targetMcVersion: "1.21.1", targetLoader: "fabric" },
        allVersions: true,
      })
    ).toEqual({ version: "1.21.1", loader: "fabric" });
  });

  it("sends the pack's version and loader when not widened", () => {
    expect(
      searchFilterParams({
        pack: { targetMcVersion: "1.21.1", targetLoader: "fabric" },
        allVersions: false,
      })
    ).toEqual({ version: "1.21.1", loader: "fabric" });
  });

  /**
   * A pack can record one and not the other — `targetLoader` is nullable and the Modrinth
   * importer does not always fill it. The axis the pack never named is left out so the route
   * falls back to the server's own loader, which is a better answer than inventing one; and
   * it must specifically NOT become `any`, which would widen an axis nobody widened.
   */
  it("leaves out the axis the pack never recorded, rather than widening it", () => {
    expect(
      searchFilterParams({
        pack: { targetMcVersion: "1.21.1", targetLoader: null },
        allVersions: true,
      })
    ).toEqual({ version: "1.21.1" });
    expect(
      searchFilterParams({
        pack: { targetMcVersion: null, targetLoader: "forge" },
        allVersions: true,
      })
    ).toEqual({ loader: "forge" });
  });

  /**
   * A pack with neither recorded sends nothing, so the route applies the server's version —
   * the same as no pack at all. It must not fall through to the widen branch: the user
   * selected a pack, which is a narrowing gesture, and answering it with "every version"
   * would be the opposite of what was asked.
   */
  it("sends nothing for a pack that recorded neither, even while widened", () => {
    expect(
      searchFilterParams({
        pack: { targetMcVersion: null, targetLoader: null },
        allVersions: true,
      })
    ).toEqual({});
  });
});
