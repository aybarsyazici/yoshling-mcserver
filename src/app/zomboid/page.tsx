import { db } from "@/lib/db";
import { GameOverview } from "@/components/game-overview";

export default async function ZomboidOverview() {
  const recentActivity = await db.activity
    .findMany({
      where: { details: { contains: "zomboid" } },
      include: { user: { select: { username: true, avatar: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    })
    .catch(() => []);

  return (
    <GameOverview
      game="zomboid"
      recentActivity={recentActivity.map(
        (a: { id: string; action: string; createdAt: Date; user: { username: string } }) => ({
          id: a.id,
          action: a.action,
          username: a.user.username,
          createdAt: a.createdAt.toISOString(),
        })
      )}
    />
  );
}
