"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GameMark } from "@/components/glyphs";
import { GAME_LIST, type GameId } from "@/lib/games";

const ROLE_TINT: Record<string, string> = {
  ADMIN: "var(--primary)",
  MOD: "var(--chart-2)",
  MEMBER: "var(--muted-foreground)",
};

export interface CrewMember {
  id: string;
  username: string;
  avatar: string | null;
  role: string;
  games: GameId[];
  createdAt: string;
}

export function CrewList({
  members,
  canManage,
  selfId,
}: {
  members: CrewMember[];
  canManage: boolean;
  selfId: string;
}) {
  const [crew, setCrew] = useState(members);

  async function setRole(userId: string, role: string) {
    const res = await fetch(`/api/users/${userId}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) {
      setCrew((prev) => prev.map((u) => (u.id === userId ? { ...u, role } : u)));
      toast.success("Role updated");
    } else {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Couldn't update the role");
    }
  }

  async function toggleWorld(user: CrewMember, game: GameId) {
    const next = user.games.includes(game)
      ? user.games.filter((g) => g !== game)
      : [...user.games, game];

    // Optimistic: the chip should light up under the cursor, not half a second later.
    setCrew((prev) => prev.map((u) => (u.id === user.id ? { ...u, games: next } : u)));

    const res = await fetch(`/api/users/${user.id}/games`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games: next }),
    });
    if (!res.ok) {
      setCrew((prev) => prev.map((u) => (u.id === user.id ? { ...u, games: user.games } : u)));
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Couldn't change world access");
    }
  }

  return (
    <div className="rounded-2xl bg-card/70 p-2 ring-1 ring-foreground/10 backdrop-blur">
      <div className="space-y-1">
        {crew.map((user, i) => {
          const isAdmin = user.role === "ADMIN";
          return (
            <motion.div
              key={user.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 transition-colors hover:bg-muted/50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar
                  className="h-10 w-10"
                  style={{
                    boxShadow: `0 0 0 2px color-mix(in oklab, ${
                      ROLE_TINT[user.role] ?? "var(--border)"
                    } 40%, transparent)`,
                  }}
                >
                  <AvatarImage src={user.avatar || undefined} />
                  <AvatarFallback>{user.username[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {user.username}
                    {user.id === selfId && (
                      <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Joined {new Date(user.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* World access — one chip per world, lit when granted */}
                <div className="flex items-center gap-1">
                  {GAME_LIST.map((g) => {
                    const on = isAdmin || user.games.includes(g.id);
                    const locked = isAdmin || !canManage;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        disabled={locked}
                        onClick={() => toggleWorld(user, g.id)}
                        title={
                          isAdmin
                            ? `Admins can see every world`
                            : on
                            ? `${user.username} can see ${g.name} — click to remove`
                            : `${user.username} can't see ${g.name} — click to grant`
                        }
                        aria-pressed={on}
                        aria-label={`${g.name} access for ${user.username}`}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-all",
                          on ? "text-foreground" : "text-muted-foreground/60",
                          locked ? "cursor-default" : "hover:text-foreground"
                        )}
                        style={
                          on
                            ? {
                                background: `color-mix(in oklab, ${g.tint} 16%, transparent)`,
                                boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${g.tint} 40%, transparent)`,
                              }
                            : { boxShadow: "inset 0 0 0 1px var(--border)" }
                        }
                      >
                        <GameMark
                          game={g.id}
                          className={cn("h-3.5 w-3.5", !on && "opacity-50")}
                          style={on ? { color: g.tint } : undefined}
                        />
                        <span className="hidden sm:inline">{g.short}</span>
                      </button>
                    );
                  })}
                </div>

                {canManage && user.id !== selfId ? (
                  <Select
                    value={user.role}
                    onValueChange={(role) => {
                      if (role) setRole(user.id, role);
                    }}
                  >
                    <SelectTrigger className="w-[120px]" style={{ color: ROLE_TINT[user.role] }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                      <SelectItem value="MOD">Mod</SelectItem>
                      <SelectItem value="MEMBER">Member</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  // Matches the Select's own rendering, which shows the raw value
                  <span
                    className="w-[120px] px-3 text-right text-sm font-medium"
                    style={{ color: ROLE_TINT[user.role] }}
                  >
                    {user.role}
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
