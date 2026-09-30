import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";

/**
 * Stream a `multipart/form-data` upload's file part straight to disk.
 *
 * ## Why this exists
 *
 * `/api/7dtd/world` used to do `await request.formData()` and then
 * `Buffer.from(await file.arrayBuffer())`, which holds the payload about **three
 * times** over.
 *
 * The first draft of this comment said "twice", and attributed both copies to
 * `arrayBuffer()`. Re-measured on Node 20.12 with a real `Request` and the built-in
 * undici parser, 100 MB multipart body, `process.memoryUsage().arrayBuffers`:
 *
 *     start                 rss=236.1  arrayBuffers=200.0
 *     new Request(body)     rss=343.5  arrayBuffers=300.1   <- +1x, the body is copied in
 *     await formData()      rss=345.6  arrayBuffers=300.0   <- free; it reuses that copy
 *     await arrayBuffer()   rss=545.7  arrayBuffers=500.0   <- +2x more
 *     Buffer.from(ab)       rss=545.7  arrayBuffers=500.0   <- a view, so no third here
 *
 * So the `Buffer` really is a view — that part was right — but the request path costs
 * ~3x the file before the write even starts, and RSS grew 4.3x in the end-to-end run
 * against a real standalone server (115.2 -> 1285.1 MB for a 300 MB upload). With a 2 GB
 * cap that is ~6-8 GB, not ~5 GB, which is why the web container's `mem_limit` was 6g —
 * see the comment on the `web` service in `docker-compose.yml`, whose own "DOUBLE the
 * cap" arithmetic had the same understatement.
 *
 * It also **blocked the event loop**: `arrayBuffer()` resolves with one large
 * allocation and `writeFile` of a 2 GB Buffer is a single synchronous-ish burst, during
 * which the operation registry's heartbeat interval cannot fire. So the one operation
 * somebody is definitely watching was the one whose progress line went quiet.
 *
 * ## Why a parser rather than a dependency, and rather than a client change
 *
 * Nothing in Node streams a multipart body: `formData()` is the only built-in parser
 * and it buffers by definition. The two alternatives were a new runtime dependency
 * (`busboy`) or changing the client to `xhr.send(file)` and reading `request.body`
 * raw. Both were rejected: the wire format is load-bearing here, because the uploader
 * posts **cross-origin** to `direct.yoshling.xyz` with an HMAC token instead of a
 * cookie (Cloudflare caps requests at 100 MB), and that path is awkward to re-verify.
 * Keeping the request byte-identical means the CORS preflight, the allowed headers and
 * the token flow are provably unchanged — the only thing that changed is who reads the
 * bytes on the server.
 *
 * ## The two things that make it actually stream
 *
 * 1. **Back-pressure.** `pipeline()` is not decoration. A `ws.write(chunk)` loop that
 *    ignores the return value moves the 2 GB out of a Blob and into the WriteStream's
 *    internal queue, which is the same bug wearing a hat.
 * 2. **A bounded look-behind.** The closing delimiter can straddle a chunk boundary,
 *    so the last `delimiter.length - 1` bytes are held back rather than the whole
 *    body being buffered to search it.
 *
 * Peak memory is therefore one chunk plus that look-behind, independent of file size.
 */

/** Rejected because the body is not a multipart upload we can read. */
export class MalformedUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedUploadError";
  }
}

/** Rejected because the file part exceeded the cap *while streaming*. */
export class UploadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Upload exceeded the ${maxBytes}-byte limit`);
    this.name = "UploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export interface MultipartPart {
  /** The form field name (`file`). */
  name: string;
  /** null for a non-file part; that is exactly how we tell the two apart. */
  filename: string | null;
  contentType: string | null;
}

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

/**
 * How much envelope we will read looking for the first file part.
 *
 * Without a ceiling, a body that is nothing but millions of tiny non-file parts would
 * keep us reading forever — and `Content-Length` is optional, so the route's size check
 * cannot be relied on to bound it. A browser puts at most a handful of small fields
 * before the file, so 1 MiB is several orders of magnitude of slack.
 */
const MAX_SCAN_BYTES = 1024 * 1024;

/** A single part's headers. Same reasoning: bounded, because the peer chooses them. */
const MAX_PART_HEADER_BYTES = 16 * 1024;

/**
 * The boundary token out of a `Content-Type`, or null if this is not multipart.
 *
 * RFC 2046 allows the value to be quoted (`boundary="----x"`), and browsers do not
 * quote it — but `curl -F` and some HTTP clients do, so both forms are accepted.
 */
export function parseMultipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  if (!/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
  const m = contentType.match(/;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = m?.[1] ?? m?.[2];
  return boundary ? boundary : null;
}

/**
 * `filename="a.zip"` out of a `Content-Disposition` value.
 *
 * Decoded as UTF-8, not latin1: per the HTML form-submission spec a browser sends the
 * filename's raw UTF-8 bytes and percent-encodes only `"`, CR and LF, so a name like
 * `世界.zip` arrives as UTF-8 inside an otherwise-ASCII header. Reading the header block
 * as latin1 (the obvious choice for headers) would turn it into mojibake.
 */
