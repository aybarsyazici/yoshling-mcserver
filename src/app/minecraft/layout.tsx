import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MinecraftTourProvider, MinecraftTourButton } from "@/components/minecraft-tour-provider";
import { DashShell } from "@/components/dash-shell";

export default async function MinecraftLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // No access to this world = these pages don't exist for you.
  if (!session.user.games.includes("minecraft")) redirect("/home");
  return <MinecraftTourProvider key={session.user.id} userId={session.user.id}><DashShell game="minecraft" access={session.user.games} toolbar={<MinecraftTourButton />}>{children}</DashShell></MinecraftTourProvider>;
}
