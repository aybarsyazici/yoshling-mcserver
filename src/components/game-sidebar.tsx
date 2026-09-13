"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { GAMES, GAME_LIST, type GameId } from "@/lib/games";
import { useGames } from "@/lib/use-games";
import { GameMark } from "@/components/glyphs";
import {
  Gamepad2,
  Puzzle,
  Server,
  Settings,
  Users,
  Shield,
  Clock,
  Archive,
  LogOut,
  ChevronLeft,
  Menu,
} from "lucide-react";

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

function navFor(game: GameId): NavItem[] {
  const meta = GAMES[game];
  const base = meta.base;
  return [
    { name: "Overview", href: base, icon: Gamepad2 },
    ...(meta.hasMods ? [{ name: "Mods", href: `${base}/mods`, icon: Puzzle }] : []),
    { name: "Server", href: `${base}/server`, icon: Server },
    { name: "Backups", href: `${base}/backups`, icon: Archive },
    { name: "Settings", href: `${base}/settings`, icon: Settings },
    ...(meta.hasWhitelist ? [{ name: "Whitelist", href: `${base}/whitelist`, icon: Shield }] : []),
  ];
}

const SHARED: NavItem[] = [
  { name: "Users", href: "/users", icon: Users },
  { name: "Activity", href: "/activity", icon: Clock },
];

export function GameSidebar({ game, access }: { game: GameId; access: GameId[] }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { games } = useGames(8000);

  const meta = GAMES[game];
  const nav = navFor(game);
  // Only the worlds this user may open; comes from the session, so it's right on
  // the first paint rather than after the first status poll.
  const worlds = GAME_LIST.filter((g) => access.includes(g.id));

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-4 top-3 z-50 rounded-lg border border-border bg-card/80 p-2 shadow-md backdrop-blur lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        className={cn(
          "relative flex flex-col overflow-hidden border-r border-sidebar-border bg-sidebar/80 backdrop-blur-xl transition-all duration-300",
          collapsed ? "w-16" : "w-64",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-64",
          mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"
        )}
        style={{ ["--tint" as string]: meta.tint }}
      >
        {/* Accent wash keyed to the active game */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-40"
          style={{ background: `linear-gradient(to bottom, color-mix(in oklab, ${meta.tint} 12%, transparent), transparent)` }}
        />

        {/* Brand → back home */}
        <Link
          href="/home"
          onClick={() => setMobileOpen(false)}
          className={cn(
            "relative flex items-center gap-3 border-b border-sidebar-border p-4 transition-colors hover:bg-sidebar-accent/50",
            collapsed && "justify-center"
          )}
        >
          <Image src="/fat-yoshi.png" alt="Yoshling" width={32} height={32} className="flex-shrink-0 rounded-lg" />
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="truncate font-display text-base font-bold tracking-tight text-sidebar-foreground">Yoshling</h1>
              <p className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <ChevronLeft className="h-3 w-3" /> all worlds
              </p>
            </div>
          )}
        </Link>

        {/* World switcher — hidden entirely when there's only one world to pick */}
        <div
          className={cn(
            "relative border-b border-sidebar-border p-2",
            collapsed && "px-1",
            worlds.length < 2 && "hidden"
          )}
        >
          {!collapsed && <p className="eyebrow px-2 pb-2 pt-1 text-muted-foreground">World</p>}
          <div className={cn("flex gap-1", collapsed ? "flex-col" : "flex-row")}>
            {worlds.map((g) => {
              const on = games?.[g.id]?.status === "online";
              const isCurrent = g.id === game;
              return (
                <Link
                  key={g.id}
                  href={g.base}
                  onClick={() => setMobileOpen(false)}
                  title={g.name}
                  className={cn(
                    "group relative flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-all",
                    collapsed && "justify-center px-0",
                    isCurrent ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                  style={
                    isCurrent
                      ? { background: `color-mix(in oklab, ${g.tint} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${g.tint} 35%, transparent)` }
                      : undefined
                  }
                >
                  <span className="relative">
                    <GameMark game={g.id} className="h-4 w-4" />
                    {on && (
                      <span
                        className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-sidebar"
                        style={{ background: g.tint }}
                      />
                    )}
                  </span>
                  {!collapsed && <span className="truncate">{g.short}</span>}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Nav */}
        <nav className="relative flex-1 space-y-0.5 overflow-y-auto p-2">
          {nav.map((item) => {
            const isActive = pathname === item.href || (item.href !== meta.base && pathname.startsWith(item.href));
            return (
              <NavLink key={item.href} item={item} active={isActive} collapsed={collapsed} tint={meta.tint} onNav={() => setMobileOpen(false)} />
            );
          })}

          {!collapsed && <p className="eyebrow px-3 pb-1 pt-4 text-muted-foreground">Shared</p>}
          {collapsed && <div className="my-2 border-t border-sidebar-border" />}
          {SHARED.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href);
            return (
              <NavLink key={item.href} item={item} active={isActive} collapsed={collapsed} tint={meta.tint} onNav={() => setMobileOpen(false)} />
            );
          })}
        </nav>

        {/* Footer */}
        <div className="relative space-y-1 border-t border-sidebar-border p-2">
          <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between px-3 py-1")}>
            {!collapsed && <span className="text-xs text-muted-foreground">Theme</span>}
            <ThemeToggle />
          </div>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- signout is an API route, not a page */}
          <a
            href="/api/auth/signout"
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
              collapsed && "justify-center px-2"
            )}
          >
            <LogOut className="h-4 w-4 flex-shrink-0" />
            {!collapsed && <span>Sign out</span>}
          </a>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted lg:flex"
          >
            <ChevronLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
            {!collapsed && <span className="text-xs">Collapse</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  tint,
  onNav,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  tint: string;
  onNav: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNav}
      title={collapsed ? item.name : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
        active ? "text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
        collapsed && "justify-center px-2"
      )}
      style={active ? { background: `color-mix(in oklab, ${tint} 14%, transparent)` } : undefined}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full"
          style={{ background: tint }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
        />
      )}
      <item.icon className={cn("h-[18px] w-[18px] flex-shrink-0", active && "text-foreground")} />
      {!collapsed && <span className="truncate">{item.name}</span>}
    </Link>
  );
}
