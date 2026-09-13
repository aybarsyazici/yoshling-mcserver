import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gameAccess, hasPermission } from "@/lib/permissions";
import { SectionHeading } from "@/components/ui-bits";
import { CrewList, type CrewMember } from "@/components/crew-list";
import { PhotoFooter } from "@/components/photo-footer";

export default async function UsersPage() {
  const session = await auth();
  const canManage = session ? hasPermission(session.user.role, "users.manage") : false;

  const users = await db.user
    .findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, avatar: true, role: true, games: true, createdAt: true },
    })
    .catch(() => []);

  const members: CrewMember[] = users.map(
    (u: {
      id: string;
      username: string;
      avatar: string | null;
      role: string;
      games: string;
      createdAt: Date;
    }) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      role: u.role,
      games: gameAccess(u.role as "ADMIN" | "MOD" | "MEMBER", u.games),
      createdAt: u.createdAt.toISOString(),
    })
  );

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Shared · Access"
        title="Crew"
        sub={
          canManage
            ? "Who can reach which server, and what they're allowed to do there. Click a world to grant or remove it."
            : "Who can reach which server, and what they're allowed to do there."
        }
      />

      <CrewList members={members} canManage={canManage} selfId={session?.user?.id ?? ""} />

      <PhotoFooter src="/pub-table.jpg" />
    </div>
  );
}
