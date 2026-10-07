import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
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
  // The same capability the upload itself needs. A token that could be minted more widely
  // than it can be spent is a gate that only looks like one.
  if (!hasPermission(session.user.role, "world.upload")) {
    return NextResponse.json(
      { error: "Uploading a world needs the admin or moderator role." },
      { status: 403 }
    );
  }
  let token: string;
  try {
    token = createUploadToken(session.user.id);
  } catch {
    return NextResponse.json(
      { error: "World uploads are unavailable: configure AUTH_SECRET." },
      { status: 503 }
    );
  }
  // The host to POST the big upload to (bypasses Cloudflare's 100MB cap).
  const directHost = process.env.NEXT_PUBLIC_DIRECT_UPLOAD_HOST || "";
  return NextResponse.json({ token, directHost });
}
