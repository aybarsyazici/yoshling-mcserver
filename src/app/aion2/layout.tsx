import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Swords } from "lucide-react";
import { auth } from "@/lib/auth";
import { AppSwitcher } from "@/components/app-switcher";
import { Backdrop } from "@/components/ui-bits";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = { title: "Aion 2 Helper — Yoshling", description: "Track your Aion 2 characters and plan your next upgrades." };

export default async function AionLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return (
    <div className="relative flex min-h-screen flex-col bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_5%,transparent),transparent_520px)]">
      <Backdrop tintA="var(--primary)" tintB="var(--chart-2)" />
      <header className="sticky top-0 z-30 border-b border-primary/15 bg-gradient-to-r from-card/95 via-background/90 to-card/95 shadow-sm backdrop-blur-xl">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary via-[var(--chart-2)] to-[var(--chart-3)] opacity-70" />
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/aion2" className="flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"><span className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-[var(--chart-2)]/12 p-2.5 text-primary shadow-sm"><Swords className="size-5" aria-hidden /></span><span><span className="block font-display text-sm font-bold">Yoshling</span><span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Aion 2 helper</span></span></Link>
          <div className="flex items-center gap-2"><AppSwitcher /><ThemeToggle /></div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      <footer className="border-t border-border/50 px-4 py-5 text-center text-xs text-muted-foreground">Public character data from NCSOFT. An unofficial companion by Yoshling.</footer>
    </div>
  );
}
