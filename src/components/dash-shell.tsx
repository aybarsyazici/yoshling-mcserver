import { GameSidebar } from "@/components/game-sidebar";
import { Backdrop } from "@/components/ui-bits";
import { RoadhogDrawer } from "@/components/roadhog-drawer";
import { GAMES, type GameId } from "@/lib/games";

/**
 * Shared dashboard chrome: game-aware sidebar + atmospheric backdrop + footer.
 * `game` decides the accent + nav; shared pages (users/activity) default to
 * whichever world the viewer came from — we pass minecraft as the neutral base.
 */
export function DashShell({ game, children }: { game: GameId; children: React.ReactNode }) {
  const meta = GAMES[game];
  return (
    <div className="relative flex h-screen overflow-hidden">
      <Backdrop tintA={meta.tint} tintB={meta.tintSoft} />
      <GameSidebar game={game} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <RoadhogDrawer />
        <main className="flex-1 overflow-y-auto px-4 py-6 max-lg:pt-14 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
        <footer className="flex-shrink-0 border-t border-border/50 bg-background/60 py-3 text-center text-xs text-muted-foreground backdrop-blur">
          created by{" "}
          <a
            href="https://github.com/aybarsyazici/yoshling-mcserver"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            yoshiane
          </a>
        </footer>
      </div>
    </div>
  );
}
