"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The route-segment error boundary.
 *
 * There was none anywhere in this app, so any render throw white-screened the whole
 * dashboard. That became urgent with the operation ledger: it is mounted above
 * `<main>` in `dash-shell.tsx`, which puts it on the critical render path for every
 * page — a bad `op.steps` shape would have taken the site down rather than one strip.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The container log is where this project's forensics live.
    console.error("[render]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="font-display text-2xl font-bold tracking-tight">This page didn&apos;t render</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Something in the dashboard threw while drawing this page. The servers are
        unaffected — nothing on the box was touched.
      </p>
      <p className="mt-3 break-words rounded-lg bg-card/70 p-3 font-mono text-[11px] text-muted-foreground ring-1 ring-foreground/10">
        {error.message || "No message"}
        {error.digest ? ` (${error.digest})` : ""}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button onClick={reset}>
          <RotateCw className="h-4 w-4" /> Try again
        </Button>
        <Button variant="outline" onClick={() => window.location.assign("/home")}>
          Back to the worlds
        </Button>
      </div>
    </div>
  );
}
