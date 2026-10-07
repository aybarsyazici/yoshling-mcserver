import type { GameId } from "@/lib/games";
import { isCreationOnly, NEXT_WORLD_LABEL } from "@/lib/live-settings";
import {
  CREATION_ONLY_NOTE,
  isCreationOnly as isSandboxCreationOnly,
} from "@/lib/sandbox-lua";
import { restartKeysIn } from "@/lib/zomboid-ini-contract";

export interface ConfigChangeReviewRow {
  name: string;
  before: string;
  after: string;
  secret: boolean;
  effect: string | null;
}

interface ConfigReviewContext {
  game: GameId | null;
  endpoint: string;
  restartNote?: string;
}

const SECRET_KEY_RE = /password|passwd|token|secret/i;

function changeEffect(name: string, context: ConfigReviewContext): string | null {
  // Sandbox options have their own contract and deliberately no live game identity.
  const sandbox = context.endpoint.startsWith("/api/zomboid/sandbox");
  if (sandbox) {
    if (isSandboxCreationOnly(name)) return CREATION_ONLY_NOTE;
  } else if (context.game && isCreationOnly(context.game, name)) {
    return NEXT_WORLD_LABEL;
  }

  if (context.restartNote) return context.restartNote;
  if (!sandbox && context.game === "zomboid" && restartKeysIn([name]).length > 0) {
    return "Needs a restart to take effect.";
  }
  // Saving a file is not evidence that a running game has reloaded the change.
  return null;
}

/** A display-only review of exact draft changes; secret values never leave this helper. */
export function buildConfigChangeReview(
  properties: readonly { name: string; value: string; help: string }[],
  draft: Readonly<Record<string, string>>,
  context: ConfigReviewContext
): ConfigChangeReviewRow[] {
  const rows: ConfigChangeReviewRow[] = [];
  for (const property of properties) {
    if (!Object.hasOwn(draft, property.name) || draft[property.name] === property.value) continue;
    const secret = SECRET_KEY_RE.test(property.name);
    rows.push({
      name: property.name,
      before: secret ? "Hidden" : property.value || "(empty)",
      after: secret ? "Hidden" : draft[property.name] || "(empty)",
      secret,
      effect: changeEffect(property.name, context),
    });
  }
  return rows;
}
