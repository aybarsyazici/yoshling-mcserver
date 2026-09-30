// Small shared formatters. Client-safe.

/**
 * "198 MiB" / "1.8 GiB" — for archive sizes in facts, summaries and toasts.
 *
 * **The unit label has to match the arithmetic.** This divided by 1024 and printed "MB",
 * so every backup summary understated its own file by ~5%: `165 MB` for an archive
 * `stat` reports as 173,283,914 bytes (= 165.26 MiB = 173.3 MB). Three sizes were
 * checked against `stat` on the box and all three were off by the same factor, and a
 * previous review had already validated one of them as "exact" by doing the arithmetic
 * in MiB — which is how a wrong label survives.
 *
 * Kept binary rather than switched to powers of 1000, because `ls -lh` and `du -h` on
 * the box report `166M` for that same file: binary is what every other reading of these
 * archives agrees on, so the honest fix is to say which unit it is.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * "1 mod" / "6 mods" — a count with its noun, pluralised.
 *
 * Exists because a real production summary read **"1 mods updated"**: the noun came from
 * `op.progress({noun: "mods"})`, which is right for the progress line ("3 of 6 mods") and
 * wrong the moment the count lands on 1. Rendering a count without asking whether it is
 * one is the kind of small wrongness that makes everything next to it read as sloppy.
 *
 * English-only and deliberately dumb: an `s` suffix, with an explicit override for the
 * cases where that is wrong. The alternative — pluralisation rules — is a library, and
 * this app has four nouns.
 */
export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** The noun alone, pluralised for `count`. `progress` carries plurals ("mods"). */
export function pluralNoun(count: number, noun: string): string {
  if (count !== 1) return noun;
  return noun.endsWith("ies") ? `${noun.slice(0, -3)}y` : noun.endsWith("s") ? noun.slice(0, -1) : noun;
}
