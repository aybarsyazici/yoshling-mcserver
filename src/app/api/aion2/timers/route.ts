import { aionBossReport } from "@/lib/aion2-boss-report";
import { aionJson, aionRegion, aionServerId, limitAionRequests, withAionUser } from "@/lib/aion2-http";

export async function GET(request: Request) {
  return withAionUser(request, async (ownerId) => {
    limitAionRequests(ownerId, "timers", 30);
    const params = new URL(request.url).searchParams;
    return aionJson(await aionBossReport(aionRegion(params.get("region")), aionServerId(params.get("serverId"))));
  });
}
