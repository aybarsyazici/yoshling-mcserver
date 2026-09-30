import { afterEach, describe, expect, it } from "vitest";
import { resetCommandRunner, runCommand, setCommandRunner } from "@/lib/docker-cli";

/**
 * The seam that makes `game-manager` testable — and its one safety property.
 *
 * `setCommandRunner` is an escape hatch into the module that starts, stops and recreates
 * this box's game containers, so it must not be reachable from the code that actually
 * drives it. An untested guard is a comment, and a comment claiming a behaviour it did
 * not have is exactly how this project hid a five-minute Project Zomboid restart through
 * four audits.
 */
describe("the command-runner seam", () => {
  const realNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    // `NODE_ENV` is readonly in the Next types but writable at runtime; put it back so a
    // later test file cannot inherit "production".
    (process.env as Record<string, string | undefined>).NODE_ENV = realNodeEnv;
    resetCommandRunner();
  });

  it("routes commands through the substituted runner", async () => {
    const seen: string[] = [];
    setCommandRunner(async (cmd) => {
      seen.push(cmd);
      return { stdout: "ok", stderr: "" };
    });
    await expect(runCommand("docker ps")).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(seen).toEqual(["docker ps"]);
  });

  it("is refused under NODE_ENV=production", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(() => setCommandRunner(async () => ({ stdout: "", stderr: "" }))).toThrow(
      /test seam/
    );
  });

  it("puts the real runner back, so one test cannot leak into the next", async () => {
    setCommandRunner(async () => ({ stdout: "fake", stderr: "" }));
    resetCommandRunner();
    // A real shell, deliberately: proving the reset restored the genuine runner needs an
    // observation the fake could not have produced. `echo` is a builtin, not Docker —
    // nothing here touches a container, the network or the daemon.
    const { stdout } = await runCommand("echo seam-restored");
    expect(stdout.trim()).toBe("seam-restored");
  });
});
