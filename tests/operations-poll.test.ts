import { describe, expect, it } from "vitest";
import { parseOperationsPoll } from "@/lib/operations-poll";
import { op } from "./helpers/dom";
const payload = () => ({ operations: [op()], finished: [op({ id: "done", endedAt: 20, outcome: "ok" })], serverNow: 30 });
describe("operation refresh receipts require complete readings", () => {
  it("accepts complete tracked, redacted and synthetic rows", () => {
    const value = payload(); expect(parseOperationsPoll(value)).toBe(value);
    expect(parseOperationsPoll({ ...value, operations: [op({ id: "boot", kind: "boot", synthetic: true, redacted: true, startedBy: null, resources: [], holdsPower: false })] })).not.toBeNull();
  });
  it.each([null, {}, { ...payload(), serverNow: Infinity }, { ...payload(), serverNow: "30" }, { ...payload(), operations: {} },
    { ...payload(), finished: null }, { ...payload(), operations: [op(), op()] }, { ...payload(), finished: [op()] }])("refuses incomplete payload %j", value => expect(parseOperationsPoll(value)).toBeNull());
  it.each([
    { resources: null }, { resources: ["unknown"] }, { holdsPower: true }, { steps: null }, { facts: null }, { progress: null },
    { heartbeatAt: null }, { game: "other" }, { startedBy: {} }, { action: ["restart"] },
    { facts: [{ label: "Fact", value: "Value", verdict: ["ok"] }] },
    { steps: [{ id: "s", label: "Working", at: 20, kind: ["running"] }] },
    { progress: { kind: "count", done: 1, total: "2", noun: "files" } },
  ])("refuses malformed consumed row fields %j", patch => expect(parseOperationsPoll({ ...payload(), operations: [{ ...op(), ...patch }] })).toBeNull());
});
