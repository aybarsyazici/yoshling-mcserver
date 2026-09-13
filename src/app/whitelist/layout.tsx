import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashShell } from "@/components/dash-shell";

export default async function WhitelistLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Shared page: wear the colours of the first world this user can actually see.
  const base = session.user.games[0];
  if (!base) redirect("/home");
  return (
    <DashShell game={base} access={session.user.games}>
      {children}
    </DashShell>
  );
}
