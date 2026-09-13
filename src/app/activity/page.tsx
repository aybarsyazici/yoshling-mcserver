"use client";

import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { SectionHeading } from "@/components/ui-bits";
import { PhotoFooter } from "@/components/photo-footer";
import { PowerGlyph } from "@/components/glyphs";
import { GAMES, isGameId } from "@/lib/games";
import { Puzzle, FileEdit, Trash2, Users, Activity as ActivityIcon } from "lucide-react";

interface Activity {
  id: string;
  action: string;
  details: string;
  createdAt: string;
  user: { username: string; avatar: string | null };
}

export default function ActivityPage() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/activity")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setActivities(data);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Shared · Log"
        title="Activity"
        sub="Everything that happened across your worlds, newest first."
      />

      <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-12 rounded-lg" />
            ))}
          </div>
        ) : activities.length === 0 ? (
          <div className="py-12 text-center">
            <ActivityIcon className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>
          </div>
        ) : (
          <ol className="relative space-y-1 before:absolute before:left-[15px] before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-border">
            {activities.map((activity, i) => {
              let details: Record<string, unknown> = {};
              try {
                details = JSON.parse(activity.details);
              } catch {}
              const { icon: Icon, tint } = actionVisual(activity.action, details);
              return (
                <motion.li
                  key={activity.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.4) }}
                  className="relative flex items-center gap-3 rounded-lg py-2 pl-0 pr-2 transition-colors hover:bg-muted/40"
                >
                  <span
                    className="relative z-10 grid h-8 w-8 flex-shrink-0 place-items-center rounded-full ring-4 ring-card"
                    style={{ background: `color-mix(in oklab, ${tint} 16%, var(--background))`, color: tint }}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <p className="flex-1 text-sm">
                    <span className="font-semibold">{activity.user.username}</span>{" "}
                    <span className="text-muted-foreground">{formatAction(activity.action, details)}</span>
                  </p>
                  <time className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {new Date(activity.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </motion.li>
              );
            })}
          </ol>
        )}
      </div>

      <PhotoFooter src="/happy.jpg" />
    </div>
  );
}

type IconT = React.ComponentType<{ className?: string }>;

/** The accent of the world an entry belongs to, or a neutral one if it names none. */
function gameTint(details: Record<string, unknown>, fallback = "var(--muted-foreground)"): string {
  const game = details.game;
  return typeof game === "string" && isGameId(game) ? GAMES[game].tint : fallback;
}

function actionVisual(action: string, details: Record<string, unknown>): { icon: IconT; tint: string } {
  if (action.startsWith("server_")) return { icon: PowerGlyph, tint: gameTint(details) };
  if (action.includes("mod")) return { icon: Puzzle, tint: gameTint(details, "var(--mc)") };
  if (action === "edit_file") return { icon: FileEdit, tint: gameTint(details, "var(--chart-2)") };
  if (action === "delete_file") return { icon: Trash2, tint: "var(--destructive)" };
  if (action === "set_user_games") return { icon: Users, tint: "var(--primary)" };
  return { icon: ActivityIcon, tint: "var(--muted-foreground)" };
}

function formatAction(action: string, details: Record<string, unknown>): string {
  const game = details.game;
  const world = typeof game === "string" && isGameId(game) ? GAMES[game].name : null;
  const on = world ? ` · ${world}` : "";
  switch (action) {
    case "install_mod":
      return `installed ${details.modName} (v${details.version})`;
    case "remove_mod":
      return `removed ${details.modName}`;
    case "update_mod":
      return `updated ${details.modName} from v${details.fromVersion} to v${details.toVersion}`;
    case "server_start":
      return `powered on the server${on}`;
    case "server_stop":
      return `powered off the server${on}`;
    case "server_restart":
      return `restarted the server${on}`;
    case "server_update":
      return `updated the server${on}`;
    case "server_reset":
      return `reset the world${on}${details.newName ? ` (new game: ${details.newName})` : ""}`;
    case "edit_file":
      return `edited ${details.file ?? details.path}${on}`;
    case "delete_file":
      return `deleted ${details.path}${on}`;
    case "set_user_games":
      return `changed who can see which server`;
    default:
      return action.replace(/_/g, " ");
  }
}
