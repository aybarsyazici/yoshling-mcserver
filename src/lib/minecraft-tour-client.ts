import type { MinecraftTourState } from "./minecraft-tour-state";

export const MINECRAFT_TOUR_REQUEST_MS = 15_000;
export class MinecraftTourRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function parseMinecraftTourState(value: unknown, userId: string): MinecraftTourState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tour preference could not be verified");
  const state = value as MinecraftTourState;
  if (state.userId !== userId || state.version !== 1 || typeof state.done !== "boolean") throw new Error("Tour preference identity could not be verified");
  return { userId, version: 1, done: state.done };
}
/** Deadline includes response headers and the body, even if a test/proxy ignores abort. */
export async function requestMinecraftTourState(userId: string, method: "GET" | "POST", signal: AbortSignal): Promise<MinecraftTourState> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abort = () => { controller.abort(); rejectAbort?.(new Error("Tour request was interrupted")); };
  const deadline = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => { controller.abort(); reject(new Error("Tour request timed out")); }, MINECRAFT_TOUR_REQUEST_MS);
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch("/api/minecraft/tour", { method, cache: "no-store", signal: controller.signal,
        headers: { "X-Minecraft-Tour-User": userId, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ version: 1, done: true }) } : {}) });
      if (!response.ok) throw new MinecraftTourRequestError(`Tour preference request refused (HTTP ${response.status})`, response.status);
      const contentType = response.headers?.get("content-type");
      if (contentType && !contentType.toLowerCase().includes("application/json")) throw new Error("Tour preference response was not JSON");
      let value: unknown;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let total = 0, text = "";
        try {
          for (;;) {
            const block = await reader.read(); if (block.done) break;
            total += block.value.byteLength; if (total > 64 * 1024) throw new Error("Tour preference response exceeded its bound");
            text += decoder.decode(block.value, { stream: true });
          }
          value = JSON.parse(text + decoder.decode());
        } finally { void reader.cancel().catch(() => {}); }
      } else value = await response.json();
      if (controller.signal.aborted || signal.aborted) throw new Error("Tour request was interrupted");
      return parseMinecraftTourState(value, userId);
    })()]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
}
