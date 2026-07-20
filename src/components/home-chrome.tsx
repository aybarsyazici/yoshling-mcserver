"use client";

import Image from "next/image";
import { motion } from "motion/react";
import { ThemeToggle } from "@/components/theme-toggle";
import { LogOut } from "lucide-react";

export function HomeChrome({
  user,
}: {
  user: { name?: string | null; image?: string | null; role?: string };
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/50 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
        <motion.div
          className="flex items-center gap-2.5"
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="relative">
            <Image src="/fat-yoshi.png" alt="Yoshling" width={34} height={34} className="rounded-lg" />
            <span className="absolute -inset-1 -z-10 rounded-xl bg-primary/20 blur-md" />
          </div>
          <div className="leading-tight">
            <p className="font-display text-sm font-bold tracking-tight">Yoshling</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Control
            </p>
          </div>
        </motion.div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          {user.image && (
            <Image
              src={user.image}
              alt={user.name ?? "you"}
              width={30}
              height={30}
              className="rounded-full ring-1 ring-border"
            />
          )}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- signout is an API route, not a page */}
          <a
            href="/api/auth/signout"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </a>
        </div>
      </div>
    </header>
  );
}
