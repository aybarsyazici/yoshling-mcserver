import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@auth/core";
import type { OAuthConfig } from "@auth/core/providers";

const fixture = vi.hoisted(() => ({ config: null as unknown, invited: vi.fn(), registered: vi.fn(), find: vi.fn(), errors: vi.fn(), http: vi.fn() }));
vi.mock("next-auth", () => ({ default: (config: unknown) => { fixture.config = config; return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }; } }));
// The real Discord provider and actual Auth.js/OAuth validation stay in this test.
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: fixture.find } } }));
vi.mock("@/lib/whitelist", () => ({ isWhitelisted: fixture.invited }));
vi.mock("@/lib/discord-user", () => ({ registerDiscordUser: fixture.registered }));

const ORIGIN = "https://fixture.invalid";
const DISCORD_ID = "9007199254740993";
const user = { id: "fixture-local-id", discordId: DISCORD_ID, username: "fixture-label", avatar: null, role: "MEMBER", games: "" };
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

beforeEach(async () => {
  vi.resetModules(); fixture.config = null;
  fixture.invited.mockReset().mockResolvedValue(true); fixture.registered.mockReset().mockResolvedValue(undefined); fixture.find.mockReset().mockResolvedValue(user); fixture.errors.mockReset(); fixture.http.mockReset();
  vi.stubEnv("DISCORD_CLIENT_ID", "fixture-discord-client"); vi.stubEnv("DISCORD_CLIENT_SECRET", "fixture-discord-secret");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in the OAuth regression fixture"); }));
  await import("@/lib/auth");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function flow() {
  const { Auth, customFetch, skipCSRFCheck } = await import("@auth/core");
  const application = fixture.config as AuthConfig;
  const actualProvider = application.providers[0] as OAuthConfig<Record<string, unknown>>;
  let challenge = "";
  fixture.http.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://discord.com/api/oauth2/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("fixture-authorization-code");
      expect(body.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/discord`);
      expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(challenge);
      return reply({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3600, scope: "identify email" });
    }
    if (url === "https://discord.com/api/users/@me") return reply({ id: DISCORD_ID, username: "fixture-label", global_name: "Fixture Display", avatar: null, discriminator: "0", email: "fixture@example.invalid", verified: true });
    throw new Error("Unexpected OAuth endpoint in offline fixture");
  });
  const provider = { ...actualProvider, options: { ...actualProvider.options, [customFetch]: fixture.http } };
  const config: AuthConfig = { ...application, providers: [provider], secret: "synthetic-offline-oauth-regression-secret", trustHost: true, basePath: "/api/auth", skipCSRFCheck: skipCSRFCheck as NonNullable<AuthConfig["skipCSRFCheck"]>, logger: { error: fixture.errors, warn: vi.fn(), debug: vi.fn() } };
  const jar = new Map<string, string>();
  const remember = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0], equals = pair.indexOf("=");
      const name = pair.slice(0, equals), value = pair.slice(equals + 1);
      if (value) jar.set(name, value); else jar.delete(name);
    }
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  // CSRF is bypassed only for this synthetic server-side start request. OAuth
  // issuer and PKCE validation use the real configured checks without a bypass.
  const start = await Auth(new Request(`${ORIGIN}/api/auth/signin/discord`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ callbackUrl: `${ORIGIN}/aion2` }) }), config);
  remember(start);
  expect(start.status).toBe(302);
  const authorization = new URL(start.headers.get("location")!);
  challenge = authorization.searchParams.get("code_challenge") ?? "";
  const callback = async (issuer = "https://discord.com", duplicateIssuer = false) => {
    const url = new URL(`${ORIGIN}/api/auth/callback/discord`);
    url.searchParams.set("code", "fixture-authorization-code"); url.searchParams.set("iss", issuer);
    const state = authorization.searchParams.get("state"); if (state) url.searchParams.set("state", state);
    if (duplicateIssuer) url.searchParams.append("iss", "https://untrusted.invalid");
    const response = await Auth(new Request(url, { headers: { cookie: cookie() } }), config);
    remember(response); return response;
  };
  const session = () => Auth(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: cookie() } }), config);
  return { authorization, actualProvider, callback, jar, session };
}

describe("Discord authorization response issuer", () => {
  it("accepts Discord's issuer through the real callback, token exchange and application session", async () => {
    const test = await flow();
    const callback = await test.callback();
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/aion2`);
    expect(fixture.http.mock.calls.map(([url]) => String(url))).toEqual(["https://discord.com/api/oauth2/token", "https://discord.com/api/users/@me"]);
    expect(fixture.registered).toHaveBeenCalledWith(expect.objectContaining({ discordId: DISCORD_ID, username: "fixture-label" }));
    expect([...test.jar.keys()].some((name) => name.startsWith("__Secure-authjs.session-token"))).toBe(true);
    const session = await (await test.session()).json();
    expect(session.user).toMatchObject({ id: user.id, discordId: DISCORD_ID, role: "MEMBER", games: [] });
    expect(fixture.errors).not.toHaveBeenCalled();
  });

  it.each(["https://untrusted.invalid", "https://discord.com/"])("refuses a nonmatching issuer %s before token exchange", async (issuer) => {
    const test = await flow();
    const response = await test.callback(issuer);
    expect(response.headers.get("location")).toContain("error=Configuration");
    expect(fixture.http).not.toHaveBeenCalled(); expect(fixture.registered).not.toHaveBeenCalled();
    expect(fixture.errors.mock.calls[0]?.[0]?.cause?.err?.message).toContain('unexpected "iss"');
  });

  it("rejects duplicate issuer parameters before token exchange", async () => {
    const test = await flow(); await test.callback("https://discord.com", true);
    expect(fixture.http).not.toHaveBeenCalled(); expect(fixture.registered).not.toHaveBeenCalled(); expect(fixture.errors).toHaveBeenCalled();
  });

  it.each(["missing", "invalid"])("retains the PKCE check for a %s verifier cookie", async (kind) => {
    const test = await flow();
    const name = [...test.jar.keys()].find((key) => key.endsWith("pkce.code_verifier"))!;
    expect(name).toBeTruthy();
    if (kind === "missing") test.jar.delete(name); else test.jar.set(name, "invalid-synthetic-cookie");
    await test.callback();
    expect(fixture.http).not.toHaveBeenCalled(); expect(fixture.registered).not.toHaveBeenCalled();
    expect(fixture.errors.mock.calls[0]?.[0]?.type).toBe("InvalidCheck");
    expect(fixture.errors.mock.calls[0]?.[0]?.message).toContain("pkceCodeVerifier");
  });

  it("keeps the existing OAuth scopes, endpoints and S256 challenge", async () => {
    const test = await flow();
    expect(test.actualProvider.type).toBe("oauth");
    expect(test.authorization.origin + test.authorization.pathname).toBe("https://discord.com/api/oauth2/authorize");
    expect(test.authorization.searchParams.get("scope")).toBe("identify email");
    expect(test.authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(test.authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(test.actualProvider.token).toBe("https://discord.com/api/oauth2/token");
    expect(test.actualProvider.userinfo).toBe("https://discord.com/api/users/@me");
    expect(fixture.http).not.toHaveBeenCalled();
  });
});
