import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import {
  MalformedUploadError,
  UploadTooLargeError,
  openFirstFilePart,
  parseMultipartBoundary,
  writeStreamToFile,
} from "../upload-stream";

/**
 * These tests pin the **property** the streaming upload has to keep, not the shape of
 * the code that currently provides it:
 *
 *   the bytes written to disk are exactly the file part's bytes, for every way the
 *   transport may split them into chunks — including a split through the middle of the
 *   closing boundary.
 *
 * That last one is the bug a look-behind exists to prevent, and it is invisible in the
 * happy path: a parser that buffers the whole body passes every single-chunk test.
 *
 * Nothing here touches Docker, the network or a running server; the two disk tests use
 * a temp dir, which is the same thing `backup-names.test.ts` does.
 */

const BOUNDARY = "----WebKitFormBoundary7dtd";

/** Build a multipart body the way a browser's `FormData` does. */
function multipart(
  parts: Array<{ name: string; filename?: string; type?: string; data: Buffer | string }>,
  boundary = BOUNDARY
): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp =
      `Content-Disposition: form-data; name="${p.name}"` +
      (p.filename !== undefined ? `; filename="${p.filename}"` : "");
    const headers =
      `--${boundary}\r\n${disp}\r\n` + (p.type ? `Content-Type: ${p.type}\r\n` : "") + `\r\n`;
    chunks.push(Buffer.from(headers, "utf-8"));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/** Feed a body in fixed-size chunks, the way a socket does. */
async function* inChunks(buf: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of gen) out.push(c);
  return Buffer.concat(out);
}

