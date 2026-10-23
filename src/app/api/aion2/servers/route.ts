import { aionServers } from "@/lib/aion2-api";
import { aionJson, aionRegion, withAionUser } from "@/lib/aion2-http";

export async function GET(request: Request) {
  return withAionUser(request, async () => {
    const region = aionRegion(new URL(request.url).searchParams.get("region"));
    return aionJson({ servers: await aionServers(region) });
  });
}
