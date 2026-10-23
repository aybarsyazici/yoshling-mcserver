import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AionApiError, aionCharacterId } from "@/lib/aion2-api";
import { AionStoreError } from "@/lib/aion2-store";
import { isAionRegion, type AionCharacterRef, type AionRegion } from "@/lib/aion2-types";

const responseHeaders = { "Cache-Control": "private, no-store" };
type RateState = { startedAt: number; requests: number };
const globals = globalThis as typeof globalThis & { __aion2HttpRates?: Map<string, RateState> };
const rates = (globals.__aion2HttpRates ??= new Map<string, RateState>());

export function aionJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: responseHeaders });
}

function requireSameOrigin(request: Request) {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") throw new AionStoreError("Use the Aion helper on this site to make changes", 403);
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const allowed = new Set([new URL(request.url).origin]);
  if (process.env.AUTH_URL) { try { allowed.add(new URL(process.env.AUTH_URL).origin); } catch {} }
  if (!allowed.has(origin)) throw new AionStoreError("This request came from another site", 403);
}

export function limitAionRequests(ownerId: string, bucket: string, maximum = 20) {
  const now = Date.now();
  for (const [key, value] of rates) if (now - value.startedAt >= 60_000) rates.delete(key);
  const key = `${ownerId}:${bucket}`;
  const current = rates.get(key) ?? { startedAt: now, requests: 0 };
  current.requests++;
  rates.set(key, current);
  if (current.requests > maximum) throw new AionStoreError("Too many requests; please wait a minute", 429, Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1000)));
}

export async function withAionUser(request: Request, work: (ownerId: string) => Promise<NextResponse>, mutation = false): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) return aionJson({ error: "Sign in to use the Aion helper" }, 401);
    if (mutation) requireSameOrigin(request);
    limitAionRequests(session.user.id, "all", 120);
    return await work(session.user.id);
  } catch (error) {
    if (error instanceof AionStoreError || error instanceof AionApiError) {
      const response = aionJson({ error: error.message }, error.status);
      if (error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
    const message = error instanceof Error ? error.message : "";
    if (/no such table.*Aion2|table.*Aion2.*does not exist/i.test(message)) {
      return aionJson({ error: "The Aion tracking database is not ready. Apply the reviewed Aion migration before using saved characters." }, 503);
    }
    return aionJson({ error: "The Aion helper could not complete this request; reload current data before trying again" }, 503);
  }
}

export function aionRegion(value: unknown): AionRegion {
  if (!isAionRegion(value)) throw new AionStoreError("Choose a supported Aion region", 400);
  return value;
}

export function aionServerId(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > 99999) throw new AionStoreError("Choose a valid server", 400);
  return number;
}

export function aionRecordId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new AionStoreError("Invalid saved character", 400);
  return value;
}

export function aionCharacterRef(body: Record<string, unknown>): AionCharacterRef {
  const characterId = aionCharacterId(body.characterId);
  return { region: aionRegion(body.region), serverId: aionServerId(body.serverId), characterId };
}

export async function aionBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new AionStoreError("Expected a JSON request", 415);
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new AionStoreError("The request is too large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AionStoreError("Expected a JSON request body", 400);
  let expired = false, total = 0;
  const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 3000);
  try {
    for (;;) {
      const result = await reader.read();
      if (expired) throw new AionStoreError("Reading the request timed out", 408);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > 4096) throw new AionStoreError("The request is too large", 413);
      chunks.push(result.value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AionStoreError("Expected valid JSON", 400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AionStoreError("Expected a JSON object", 400);
    return value as Record<string, unknown>;
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
