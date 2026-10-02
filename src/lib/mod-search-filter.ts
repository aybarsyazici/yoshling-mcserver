/**
 * **Which version facet the mod browser asks `/api/mods/search` for.**
 *
 * Three states and one precedence rule, which is more than reads well inline — and the
 * precedent for pulling it out is `mod-plan.ts`: the client-only filter was an `if` inside
 * `install-modpack`, a recheck replaced it with `if (false)`, and the whole suite stayed
 * green because nothing could reach the decision without a route, a database and a network.
 * The same is true here one layer up: the branch lives in a `useCallback` behind a debounce
 * and a base-ui `Select`, so asserting it through the DOM means driving a combobox rather
 * than stating the rule.
 *
 * The three states:
 *
 * - **Nothing sent.** The route then facets on the server's own Minecraft version and loader.
 *   This is the default, and it is deliberately an *omission* rather than the version copied
 *   into the query: the browser does not know what the server runs, and a second copy of that
 *   value would be a second thing to drift.
 * - **`any`.** The one literal that widens, sent only when the user asked for it.
 * - **A pack's own target.** Selecting a modpack is already a statement about which version
 *   you mean, so it outranks a widen that was switched on earlier — otherwise picking a
 *   1.21.1 pack while widened silently searched every version and the badge said 1.21.1.
 */
export interface PackTarget {
  targetMcVersion: string | null;
  targetLoader: string | null;
}

export interface SearchFilterParams {
  version?: string;
  loader?: string;
}

/** The literal `/api/mods/search` reads as "drop this facet". Must match the route's `ANY`. */
export const ANY_VERSION = "any";

export function searchFilterParams(opts: {
  /** The modpack whose compatibility the user is filtering by, if any. */
  pack: PackTarget | undefined;
  /** Whether the user pressed "show all versions". */
  allVersions: boolean;
}): SearchFilterParams {
  const params: SearchFilterParams = {};

  if (opts.pack) {
    // A pack can record a version without a loader (and vice versa). Only what it actually
    // recorded is sent; the rest falls through to the server's own value, which is a better
    // answer than guessing a loader the pack never named.
    if (opts.pack.targetMcVersion) params.version = opts.pack.targetMcVersion;
    if (opts.pack.targetLoader) params.loader = opts.pack.targetLoader;
    return params;
  }

  if (opts.allVersions) {
    params.version = ANY_VERSION;
    params.loader = ANY_VERSION;
  }

  return params;
}
