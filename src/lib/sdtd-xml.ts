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
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
