import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The upload token is the *only* thing standing between the world-upload route and the
 * open internet on `direct.yoshling.xyz`.
 *
 * That host is DNS-only (grey-cloud), so it is not behind Cloudflare, and the session
 * cookie is host-only for `yoshling.xyz` and therefore never sent to it. So
 * `POST /api/7dtd/world` on the direct host authenticates on this token alone — and the
 * route it guards deletes and replaces directories under `/sevendtd`. There was no test
 * for it.
 *
 * `SECRET` is read at module load, so each case that needs a different secret re-imports
 * the module under `vi.resetModules()`.
 */
async function freshModule(secret: string | undefined) {
  vi.resetModules();
  if (secret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = secret;
  return import("../upload-token");
}

const ORIGINAL_SECRET = process.env.AUTH_SECRET;

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

describe("upload token", () => {
  it.each([undefined, "", "dev-secret-change-me"])("refuses token mint and verification without a deployment secret: %s", async (secret) => {
    const crypto = await import("crypto");
    const { createUploadToken, verifyUploadToken } = await freshModule(secret);
    expect(() => createUploadToken("user-123")).toThrow(/configured AUTH_SECRET/);
    const payload = Buffer.from(JSON.stringify({ u: "user-123", e: Date.now() + 60_000 })).toString("base64url");
    const sig = crypto.createHmac("sha256", "dev-secret-change-me").update(payload).digest("base64url");
    expect(verifyUploadToken(`${payload}.${sig}`)).toBeNull();
  });

  it("round-trips the user id it was minted for", async () => {
    const { createUploadToken, verifyUploadToken } = await freshModule("secret-a");
    expect(verifyUploadToken(createUploadToken("user-123"))).toEqual({ userId: "user-123" });
  });

  it("refuses a token signed with a different secret", async () => {
    // i.e. minted against another deployment, or forged.
    const a = await freshModule("secret-a");
    const token = a.createUploadToken("user-123");
    const b = await freshModule("secret-b");
    expect(b.verifyUploadToken(token)).toBeNull();
  });

  it("refuses a tampered payload even though the signature is well-formed", async () => {
    const { createUploadToken, verifyUploadToken } = await freshModule("secret-a");
    const token = createUploadToken("user-123");
    const [payload, sig] = token.split(".");
    // Re-encode the payload for a different user, keeping the original signature.
    const forged =
      Buffer.from(JSON.stringify({ u: "someone-else", e: Date.now() + 60_000 })).toString(
        "base64url"
      ) + `.${sig}`;
    expect(verifyUploadToken(forged)).toBeNull();
    // And the untouched one still verifies, so the case above is not passing by accident.
    expect(verifyUploadToken(`${payload}.${sig}`)).toEqual({ userId: "user-123" });
  });

  it("expires, and the boundary is inclusive of the expiry instant", async () => {
    const { createUploadToken, verifyUploadToken } = await freshModule("secret-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    const token = createUploadToken("user-123", 60_000);

    vi.setSystemTime(new Date("2026-09-30T00:00:59Z"));
    expect(verifyUploadToken(token)).toEqual({ userId: "user-123" });
    // `Date.now() > e` is the predicate, so the expiry instant itself still passes and
    // one millisecond later does not.
    vi.setSystemTime(new Date("2026-09-30T00:01:00.000Z"));
    expect(verifyUploadToken(token)).toEqual({ userId: "user-123" });
    vi.setSystemTime(new Date("2026-09-30T00:01:00.001Z"));
    expect(verifyUploadToken(token)).toBeNull();
  });

  it("defaults to a short life rather than an open-ended one", async () => {
    const { createUploadToken, verifyUploadToken } = await freshModule("secret-a");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    const token = createUploadToken("user-123");
    // A 2 GB upload over a slow link can take a while, so the default must not be
    // seconds; it must also not be a day. 10 minutes is the value the module ships.
    vi.setSystemTime(new Date("2026-09-30T00:09:00Z"));
    expect(verifyUploadToken(token)).toEqual({ userId: "user-123" });
    vi.setSystemTime(new Date("2026-09-30T00:11:00Z"));
    expect(verifyUploadToken(token)).toBeNull();
  });

  it("refuses every malformed shape without throwing", async () => {
    const { verifyUploadToken } = await freshModule("secret-a");
    for (const bad of [
      null,
      undefined,
      "",
      "no-dot",
      ".",
      "payload.",
      "payload.signature.extra",
      ".signature",
      "not-base64.not-a-signature",
      // A signature of the right *content* but the wrong length: `timingSafeEqual`
      // throws on a length mismatch, so the length check in front of it is what keeps
      // this a null instead of a 500.
      "eyJ1IjoiYSIsImUiOjF9.short",
    ]) {
      expect(verifyUploadToken(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });

  it("refuses a validly signed token whose payload is not a token at all", async () => {
    // Signed by us, so the HMAC passes — the claims check is the only thing left.
    const crypto = await import("crypto");
    await freshModule("secret-a");
    const { verifyUploadToken } = await import("../upload-token");
    const sign = (obj: unknown) => {
      const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
      const sig = crypto.createHmac("sha256", "secret-a").update(payload).digest("base64url");
      return `${payload}.${sig}`;
    };
    expect(verifyUploadToken(sign({ u: "", e: Date.now() + 1000 }))).toBeNull();
    expect(verifyUploadToken(sign({ u: 42, e: Date.now() + 1000 }))).toBeNull();
    expect(verifyUploadToken(sign({ u: "a" }))).toBeNull();
    expect(verifyUploadToken(sign({ u: "a", e: "later" }))).toBeNull();
    expect(verifyUploadToken(sign(["a", 1]))).toBeNull();
    // ...and the positive control, so the assertions above are not all failing for a
    // shared reason (a wrong secret, say).
    expect(verifyUploadToken(sign({ u: "a", e: Date.now() + 1000 }))).toEqual({ userId: "a" });
  });
});
