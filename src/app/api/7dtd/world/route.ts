import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, rm, readdir } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { verifyUploadToken } from "@/lib/upload-token";

// This route can be hit cross-origin from direct.yoshling.xyz (the non-Cloudflare
// host used for large uploads). Allow that specific origin for CORS.
const DIRECT_ORIGIN = process.env.NEXT_PUBLIC_DIRECT_UPLOAD_ORIGIN || "https://direct.yoshling.xyz";
const PROXIED_ORIGIN = process.env.AUTH_URL || "https://yoshling.xyz";
function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin === DIRECT_ORIGIN || origin === PROXIED_ORIGIN ? origin : PROXIED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Upload-Token",
    "Access-Control-Allow-Credentials": "true",
  };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export const runtime = "nodejs";
// Worlds can be large; allow a long-running request for the extract.
export const maxDuration = 300;

const execAsync = promisify(exec);
const SAVES_DIR = process.env.SDTD_SERVER_DIR || "/sevendtd"; // = .local/share/7DaysToDie
const WORLDS_DIR = path.join(SAVES_DIR, "GeneratedWorlds");
const TMP_DIR = "/app/data/tmp";
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB cap

// A custom WORLD (map) has these signature files; a SAVE has main.ttw / region data.
const WORLD_MARKERS = ["dtm.raw", "biomes.png", "prefabs.xml", "splat3.png", "world.json"];
const SAVE_MARKERS = ["main.ttw", "players.xml"];

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _.-]/g, "").replace(/\.+/g, ".").trim().slice(0, 60);
}

// List existing generated worlds so the UI can show what's installed.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const entries = await readdir(WORLDS_DIR, { withFileTypes: true }).catch(() => []);
    const worlds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return NextResponse.json({ worlds });
  } catch {
    return NextResponse.json({ worlds: [] });
  }
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request.headers.get("origin"));
  const json = (body: object, status = 200) =>
    NextResponse.json(body, { status, headers: cors });

  // Auth: either a logged-in ADMIN session, OR a valid short-lived upload token
  // (used when POSTing cross-origin from the direct host, where cookies aren't
  // sent). The token is minted by /api/7dtd/world/token for ADMINs only.
  let userId: string | null = null;
  const session = await auth();
  if (session?.user) {
    if (session.user.role !== "ADMIN") return json({ error: "Admin only" }, 403);
    userId = session.user.id;
  } else {
    const token = request.headers.get("x-upload-token");
    const verified = verifyUploadToken(token);
    if (!verified) return json({ error: "Unauthorized" }, 401);
    userId = verified.userId;
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return json({ error: "No file uploaded" }, 400);
  }
  if (!file.name.toLowerCase().endsWith(".zip")) {
    return json({ error: "Please upload a .zip file" }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: "File too large (max 2 GB)" }, 400);
  }

  await mkdir(TMP_DIR, { recursive: true });
  // Use a fixed-ish temp name (no Math.random available); the pid+size is enough
  // since uploads are admin-only and serialized in practice.
  const zipPath = path.join(TMP_DIR, `world-upload-${file.size}.zip`);
  const workDir = path.join(TMP_DIR, `world-work-${file.size}`);

  try {
    // Persist the upload to disk.
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(zipPath, buf);

    // Validate + list contents (also rejects non-zips / zip bombs early).
    const { stdout: listing } = await execAsync(`unzip -l ${JSON.stringify(zipPath)}`, { maxBuffer: 16 * 1024 * 1024 });
    if (/\.\.\//.test(listing)) {
      return json({ error: "Zip contains unsafe paths" }, 400);
    }
    const lower = listing.toLowerCase();
    const looksWorld = WORLD_MARKERS.some((m) => lower.includes(m.toLowerCase()));
    const looksSave = SAVE_MARKERS.some((m) => lower.includes(m.toLowerCase()));

    if (!looksWorld && !looksSave) {
      return json(
        { error: "This doesn't look like a 7DTD world or save. A world zip should contain files like dtm.raw / biomes.png / prefabs.xml." },
        400
      );
    }

    // Extract to a clean work dir first, then place into the right home.
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    await execAsync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(workDir)}`, { maxBuffer: 16 * 1024 * 1024, timeout: 240000 });

    // Find the folder that actually contains the world/save markers (handles a
    // wrapping top-level folder in the zip).
    const rootDir = await findContentRoot(workDir, looksWorld ? WORLD_MARKERS : SAVE_MARKERS);

    let installedAs: string;
    let kind: "world" | "save";

    if (looksWorld) {
      kind = "world";
      // World name = the folder name that held the markers, or the zip name.
      const worldName = safeName(path.basename(rootDir) === path.basename(workDir) ? file.name.replace(/\.zip$/i, "") : path.basename(rootDir));
      const dest = path.join(WORLDS_DIR, worldName);
      await mkdir(WORLDS_DIR, { recursive: true });
      await rm(dest, { recursive: true, force: true });
      await execAsync(`mv ${JSON.stringify(rootDir)} ${JSON.stringify(dest)}`);
      installedAs = worldName;
    } else {
      kind = "save";
      // Place the save under Saves/<parent>/<name> preserving its structure.
      const dest = path.join(SAVES_DIR, "Saves");
      await mkdir(dest, { recursive: true });
      // Copy contents of the extracted tree into Saves/ (merge).
      await execAsync(`cp -a ${JSON.stringify(rootDir)}/. ${JSON.stringify(dest)}/`);
      installedAs = path.basename(rootDir);
    }

    try {
      await db.activity.create({
        data: {
          userId,
          action: "edit_file",
          details: JSON.stringify({ game: "7dtd", uploaded: kind, name: installedAs }),
        },
      });
    } catch {}

    return json({
      success: true,
      kind,
      name: installedAs,
      hint:
        kind === "world"
          ? `World "${installedAs}" installed. In Settings → set Game World to "${installedAs}" and start a new game on it.`
          : `Save "${installedAs}" installed under Saves. Set Game World / Game Name to match it, then start the server.`,
    });
  } catch (e) {
    return json({ error: (e as Error).message || "Upload failed" }, 500);
  } finally {
    await rm(zipPath, { force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Walk down into single-child wrapper folders until we find the markers. */
async function findContentRoot(dir: string, markers: string[]): Promise<string> {
  const hasMarker = async (d: string) => {
    const entries = await readdir(d).catch(() => [] as string[]);
    const lower = entries.map((e) => e.toLowerCase());
    return markers.some((m) => lower.includes(m.toLowerCase()));
  };
  if (await hasMarker(dir)) return dir;
  // descend into subdirs (breadth-limited)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const subdirs = entries.filter((e) => e.isDirectory());
  for (const sd of subdirs) {
    const p = path.join(dir, sd.name);
    if (await hasMarker(p)) return p;
  }
  // one more level for save trees (Saves/<World>/<Game>/main.ttw)
  for (const sd of subdirs) {
    const found = await findContentRoot(path.join(dir, sd.name), markers).catch(() => null);
    if (found) return found;
  }
  return dir;
}
