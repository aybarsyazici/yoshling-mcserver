"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseMinecraftProfiles } from "@/lib/minecraft-profiles-client";
import type { MinecraftProfilesDTO } from "@/lib/minecraft-profile-types";

export function useMinecraftProfiles(enabled = true) {
  const [data, setData] = useState<MinecraftProfilesDTO | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const response = await fetch("/api/minecraft/profiles", { cache: "no-store" });
      const raw = await response.json();
      if (request !== generation.current) return;
      if (!response.ok) throw new Error(typeof raw?.error === "string" ? raw.error : "Minecraft profiles could not be read.");
      const parsed = parseMinecraftProfiles(raw);
      if (!parsed) throw new Error("The profile response is incomplete. Reload before taking an action.");
      if (!parsed.capabilities.read) throw new Error("This account cannot read Minecraft profiles.");
      setData(parsed); setError(null);
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : "Minecraft profiles could not be read.");
    } finally { if (request === generation.current) setLoading(false); }
  }, []);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => {
    let current = true;
    if (enabled) void Promise.resolve().then(() => { if (current) return refresh(); });
    return () => { current = false; invalidate(); };
  }, [enabled, refresh, invalidate]);
  return { data, loading, error, refresh, ready: enabled && !loading && !error && data !== null };
}
