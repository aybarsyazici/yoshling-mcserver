const SCOPED_URL = "https://aion2.gg/database/skills/overhead-slam-11170000";

export class AionSourceContentError extends Error {
  constructor() { super("The reviewed source content scope could not be verified"); this.name = "AionSourceContentError"; }
}

/** Raw bytes remain the default. The sole opt-in keeps the exact UTF-8 bytes
 * inside one complete main element, including all its markup and scripts. */
export function aionSourceContent(source: { fetchUrl?: string; hashScope?: unknown }, raw: Uint8Array): Uint8Array {
  if (source.hashScope === undefined) return raw;
  if (source.hashScope !== "html-main-v1" || source.fetchUrl !== SCOPED_URL) throw new AionSourceContentError();
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { throw new AionSourceContentError(); }
  let opened = -1, closed = -1, cursor = 0, svgDepth = 0;
  const tagEnd = (start: number) => {
    let quote = "";
    for (let index = start; index < html.length; index++) {
      const char = html[index];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === "<") throw new AionSourceContentError();
      else if (char === ">") return index;
    }
    throw new AionSourceContentError();
  };
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor); if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      // Do not search past an invalid terminator to a later well-formed one.
      const end = html.indexOf("--", start + 4);
      if (end < 0 || html.slice(end, end + 3) !== "-->" || /^>|^->/.test(html.slice(start + 4, end))) throw new AionSourceContentError();
      cursor = end + 3; continue;
    }
    if (html.startsWith("<!", start)) {
      const end = tagEnd(start + 2);
      if (!/^<!doctype\s+html\s*>$/i.test(html.slice(start, end + 1))) throw new AionSourceContentError();
      cursor = end + 1; continue;
    }
    if (html.startsWith("<?", start)) throw new AionSourceContentError();
    const token = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/i.exec(html.slice(start));
    if (!token) {
      cursor = start + 1;
      continue;
    }
    const end = tagEnd(start + token[0].length), name = token[2].toLowerCase(), closing = token[1] === "/";
    const selfClosing = /\/[\t\n\f\r ]*>$/.test(html.slice(start, end + 1));
    // These context-sensitive HTML modes are absent from the reviewed page.
    // Refuse them instead of guessing which apparent main tags are text.
    if (["plaintext", "xmp", "iframe", "noembed", "noframes", "noscript"].includes(name)) throw new AionSourceContentError();
    if (name === "math" || (svgDepth && ["main", "title", "script", "style", "foreignobject", "desc"].includes(name))) throw new AionSourceContentError();
    if (name === "svg") {
      if (selfClosing && !/\/>$/.test(html.slice(start, end + 1))) throw new AionSourceContentError();
      if (closing) { if (!svgDepth || !/^<\/svg[\t\n\f\r ]*>$/i.test(html.slice(start, end + 1))) throw new AionSourceContentError(); svgDepth--; }
      else if (!selfClosing) svgDepth++;
    }
    if (name === "main") {
      if (selfClosing) throw new AionSourceContentError();
      if (closing) {
        if (opened < 0 || closed >= 0 || !/^<\/main[\t\n\f\r ]*>$/i.test(html.slice(start, end + 1))) throw new AionSourceContentError();
        closed = start;
      } else {
        if (opened >= 0 || closed >= 0) throw new AionSourceContentError();
        opened = end + 1;
      }
    }
    cursor = end + 1;
    // HTML raw-text elements can contain main-looking text. This only locates
    // element boundaries; their bytes are retained when they are inside main.
    if (!closing && ["script", "style", "textarea", "title"].includes(name)) {
      if (selfClosing) throw new AionSourceContentError();
      const rawEnd = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "ig"); rawEnd.lastIndex = cursor;
      const match = rawEnd.exec(html); if (!match) throw new AionSourceContentError();
      const rawClose = tagEnd(match.index + match[0].length);
      if (!new RegExp(`^</${name}[\\t\\n\\f\\r ]*>$`, "i").test(html.slice(match.index, rawClose + 1))) throw new AionSourceContentError();
      // Escaped script tokenizer states need a browser parser. The reviewed
      // source has no such states; withhold if that format changes.
      if (name === "script" && html.slice(cursor, match.index).includes("<!--")) throw new AionSourceContentError();
      cursor = rawClose + 1;
    }
  }
  if (opened < 0 || closed < opened || svgDepth) throw new AionSourceContentError();
  return new TextEncoder().encode(html.slice(opened, closed));
}
