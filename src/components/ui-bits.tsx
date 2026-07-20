"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, type ServerStatus } from "@/lib/games";
import type { ReactNode } from "react";

/** Live status pill with a pulsing dot, color-coded by state. */
export function StatusPill({
  status,
  className,
  tint,
}: {
  status: ServerStatus;
  className?: string;
  tint?: string; // override dot color (world accent) when online
}) {
  const map: Record<ServerStatus, { dot: string; text: string; ring: string }> = {
    online: { dot: tint ?? "var(--mc)", text: "text-foreground", ring: "ring-[color-mix(in_oklab,var(--mc)_40%,transparent)]" },
    offline: { dot: "var(--muted-foreground)", text: "text-muted-foreground", ring: "ring-border" },
    starting: { dot: "var(--chart-5)", text: "text-foreground", ring: "ring-[color-mix(in_oklab,var(--chart-5)_40%,transparent)]" },
    stopping: { dot: "var(--chart-5)", text: "text-foreground", ring: "ring-[color-mix(in_oklab,var(--chart-5)_40%,transparent)]" },
    installing: { dot: "var(--chart-2)", text: "text-foreground", ring: "ring-[color-mix(in_oklab,var(--chart-2)_40%,transparent)]" },
  };
  const s = map[status];
  const busy = status === "starting" || status === "stopping" || status === "installing";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-card/70 px-3 py-1 text-xs font-medium ring-1 backdrop-blur",
        s.text,
        s.ring,
        className
      )}
    >
      <span className="relative flex h-2 w-2">
        {(status === "online" || busy) && (
          <motion.span
            className="absolute inline-flex h-full w-full rounded-full"
            style={{ background: s.dot }}
            animate={{ opacity: [0.7, 0, 0.7], scale: [1, 2.4, 1] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: s.dot }} />
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Ambient animated backdrop: blueprint grid + drifting aurora blobs. */
export function Backdrop({
  tintA = "var(--primary)",
  tintB = "var(--chart-2)",
}: {
  tintA?: string;
  tintB?: string;
}) {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 grid-overlay opacity-40" />
      <div
        className="aurora"
        style={{
          background: `radial-gradient(circle at 20% 20%, color-mix(in oklab, ${tintA} 55%, transparent), transparent 55%)`,
        }}
      />
      <div
        className="aurora"
        style={{
          background: `radial-gradient(circle at 80% 70%, color-mix(in oklab, ${tintB} 45%, transparent), transparent 55%)`,
          animationDelay: "-8s",
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-background/0 via-background/0 to-background" />
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  sub,
  tint,
  action,
}: {
  eyebrow?: string;
  title: ReactNode;
  sub?: ReactNode;
  tint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <div className="eyebrow mb-2 flex items-center gap-2" style={{ color: tint ?? "var(--muted-foreground)" }}>
            <span className="inline-block h-px w-6" style={{ background: tint ?? "var(--muted-foreground)" }} />
            {eyebrow}
          </div>
        )}
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
        {sub && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** Small labelled stat used in headers/consoles. */
export function MiniStat({
  label,
  value,
  tint,
}: {
  label: string;
  value: ReactNode;
  tint?: string;
}) {
  return (
    <div className="rounded-lg bg-card/60 px-3 py-2 ring-1 ring-foreground/10 backdrop-blur">
      <div className="eyebrow text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold" style={{ color: tint }}>
        {value}
      </div>
    </div>
  );
}
