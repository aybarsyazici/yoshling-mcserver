import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { denyGame } from "@/lib/game-gate";
import { hasPermission } from "@/lib/permissions";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, rm, readdir, readFile, stat } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { db } from "@/lib/db";
import { verifyUploadToken } from "@/lib/upload-token";
import { runOperation, type OpHandle, type OpSuccess } from "@/lib/operations";
import { conflictResponse, isConflict } from "@/lib/operation-response";
import { unsafeZipPaths, zipMemberNames } from "@/lib/file-guard";
import { formatBytes } from "@/lib/format";
import { MAX_WORLD_UPLOAD_BYTES, MAX_WORLD_UPLOAD_LABEL } from "@/lib/sdtd-upload-limits";
import {
  SAVE_MARKERS,
  WORLD_MARKERS,
  classifyZipListing,
  saveTargetForUpload,
  worldTargetForUpload,
} from "@/lib/sdtd-upload-shape";
import {
  MalformedUploadError,
  UploadTooLargeError,
  openFirstFilePart,
  parseMultipartBoundary,
  webStreamChunks,
  writeStreamToFile,
} from "@/lib/upload-stream";

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

/**
 * `execFile`, never `exec`.
 *
 * Every argument below is a path, and two of them (`rootDir`, and the temp dir keyed
 * on the upload) are derived from the *contents of the uploaded zip*. Quoting them
 * with `JSON.stringify` is not protection: those are double quotes, inside which
 * `sh` still expands `$(...)` and backticks. `safeName` only ever covered the world
 * name, not the extracted directory these use. An argv array spawns no shell.
 */
const execFileAsync = promisify(execFile);
const SAVES_DIR = process.env.SDTD_SERVER_DIR || "/sevendtd"; // = .local/share/7DaysToDie
const WORLDS_DIR = path.join(SAVES_DIR, "GeneratedWorlds");
const SAVES_ROOT = path.join(SAVES_DIR, "Saves");
const SDTD_CONFIG_DIR = process.env.SDTD_CONFIG_DIR || "/sevendtd-config";
const TMP_DIR = "/app/data/tmp";
// Shared with the uploader card so the browser refuses what the server would refuse —
// and set to what Caddy will actually carry. See `src/lib/sdtd-upload-limits.ts`.
const MAX_BYTES = MAX_WORLD_UPLOAD_BYTES;

/**
 * `Content-Length` covers the multipart envelope as well as the file, so comparing it
 * straight to `MAX_BYTES` would refuse a file a few hundred bytes under the cap. This
 * slack only affects the *early* refusal; `writeStreamToFile` enforces `MAX_BYTES` on
 * the file's own bytes as they land, which is the gate that cannot be lied to.
 */
const ENVELOPE_SLACK_BYTES = 64 * 1024;

/**
 * The uid/gid the 7DTD server runs as.
 *
 * This web container is Alpine and runs as **root**, so everything it unzips and moves
 * lands root-owned — and the game does not. Verified on the box 2026-09-29: `/sevendtd`,
 * `/sevendtd/Saves` and `/sevendtd/GeneratedWorlds/Reveo Valley` are all `1000:1000`
 * (`vinanrra/7dtd-server` runs as its `sdtdserver` user), and neither `PUID` nor `PGID`
 * is set on the web container, so the fallback is what is used in practice. The env vars
 * exist only so an image change has one knob rather than a code edit.
 */
const SDTD_UID = process.env.SDTD_PUID || process.env.PUID || "1000";
const SDTD_GID = process.env.SDTD_PGID || process.env.PGID || "1000";

/**
 * Was the placement actually usable **by the game**?
 *
 * The check this replaces was a root `stat()` on the destination, which answers "does a
 * directory exist" and nothing else. It reported a green `On disk: found where the server
 * will look for it` in both of the real failure modes, because root cannot see either of
 * them: a tree left root-owned by `mv`, and a zip that stored 0600 modes. Worse, on the
 * save branch it stat'd `Saves/` *itself*, which exists whatever the upload did — so that
 * fact could not fail.
 *
 * Ask the two questions the game's uid would ask instead: do I own this, and can I read
 * the file that makes it a world/save?
 *
 * `SDTD_UID`/`SDTD_GID` must be **numeric** — `chown` would accept a name, but `stat`
 * reports numbers, so a name would make this comparison fail on every upload.
 */
