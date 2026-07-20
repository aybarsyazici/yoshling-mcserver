"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameId, ServerStatus } from "@/lib/games";

export interface GameSnapshot {
  game: GameId;
  status: ServerStatus;
  uptime?: string;
  players: { online: number; max: number; players: string[] };
  detail?: string;
}

export interface GamesState {
  games: Record<GameId, GameSnapshot> | null;
  activeGame: GameId | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Polls /api/games/status. `interval` in ms; pass 0 to disable polling. */
export function useGames(interval = 5000): GamesState {
  const [games, setGames] = useState<Record<GameId, GameSnapshot> | null>(null);
  const [activeGame, setActiveGame] = useState<GameId | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/games/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!alive.current) return;
      setGames(data.games);
      setActiveGame(data.activeGame ?? null);
    } catch {
      /* keep last known */
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    if (interval > 0) {
      const id = setInterval(refresh, interval);
      return () => {
        alive.current = false;
        clearInterval(id);
      };
    }
    return () => {
      alive.current = false;
    };
  }, [refresh, interval]);

  return { games, activeGame, loading, refresh };
}
