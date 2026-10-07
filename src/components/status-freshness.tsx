"use client";
import { useEffect, useState } from "react";
export function StatusFreshness({ lastSuccessAt, pollError }: { lastSuccessAt?: number | null; pollError?: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (lastSuccessAt === undefined && !pollError) return null;
  const age = lastSuccessAt !== null && lastSuccessAt !== undefined ? Math.max(0, Math.floor((now - lastSuccessAt) / 1000)) : null;
  if (!pollError && age !== null && age <= 15) return null;
  return <p role="status" className="my-3 text-xs text-chart-5">
    {pollError || "Waiting for a fresh status reading"}. {age === null ? "No server state has been read yet." : `Showing the last known server state from ${age}s ago.`}
  </p>;
}
