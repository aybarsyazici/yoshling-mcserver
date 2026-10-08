"use client";
import { useCallback, useRef, useState } from "react";

const HEADER = "X-Minecraft-Context";
/** Pin each editor to the profile it first read, including background refreshes. */
export interface MinecraftProfileRequest { request: typeof fetch; contextReady: boolean; contextError: string | null; contextToken: string | null }
export function useMinecraftProfileRequest(enabled = true): MinecraftProfileRequest {
  const token = useRef<string | null>(null);
  const invalidated = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextToken, setContextToken] = useState<string | null>(null);
  const request = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!enabled) return fetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!["GET", "HEAD"].includes(method)) {
      if (invalidated.current) throw new Error("The Minecraft profile changed. Reload this page before editing.");
      if (!token.current) throw new Error("Read the Minecraft profile context before editing.");
      headers.set(HEADER, token.current);
    }
    const response = await fetch(input, { ...init, headers });
    const observed = response.headers.get(HEADER);
    if (observed) {
      if (invalidated.current || token.current && observed !== token.current) {
        const message = "The Minecraft profile changed. Reload this page before editing.";
        invalidated.current = true;
        setError(message); setReady(false); throw new Error(message);
      }
      token.current = observed;
      setContextToken(observed);
      setReady(true);
    }
    return response;
  }, [enabled]);
  return { request, contextReady: !enabled || ready, contextError: error, contextToken };
}
