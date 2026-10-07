import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const connections = new Set<net.Socket>();
let server: net.Server | null = null;
let calls: string[] = [];
type Reply = (command: string, socket: net.Socket) => void;
async function fixture(reply: Reply, options: { denied?: boolean; noPrompt?: boolean; unconfirmedAuth?: boolean } = {}) {
  calls = [];
  server = net.createServer(socket => {
    connections.add(socket);
    socket.setEncoding("utf-8");
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    if (!options.noPrompt) socket.write("Please enter password:\r\n");
    let authenticated = false;
    let pending = "";
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        const command = pending.slice(0, boundary).replace(/\r$/, "");
        pending = pending.slice(boundary + 1);
        if (!authenticated) {
          if (options.denied || command !== "fixture-password") {
            socket.end("Password incorrect, please enter password:\r\n");
            return;
          }
          authenticated = true;
          socket.write((options.unconfirmedAuth ? "" : "Logon successful.\r\n") + "Press 'help' to get a list of all commands.\r\n");
          continue;
        }
        calls.push(command);
        if (command === "exit") socket.end();
        else reply(command, socket);
      }
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("SDTD_TELNET_HOST", "127.0.0.1");
  vi.stubEnv("SDTD_TELNET_PORT", String((server.address() as net.AddressInfo).port));
  vi.stubEnv("SDTD_TELNET_PASSWORD", "fixture-password");
  vi.resetModules();
  return import("@/lib/telnet");
}
function fence(command: string, socket: net.Socket) {
  if (!command.startsWith("__yoshling_done_")) return false;
  socket.write(`Unknown command '${command}'\r\n`);
  return true;
}
afterEach(async () => {
  for (const socket of connections) socket.destroy();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  vi.unstubAllEnvs();
});

describe("authenticated telnet command completion", () => {
  it("refuses denied authentication without issuing status or save commands", async () => {
    const telnet = await fixture(() => {}, { denied: true });
    expect((await telnet.getSdtdStatus()).reachable).toBe(false);
    await expect(telnet.sdtdSaveWorld()).rejects.toThrow(/authentication was rejected/);
    expect(calls).toEqual([]);
  });
  it("does not guess authentication when a prompt never arrives", async () => {
    const telnet = await fixture(() => {}, { noPrompt: true });
    await expect(telnet.telnetSession(["version"], { timeoutMs: 40, idleMs: 5 })).rejects.toThrow(/authentication timed out/);
    expect(calls).toEqual([]);
  });
  it("requires explicit authenticated acknowledgement even when a welcome banner appears", async () => {
    const telnet = await fixture((command, socket) => {
      if (!fence(command, socket)) socket.write("Game version: V 3.3.0 (b14)\r\n");
    }, { unconfirmedAuth: true });
    await expect(telnet.telnetSession(["version"], { timeoutMs: 40, idleMs: 5 })).rejects.toThrow(/authentication timed out/);
    expect(calls).toEqual([]);
  });
  it("rejects an early close and never promotes a partial player probe to ready", async () => {
    const telnet = await fixture((command, socket) => {
      if (command === "listplayers") socket.end("0. id=1, FixturePlayer, pos=(0,0,0)\r\n");
    });
    await expect(telnet.telnetSession(["listplayers", "gettime", "version"], { timeoutMs: 60, idleMs: 5 })).rejects.toThrow(/unconfirmed/);
    expect(telnet.sdtdSessionIsGameReady("Logon successful.\n0. id=1, FixturePlayer, pos=(0,0,0)")).toBe(false);
  });
  it("does not accept quiet partial output without a reply fence", async () => {
    const telnet = await fixture((command, socket) => {
      if (command === "version") socket.write("Game version: V 3.3.0 (b14)\r\n");
    });
    await expect(telnet.telnetSession(["version"], { timeoutMs: 60, idleMs: 5 })).rejects.toThrow(/completion timed out/);
  });
  it("rejects command errors even when a full completion fence follows", async () => {
    const telnet = await fixture((command, socket) => {
      if (fence(command, socket)) return;
      socket.write("*** ERROR: Command 'saveworld' can only be executed when a game is started.\r\n");
    });
    await expect(telnet.sdtdSaveWorld()).rejects.toThrow(/command was rejected/);
    expect(calls).toContain("saveworld");
  });
  it("requires a save acknowledgement rather than only command receipt and fencing", async () => {
    const telnet = await fixture((command, socket) => {
      if (command.startsWith("__yoshling_done_")) socket.end(`Unknown command '${command}'\r\n`);
      else socket.write("INF Executing command 'saveworld' by Telnet from 127.0.0.1\r\n");
    });
    await expect(telnet.sdtdSaveWorld()).rejects.toThrow(/unconfirmed/);
  });
  it("waits for split terminal replies and removes the internal completion marker", async () => {
    const telnet = await fixture((command, socket) => {
      if (command === "listplayers") socket.write("Total of 0 in the game\r\n");
      else if (command === "gettime") socket.write("Day 7, 21:40\r\n");
      else if (command === "version") socket.write("Game version: V 3.3.0 (b14)\r\n");
      else if (command.startsWith("__yoshling_done_")) {
        socket.write(`Unknown command '${command}`);
        setTimeout(() => socket.write("'\r\n"), 15);
      }
    });
    const out = await telnet.telnetSession(["listplayers", "gettime", "version"], { timeoutMs: 150, idleMs: 5 });
    expect(out).toContain("Day 7, 21:40");
    expect(out).not.toContain("__yoshling_done_");
    expect(telnet.sdtdSessionIsGameReady(out)).toBe(true);
    expect(calls.filter(command => !command.startsWith("__yoshling_done_")).slice(0, 3)).toEqual(["listplayers", "gettime", "version"]);
  });
  it("accepts a confirmed save with a complete fence, including orderly server closure", async () => {
    const telnet = await fixture((command, socket) => {
      if (command.startsWith("__yoshling_done_")) socket.end(`Unknown command '${command}'\r\n`);
      else socket.write("INF World saved in 12 ms\r\n");
    });
    await expect(telnet.sdtdSaveWorld()).resolves.toBeUndefined();
  });
  it("keeps arbitrary-console errors separate from successful output", async () => {
    const telnet = await fixture((command, socket) => {
      if (fence(command, socket)) return;
      socket.write(`Unknown command '${command}'\r\n`);
    });
    await expect(telnet.sdtdConsole("not-a-real-command")).rejects.toThrow(/rejected/);
  });
});
