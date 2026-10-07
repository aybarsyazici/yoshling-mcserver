import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readServiceEnv } from "@/lib/compose";

const compose = await readFile(path.resolve(__dirname, "../../../docker-compose.yml"), "utf8");

describe("the web watcher honors operator environment settings", () => {
  it("keeps the documented fresh-install defaults", () => {
    expect(readServiceEnv(compose, "web", "PZ_UPDATE_WATCH")).toBe("true");
    expect(readServiceEnv(compose, "web", "PZ_UPDATE_POLL_MS")).toBe("300000");
    expect(readServiceEnv(compose, "web", "PZ_UPDATE_PENDING_POLL_MS")).toBe("15000");
  });

  it.each([
    ["PZ_UPDATE_WATCH", "false"],
    ["PZ_UPDATE_POLL_MS", "90000"],
    ["PZ_UPDATE_PENDING_POLL_MS", "7000"],
  ])("passes %s from the operator env into the created web container", (key, value) => {
    expect(readServiceEnv(compose, "web", key, { [key]: value })).toBe(value);
  });
});
