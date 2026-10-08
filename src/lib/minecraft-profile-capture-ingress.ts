import { CaptureError } from "./minecraft-profile-capture-store";
const globals = globalThis as unknown as { yoshlingCaptureIngress?: { owner: symbol; id: string; signal: AbortSignal } };
export function captureIngressActive(id: string): boolean { return globals.yoshlingCaptureIngress?.id === id && !globals.yoshlingCaptureIngress.signal.aborted; }
/** Body/decoder admission is independent of the game's short publication lease. */
export async function withCaptureIngress<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (globals.yoshlingCaptureIngress) throw new CaptureError("Another capture upload is being verified; wait before retrying", 409, "capture_ingress_busy");
  const owner = Symbol("capture ingress"), controller = new AbortController(); globals.yoshlingCaptureIngress = { owner, id, signal: controller.signal };
  const timer = setTimeout(() => controller.abort(), 30_000);
  try { const result = await work(controller.signal); if (controller.signal.aborted) throw new CaptureError("Capture upload timed out before confirmation", 408, "capture_timeout"); return result; }
  finally { clearTimeout(timer); if (globals.yoshlingCaptureIngress?.owner === owner) delete globals.yoshlingCaptureIngress; }
}
export async function boundedCaptureBody(request: Request, signal: AbortSignal, maximum = 5 * 1024 * 1024): Promise<Buffer> {
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new CaptureError("Capture image exceeds its byte limit", 413, "capture_too_large");
  const reader = request.body?.getReader(); if (!reader) throw new CaptureError("A capture image body is required", 400);
  const chunks: Buffer[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new CaptureError("Capture body timed out", 408, "capture_timeout");
      const next = await reader.read();
      if (signal.aborted) throw new CaptureError("Capture body timed out", 408, "capture_timeout");
      if (next.done) break;
      bytes += next.value.byteLength; if (bytes > maximum) throw new CaptureError("Capture image exceeds its byte limit", 413, "capture_too_large");
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, bytes);
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
