import { refreshAionCharacter } from "@/lib/aion2-store";
import { aionJson, aionRecordId, limitAionRequests, withAionUser } from "@/lib/aion2-http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withAionUser(request, async (ownerId) => {
    limitAionRequests(ownerId, "refresh", 12);
    return aionJson({ character: await refreshAionCharacter(ownerId, aionRecordId((await context.params).id)) });
  }, true);
}
