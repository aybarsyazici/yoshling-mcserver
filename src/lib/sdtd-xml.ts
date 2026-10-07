import { SaxesParser } from "saxes";

/**
 * XML attribute escaping for `sdtdserver.xml`.
 *
 * Extracted out of `/api/7dtd/config/all` so the round-trip below can be asserted by a
 * test -- importing a route module pulls in `next/server`, Prisma and the Docker CLI.
 *
 * ## The bug this pair exists to stop
 *
 * Measured on the box 2026-09-29. `PUT ServerDescription = 'AGENT7DTD probe <&"> test'`
 * wrote the correctly escaped `AGENT7DTD probe &lt;&amp;&quot;&gt; test` to disk. The
 * matching `GET` then returned the **raw attribute text** -- `&lt;&amp;&quot;&gt;` --
 * because `parseProperties` handed back the regex capture with no unescaping. That string
 * is what the settings page holds in state, so the next Save escaped it *again* and wrote
 * `&amp;lt;&amp;amp;&amp;quot;&amp;gt;`. Confirmed on disk both times. Every save doubles
 * the entities.
 *
 * The fields this hits are exactly the ones people edit: `ServerName`,
 * `ServerDescription`, **`ServerPassword`** and `ServerLoginConfirmationText`. A password
 * containing `&` is stored escaped, so what the admin typed is not what the game asks
 * players for and nobody can join -- reported as a green success.
 *
 * `escapeXml` was already correct and is unchanged; the missing half was `unescapeXml`.
 */

/** Escape a value for use inside a double-quoted XML attribute. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The inverse of `escapeXml`, plus the two apostrophe forms the game's own file uses.
 *
 * **`&amp;` must be substituted last.** Doing it first turns `&amp;lt;` into `&lt;` and
 * then into `<`, which un-escapes one level too far and re-introduces the doubling from
 * the other direction.
 */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, digits: string) => {
      const code = digits[0].toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : Number(digits);
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    })
    .replace(/&amp;/g, "&");
}

interface XmlPropertySpan {
  start: number;
  end: number;
}

/** Parse the actual document, excluding comments and refusing duplicate settings. */
function parseDocument(xml: string) {
  const parser = new SaxesParser({ xmlns: false });
  const properties = new Map<string, string>();
  const spans = new Map<string, XmlPropertySpan>();
  let depth = 0;
  let rootEnd = 0;
  parser.on("doctype", () => { throw new Error("sdtdserver.xml must not contain a DOCTYPE"); });
  parser.on("opentag", (tag) => {
    if (depth === 0) {
      if (tag.name !== "ServerSettings" || tag.isSelfClosing) throw new Error("sdtdserver.xml needs a ServerSettings document");
      rootEnd = parser.position;
    } else if (tag.name === "property") {
      if (depth !== 1 || !tag.isSelfClosing) throw new Error("sdtdserver.xml properties must be direct, self-closing settings");
      const name = tag.attributes.name;
      const value = tag.attributes.value;
      if (typeof name !== "string" || !name || typeof value !== "string") throw new Error("sdtdserver.xml has an incomplete property");
      if (properties.has(name)) throw new Error(`sdtdserver.xml has duplicate property "${name}"`);
      properties.set(name, value);
      spans.set(name, { start: xml.lastIndexOf("<", parser.position - 1), end: parser.position });
    } else {
      throw new Error(`sdtdserver.xml has an unexpected element "${tag.name}"`);
    }
    depth++;
  });
  parser.on("closetag", () => { depth--; });
  parser.write(xml).close();
  return { properties, spans, rootEnd };
}

export function parseSdtdXmlProperties(xml: string): Map<string, string> {
  return parseDocument(xml).properties;
}

/** Attribute values are decoded by the parser; help comes from the trailing comment. */
export function sdtdXmlPropertyRows(xml: string): { name: string; value: string; help: string }[] {
  const { properties, spans } = parseDocument(xml);
  return Array.from(properties, ([name, value]) => ({
    name,
    value,
    help: (xml.slice(spans.get(name)!.end).match(/^\s*<!--\s*([\s\S]*?)\s*-->/)?.[1] ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/**
 * Change attribute text at parsed property positions, retaining the rest of the
 * file byte for byte. Callback replacements keep $&, $$, $1 and $` literal.
 * Missing keys are normally reported; restore may add deployment keys absent
 * from an older archive. Parse and compare before handing any new XML to a writer.
 */
export function setSdtdXmlProperties(
  xml: string,
  updates: Record<string, string>,
  options: { addMissing?: boolean } = {}
): { xml: string; applied: string[]; ignored: string[] } {
  const parsed = parseDocument(xml);
  const edits: { start: number; end: number; text: string }[] = [];
  const applied: string[] = [];
  const ignored: string[] = [];
  const additions: string[] = [];
  for (const [name, value] of Object.entries(updates)) {
    const encoded = escapeXml(value).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
    const span = parsed.spans.get(name);
    if (span) {
      const tag = xml.slice(span.start, span.end);
      const text = tag.replace(/(\svalue\s*=\s*)(["'])([\s\S]*?)\2/, (_match, prefix: string, quote: string) =>
        `${prefix}${quote}${quote === "'" ? encoded.replace(/'/g, "&apos;") : encoded}${quote}`
      );
      edits.push({ ...span, text });
      applied.push(name);
    } else if (options.addMissing) {
      additions.push(`\n  <property name="${escapeXml(name)}" value="${encoded}"/>`);
      applied.push(name);
    } else {
      ignored.push(name);
    }
  }
  let next = xml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  if (additions.length) next = next.slice(0, parsed.rootEnd) + additions.join("") + next.slice(parsed.rootEnd);
  assertSdtdXmlValues(next, Object.fromEntries(applied.map((name) => [name, updates[name]])));
  return { xml: next, applied, ignored };
}

/** Values come from a fresh disk read on the writer's success path. Never print secrets. */
export function assertSdtdXmlValues(xml: string, expected: Record<string, string>): void {
  const properties = parseSdtdXmlProperties(xml);
  for (const [name, value] of Object.entries(expected)) {
    if (properties.get(name) !== value) throw new Error(`Could not verify sdtdserver.xml property "${name}"`);
  }
}
