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

export interface ControlLock {
  game: GameId;
  action: "start" | "stop" | "restart";
  since: number;
}

export interface GamesState {
  games: Record<GameId, GameSnapshot> | null;
  activeGame: GameId | null;
  /** A server power op is in flight (from any client); disables controls. */
  busy: ControlLock | null;
  /**
   * Worlds this user may open. `games` still carries the run state of the others
   * (one server at a time — starting yours stops theirs), but nothing outside
   * this list gets a card, a nav entry or a page.
   */
  access: GameId[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Polls /api/games/status. `interval` in ms; pass 0 to disable polling. */
export function useGames(interval = 5000): GamesState {
  const [games, setGames] = useState<Record<GameId, GameSnapshot> | null>(null);
  const [activeGame, setActiveGame] = useState<GameId | null>(null);
  const [busy, setBusy] = useState<ControlLock | null>(null);
  const [access, setAccess] = useState<GameId[]>([]);
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
      setBusy(data.busy ?? null);
      setAccess(Array.isArray(data.access) ? data.access : []);
    } catch {
      /* keep last known */
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  return { games, activeGame, busy, access, loading, refresh };
}
