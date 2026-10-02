// @vitest-environment jsdom
/**
 * **The search result's Install button and the client-only override dialog, rendered.**
 *
 * `POST /api/mods/install` was written, hardened (side filtering, verify-before-write) and
 * tested, and **had no caller** — its own comment said so. The mods page could add a mod to a
 * saved pack and apply the whole pack; it could not install one mod. So the two things this
 * file pins are both "the UI reads what the route already says":
 *
 * 1. the Install button exists, posts the mod, and renders the route's own message — which is
 *    the only thing carrying the "no checksum was published, so it could not be verified"
 *    caveat;
 * 2. the 409 `{error:"client-only"}` becomes a **dialog** that states the consequence and
 *    offers `allowClientOnly`. Both fields the route sends for this (`serverSide`, `decidedBy`)
 *    and the opt-in itself were unreachable from the dashboard: a refusal with no way through,
 *    which is a control broken in a new way.
 *
 * DOM-level by nature. An assertion on the route cannot fail when nothing calls it, which is
 * exactly the state this increment found.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModCard } from "@/components/mod-card";
import type { ModrinthProject } from "@/lib/modrinth";
import { installBrowserStubs } from "./helpers/dom";

/**
 * Stubbed for a mechanical reason, not a behavioural one, and it is the same trap
 * `vitest.config.mts` and `CLAUDE.md` both record: `ModDetailDialog` imports
 * `html-react-parser`, which `require()`s the ESM-only `domhandler`, so on this project's
 * default Node (20.12) merely *importing* `ModCard` dies with `ERR_REQUIRE_ESM` before a
 * single test collects. Nothing below touches the detail dialog — it is a separate surface
 * opened by clicking the card body, and the install action calls `stopPropagation` precisely
 * so the two do not interact.
 */
vi.mock("@/components/mod-detail-dialog", () => ({ ModDetailDialog: () => null }));

const toasts: { kind: string; text: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (text: string) => toasts.push({ kind: "success", text }),
    error: (text: string) => toasts.push({ kind: "error", text }),
    info: (text: string) => toasts.push({ kind: "info", text }),
    warning: (text: string) => toasts.push({ kind: "warning", text }),
  },
}));

beforeAll(() => {
  installBrowserStubs();
});
afterEach(() => {
  cleanup();
  toasts.length = 0;
  posts.length = 0;
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 5000 } as const;

const SODIUM = {
  project_id: "AANobbMI",
  slug: "sodium",
  title: "Sodium",
  description: "A modern rendering engine",
  author: "jellysquid3",
  categories: ["optimization"],
  downloads: 12_000_000,
  icon_url: null,
  client_side: "required",
  server_side: "unsupported",
} as unknown as ModrinthProject;

/** Every POST the card made, with its parsed body, so the opt-in can be asserted. */
const posts: { url: string; body: Record<string, unknown> }[] = [];

/**
 * One reply per `/api/mods/install` POST, consumed in order.
 *
 * A queue rather than a single reply because the override is a **second** request: the first
 * answers 409 and the second has to be told apart from it, which is where the mutant that
 * forgets `allowClientOnly` lives.
 */
function stubFetch(replies: { status?: number; body: unknown }[]) {
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/mods/install") {
        posts.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
        const next = queue.shift();
        if (!next) throw new Error("the card posted an install the test did not stub");
        return json(next.status ?? 200, next.body);
      }
      if (u === "/api/modpacks") return json(200, []);
      if (u.startsWith("/api/mods/dependencies")) return json(200, { dependencies: [] });
      return json(404, { error: `unstubbed ${u}` });
    })
  );
}

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function install() {
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
}

/** The route's real sentence for this mod, composed the way `/api/mods/install` composes it. */
const REFUSAL =
  "Sodium is client-only — this build declares `client_only`, which has no server support, " +
  "and on a server it does nothing at best, and can stop the server from starting. " +
  "Nothing was installed.";

const CLIENT_ONLY_409 = {
  status: 409,
  body: {
    error: "client-only",
    message: `${REFUSAL} Send allowClientOnly to install it anyway.`,
    refusal: REFUSAL,
    serverSide: "unsupported",
    decidedBy: "version-environment",
  },
};

// ── the button that did not exist ───────────────────────────────────────────