async function verifyPlacement(
  dir: string,
  markers: string[]
): Promise<{ ok: boolean; why: string }> {
  const st = await stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return { ok: false, why: "not found after the move" };
  if (st.uid !== Number(SDTD_UID) || st.gid !== Number(SDTD_GID)) {
    return { ok: false, why: `placed, but owned by ${st.uid}:${st.gid}, not by the game's user` };
  }
  const entries = await readdir(dir).catch(() => [] as string[]);
  const marker = entries.find((e) => markers.some((m) => m.toLowerCase() === e.toLowerCase()));
  if (!marker) return { ok: false, why: "placed, but the file that identifies it is missing" };
  const mst = await stat(path.join(dir, marker)).catch(() => null);
  // Group + other read. `chmod -R go+rX` sets both; a zip storing 0600 sets neither, and
  // that is a world the server silently cannot load.
  if (!mst || (mst.mode & 0o044) !== 0o044) {
    return { ok: false, why: "placed, but not readable by the game's user" };
  }
  return { ok: true, why: "owned by the game's user and readable" };
}

/**
 * The world *and* game name the server is configured to load, i.e. the save directory
 * `Saves/<GameWorld>/<GameName>` that holds the progress people actually played.
 *
 * Both halves matter and only one of them was ever read. `protectedWorldReason` checks
 * `GameWorld` alone, which is the right question for a **map** under `GeneratedWorlds`
 * and the wrong one for a **save** under `Saves/` -- a save upload named
 * `Reveo Valley/Fresh2` is the live save, and the old save branch would have overwritten
 * it without asking. Returns null when the file can't be read, in which case every
 * caller treats "unknown" as "not protected" exactly as it did before.
 */
async function liveSaveIds(): Promise<{ world: string; game: string } | null> {
  try {
    const xml = await readFile(path.join(SDTD_CONFIG_DIR, "sdtdserver.xml"), "utf-8");
    const world = xml.match(/<property\s+name="GameWorld"\s+value="([^"]*)"/i)?.[1] ?? "";
    const game = xml.match(/<property\s+name="GameName"\s+value="([^"]*)"/i)?.[1] ?? "";
    if (!world && !game) return null;
    return { world, game };
  } catch {
    return null;
  }
}

/**
 * A world we must not replace or delete, with the reason to show. Both the
 * uploader and DELETE go through this so the two can't drift: installing a world
 * `rm -rf`s any existing one of the same name first, which is every bit as
 * destructive as a delete (the live map, Reveo Valley, is 417 MB).
 * Returns null when the world is fair game.
 */
async function protectedWorldReason(
  name: string,
  /**
   * `"delete"` blocks on anything a backup depends on. `"replace"` (an upload of
   * the same name) does not, because that rule is wrong for uploads: it told an
   * admin to **delete their only 7DTD backup in order to upload a map**, which
   * trades a recoverable mismatch for an unrecoverable one. Replacing terrain a
   * backup references only means that backup's saves pair with different terrain --
   * worth a confirmation, not a refusal. The active world stays blocked either way.
   */
  mode: "delete" | "replace" = "delete"
): Promise<string | null> {
  // 1) the world the server is configured to load (sdtdserver.xml GameWorld).
  try {
    const cur = (await liveSaveIds())?.world;
    if (cur && cur === name) {
      return `"${name}" is the server's current world. Switch Game World to something else first.`;
    }
  } catch {}

  // 2) a backup bundles this map, so swapping it out would leave that backup's
  //    saves paired with different terrain.
  if (mode === "delete") {
    try {
      const { worldsUsedByBackups } = await import("@/app/api/7dtd/backups/route");
      const used = await worldsUsedByBackups();
      if (used.has(name)) {
        return `"${name}" is included in one or more backups. Delete those backups first.`;
      }
    } catch {}
  }

  return null;
}

// Stock worlds ship inside the server files (Navezgane, Pregen*, …).
const STOCK_WORLDS_DIR = path.join(SDTD_CONFIG_DIR, "Data", "Worlds");

