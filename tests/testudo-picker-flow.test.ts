import assert from "node:assert/strict";
import test from "node:test";
import { openLocalPackageFromActivation } from "../apps/geolibre-desktop/src/lib/testudo-picker-flow";

test("local package picker is invoked synchronously only from the matching activation", async () => {
  const calls: string[] = [];
  const handle = { name: "chosen-folder" };
  const pending = openLocalPackageFromActivation("request-1", "request-1", () => {
    calls.push("picker");
    return Promise.resolve(handle);
  }, async selected => {
    calls.push(`load:${selected.name}`);
    return "loaded";
  });
  assert.deepEqual(calls, ["picker"], "the picker call occurs before activation handling yields");
  assert.equal(await pending, "loaded");
  assert.deepEqual(calls, ["picker", "load:chosen-folder"]);
});

test("local package picker ignores activations that do not match a pending command", async () => {
  let opened = false;
  const result = await openLocalPackageFromActivation("request-1", "request-2", async () => {
    opened = true;
    return {};
  }, async () => "loaded");
  assert.equal(result, null);
  assert.equal(opened, false);
});
