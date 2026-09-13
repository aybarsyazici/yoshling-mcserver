import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashShell } from "@/components/dash-shell";

export default async function SevenDtdLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // No access to this world = these pages don't exist for you.
  if (!session.user.games.includes("7dtd")) redirect("/home");
  return <DashShell game="7dtd" access={session.user.games}>{children}</DashShell>;
}
