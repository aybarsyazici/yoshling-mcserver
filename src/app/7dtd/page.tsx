import { db } from "@/lib/db";
import { GameOverview } from "@/components/game-overview";
import { PhotoStrip } from "@/components/photo-footer";

export default async function SevenDtdOverview() {
  const recentActivity = await db.activity
    .findMany({
      where: { details: { contains: "7dtd" } },
      include: { user: { select: { username: true, avatar: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    })
    .catch(() => []);

  return (
    <GameOverview
      game="7dtd"
      recentActivity={recentActivity.map((a: { id: string; action: string; createdAt: Date; user: { username: string } }) => ({
        id: a.id,
        action: a.action,
        username: a.user.username,
        createdAt: a.createdAt.toISOString(),
      }))}
    >
      <PhotoStrip
        photos={[
          { src: "/the-stare.jpg" },
          { src: "/happy.jpg" },
        ]}
      />
    </GameOverview>
  );
}
