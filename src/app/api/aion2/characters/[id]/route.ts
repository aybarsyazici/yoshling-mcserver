import { removeAionCharacter, setAionTracking, setAionResources, AionStoreError } from "@/lib/aion2-store";
import { aionBody, aionJson, aionRecordId, withAionUser } from "@/lib/aion2-http";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  return withAionUser(request, async (ownerId) => {
    const id = aionRecordId((await context.params).id);
    const body = await aionBody(request);
    const hasTracking = Object.hasOwn(body, "tracking"), hasOdyle = Object.hasOwn(body, "odyleEnergy");
    if (hasTracking === hasOdyle) throw new AionStoreError("Update either automatic tracking or the manual Odyle balance in one request", 400);
    if (hasOdyle) return aionJson({ character: await setAionResources(ownerId, id, body.odyleEnergy) });
    if (typeof body.tracking !== "boolean") throw new AionStoreError("Choose whether automatic tracking is enabled", 400);
    return aionJson({ character: await setAionTracking(ownerId, id, body.tracking) });
  }, true);
}

export async function DELETE(request: Request, context: Context) {
  return withAionUser(request, async (ownerId) => aionJson({ removedId: await removeAionCharacter(ownerId, aionRecordId((await context.params).id)) }), true);
}
