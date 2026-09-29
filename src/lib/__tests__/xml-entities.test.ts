import { describe, it, expect } from "vitest";
import { escapeXml, unescapeXml } from "../sdtd-xml";

/**
 * The defect these assertions pin down: `/api/7dtd/config/all` escaped on write and did
 * **not** unescape on read, so the value the settings page held in state was already
 * escaped and the next Save escaped it again. Measured on disk: `<&">` became
 * `&lt;&amp;&quot;&gt;` and then `&amp;lt;&amp;amp;&amp;quot;&amp;gt;`.
 *
 * The third test is the one that fails if `&amp;` is ever moved out of last place in
 * `unescapeXml` — the ordering bug that produces the same doubling from the other side.
 */
describe("escapeXml / unescapeXml round-trip", () => {
  for (const s of [
    'a & b < c > d " e',
    "&amp;",
    "100% & <none>",
    'AGENT7DTD probe <&"> test', // the exact probe value written to the live file
    "plain value with no entities",
    "",
  ]) {
    it(`unescapeXml(escapeXml(${JSON.stringify(s)})) is the original`, () => {
      expect(unescapeXml(escapeXml(s))).toBe(s);
    });
  }

  it("is stable across repeated save/load cycles", () => {
    // What the UI actually does: GET (unescape) → PUT (escape) → GET (unescape) → …
    // Before the fix this grew by one level of entities each time round.
    const original = 'pass&word <with> "quotes"';
    let onDisk = escapeXml(original);
    for (let i = 0; i < 3; i++) {
      const shown = unescapeXml(onDisk);
      expect(shown).toBe(original);
      onDisk = escapeXml(shown);
    }
    expect(onDisk).toBe(escapeXml(original));
  });

  it("re-escaping an unescaped attribute reproduces it byte for byte", () => {
    // The exact round-trip that was doubling.
    expect(escapeXml(unescapeXml("&lt;&amp;&quot;&gt;"))).toBe("&lt;&amp;&quot;&gt;");
  });

  it("decodes the apostrophe forms the game's own file uses", () => {
    expect(unescapeXml("it&apos;s")).toBe("it's");
    expect(unescapeXml("it&#39;s")).toBe("it's");
  });

  it("does not over-decode a literal ampersand sequence", () => {
    // A value the admin typed as the literal text `&amp;` survives a full cycle: escape
    // makes it `&amp;amp;`, unescape brings back `&amp;`. Decoding `&amp;` first would
    // collapse it to `&`.
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
    expect(unescapeXml("&amp;amp;")).toBe("&amp;");
  });
});