function dispositionParam(value: string, key: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;]*))`, "i");
  const m = value.match(re);
  const raw = m?.[1] ?? m?.[2];
  if (raw === undefined) return null;
  return raw
    .trim()
    .replace(/%22/g, '"')
    .replace(/%0D/gi, "\r")
    .replace(/%0A/gi, "\n");
}

function parsePartHeaders(raw: string): MultipartPart {
  let name = "";
  let filename: string | null = null;
  let contentType: string | null = null;
  for (const line of raw.split("\r\n")) {
    const m = line.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "content-disposition") {
      name = dispositionParam(m[2], "name") ?? "";
      filename = dispositionParam(m[2], "filename");
    } else if (key === "content-type") {
      contentType = m[2].trim() || null;
    }
  }
  return { name, filename, contentType };
}

/**
 * A pull-based buffer over an async chunk source.
 *
 * Deliberately not a `Transform`: the parser needs to say "give me more until I can see
 * a delimiter", and everything it holds at any moment is one source chunk plus the
 * look-behind.
 */
class ChunkReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private consumed = 0;
  private readonly it: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]();
  }

  get buffered(): Buffer {
    return this.buf;
  }
  /**
   * Bytes handed out by `take()` so far.
   *
   * Deliberately *consumed* and not *pulled*: the source is free to hand us a multi-MiB
   * first chunk, so a pulled-bytes cap would refuse a perfectly ordinary upload whose
   * file part starts 200 bytes in. Consumed bytes are the envelope we actually walked.
   */
  get bytesConsumed(): number {
    return this.consumed;
  }
  get atEnd(): boolean {
    return this.ended;
  }

  /** Append one more source chunk. False once the source is exhausted. */
  async pull(): Promise<boolean> {
    if (this.ended) return false;
    const r = await this.it.next();
    if (r.done) {
      this.ended = true;
      return false;
    }
    // `Buffer.from(Uint8Array)` copies, which matters: a chunk handed to us may be a
    // view onto a pooled buffer the source is free to reuse once we yield.
    const chunk = Buffer.from(r.value);
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return true;
  }

  /** Remove and return the first `n` buffered bytes. */
  take(n: number): Buffer {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.consumed += out.length;
    return out;
  }

  /** Read until `needle` is buffered, or the source ends. Returns its index or -1. */
  async findAhead(needle: Buffer, maxAhead: number): Promise<number> {
    for (;;) {
      const i = this.buf.indexOf(needle);
      if (i >= 0) return i;
      if (this.buf.length > maxAhead) return -1;
      if (!(await this.pull())) return -1;
    }
  }

  /** Discard everything left, without buffering it. For a refusal mid-body. */
  async drain(): Promise<void> {
    this.buf = Buffer.alloc(0);
    while (await this.pull()) this.buf = Buffer.alloc(0);
  }
}

export interface OpenedFilePart {
  part: MultipartPart;
  /** The part's bytes, in order. Ends at the closing delimiter. */
  body: AsyncGenerator<Buffer, void>;
  /**
   * Throw away whatever is left of the request body.
   *
   * Needed when we refuse an upload *after* starting to read it (a bad filename):
   * answering while the peer is still sending is allowed but unkind, and some
   * intermediaries surface it to the browser as a network error rather than as our
   * 400. Discarding costs no memory.
   */
  drainRest: () => Promise<void>;
}

/**
 * Position the reader on the first part that carries a `filename`, and hand back a
 * generator over its bytes. Non-file fields before it are skipped, not buffered.
 *
 * Returns null when the body contains no file part at all.
 */
export async function openFirstFilePart(
  source: AsyncIterable<Uint8Array>,
  boundary: string
): Promise<OpenedFilePart | null> {
  const reader = new ChunkReader(source);
  const delimiter = Buffer.from(`--${boundary}`);
  // Every delimiter after the first is preceded by CRLF, and that CRLF belongs to the
  // delimiter rather than to the part's content — a body whose last byte looks like the
  // start of one is why the look-behind below exists.
  const needle = Buffer.concat([CRLF, delimiter]);

  // Skip the preamble (usually empty) up to the first delimiter.
  const first = await reader.findAhead(delimiter, MAX_SCAN_BYTES);
  if (first < 0) {
    throw new MalformedUploadError("the upload's multipart boundary was never found");
  }
  reader.take(first + delimiter.length);

  for (;;) {
    // Bounded while *hunting*. Once we return, the body generator has no such cap —
    // the caller's byte cap governs the file itself.
    if (reader.bytesConsumed > MAX_SCAN_BYTES) {
      throw new MalformedUploadError("no file part found near the start of the upload");
    }
    while (reader.buffered.length < 2 && (await reader.pull())) {
      /* need enough to tell "--" (last boundary) from CRLF (another part) */
    }
    if (reader.buffered.length < 2) return null;
    // `--` immediately after a delimiter is the closing boundary: no more parts.
    if (reader.buffered[0] === 0x2d && reader.buffered[1] === 0x2d) return null;

    const hdrEnd = await reader.findAhead(HEADER_END, MAX_PART_HEADER_BYTES);
    if (hdrEnd < 0) {
      throw new MalformedUploadError("a multipart part had no usable headers");
    }
    const raw = reader.take(hdrEnd + HEADER_END.length).toString("utf-8");
    const part = parsePartHeaders(raw);

    if (part.filename !== null) {
      return {
        part,
        body: streamPartBody(reader, needle),
        drainRest: () => reader.drain(),
      };
    }

    // A plain field: walk past its body without accumulating it.
    const end = await reader.findAhead(needle, MAX_SCAN_BYTES);
    if (end < 0) {
      throw new MalformedUploadError("a multipart field was not terminated");
    }
    reader.take(end + needle.length);
  }
}

async function* streamPartBody(reader: ChunkReader, needle: Buffer): AsyncGenerator<Buffer, void> {
  for (;;) {
    const i = reader.buffered.indexOf(needle);
    if (i >= 0) {
      if (i > 0) yield reader.take(i);
      reader.take(needle.length);
      return;
    }
    // Hold back only as much as a delimiter could span. Emitting it would be wrong
    // (those bytes may turn out to be the delimiter); buffering more would be the bug
    // this file exists to remove.
    const keep = Math.min(needle.length - 1, reader.buffered.length);
    const emit = reader.buffered.length - keep;
    if (emit > 0) yield reader.take(emit);
    if (!(await reader.pull())) {
      /**
       * The closing delimiter never arrived, i.e. the client went away mid-upload.
       *
       * Throwing is the point. `formData()` also rejected here, and a truncated zip
       * that is *accepted* is the documented failure mode of this codebase: the
       * extract would fail later, or worse, succeed on a partial tree and report a
       * placed world. A short upload must not be a placed world.
       */
      throw new MalformedUploadError("the upload ended before its closing boundary");
    }
  }
}

/**
 * Write an async byte source to `destPath`, enforcing `maxBytes` as it goes.
 *
 * The cap is enforced here and not only from `Content-Length`, because that header is
 * optional (a chunked upload has none) and is in any case the peer's claim about its
 * own body rather than a measurement of it.
 */
export async function writeStreamToFile(opts: {
  source: AsyncIterable<Buffer>;
  destPath: string;
  maxBytes: number;
  /** Called as bytes land. Throttle inside the callback if it is expensive. */
  onProgress?: (bytesWritten: number) => void;
}): Promise<{ bytesWritten: number }> {
  const counted = { bytes: 0 };
  async function* limit(): AsyncGenerator<Buffer, void> {
    for await (const chunk of opts.source) {
      counted.bytes += chunk.length;
      if (counted.bytes > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes);
      yield chunk;
      opts.onProgress?.(counted.bytes);
    }
  }
  // `pipeline`, not a write loop: it is what honours `ws.write()` returning false.
  await pipeline(limit(), createWriteStream(opts.destPath));
  return { bytesWritten: counted.bytes };
}

/**
 * A web `ReadableStream` (what a route handler's `request.body` is) as Node chunks.
 *
 * `Readable.fromWeb` rather than `for await (const c of request.body)`: the DOM lib
 * types do not declare `Symbol.asyncIterator` on `ReadableStream`, so the latter needs
 * a cast at every call site and silently depends on a Node-only extension.
 */
export function webStreamChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  return Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>);
}
