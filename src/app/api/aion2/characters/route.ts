import { addAionCharacter, listAionCharacters } from "@/lib/aion2-store";
import { aionBody, aionCharacterRef, aionJson, limitAionRequests, withAionUser } from "@/lib/aion2-http";
import { refreshAionKnowledgeStatus } from "@/lib/aion2-knowledge";

export async function GET(request: Request) {
  return withAionUser(request, async (ownerId) => {
    const knowledge = await refreshAionKnowledgeStatus();
    return aionJson({ ...await listAionCharacters(ownerId), knowledge });
  });
}

export async function POST(request: Request) {
  return withAionUser(request, async (ownerId) => {
    limitAionRequests(ownerId, "add", 12);
    return aionJson({ character: await addAionCharacter(ownerId, aionCharacterRef(await aionBody(request))) });
  }, true);
}
