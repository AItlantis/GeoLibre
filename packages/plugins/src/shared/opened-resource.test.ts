import assert from "node:assert/strict";
import { test } from "node:test";
import { installOpenedResourceIfCurrent } from "./opened-resource";

test("opened resource installs while current", async () => {
  let installed: string | null = null; let closed = 0;
  const ok = await installOpenedResourceIfCurrent(Promise.resolve({ close: () => { closed++; }, value: "live" }), () => true, resource => { installed = resource.value; });
  assert.equal(ok, true); assert.equal(installed, "live"); assert.equal(closed, 0);
});

test("resource resolving after close is disposed and never installed", async () => {
  let resolve!: (resource: { close(): void; value: string }) => void;
  const opened = new Promise<{ close(): void; value: string }>(done => { resolve = done; });
  let current = true; let installed = false; let closed = 0;
  const pending = installOpenedResourceIfCurrent(opened, () => current, () => { installed = true; });
  current = false; resolve({ value: "stale", close: () => { closed++; } });
  assert.equal(await pending, false); assert.equal(installed, false); assert.equal(closed, 1);
});
