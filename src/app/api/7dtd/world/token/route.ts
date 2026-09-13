import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { createUploadToken } from "@/lib/upload-token";

// Mint a short-lived signed token so the browser can upload a large world
// directly to the non-Cloudflare host (direct.yoshling.xyz), where the session
// cookie isn't sent. Called from the already-authenticated page on yoshling.xyz.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const token = createUploadToken(session.user.id);
  // The host to POST the big upload to (bypasses Cloudflare's 100MB cap).
  const directHost = process.env.NEXT_PUBLIC_DIRECT_UPLOAD_HOST || "";
  return NextResponse.json({ token, directHost });
}
