import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashShell } from "@/components/dash-shell";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <DashShell game="minecraft">{children}</DashShell>;
}
