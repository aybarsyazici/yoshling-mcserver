import { auth } from "@/lib/auth";
import { MissionControl } from "@/components/mission-control";

export default async function HomePage() {
  const session = await auth();
  return <MissionControl userName={session?.user?.name} />;
}
