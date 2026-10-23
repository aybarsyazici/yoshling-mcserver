import { aionSearch } from "@/lib/aion2-api";
import { aionJson, aionRegion, aionServerId, limitAionRequests, withAionUser } from "@/lib/aion2-http";
import { AionStoreError } from "@/lib/aion2-store";

export async function GET(request: Request) {
  return withAionUser(request, async (ownerId) => {
    limitAionRequests(ownerId, "search");
    const query = new URL(request.url).searchParams;
    const region = aionRegion(query.get("region"));
    const name = query.get("name")?.trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw new AionStoreError("Enter a character name of up to 64 characters", 400);
    const server = query.get("serverId");
    return aionJson({ characters: await aionSearch(region, name, server ? aionServerId(server) : undefined) });
  });
}
