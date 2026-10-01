import { describe, it, expect } from "vitest";
import { parseLevelDatVersion } from "../mc-world-version";

/**
 * The **real** `world/level.dat` from production, 2026-10-01 — 415 bytes gzipped on disk,
 * 541 inflated, base64 of the inflated NBT. Copied with
 * `docker exec yoshling-mc base64 /data/world/level.dat` and gunzipped locally.
 *
 * A synthetic buffer would only prove the parser agrees with my reading of the format.
 * This one proves it agrees with the file Minecraft wrote, which is the thing the version
 * guard refuses saves on the strength of. It contains no secret: a difficulty, a spawn
 * position, the enabled data packs and the version.
 */
const LIVE_LEVEL_DAT_B64 =
  "CgAACgAERGF0YQoAE2RpZmZpY3VsdHlfc2V0dGluZ3MIAApkaWZmaWN1bHR5AARoYXJkAQAIaGFy" +
  "ZGNvcmUAAQAGbG9ja2VkAAAEAARUaW1lAAAAAAAJXCkDAAhHYW1lVHlwZQAAAAAJAAxTZXJ2ZXJC" +
  "cmFuZHMIAAAAAQAGZmFicmljAwAHdmVyc2lvbgAASr0EAApMYXN0UGxheWVkAAABoPc9qfUKAAVz" +
  "cGF3bgsAA3BvcwAAAAMAAAAQAAAAS////9AFAAVwaXRjaAAAAAAIAAlkaW1lbnNpb24AE21pbmVj" +
  "cmFmdDpvdmVyd29ybGQFAAN5YXcAAAAAAAoAB1ZlcnNpb24BAAhTbmFwc2hvdAAIAAZTZXJpZXMA" +
  "BG1haW4DAAJJZAAAErYIAAROYW1lAAYyNi4xLjIACAAJTGV2ZWxOYW1lAAV3b3JsZAEAC2luaXRp" +
  "YWxpemVkAQEACVdhc01vZGRlZAEDAAtEYXRhVmVyc2lvbgAAErYBAA1hbGxvd0NvbW1hbmRzAAoA" +
  "CURhdGFQYWNrcwkAB0VuYWJsZWQIAAAAAgAHdmFuaWxsYQAZZmFicmljLWNvbnZlbnRpb24tdGFn" +
  "cy12MgkACERpc2FibGVkCAAAAAMAFW1pbmVjYXJ0X2ltcHJvdmVtZW50cwAUcmVkc3RvbmVfZXhw" +
  "ZXJpbWVudHMAD3RyYWRlX3JlYmFsYW5jZQAAAA==";

const live = Buffer.from(LIVE_LEVEL_DAT_B64, "base64");

/** TAG_String with the given name and value, as NBT writes it. */
function str(name: string, value: string): Buffer {
  const n = Buffer.from(name, "utf8");
  const v = Buffer.from(value, "utf8");
  const out = Buffer.alloc(3 + n.length + 2 + v.length);
  out[0] = 0x08;
  out.writeUInt16BE(n.length, 1);
  n.copy(out, 3);
  out.writeUInt16BE(v.length, 3 + n.length);
  v.copy(out, 5 + n.length);
  return out;
}

/** TAG_Compound header with the given name. */
function compound(name: string): Buffer {
  const n = Buffer.from(name, "utf8");
  const out = Buffer.alloc(3 + n.length);
  out[0] = 0x0a;
  out.writeUInt16BE(n.length, 1);
  n.copy(out, 3);
  return out;
}

describe("reading the world's own version out of level.dat", () => {
  it("reads 26.1.2 out of the production file", () => {
    // The oracle: the same number `rcon-cli version` reports (`id = 26.1.2`, data 4790),
    // read from the bytes the game wrote rather than from the app's own DB row — which has
    // disagreed with reality before.
    expect(parseLevelDatVersion(live)).toBe("26.1.2");
  });

  it("takes the Name inside the Version compound, not the first Name it finds", () => {
    /**
     * The property, and the reason the parser is anchored rather than greedy. `LevelName`
     * is a sibling string in the same file; a looser scan is one NBT reordering away from
     * answering "world" as the version — and a wrong answer here does not fail loudly, it
     * *blocks* every version change with a nonsense comparison.
     */
    const reordered = Buffer.concat([
      compound(""),
      compound("Data"),
      str("Name", "decoy-before"),
      str("LevelName", "world"),
      compound("Version"),
      str("Series", "main"),
      str("Name", "26.9.9"),
    ]);
    expect(parseLevelDatVersion(reordered)).toBe("26.9.9");
  });

  it("answers null rather than guessing when there is no Version compound", () => {
    // Not knowing has to degrade to "no opinion": the guard treats null as "nothing to
    // compare", so a world this cannot read must never become a world nobody may change.
    expect(parseLevelDatVersion(Buffer.concat([compound("Data"), str("LevelName", "world")]))).toBe(null);
    expect(parseLevelDatVersion(Buffer.alloc(0))).toBe(null);
    expect(parseLevelDatVersion(Buffer.from("not nbt at all"))).toBe(null);
  });

  it("rejects a Version/Name that is not version-shaped", () => {
    // A corrupt or hostile file must not get its bytes rendered into the settings page.
    const junk = Buffer.concat([compound("Version"), str("Name", "26.1.2\n<script>")]);
    expect(parseLevelDatVersion(junk)).toBe(null);
  });
});
