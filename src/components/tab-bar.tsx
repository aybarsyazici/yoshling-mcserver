"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export interface TabDef {
  value: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

/** Animated segmented tab bar with a sliding accent pill. */
export function TabBar({
  tabs,
  value,
  onChange,
  tint = "var(--primary)",
  layoutId = "tabbar",
}: {
  tabs: TabDef[];
  value: string;
  onChange: (v: string) => void;
  tint?: string;
  layoutId?: string;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl bg-muted/60 p-1 ring-1 ring-foreground/10 backdrop-blur">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-lg"
                style={{ background: `color-mix(in oklab, ${tint} 18%, var(--card))`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tint} 40%, transparent)` }}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            {t.icon && <t.icon className="relative h-4 w-4" />}
            <span className="relative">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
