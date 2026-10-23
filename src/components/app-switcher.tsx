"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Gamepad2, Swords } from "lucide-react";
import { cn } from "@/lib/utils";

export function AppSwitcher({ compact = false }: { compact?: boolean }) {
  const aion = usePathname()?.startsWith("/aion2") ?? false;
  return (
    <nav aria-label="Applications" className={cn("inline-flex rounded-xl border border-border/70 bg-background/60 p-1", compact && "w-full flex-col")}>
      {[{ href: "/home", label: "Game hosting", icon: Gamepad2, active: !aion }, { href: "/aion2", label: "Aion 2 helper", icon: Swords, active: aion }].map(({ href, label, icon: Icon, active }) => (
        <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring", active ? "bg-primary/10 text-primary shadow-sm" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
          <Icon className="size-3.5" aria-hidden />{label}
        </Link>
      ))}
    </nav>
  );
}