describe("parseMultipartBoundary", () => {
  it("reads the boundary a browser sends", () => {
    expect(parseMultipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  it("reads a quoted boundary, which curl -F and several HTTP clients send", () => {
    expect(parseMultipartBoundary('multipart/form-data; boundary="a;b c"')).toBe("a;b c");
  });

  it("is case- and whitespace-insensitive about the header, as HTTP requires", () => {
    expect(parseMultipartBoundary("Multipart/Form-Data;  Boundary=xyz")).toBe("xyz");
    expect(parseMultipartBoundary("multipart/form-data; charset=utf-8; boundary=xyz")).toBe("xyz");
  });

  it("refuses anything that is not a multipart upload", () => {
    // The route turns each of these into a 400 naming the shape it wants, rather than
    // reading a body it cannot parse.
    expect(parseMultipartBoundary("application/zip")).toBeNull();
    expect(parseMultipartBoundary("multipart/form-data")).toBeNull(); // no boundary
    expect(parseMultipartBoundary("multipart/mixed; boundary=x")).toBeNull();
    expect(parseMultipartBoundary(null)).toBeNull();
    expect(parseMultipartBoundary("")).toBeNull();
  });
});

describe("openFirstFilePart", () => {
  it("returns the file part's headers before any of its bytes are read", async () => {
    // This ordering is what lets the route refuse a non-.zip without writing it: the
    // filename is known from the part headers, i.e. the first few hundred bytes.
    const body = multipart([{ name: "file", filename: "world.zip", type: "application/zip", data: "PK" }]);
    const opened = await openFirstFilePart(inChunks(body, 8), BOUNDARY);
    expect(opened?.part).toEqual({
      name: "file",
      filename: "world.zip",
      contentType: "application/zip",
    });
  });

  it("reproduces the part's bytes exactly, at every chunk size", async () => {
    // A deliberately awkward payload: it contains CRLF, a lone `--`, and the boundary
    // token *minus one character*, so a parser that searches loosely will truncate it.
    const payload = Buffer.concat([
      Buffer.from("PK\x03\x04binary\r\n--not-the-boundary\r\n"),
      Buffer.from(`--${BOUNDARY.slice(0, -1)}\r\n`),
      Buffer.from([0, 255, 13, 10, 45, 45]),
    ]);
    const body = multipart([{ name: "file", filename: "w.zip", data: payload }]);
    // 1 is the pathological case (every delimiter straddles); the rest bracket the
    // boundary length (43 bytes here) from both sides.
    for (const size of [1, 2, 3, 7, 16, 41, 42, 43, 44, 64, 1024, body.length]) {
      const opened = await openFirstFilePart(inChunks(body, size), BOUNDARY);
      const got = await collect(opened!.body);
      expect(got.equals(payload), `chunk size ${size}`).toBe(true);
    }
  });

  it("does not mistake a boundary-shaped byte run inside the file for the end", async () => {
    // The closing delimiter is CRLF + `--boundary`. A file containing `--boundary`
    // *without* the leading CRLF must survive intact.
    const payload = Buffer.from(`head--${BOUNDARY}tail`);
    const body = multipart([{ name: "file", filename: "w.zip", data: payload }]);
    const opened = await openFirstFilePart(inChunks(body, 5), BOUNDARY);
    expect((await collect(opened!.body)).equals(payload)).toBe(true);
  });

  it("skips plain fields and finds the file part after them", async () => {
    const body = multipart([
      { name: "kind", data: "world" },
      { name: "note", data: "a\r\nmultiline value" },
      { name: "file", filename: "after.zip", data: "ZIPBYTES" },
    ]);
    const opened = await openFirstFilePart(inChunks(body, 9), BOUNDARY);
    expect(opened?.part.filename).toBe("after.zip");
    expect((await collect(opened!.body)).toString()).toBe("ZIPBYTES");
  });

  it("returns null when the body has no file part at all", async () => {
    const body = multipart([{ name: "kind", data: "world" }]);
    expect(await openFirstFilePart(inChunks(body, 4), BOUNDARY)).toBeNull();
  });

  it("handles an empty file part without claiming bytes it never saw", async () => {
    const body = multipart([{ name: "file", filename: "empty.zip", data: "" }]);
    const opened = await openFirstFilePart(inChunks(body, 3), BOUNDARY);
    expect((await collect(opened!.body)).length).toBe(0);
  });

  it("decodes a non-ASCII filename as UTF-8, the way browsers send it", async () => {
    // Per the HTML form-submission spec the filename's raw UTF-8 bytes go in the header
    // and only `"`, CR and LF are percent-encoded. Reading the header block as latin1
    // (the obvious choice for headers) would make this mojibake.
    const body = multipart([{ name: "file", filename: "世界.zip", data: "x" }]);
    const opened = await openFirstFilePart(inChunks(body, 6), BOUNDARY);
    expect(opened?.part.filename).toBe("世界.zip");
  });

  it("throws rather than accepting a body that was cut off mid-file", async () => {
    // A client that goes away mid-upload must not produce a placed world. The old
    // `request.formData()` rejected here too, and that behaviour is load-bearing:
    // a truncated zip is the documented "reports success after doing the wrong thing".
    const full = multipart([{ name: "file", filename: "w.zip", data: "A".repeat(500) }]);
    const cut = full.subarray(0, full.length - 60);
    const opened = await openFirstFilePart(inChunks(cut, 32), BOUNDARY);
    await expect(collect(opened!.body)).rejects.toBeInstanceOf(MalformedUploadError);
  });

  it("throws when the body is not multipart at all", async () => {
    await expect(
      openFirstFilePart(inChunks(Buffer.from("just some bytes"), 4), BOUNDARY)
    ).rejects.toBeInstanceOf(MalformedUploadError);
  });

  it("refuses an envelope that never gets to a file part, so it cannot be read forever", async () => {
    // Content-Length is optional, so the route's early size check cannot bound this.
    // A body of nothing but small non-file fields has to stop being read at some point.
    const filler = Array.from({ length: 4000 }, (_, i) => ({ name: `f${i}`, data: "x".repeat(300) }));
    const body = multipart([...filler, { name: "file", filename: "w.zip", data: "x" }]);
    expect(body.length).toBeGreaterThan(1024 * 1024);
    await expect(openFirstFilePart(inChunks(body, 4096), BOUNDARY)).rejects.toBeInstanceOf(
      MalformedUploadError
    );
  });

  it("tolerates a preamble before the first boundary", async () => {
    const body = Buffer.concat([
      Buffer.from("this is a preamble some agents insert\r\n"),
      multipart([{ name: "file", filename: "w.zip", data: "OK" }]),
    ]);
    const opened = await openFirstFilePart(inChunks(body, 11), BOUNDARY);
    expect((await collect(opened!.body)).toString()).toBe("OK");
  });
});

describe("writeStreamToFile", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function tmp(): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), "yoshling-upload-"));
    dirs.push(d);
    return d;
  }

  it("writes the streamed bytes byte-for-byte and reports the count", async () => {
    const dir = await tmp();
    const dest = path.join(dir, "out.zip");
    // 3 MiB of non-repeating bytes: a truncation or a duplicated chunk changes the file.
    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 8)) & 0xff;
    const body = multipart([{ name: "file", filename: "w.zip", data: payload }]);

    const opened = await openFirstFilePart(inChunks(body, 64 * 1024), BOUNDARY);
    const { bytesWritten } = await writeStreamToFile({
      source: opened!.body,
      destPath: dest,
      maxBytes: 10 * 1024 * 1024,
    });

    expect(bytesWritten).toBe(payload.length);
    expect((await stat(dest)).size).toBe(payload.length);
    expect((await readFile(dest)).equals(payload)).toBe(true);
  });

  it("reports progress from bytes that actually landed, never from a predicted total", async () => {
    const dir = await tmp();
    const seen: number[] = [];
    const payload = Buffer.alloc(200_000, 7);
    const body = multipart([{ name: "file", filename: "w.zip", data: payload }]);
    const opened = await openFirstFilePart(inChunks(body, 16 * 1024), BOUNDARY);
    await writeStreamToFile({
      source: opened!.body,
      destPath: path.join(dir, "out.zip"),
      maxBytes: 1024 * 1024,
      onProgress: (n) => seen.push(n),
    });
    expect(seen.length).toBeGreaterThan(1);
    // Monotonic, and the last value is the real size — not the multipart envelope's.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(payload.length);
    expect(seen.at(-1)).toBeLessThan(body.length);
  });

  it("stops at the cap mid-stream instead of writing the whole thing first", async () => {
    // The point of enforcing the cap here as well as on Content-Length: a chunked
    // upload has no Content-Length, so this is the only limit it ever meets.
    const dir = await tmp();
    const dest = path.join(dir, "out.zip");
    const maxBytes = 64 * 1024;
    const body = multipart([{ name: "file", filename: "w.zip", data: Buffer.alloc(512 * 1024, 1) }]);
    const opened = await openFirstFilePart(inChunks(body, 8 * 1024), BOUNDARY);

    await expect(
      writeStreamToFile({ source: opened!.body, destPath: dest, maxBytes })
    ).rejects.toBeInstanceOf(UploadTooLargeError);

    // Whatever landed before the refusal is a partial file the route's `finally` removes.
    // What matters here is that it never grew to the full payload.
    const size = await stat(dest).then((s) => s.size).catch(() => 0);
    expect(size).toBeLessThanOrEqual(maxBytes + 8 * 1024);
  });

  /**
   * **The property this module exists for**, and the one nothing pinned.
   *
   * The header says the first of "the two things that make it actually stream" is that
   * `pipeline()` is not decoration — "a `ws.write(chunk)` loop that ignores the return
   * value moves the 2 GB out of a Blob and into the WriteStream's internal queue, which is
   * the same bug wearing a hat". That regression was reintroduced on purpose and the whole
   * 244-test suite stayed green: the bytes on disk are identical either way, and the bytes
   * on disk are all the other tests look at.
   *
   * So this asserts the thing that differs: how far ahead of the sink the SOURCE is
   * allowed to get. A slow sink (one that defers its `_write` callback) plus a real file
   * is impossible on a laptop — a local file never blocks long enough — which is why
   * `createSink` exists.
   *
   * Bounded by "a few chunks", not by an exact number: the highWaterMark arithmetic is a
   * tuning detail, whereas "does not track the payload size" is the property. The
   * discriminating power is enormous — the write loop pulls all 64 chunks before the first
   * callback fires, `pipeline` pulls a handful.
   */
  it("does not read ahead of a slow sink — peak in flight is bounded, not payload-sized", async () => {
    const dir = await tmp();
    const dest = path.join(dir, "out.zip");
    const CHUNK = 64 * 1024;
    const CHUNKS = 64; // 4 MiB
    const { Writable } = await import("node:stream");

    let pulled = 0;
    let flushed = 0;
    let peakInFlight = 0;
    async function* source(): AsyncGenerator<Buffer, void> {
      for (let i = 0; i < CHUNKS; i++) {
        pulled++;
        peakInFlight = Math.max(peakInFlight, pulled - flushed);
        yield Buffer.alloc(CHUNK, i & 0xff);
      }
    }

    const slow = new Writable({
      highWaterMark: CHUNK,
      write(_chunk, _enc, cb) {
        // Defer: this is what a network or a loaded disk does, and what a local file
        // never does long enough to observe.
        setTimeout(() => {
          flushed++;
          cb();
        }, 1);
      },
    });

    const { bytesWritten } = await writeStreamToFile({
      source: source(),
      destPath: dest,
      maxBytes: 64 * 1024 * 1024,
      createSink: () => slow,
    });

    expect(bytesWritten).toBe(CHUNK * CHUNKS);
    expect(pulled).toBe(CHUNKS);
    // A handful, not all 64. With back-pressure honoured this is 2-3; a `write()` loop
    // that ignores the return value reads the whole payload into the queue and makes it
    // 64, i.e. proportional to the payload — the exact defect being guarded.
    expect(peakInFlight).toBeLessThanOrEqual(8);
  });

  it("leaves no successful result when the upload is truncated", async () => {
    const dir = await tmp();
    const dest = path.join(dir, "out.zip");
    const full = multipart([{ name: "file", filename: "w.zip", data: Buffer.alloc(50_000, 9) }]);
    const opened = await openFirstFilePart(inChunks(full.subarray(0, 20_000), 4096), BOUNDARY);
    await expect(
      writeStreamToFile({ source: opened!.body, destPath: dest, maxBytes: 1024 * 1024 })
    ).rejects.toBeInstanceOf(MalformedUploadError);
  });
});
