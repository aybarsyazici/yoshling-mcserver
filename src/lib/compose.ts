import { readFile, writeFile } from "fs/promises";

/**
 * Surgical reads/writes of `docker-compose.yml` on the host.
 *
 * Everything here is scoped to ONE service block on purpose. A previous version
 * of the settings route regenerated the whole file from a template, which
 * silently deleted every service the template didn't know about. Scoping also
 * matters because keys repeat: `VERSION` is the Minecraft version in one block
 * and the Steam branch in another, and `MEMORY` means different things again.
 */
export const COMPOSE_FILE = process.env.COMPOSE_FILE || "/opt/yoshling/docker-compose.yml";

/** Line range of a service's block: [firstLineAfterHeader, endExclusive]. */
function serviceBlock(lines: string[], service: string): { start: number; end: number; indent: string } | null {
  const startRe = new RegExp(`^(\\s*)${service}:\\s*$`);
  let start = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (m) {
      start = i;
      indent = m[1];
      break;
    }
  }
  if (start < 0) return null;

  // The block ends at the next non-blank line indented no deeper than the key.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if ((lines[i].match(/^\s*/)?.[0].length ?? 0) <= indent.length) {
      end = i;
      break;
    }
  }
  return { start, end, indent };
}

/** The value of `KEY: value` inside one service block, unquoted. */
export function readServiceEnv(compose: string, service: string, key: string): string | null {
  const lines = compose.split("\n");
  const block = serviceBlock(lines, service);
  if (!block) return null;
  const re = new RegExp(`^\\s*${key}:\\s*(.*)$`);
  for (let i = block.start + 1; i < block.end; i++) {
    const m = re.exec(lines[i]);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/** Rewrite `KEY: value` lines inside one service block, leaving the rest byte-identical. */
export function patchServiceEnv(
  compose: string,
  service: string,
  updates: Record<string, string>
): { text: string; applied: string[] } {
  const lines = compose.split("\n");
  const applied: string[] = [];
  const block = serviceBlock(lines, service);
  if (!block) return { text: compose, applied };

  for (let i = block.start + 1; i < block.end; i++) {
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp(`^(\\s*${key}:\\s*)(.*)$`);
      if (!re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, `$1"${value}"`);
      applied.push(key);
    }
  }

  return { text: lines.join("\n"), applied };
}

export async function readCompose(): Promise<string> {
  return readFile(COMPOSE_FILE, "utf-8");
}

export async function writeCompose(text: string): Promise<void> {
  await writeFile(COMPOSE_FILE, text, "utf-8");
}
