import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { profileJavaVariant, resolveProfileTarget, selectProfileLoaderVersion } from "../minecraft-profile-target";
afterEach(() => vi.unstubAllGlobals());
describe("profile target", () => {
  it("pins the newest stable loader from an unordered registry list", () => {
    expect(selectProfileLoaderVersion([{ loader: { version: "0.20.0-beta.9" } }, { loader: { version: "0.9.0" } }, { loader: { version: "0.29.2" } }, { loader: { version: "0.30.0-beta.1" } }])).toBe("0.29.2");
    expect(selectProfileLoaderVersion([{ loader: { version: "0.16.9", stable: true } }, { loader: { version: "0.16.10", stable: true } }])).toBe("0.16.10");
  });
  it.each([[8,"java8"],[16,"java17"],[17,"java17"],[21,"java21"],[25,"java25"]])("maps required Java %i to %s", (major, variant) => expect(profileJavaVariant(Number(major))).toBe(variant));
  it("refuses unsupported Java or an older requested image", () => {
    expect(() => profileJavaVariant(26)).toThrow();
    expect(() => profileJavaVariant(21,"java17")).toThrow();
    expect(profileJavaVariant(17,"java21")).toBe("java21");
  });
  it("reads exact official Minecraft metadata and freezes a loader build", async () => {
    const bytes = JSON.stringify({ id:"1.21.1", javaVersion:{majorVersion:21}, downloads:{server:{}} });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (value: string | URL) => {
      const url=String(value);
      if(url.endsWith("version_manifest_v2.json")) return Response.json({versions:[{id:"1.21.1",url:"https://piston-meta.mojang.com/v1/example.json",sha1:createHash("sha1").update(bytes).digest("hex")}]});
      if(url.endsWith("example.json")) return new Response(bytes);
      return Response.json([{loader:{version:"0.16.9",stable:true}}]);
    }));
    await expect(resolveProfileTarget({mcVersion:"1.21.1",loader:"fabric"})).resolves.toEqual({mcVersion:"1.21.1",loader:"fabric",loaderVersion:"0.16.9",javaVariant:"java21"});
  });
  it("refuses a moving version alias before fetching", async () => {
    const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
    await expect(resolveProfileTarget({mcVersion:"latest",loader:"vanilla"})).rejects.toThrow(/exact/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
