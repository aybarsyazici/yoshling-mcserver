import { db } from "@/lib/db";
import { GameOverview } from "@/components/game-overview";

export default async function MinecraftOverview() {
  const [modCount, recentActivity] = await Promise.all([
    db.installedMod.count().catch(() => 0),
    db.activity
      .findMany({
        where: { details: { contains: "minecraft" } },
        include: { user: { select: { username: true, avatar: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      })
      .catch(() => []),
  ]);

  return (
    <GameOverview
      game="minecraft"
      extraStats={[{ label: "Installed mods", value: modCount, kind: "mods" }]}
      recentActivity={recentActivity.map((a: { id: string; action: string; createdAt: Date; user: { username: string } }) => ({
        id: a.id,
        action: a.action,
        username: a.user.username,
        createdAt: a.createdAt.toISOString(),
      }))}
    />
  );
}
