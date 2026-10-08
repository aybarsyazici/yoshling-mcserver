import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function MinecraftGuidePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!session.user.games.includes("minecraft")) redirect("/home");
  redirect("/minecraft?tour=1");
}
