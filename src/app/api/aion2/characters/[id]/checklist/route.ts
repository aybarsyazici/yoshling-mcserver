import { setAionChecklist, AionStoreError } from "@/lib/aion2-store";
import { aionBody, aionJson, aionRecordId, limitAionRequests, withAionUser } from "@/lib/aion2-http";
import type { AionChecklistChange } from "@/lib/aion2-checklist";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  return withAionUser(request, async (ownerId) => {
    limitAionRequests(ownerId, "checklist", 60);
    const id = aionRecordId((await context.params).id);
    const body = await aionBody(request);
    if (Object.keys(body).length !== 4 || Object.keys(body).some((key) => !["activityId", "completed", "periodKey", "revision"].includes(key))) throw new AionStoreError("Update one reset activity using its current revision", 400);
    return aionJson({ character: await setAionChecklist(ownerId, id, body as AionChecklistChange) });
  }, true);
}
