"use client";
import { useEffect, useState } from "react";
/** Freshness belongs to the visible polled status, not a click-time identity lookup. */
export function useMinecraftRecoveryReady(context: string | null | undefined, lastSuccessAt: number | null | undefined, pollError: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return !!context && !!lastSuccessAt && !pollError && now - lastSuccessAt <= 15000;
}
