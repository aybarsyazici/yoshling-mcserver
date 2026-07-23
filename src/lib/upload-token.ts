import crypto from "crypto";

// Short-lived, HMAC-signed token that authorizes ONE upload from the browser to
// the direct (non-Cloudflare) subdomain, where the session cookie isn't sent
// (it's host-only for yoshling.xyz). The already-authenticated page mints this
// via /api/7dtd/world/token, then attaches it to the cross-origin upload. This
// avoids widening the auth cookie's domain (which would force everyone to
// re-login and risks lockout on the live app).

const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createUploadToken(userId: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + ttlMs })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyUploadToken(token: string | null | undefined): { userId: string } | null {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof e !== "number" || Date.now() > e) return null;
    if (typeof u !== "string" || !u) return null;
    return { userId: u };
  } catch {
    return null;
  }
}
