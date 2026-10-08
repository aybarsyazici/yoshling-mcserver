import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { MinecraftGuide } from "@/components/minecraft-guide";

export default async function MinecraftGuidePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!session.user.games.includes("minecraft")) redirect("/home");
  return <MinecraftGuide userId={session.user.id} />;
}
