import { aionJson, limitAionRequests, withAionUser } from "@/lib/aion2-http";
import { refreshAionKnowledgeStatus } from "@/lib/aion2-knowledge";

/** Refresh reviewed timer sources without reading a character roster. */
export async function GET(request: Request) {
  return withAionUser(request, async (ownerId) => {
    limitAionRequests(ownerId, "knowledge", 12);
    return aionJson({ knowledge: await refreshAionKnowledgeStatus({ maximumCheckAgeMs: 15 * 60_000 }) });
  });
}
