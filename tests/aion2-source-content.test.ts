import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aionSourceContent, AionSourceContentError } from "@/lib/aion2-source-content";
import { validateAionKnowledge } from "@/lib/aion2-knowledge-validation";
import knowledge from "@/data/aion2/knowledge.json";

const URL = "https://aion2.gg/database/skills/overhead-slam-11170000";
const scoped = { fetchUrl: URL, hashScope: "html-main-v1" };
const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

describe("reviewed exact source content scope", () => {
  it("keeps every other source's bytes unchanged, including invalid UTF-8 and BOMs", () => {
    const raw = new Uint8Array([0xef,0xbb,0xbf,0xff,0x00,0x0d,0x0a]);
    expect(aionSourceContent({ fetchUrl: URL }, raw)).toBe(raw);
    expect(aionSourceContent({ fetchUrl: "https://aion2.gg/other" }, raw)).toBe(raw);
  });

  it("ignores differing outside Flight serialization while retaining the exact untrimmed main bytes", () => {
    const main = "\n <h1>Overhead Slam</h1><p>Level 16 · Ω &amp; cooldown</p> \n";
    const baseline = `<html><body><main class="old">${main}</main><script>self.__next_f.push([1,"$old-reference"])</script></body></html>`;
    const variant = `<html><body><main class="new">${main}</main><script>self.__next_f.push([1,"$new-reference"])</script></body></html>`;
    expect(digest(aionSourceContent(scoped, bytes(baseline)))).toBe(digest(bytes(main)));
    expect(aionSourceContent(scoped, bytes(variant))).toEqual(bytes(main));
    expect(digest(bytes(baseline))).not.toBe(digest(bytes(variant)));
  });

  it("detects an actual skill claim change inside main", () => {
    const baseline = bytes("<main><p>Specialty at 16</p></main>");
    const changed = bytes("<main><p>Specialty at 18</p></main>");
    expect(digest(aionSourceContent(scoped, changed))).not.toBe(digest(aionSourceContent(scoped, baseline)));
  });

  it("retains scripts, styles, comments and every attribute/content byte INSIDE main", () => {
    const main = `<!-- retained --><script>const s="<main>literal</main>";</script><style>.x:before{content:"<main>"}</style><textarea><main>literal</main></textarea><p title='a > b'>É</p>`;
    expect(aionSourceContent(scoped, bytes(`<main>${main}</main>`))).toEqual(bytes(main));
  });

  it("does not treat comments, raw text or a quoted greater-than as a second main", () => {
    const html = `<!-- <main>comment</main> --><script>const s="<main>literal</main>"</script><style>.x{content:"<main>"}</style><title><main>title</main></title><MAIN data-x="a > b"> exact </MAIN>`;
    expect(aionSourceContent(scoped, bytes(html))).toEqual(bytes(" exact "));
  });

  it("retains the reviewed simple SVG markup without guessing foreign-content parsing modes", () => {
    const main = '<svg viewBox="0 0 2 2"><path d="M0 0"/></svg><p>Skill claim</p>';
    expect(aionSourceContent(scoped, bytes(`<main>${main}</main>`))).toEqual(bytes(main));
  });

  it.each([
    "<html>No main</html>", "<main>missing close", "</main><main>orphan</main>",
    "<main>one</main><main>two</main>", "<main>nested<main>two</main></main>",
    "<main>one</main></main>", "<main/>", "<main / >", "<main>one</main invalid>",
    '<main data-x="unterminated>one</main>', "<main>one</main><!-- unterminated", "<script>unclosed<main>one</main>",
    "<plaintext><main>trusted</main>", "<xmp><main>trusted</main></xmp>",
    "<iframe><main>trusted</main></iframe>", "<noembed><main>trusted</main></noembed>",
    "<noframes><main>trusted</main></noframes>", "<noscript><main>trusted</main></noscript>",
    "<script>x</script data-x><main>changed</main><script>x</script><main>trusted</main>",
    "<style>x</style data-x><main>changed</main><style>x</style><main>trusted</main>",
    "<textarea>x</textarea data-x><main>changed</main><textarea>x</textarea><main>trusted</main>",
    "<title>x</title data-x><main>changed</main><title>x</title><main>trusted</main>",
    "<!--x--!><main>changed</main><!--x--><main>trusted</main>",
    "<!--><main>changed</main><!--x--><main>trusted</main>",
    "<!---><main>changed</main><!--x--><main>trusted</main>",
    "<script><!--<script>x</script><main>trusted</main>",
    "<main\u00a0>trusted</main>", "<main>trusted</main\u00a0>",
    "<main x=<main>trusted</main>",
    "<svg><title><main>changed</main></title></svg><main>trusted</main>",
    "<svg><foreignObject><main>changed</main></foreignObject></svg><main>trusted</main>",
    "<svg><desc><main>changed</main></desc></svg><main>trusted</main>",
    "<math><main>changed</main></math><main>trusted</main>",
    "<main>trusted</main><svg>",
    "<script>x</script\u00a0><main>trusted</main>",
    "<script>x</script\u000b><main>trusted</main>",
    "<svg/ ><main>trusted</main>", "<svg/\u00a0><main>trusted</main>",
  ])("fails closed for missing or malformed main markup: %s", (html) => {
    expect(() => aionSourceContent(scoped, bytes(html))).toThrow(AionSourceContentError);
  });

  it("fails closed on invalid scoped UTF-8 instead of replacing bytes", () => {
    const raw = new Uint8Array([...bytes("<main>"),0xc3,0x28,...bytes("</main>")]);
    expect(() => aionSourceContent(scoped, raw)).toThrow(AionSourceContentError);
  });

  it.each([
    { fetchUrl: URL, hashScope: "unknown" }, { fetchUrl: URL, hashScope: null },
    { fetchUrl: URL + "?variant=1", hashScope: "html-main-v1" },
    { fetchUrl: URL + "#main", hashScope: "html-main-v1" },
    { fetchUrl: "https://aion2.gg/database/skills/other", hashScope: "html-main-v1" },
    { hashScope: "html-main-v1" },
  ])("never broadens the opt-in scope or falls back to raw: %j", (source) => {
    expect(() => aionSourceContent(source, bytes("<main>fact</main>"))).toThrow(AionSourceContentError);
  });

  it("the shared manifest validator allows only the exact opted-in source", () => {
    const manifest = structuredClone(knowledge);
    const source = manifest.sources.find((source) => source.id === "overhead-skill")!;
    Object.assign(source, scoped);
    expect(validateAionKnowledge(manifest)).toEqual([]);
    Object.assign(source, { fetchUrl: URL + "?variant=1" });
    expect(validateAionKnowledge(manifest).join(" ")).toContain("hashScope");
    Object.assign(source, { fetchUrl: URL, hashScope: "unknown" });
    expect(validateAionKnowledge(manifest).join(" ")).toContain("hashScope");
  });
});
