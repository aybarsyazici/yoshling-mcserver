import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashShell } from "@/components/dash-shell";

export default async function SevenDtdLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <DashShell game="7dtd">{children}</DashShell>;
}
