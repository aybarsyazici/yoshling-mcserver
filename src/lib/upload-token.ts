import crypto from "crypto";

// Short-lived, HMAC-signed token that authorizes uploads from the browser to the direct
// (non-Cloudflare) subdomain, where the session cookie isn't sent (it's host-only for
// yoshling.xyz). The already-authenticated page mints this via /api/7dtd/world/token, then
// attaches it to the cross-origin upload. This avoids widening the auth cookie's domain
// (which would force everyone to re-login and risks lockout on the live app).
//
// **"uploads", plural.** This said "authorizes ONE upload", which is a property the code
// does not have: there is no nonce and no replay store, so a token is good for any number
// of uploads until it expires. Not a serious hole — the TTL is 10 minutes and minting is
// gated on the same capability as uploading — but a comment that claims single-use is the
// exact pattern that hid the PZ SIGTERM bug through four audits, so it is reworded rather
// than left to be trusted. Making it true would mean a store of spent nonces, which is
// state that can get stuck; the TTL is the cheaper bound.

const SECRET = process.env.AUTH_SECRET;
const HAS_SECRET = Boolean(SECRET && SECRET !== "dev-secret-change-me");
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createUploadToken(userId: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!HAS_SECRET) throw new Error("World upload tokens require a configured AUTH_SECRET");
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + ttlMs })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET!).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyUploadToken(token: string | null | undefined): { userId: string } | null {
  if (!HAS_SECRET || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const expected = crypto.createHmac("sha256", SECRET!).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof e !== "number" || !Number.isFinite(e) || Date.now() > e) return null;
    if (typeof u !== "string" || !u) return null;
    return { userId: u };
  } catch {
    return null;
  }
}
