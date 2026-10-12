import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runWithPackageOwnerRelease, TestudoCommandGate } from "../apps/geolibre-desktop/src/lib/testudo-command-gate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("published package run releases its owner before success acknowledgement and on rejection", async () => {
  const receiver = readFileSync(new URL("../apps/geolibre-desktop/src/components/layout/TestudoControls.tsx", import.meta.url), "utf8");
  assert.match(receiver, /const completion = packageRequest && operation !== null[\s\S]*runWithPackageOwnerRelease\(run, \(\) => commandGate\.finishPackage\(operation\)\)[\s\S]*void completion\.then/);
  assert.match(receiver, /if \(current\.status === "loading" && current\.error !== detail\) \{ reset\(\); update\(\{ status: "error", error: detail \}\); \}/);

  const successGate = new TestudoCommandGate();
  successGate.beginPackage(1);
  const acknowledgements: boolean[] = [];
  await runWithPackageOwnerRelease(async () => "loaded", () => successGate.finishPackage(1))
    .then(() => acknowledgements.push(successGate.packageBusy));
  assert.deepEqual(acknowledgements, [false], "success ack runs only after the package owner is released");
  for (const command of ["testudoSetEsriWorldImagery", "testudoSetKpiGeometry"]) {
    let owner: number | null | undefined;
    assert.doesNotThrow(() => { owner = successGate.beginCommand(command); }, `${command} is accepted immediately after a successful published load`);
    assert.equal(successGate.packageBusy, false);
    successGate.finishCommand(owner ?? null);
  }

  const rejectedGate = new TestudoCommandGate();
  rejectedGate.beginPackage(3);
  await assert.rejects(runWithPackageOwnerRelease(async () => { throw new Error("load failed"); }, () => rejectedGate.finishPackage(3)), /load failed/);
  assert.equal(rejectedGate.packageBusy, false, "a rejected published load releases its owner before rejection handling");
});

test("completion or rejection of load A cannot release pending load B", async () => {
  for (const rejectA of [false, true]) {
    const gate = new TestudoCommandGate();
    gate.beginPackage(10);
    const pendingA = deferred<string>();
    const runA = runWithPackageOwnerRelease(() => pendingA.promise, () => gate.finishPackage(10));
    gate.beginPackage(11);
    if (rejectA) pendingA.reject(new Error("A rejected")); else pendingA.resolve("A completed");
    if (rejectA) await assert.rejects(runA, /A rejected/); else assert.equal(await runA, "A completed");
    assert.equal(gate.packageBusy, true, "owner A's finally cannot unlock owner B");
    assert.throws(() => gate.beginCommand("testudoSetScenario"), /loading a package/);
    gate.finishPackage(11);
    assert.equal(gate.packageBusy, false);
  }
});

test("map visibility commands can finish while a scenario command keeps its busy ownership", () => {
  const gate = new TestudoCommandGate();
  const scenario = gate.beginCommand("testudoSetScenario");
  assert.throws(() => gate.beginCommand("testudoSetScenario"), /changing mode or scenario/);
  const camera = gate.beginCommand("testudoSetKpiGeometry");
  assert.equal(camera, null);
  gate.finishCommand(camera);
  assert.equal(gate.commandBusy, true);
  gate.finishCommand(scenario);
  assert.equal(gate.commandBusy, false);
});

test("a camera already in flight cannot clear a package operation that begins later", () => {
  const gate = new TestudoCommandGate();
  const camera = gate.beginCommand("testudoSetEsriWorldImagery");
  gate.beginPackage(8);
  gate.finishCommand(camera);
  assert.equal(gate.packageBusy, true);
  assert.throws(() => gate.beginCommand("testudoSetKpiGeometry"), /loading a package/);
  gate.finishPackage(7);
  assert.equal(gate.packageBusy, true, "a superseded package owner cannot clear the active package load");
  gate.finishPackage(8);
  assert.equal(gate.packageBusy, false);
});

test("read-only camera state remains available during package replacement", () => {
  const gate = new TestudoCommandGate();
  gate.beginPackage(9);
  assert.equal(gate.beginCommand("testudoGetMapControlState"), null);
  assert.equal(gate.beginCommand("testudoGetKpiGeometryState"), null);
  assert.throws(() => gate.beginCommand("testudoSetKpiGeometry"), /loading a package/);
  gate.finishPackage(9);
  assert.equal(gate.packageBusy, false);
});

test("ordinary commands stay serialized during a package replacement", () => {
  const gate = new TestudoCommandGate();
  gate.beginPackage(2);
  assert.throws(() => gate.beginCommand("testudoSetMode"), /loading a package/);
  assert.throws(() => gate.beginCommand("testudoOpenRecordVideo"), /loading a package/);
});
