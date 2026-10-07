/** Discord snowflakes remain decimal strings; converting to Number loses identity bits. */
export function discordUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[1-9]\d{0,19}$/.test(id)) return null;
  if (BigInt(id) > BigInt("18446744073709551615")) return null;
  return id;
}

export function discordIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(discordUserId);
  if (ids.some(id => id === null)) return null;
  return [...new Set(ids as string[])];
}