async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Returns the uploaded custom worlds AND the full set of worlds the server can
// be pointed at (stock + generated), so the Settings GameWorld field can offer
// every valid choice instead of a hardcoded Navezgane/RWG.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  const generated = await listDirs(WORLDS_DIR);
  const stock = await listDirs(STOCK_WORLDS_DIR);
  // "RWG" = generate a random world at runtime; always a valid option.
  const all = Array.from(new Set(["RWG", ...stock, ...generated])).sort((a, b) =>
    a === "RWG" ? -1 : b === "RWG" ? 1 : a.localeCompare(b)
  );
  return NextResponse.json({ worlds: generated, allWorlds: all });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request.headers.get("origin"));
  const json = (body: object, status = 200) =>
    NextResponse.json(body, { status, headers: cors });

  // Auth: either a logged-in session holding `world.upload`, OR a valid short-lived upload
  // token (used when POSTing cross-origin from the direct host, where cookies aren't
  // sent). The token is minted by /api/7dtd/world/token behind the same capability.
  let userId: string | null = null;
  const session = await auth();
  if (session?.user) {
    if (!hasPermission(session.user.role, "world.upload")) {
      return json(
        { error: "Replacing a world or a save needs the admin or moderator role." },
        403
      );
    }
    userId = session.user.id;
  } else {
    const token = request.headers.get("x-upload-token");
    const verified = verifyUploadToken(token);
    if (!verified) return json({ error: "Unauthorized" }, 401);
    userId = verified.userId;
  }

  // Refuse an oversized body *before* reading a byte of it. This used to be
  // `file.size > MAX_BYTES`, which could only be asked after `request.formData()` had
  // already buffered the whole 2 GB — i.e. the guard against a huge upload only ran
  // once the huge upload was in memory.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES + ENVELOPE_SLACK_BYTES) {
    return json({ error: `File too large (max ${MAX_WORLD_UPLOAD_LABEL})` }, 413);
  }

  const boundary = parseMultipartBoundary(request.headers.get("content-type"));
  if (!boundary || !request.body) {
    // The uploader posts a `FormData`, so this is either a non-browser client or a
    // proxy that rewrote the body. Naming the expected shape beats "No file uploaded",
    // which is what the old code said for every one of these.
    return json({ error: "Expected a multipart/form-data upload with a single file field" }, 400);
  }
  const body = request.body;

  await mkdir(TMP_DIR, { recursive: true });
  /**
   * A temp name per request.
   *
   * What this replaces was `world-upload-${file.size}.zip` under a comment saying "no
   * Math.random available; the pid+size is enough since uploads are admin-only and
   * serialized in practice". Both halves were wrong: `crypto.randomUUID()` has always
   * been available in Node, and *no* pid appeared in the name — two uploads of the same
   * size shared one path and raced to overwrite it. What actually serialises uploads is
   * the operation registry (`world.upload` holds `files:7dtd`, so a second one is
   * refused with a 409), and that is admitted below, before anything is written.
   */
  const id = randomUUID();
  const zipPath = path.join(TMP_DIR, `world-upload-${id}.zip`);
  const workDir = path.join(TMP_DIR, `world-work-${id}`);

  try {
    return await runOperation(
      {
        kind: "world.upload",
        game: "7dtd",
        title: "Uploading a world",
        startedBy: session?.user?.name ? { name: session.user.name } : null,
      },
      (op) => placeUpload(op, { body, boundary, zipPath, workDir, userId: userId!, json })
    );
  } catch (e) {
    if (isConflict(e)) return conflictResponse(e);
    return json({ error: (e as Error).message || "Upload failed" }, 500);
  }
}

/**
 * The server half of the upload, as an operation holding `files:7dtd`.
 *
 * The percentage bar stays client-side, because `xhr.upload.onprogress` is the only
 * thing that knows how much of the body has left the browser. But this used to say the
 * server "has nothing at all to report until the body has landed", and that stopped
 * being true when the body started streaming: bytes arriving on disk are a real,
 * observed count, and the step's detail line now reports them.
 *
 * Admission happens before this function is entered, so a second concurrent upload is
 * refused with a 409 *before* either of them has read a byte of its body. That is what
 * makes "uploads are serialized" true; the old note claimed the shared temp filename
 * did it, and a shared filename is a race, not a lock.
 *
 * The body is consumed here rather than in `POST` for the same reason: the transfer is
 * the long half, and it belongs inside the operation whose heartbeat it keeps alive.
 */