describe("a search result installs one mod", () => {
  it("posts the mod to /api/mods/install, with no override", async () => {
    stubFetch([{ body: { success: true, verified: "sha512", message: "Mod installed. Restart server to activate." } }]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();

    await waitFor(() => expect(posts).toHaveLength(1), WAIT);
    // Exactly the three fields the route requires, and **not** `allowClientOnly`: sending it
    // by default would turn the client-only refusal into a refusal nothing can reach.
    expect(posts[0].body).toEqual({
      modrinthId: "AANobbMI",
      slug: "sodium",
      name: "Sodium",
    });
  });

  /**
   * The route's own message, not a local paraphrase. It is the only thing carrying the
   * "nothing was published to check this against" caveat, and a friendlier local sentence
   * would drop precisely that — which is this repo's named defect class (implying a check
   * that did not happen).
   */
  it("renders the route's message, including the unverified caveat", async () => {
    stubFetch([
      {
        body: {
          success: true,
          verified: null,
          message:
            "Mod installed (no checksum was published, so it could not be verified). " +
            "Restart server to activate.",
        },
      },
    ]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();

    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].text).toContain("Sodium");
    expect(toasts[0].text).toContain("no checksum was published, so it could not be verified");
  });

  /**
   * The incompatible-version 409 puts its explanation in `message` and leaves `error` as the
   * bare code `"incompatible"`. Reading `error` first toasts the word "incompatible" at
   * somebody and throws away the sentence naming the server's version.
   */
  it("toasts the explanation, not the error code, when no compatible version exists", async () => {
    stubFetch([
      {
        status: 409,
        body: {
          error: "incompatible",
          message:
            "No compatible version found for Minecraft 26.1.2 with fabric. Ask an Admin to " +
            "change the server version, or choose a different mod version.",
          serverVersion: "26.1.2",
        },
      },
    ]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();

    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].text).toMatch(/^No compatible version found for Minecraft 26\.1\.2/);
    expect(clientOnlyDialog()).toBeNull();
  });

  /**
   * The lane 409 this increment added. It must NOT be mistaken for the client-only refusal —
   * the dialog's override would re-send the same request into the same held lane and refuse
   * again, which reads as a broken button.
   */
  it("toasts a file-lane conflict rather than offering an override", async () => {
    stubFetch([
      {
        status: 409,
        body: {
          error: "Minecraft is busy — installing a modpack (2m 10s). Try again when it finishes.",
          resource: "files:minecraft",
          busy: null,
        },
      },
    ]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();

    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].text).toMatch(/Minecraft is busy — installing a modpack/);
    expect(clientOnlyDialog()).toBeNull();
    expect(posts).toHaveLength(1);
  });

  /**
   * Add-to-pack survives as the secondary action. Staging a set of mods to apply together is
   * a different job from putting one jar on the server, and replacing it would have traded one
   * missing capability for another.
   */
  it("still offers Add to pack, which does not install anything", async () => {
    stubFetch([]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    fireEvent.click(screen.getByRole("button", { name: "Add to pack" }));
    await waitFor(() => expect(screen.queryByText("Add to Modpack")).not.toBeNull(), WAIT);
    expect(posts).toEqual([]);
  });
});

// ── the override dialog ─────────────────────────────────────────────────────

/** The dialog's own title, which is the thing that is or is not on screen. */
function clientOnlyDialog(): HTMLElement | null {
  return screen.queryByText("Install Sodium anyway?");
}

describe("the client-only refusal becomes a dialog that offers the override", () => {
  it("names the mod, states the consequence, and installs nothing yet", async () => {
    stubFetch([CLIENT_ONLY_409]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();

    await waitFor(() => expect(clientOnlyDialog()).not.toBeNull(), WAIT);
    // The consequence, in the route's words. Both halves: harmless at best, and a server that
    // does not start at worst — the second is the one the reassuring copy used to omit.
    expect(screen.getByText(/does nothing at best, and can stop the server from starting/))
      .toBeDefined();
    // And which signal decided it, so a wrong skip is arguable-with.
    expect(screen.getByText(/this build declares `client_only`/)).toBeDefined();
    // Still one request: the refusal is a refusal until someone overrides it.
    expect(posts).toHaveLength(1);
    // No toast — the dialog IS the message, and a toast beside it would say the same thing
    // twice in two registers.
    expect(toasts).toEqual([]);
  });

  it("sends allowClientOnly when the override is pressed, and reports the result", async () => {
    stubFetch([
      CLIENT_ONLY_409,
      {
        body: {
          success: true,
          verified: "sha512",
          message:
            "Mod installed. Restart server to activate. It is client-only — on a server it " +
            "does nothing at best, and can stop the server from starting.",
        },
      },
    ]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();
    await waitFor(() => expect(clientOnlyDialog()).not.toBeNull(), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "Install it anyway" }));
    await waitFor(() => expect(posts).toHaveLength(2), WAIT);
    expect(posts[1].body).toEqual({
      modrinthId: "AANobbMI",
      slug: "sodium",
      name: "Sodium",
      allowClientOnly: true,
    });

    // The warning survives the override, which is the whole point of keeping it on the
    // success path: whoever forced it through is the one person who needs to know the next
    // boot may be the symptom.
    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].text).toMatch(/can stop the server from starting/);
    await waitFor(() => expect(clientOnlyDialog()).toBeNull(), WAIT);
  });

  it("sends nothing more when the override is cancelled", async () => {
    stubFetch([CLIENT_ONLY_409]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();
    await waitFor(() => expect(clientOnlyDialog()).not.toBeNull(), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(clientOnlyDialog()).toBeNull(), WAIT);
    expect(posts).toHaveLength(1);
    expect(toasts).toEqual([]);
  });

  /**
   * The complement, and it is what stops "always open the dialog" passing everything above.
   * A plain server mod must install with no question asked — a confirmation on every install
   * is how a dialog teaches people to click through it unread.
   */
  it("opens no dialog for a mod the server supports", async () => {
    stubFetch([{ body: { success: true, verified: "sha512", message: "Mod installed. Restart server to activate." } }]);
    render(<ModCard mod={SODIUM} canAddToPack canInstall />);
    install();
    await waitFor(() => expect(toasts).toHaveLength(1), WAIT);
    expect(clientOnlyDialog()).toBeNull();
  });
});
