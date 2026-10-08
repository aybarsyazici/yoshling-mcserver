import { describe, expect, it } from "vitest";
import { claimOperationPower, currentControlLock, listOperations, runOperation, type OpHandle, type OperationResource } from "@/lib/operations";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("tracked preflight takes power only when needed", () => {
  it("projects the power claim and releases it with the same operation", async () => {
    const finish = deferred();
    let handle!: OpHandle;
    const declared: OperationResource[] = ["files:minecraft"];
    const running = runOperation({ kind: "mods.apply", game: "minecraft", title: "Installing", resources: declared }, async op => {
      handle = op;
      op.step("Checking dependencies");
      await finish.promise;
      op.fact({ label: "Checked", value: "all dependencies" });
      return { value: null };
    });
    try {
      expect(currentControlLock()).toBeNull();
      const beforeClaim = listOperations().find(op => op.id === handle.id)!;
      claimOperationPower(handle);
      expect(currentControlLock()).toMatchObject({ game: "minecraft", action: "restart" });
      expect(listOperations().find(op => op.id === handle.id)?.holdsPower).toBe(true);
      expect(declared).toEqual(["files:minecraft"]);
      expect(beforeClaim.holdsPower).toBe(false);
      expect(beforeClaim.resources).not.toContain("power");
    } finally {
      finish.resolve();
      await running;
    }
    expect(currentControlLock()).toBeNull();
    expect(() => claimOperationPower(handle)).toThrow(/ended/);
  });

  it("refuses an occupied power resource without stealing it", async () => {
    const finishPlan = deferred(); const finishPower = deferred();
    let plan!: OpHandle;
    const planning = runOperation({ kind: "mods.apply", game: "minecraft", title: "Planning" }, async op => {
      plan = op; await finishPlan.promise; return { value: null };
    });
    const power = runOperation({ kind: "power", game: "zomboid", title: "Starting", action: "start", resources: ["power"] }, async () => {
      await finishPower.promise; return { value: null };
    });
    try {
      expect(() => claimOperationPower(plan)).toThrow(/already starting/);
      expect(currentControlLock()?.game).toBe("zomboid");
      expect(listOperations().find(op => op.id === plan.id)?.holdsPower).toBe(false);
    } finally {
      finishPower.resolve(); finishPlan.resolve(); await Promise.all([planning, power]);
    }
  });

  it("keeps an unrelated backup valid through a refused preflight", async () => {
    const finishBackup = deferred();
    let backup!: OpHandle;
    const copying = runOperation({ kind: "backup.create", game: "zomboid", title: "Copying" }, async op => {
      backup = op; await finishBackup.promise; op.fact({ label: "Archive", value: "written" }); return { value: null };
    });
    try {
      await runOperation({ kind: "mods.apply", game: "minecraft", title: "Checking client-only pack" }, async op => {
        op.reject("This pack has no server mods"); return { value: null };
      });
      expect(backup.preempted).toBe(false);
      expect(currentControlLock()).toBeNull();
    } finally {
      finishBackup.resolve(); await copying;
    }
  });

  it("cannot take power after a recovery request preempted planning", async () => {
    const finish = deferred();
    let plan!: OpHandle;
    const planning = runOperation({ kind: "mods.apply", game: "minecraft", title: "Planning" }, async op => {
      plan = op; await finish.promise; return { value: null };
    });
    try {
      await runOperation({ kind: "power", game: "minecraft", title: "Recovering", action: "stop", resources: ["power", "files:minecraft"] }, async op => {
        op.fact({ label: "Power", value: "powered off" }); return { value: null };
      });
      expect(plan.preempted).toBe(true);
      expect(() => claimOperationPower(plan)).toThrow(/interrupted/);
      expect(currentControlLock()).toBeNull();
    } finally {
      finish.resolve(); await planning;
    }
  });

  it("refuses power acquisition without the target file resource", async () => {
    await runOperation({ kind: "mods.apply", game: "minecraft", title: "Unprotected", resources: [] }, async op => {
      expect(() => claimOperationPower(op)).toThrow(/hold.*files/);
      return { value: null };
    });
  });

  it("claims only the confirmed peer file lanes together with power", async () => {
    await runOperation({ kind: "profile.switch", game: "minecraft", title: "Preparing" }, async op => {
      claimOperationPower(op, "start", ["zomboid"]);
      const current = listOperations().find(entry => entry.id === op.id)!;
      expect(current.resources).toEqual(["files:minecraft", "power", "files:zomboid"]);
      expect(current.resources).not.toContain("files:7dtd");
      return { value: null };
    });
  });

  it("does not partially claim power when a confirmed peer is still writing files", async () => {
    const finish = deferred();
    const backup = runOperation({ kind: "backup.create", game: "zomboid", title: "Copying" }, async () => { await finish.promise; return { value: null }; });
    try {
      await runOperation({ kind: "profile.switch", game: "minecraft", title: "Preparing" }, async op => {
        expect(() => claimOperationPower(op, "start", ["zomboid"])).toThrow(/busy/);
        expect(currentControlLock()).toBeNull();
        expect(listOperations().find(entry => entry.id === op.id)?.resources).toEqual(["files:minecraft"]);
        return { value: null };
      });
    } finally { finish.resolve(); await backup; }
  });
});
