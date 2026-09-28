import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashShell } from "@/components/dash-shell";
import { hasPermission } from "@/lib/permissions";

export default async function WhitelistLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  /**
   * `/api/whitelist` is ADMIN-only but this layout used to admit anyone with a
   * session and one world, so a MOD or MEMBER reached the page, their fetch came
   * back 403 with no `users` in it, and the empty state rendered as a fact:
   * "No restrictions — anyone can sign in" — about a list with six people on it.
   * Gate the page on the same permission the route uses so the two can't diverge.
   */
  if (!hasPermission(session.user.role, "users.manage")) redirect("/home");
  // Shared page: wear the colours of the first world this user can actually see.
  const base = session.user.games[0];
  if (!base) redirect("/home");
  return (
    <DashShell game={base} access={session.user.games}>
      {children}
    </DashShell>
  );
}
