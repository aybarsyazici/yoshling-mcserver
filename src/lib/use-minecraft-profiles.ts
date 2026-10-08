"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseMinecraftProfiles } from "@/lib/minecraft-profiles-client";
import type { MinecraftProfilesDTO } from "@/lib/minecraft-profile-types";

export function useMinecraftProfiles(enabled = true) {
  const [data, setData] = useState<MinecraftProfilesDTO | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [hasAccepted, setHasAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const accepted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    // A pending refresh does not invalidate the last accepted reading. Failures
    // still set error and disable actions until a validated response arrives.
    setLoading(!accepted.current);
    setRefreshing(true);
    try {
      const response = await fetch("/api/minecraft/profiles", { cache: "no-store" });
      const raw = await response.json();
      if (request !== generation.current) return false;
      if (!response.ok) throw new Error(typeof raw?.error === "string" ? raw.error : "Minecraft profiles could not be read.");
      const parsed = parseMinecraftProfiles(raw);
      if (!parsed) throw new Error("The profile response is incomplete. Reload before taking an action.");
      if (!parsed.capabilities.read) throw new Error("This account cannot read Minecraft profiles.");
      accepted.current = true;
      setHasAccepted(true);
      setData(parsed); setError(null);
      return true;
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : "Minecraft profiles could not be read.");
      return false;
    } finally { if (request === generation.current) { setLoading(false); setRefreshing(false); } }
  }, []);
  const invalidate = useCallback(() => { generation.current++; accepted.current = false; setHasAccepted(false); }, []);
  useEffect(() => {
    let current = true;
    if (enabled) void Promise.resolve().then(() => { if (current) return refresh(); });
    return () => { current = false; invalidate(); };
  }, [enabled, refresh, invalidate]);
  return { data, loading, refreshing, error, refresh, ready: enabled && hasAccepted && !loading && !error && data !== null };
}