async function placeUpload(
  op: OpHandle,
  {
    body,
    boundary,
    zipPath,
    workDir,
    userId,
    json,
  }: {
    body: ReadableStream<Uint8Array>;
    boundary: string;
    zipPath: string;
    workDir: string;
    userId: string;
    json: (body: object, status?: number) => NextResponse;
  }
): Promise<OpSuccess<NextResponse>> {
  try {
    /**
     * Stream the body to disk. Peak memory is one chunk, not the file.
     *
     * What this replaces was `Buffer.from(await file.arrayBuffer())` + `writeFile`,
     * which held the payload twice (measured: +104.9 MB of `arrayBuffers` for a 50 MB
     * file) and blocked the event loop while it did — so the heartbeat that drives the
     * progress line went quiet during the one operation someone was watching. See
     * `src/lib/upload-stream.ts`.
     */
    op.step("Writing the upload to disk");
    let opened;
    try {
      opened = await openFirstFilePart(webStreamChunks(body), boundary);
    } catch (e) {
      // A body we cannot parse is the client's problem, not a 500. Without this the
      // route answered "Upload failed: <parser message>" with a 500, which reads as the
      // server having broken.
      if (e instanceof MalformedUploadError) {
        op.reject(`Rejected the upload — ${e.message}`);
        return { value: json({ error: `Upload failed: ${e.message}` }, 400) };
      }
      throw e;
    }
    if (!opened) {
      op.reject("No file in the upload");
      return { value: json({ error: "No file uploaded" }, 400) };
    }
    const uploadName = opened.part.filename ?? "";
    if (!uploadName.toLowerCase().endsWith(".zip")) {
      // Drain before answering: we are refusing partway through the peer's body, and a
      // response sent while it is still writing can surface in the browser as a network
      // error instead of as this 400.
      await opened.drainRest();
      op.reject("Rejected the upload — not a .zip");
      return { value: json({ error: "Please upload a .zip file" }, 400) };
    }

    let lastDetailAt = 0;
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await writeStreamToFile({
        source: opened.body,
        destPath: zipPath,
        maxBytes: MAX_BYTES,
        onProgress: (bytes) => {
          // Throttled: a 2 GB upload is ~32k chunks and the ledger only needs a line
          // that visibly moves. `detail`, not `progress`, because the only total
          // available is `Content-Length` — which includes the envelope and is the
          // peer's claim, i.e. a predicted total, and those are not allowed here.
          const now = Date.now();
          if (now - lastDetailAt < 500) return;
          lastDetailAt = now;
          op.detail(`${formatBytes(bytes)} received`);
        },
      }));
    } catch (e) {
      if (e instanceof UploadTooLargeError) {
        // Deliberately *not* drained: reading another 2 GB in order to say "that was too
        // big" is the opposite of the point. `Content-Length` catches every honest client
        // before the body starts, so reaching here means a chunked or mis-declared one.
        op.reject(`Rejected the upload — larger than ${MAX_WORLD_UPLOAD_LABEL}`);
        return { value: json({ error: `File too large (max ${MAX_WORLD_UPLOAD_LABEL})` }, 413) };
      }
      if (e instanceof MalformedUploadError) {
        op.reject(`Rejected the upload — ${e.message}`);
        return { value: json({ error: `Upload failed: ${e.message}` }, 400) };
      }
      throw e;
    }
    if (bytesWritten === 0) {
      op.reject("Rejected the upload — it was empty");
      return { value: json({ error: "The uploaded file was empty" }, 400) };
    }
    op.settle(`Wrote the upload to disk — ${formatBytes(bytesWritten)}`);

    // Validate + list contents (also rejects non-zips / zip bombs early).
    op.step("Checking the upload");
    const { stdout: listing, stderr: listErr } = await execFileAsync("unzip", ["-l", zipPath], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (unsafeZipPaths(listing, listErr)) {
      op.reject("Rejected the upload — it contains unsafe paths");
      return { value: json({ error: "Zip contains unsafe paths" }, 400) };
    }
    const shape = classifyZipListing(listing);
    const looksWorld = shape === "world";

    if (shape === null) {
      op.reject("Rejected the upload — not a 7 Days to Die world or save");
      return {
        value: json(
          { error: "This doesn't look like a 7DTD world or save. A world zip should contain files like dtm.raw / biomes.png / prefabs.xml." },
          400
        ),
      };
    }
    // `/^\s*\d+\s/` also matched `unzip -l`'s trailing "<total bytes>  <n> files" row, so
    // every count this operation reported was one too many. Verified against the container's
    // BusyBox unzip: a 3-file zip counted as 4. `zipMemberNames` parses the rows properly.
    const entryCount = zipMemberNames(listing).length;
    op.settle(`Checked the upload — ${looksWorld ? "a world map" : "a save"}`, {
      count: { done: entryCount, noun: "files" },
    });

    // Extract to a clean work dir first, then place into the right home.
    op.step("Unpacking the upload");
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const { stderr: unzipErr } = await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", workDir], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 240000,
    });
    // The extraction is where Info-ZIP actually announces a strip, and it announces it on
    // stderr. Nothing has been placed yet — the `finally` below removes `workDir` — so
    // refusing here still leaves the box untouched.
    if (unsafeZipPaths("", unzipErr)) {
      op.reject("Rejected the upload — it contains unsafe paths");
      return { value: json({ error: "Zip contains unsafe paths" }, 400) };
    }
    op.settle(`Unpacked ${entryCount.toLocaleString()} files`, {
      count: { done: entryCount, noun: "files" },
    });

    // Find the folder that actually contains the world/save markers (handles a
    // wrapping top-level folder in the zip).
    const rootDir = await findContentRoot(workDir, looksWorld ? WORLD_MARKERS : SAVE_MARKERS);

    let installedAs: string;
    let kind: "world" | "save";
    let replacedExisting = false;
    // The directory that actually got placed, so the chown/chmod and the read-back below
    // both point at the same thing. The save branch used to verify `Saves/` itself, which
    // exists no matter what the upload did.
    let placedPath: string;
    // For a save, the world folder it went under — needed for the response and the hint.
    let installedUnder: string | null = null;

    if (looksWorld) {
      kind = "world";
      // World name = the folder name that held the markers, or the zip name.
      // `worldTargetForUpload` holds the two locks on the destination — a name with at
      // least one ASCII alphanumeric left after `safeName`, and a `dest` that is a *child*
      // of GeneratedWorlds rather than GeneratedWorlds itself, which the next lines
      // `rm -rf`. See `src/lib/sdtd-upload-shape.ts` for what each one prevents; they are
      // there rather than here so they can be tested without Docker.
      const target = worldTargetForUpload({ rootDir, workDir, uploadFilename: uploadName, worldsDir: WORLDS_DIR });
      if (!target.ok) {
        op.reject("Couldn't work out a world name from the zip");
        return {
          value: json(
            {
              error: `Couldn't work out a world name from "${uploadName}". Rename the zip (or the folder inside it) using plain letters and numbers, then upload again.`,
            },
            400
          ),
        };
      }
      const worldName = target.name;
      const dest = target.dest;
      // Installing over an existing world deletes it, so refuse the same worlds
      // DELETE refuses rather than silently taking out a map in use.
      // "replace", not "delete": an upload of the same name may replace terrain a
      // backup references, but must never take out the world the server is running.
      const blocked = await protectedWorldReason(worldName, "replace");
      if (blocked) {
        op.reject(`Refused to place the world — ${blocked}`);
        return { value: json({ error: blocked }, 409) };
      }

      op.step("Placing the world");
      replacedExisting = await stat(dest).then(() => true).catch(() => false);
      await mkdir(WORLDS_DIR, { recursive: true });
      await rm(dest, { recursive: true, force: true });
      await execFileAsync("mv", [rootDir, dest]);
      installedAs = worldName;
      placedPath = dest;
      op.settle(
        replacedExisting
          ? `Placed the world "${worldName}", replacing the copy already on the box`
          : `Placed the world "${worldName}"`
      );
    } else {
      kind = "save";
      /**
       * A 7DTD save lives at `Saves/<GameWorld>/<GameName>`, so *both* names have to come
       * out of the zip. `findContentRoot` returns the directory holding `main.ttw`, which
       * is the `<GameName>` level; its parent is `<GameWorld>`.
       *
       * What this replaces was destructive and produced an unloadable save, while
       * reporting a green success. Measured 2026-09-29 by the sweep that found it, with a
       * zip containing `AgentTestSaveWorld/AgentTestSave/{main.ttw,players.xml}`:
       *
       *   await execFileAsync("cp", ["-a", `${rootDir}/.`, `${dest}/`]);   // dest = Saves/
       *
       * `main.ttw` and `players.xml` landed **directly in `/sevendtd/Saves/`** — no
       * `AgentTestSaveWorld/AgentTestSave/` at all, so no `GameWorld`/`GameName` pair
       * could ever point at them — and `cp -a` applied the *source* directory's owner to
       * the destination, taking `/sevendtd/Saves` from `1000:1000` to `0:0` (it has since
       * been put back; it reads `1000:1000` today). The server runs as uid 1000, so while
       * that lasted it could not create save directories there at all: the next new game or
       * reset would have failed. The route's own comment already said "Place the save under
       * `Saves/<parent>/<name>` preserving its structure"; it did not, and nothing checked.
       */
      const target = saveTargetForUpload({ rootDir, workDir, savesRoot: SAVES_ROOT });
      if (!target.ok) {
        // Two different refusals, kept distinct because they ask for different fixes:
        // "I can't tell which world this is" (re-zip it) versus "the names you gave
        // resolve to `Saves/` itself" (rename them).
        if (target.reason === "unsafe-path") {
          op.reject("Couldn't work out where to put this save");
          return {
            value: json(
              { error: "Couldn't work out a safe location for this save. Rename the folders inside the zip using plain letters and numbers." },
              400
            ),
          };
        }
        op.reject("Couldn't work out which world this save belongs to");
        return {
          value: json(
            {
              error:
                "Couldn't work out which world this save belongs to. Zip it as <World>/<GameName>/main.ttw and upload again.",
            },
            400
          ),
        };
      }
      const worldName = target.world;
      const gameName = target.game;
      const dest = target.dest;

      // Refuse to overwrite the save the server is configured to play. `protectedWorldReason`
      // guards `GameWorld` only, which is the right question for a map and the wrong one
      // for a save: `Reveo Valley` is shared by `Fresh1` and `Fresh2`, so the world name
      // alone cannot distinguish the live save from a sibling. Without this the branch
      // above would `rm -rf` real player progress on a name collision.
      const live = await liveSaveIds();
      if (live && live.world === worldName && live.game === gameName) {
        const why = `"${worldName}/${gameName}" is the save the server is configured to play, and uploading over it would delete that progress. Rename the folders in the zip, or change Game World / Game Name in Settings first — or restore from a backup instead.`;
        op.reject(`Refused to place the save — it is the one the server is set to play`);
        return { value: json({ error: why }, 409) };
      }

      op.step("Placing the save");
      replacedExisting = await stat(dest).then(() => true).catch(() => false);
      await mkdir(path.dirname(dest), { recursive: true });
      await rm(dest, { recursive: true, force: true });
      // `mv` the directory itself, not `cp -a <dir>/.` of its contents — that is what
      // flattened the save into `Saves/` and chowned `Saves/` to root.
      await execFileAsync("mv", [rootDir, dest]);
      installedAs = gameName;
      installedUnder = worldName;
      placedPath = dest;
      op.settle(
        replacedExisting
          ? `Placed the save "${gameName}" under "${worldName}", replacing the copy already on the box`
          : `Placed the save "${gameName}" under "${worldName}"`
      );
    }

    // Hand the placed tree to the user the game runs as, in both branches. Nothing did
    // this before, and neither branch could have got it right by accident.
    //
    // The web container runs as root, so `unzip` extracts root-owned. `/app/data` and
    // `/sevendtd` are the **same filesystem** (dev 65028, verified 2026-09-29), so the `mv`
    // is a rename: it moves the inode and therefore carries that root ownership into the
    // game's tree unchanged. Everything the game itself created there is `1000:1000`. A
    // root-owned world is one the server cannot read, and that surfaces minutes later as a
    // boot that never finishes rather than as an upload error — which is the worst possible
    // place for it to surface.
    //
    // `chmod` covers the other half: a zip is free to store 0600 modes and `unzip` honours
    // them, so ownership alone is not enough. Both commands were run in this container
    // against a scratch tree to confirm BusyBox accepts them and that `u+rwX,go+rX` turns
    // 0600/0700 into 0644/0755.
    op.step("Handing the files to the game's user");
    await execFileAsync("chown", ["-R", `${SDTD_UID}:${SDTD_GID}`, placedPath]);
    await execFileAsync("chmod", ["-R", "u+rwX,go+rX", placedPath]);
    op.settle(`Set ownership to ${SDTD_UID}:${SDTD_GID}`);

    // Read it back. "We ran mv" is not evidence the files are where the server will
    // look for them, and the rule here is that a success rests on something observed
    // after the work — an operation that returns without a fact renders `unverified`.
    const landed = await verifyPlacement(placedPath, kind === "world" ? WORLD_MARKERS : SAVE_MARKERS);

    try {
      await db.activity.create({
        data: {
          userId,
          action: "edit_file",
          details: JSON.stringify({
            game: "7dtd",
            uploaded: kind,
            name: installedAs,
            ...(installedUnder ? { world: installedUnder } : {}),
          }),
        },
      });
    } catch {}

    return {
      facts: [
        {
          label: "Installed as",
          value: installedUnder ? `${installedUnder}/${installedAs}` : installedAs,
        },
        {
          label: "On disk",
          value: landed.why,
          verdict: landed.ok ? undefined : ("bad" as const),
        },
        ...(replacedExisting
          ? [
              {
                label: "Replaced",
                value: "an existing copy of the same name",
                verdict: "warn" as const,
              },
            ]
          : []),
      ],
      value: json({
        success: true,
        kind,
        name: installedAs,
        world: installedUnder,
        replacedExisting,
        hint:
          kind === "world"
            ? `World "${installedAs}" installed${replacedExisting ? ", replacing the copy that was already on the box" : ""}. In Settings → set Game World to "${installedAs}" and start a new game on it.`
            // Name what actually exists on disk. The old text said "installed under Saves"
            // and told the admin to "set Game World / Game Name to match it" without
            // saying what to match — which was apt, because the save had been flattened
            // into `Saves/` and there was nothing to match.
            : `Save "${installedAs}" installed under "${installedUnder}". In Settings → set Game World to "${installedUnder}" and Game Name to "${installedAs}".`,
      }),
    };
  } finally {
    await rm(zipPath, { force: true }).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Delete a custom (uploaded) world — never a stock world, the active world, or a
// world any backup depends on.
export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = denyGame(session, "7dtd");
  if (denied) return denied;
  if (!hasPermission(session.user.role, "world.upload")) {
    return NextResponse.json(
      { error: "Deleting an uploaded world needs the admin or moderator role." },
      { status: 403 }
    );
  }

  const name = new URL(request.url).searchParams.get("name") || "";
  if (!name || name.includes("/") || name.includes("..")) {
    return NextResponse.json({ error: "Invalid world name" }, { status: 400 });
  }

  const target = path.join(WORLDS_DIR, name);
  // Must be an existing custom world (only GeneratedWorlds is deletable).
  try {
    const st = await stat(target);
    if (!st.isDirectory()) throw new Error();
  } catch {
    return NextResponse.json({ error: "That custom world doesn't exist (stock worlds can't be deleted)." }, { status: 404 });
  }

  // Never the active world, never one a backup depends on.
  const blocked = await protectedWorldReason(name);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  try {
    await rm(target, { recursive: true, force: true });
    // Also drop its Saves/ progress for that world so nothing dangles.
    await rm(path.join(SAVES_DIR, "Saves", name), { recursive: true, force: true }).catch(() => {});
    await db.activity.create({
      data: {
        userId: session.user.id,
        action: "delete_file",
        details: JSON.stringify({ game: "7dtd", deletedWorld: name }),
      },
    }).catch(() => {});
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Delete failed" }, { status: 500 });
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
