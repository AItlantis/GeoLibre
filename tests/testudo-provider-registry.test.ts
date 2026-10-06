import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTestudoPackageProvidersForOwner, getTestudoPackageProvider, getTestudoPackageProviderSuite, registerTestudoPackageProvider } from "../packages/plugins/src/testudo-provider-registry";
import type { TestudoPackageBootstrap } from "../packages/plugins/src/testudo-feature-bridge";

const availablePackage: TestudoPackageBootstrap = {
  packageId: "pkg",
  versionId: "v1",
  label: "Package",
  artifactEndpoint: "/artifact/",
  capabilities: [{ id: "vehicle-playback", available: true }],
};

test("Testudo provider lookup honors declared package capabilities and plugin ownership", () => {
  const factory = { open: async () => { throw new Error("not called"); } };
  const dispose = registerTestudoPackageProvider({ capability: "vehicle-playback", factory }, "vehicle-plugin");
  try {
    assert.equal(getTestudoPackageProvider("vehicle-playback", availablePackage), factory);
    assert.equal(getTestudoPackageProvider("network-kpi", availablePackage), null);
    assert.equal(getTestudoPackageProvider("vehicle-playback", {
      ...availablePackage,
      capabilities: [{ id: "vehicle-playback", available: false }],
    }), null);
    assert.throws(() => registerTestudoPackageProvider({ capability: "vehicle-playback", factory }, "other"), /already registered/);
  } finally {
    dispose();
  }
  assert.equal(getTestudoPackageProvider("vehicle-playback", availablePackage), null);
});

test("plugin deactivation removes all providers owned by that plugin", () => {
  const factory = { open: async () => { throw new Error("not called"); } };
  registerTestudoPackageProvider({ capability: "scenario-comparison", factory }, "comparison-plugin");
  assert.equal(getTestudoPackageProvider("scenario-comparison", {
    ...availablePackage,
    capabilities: [{ id: "scenario-comparison", available: true }],
  }), factory);
  clearTestudoPackageProvidersForOwner("comparison-plugin");
  assert.equal(getTestudoPackageProvider("scenario-comparison", {
    ...availablePackage,
    capabilities: [{ id: "scenario-comparison", available: true }],
  }), null);
});

test("a Results-only package does not open Animation as hidden network infrastructure", async () => {
  const opened: string[] = [];
  const makeFactory = (capability: "vehicle-playback" | "network-kpi") => ({
    async open(_bootstrap: TestudoPackageBootstrap, context: any) {
      opened.push(capability);
      return { context, capabilities: [{ id: capability, available: true }], dispose() {} } as any;
    },
  });
  const unregisterVehicle = registerTestudoPackageProvider({ capability: "vehicle-playback", factory: makeFactory("vehicle-playback") }, "test-animation");
  const unregisterResults = registerTestudoPackageProvider({ capability: "network-kpi", factory: makeFactory("network-kpi") }, "test-results");
  try {
    const bootstrap: TestudoPackageBootstrap = { ...availablePackage, selectedPlugin: "network-kpi", capabilities: [
      { id: "vehicle-playback", available: false }, { id: "network-kpi", available: true },
    ] };
    const suite = getTestudoPackageProviderSuite(bootstrap)!;
    const session = await suite.open(bootstrap, { tviewId: "results-view", packageId: "pkg", versionId: "v1", pluginId: "network-kpi", generation: 1 }, () => {}, async () => new ArrayBuffer(0), null);
    assert.deepEqual(opened, ["network-kpi"]);
    assert.equal(session.context.pluginId, "network-kpi");
    await session.dispose?.();
  } finally { unregisterResults(); unregisterVehicle(); }
});

test("provider selection deactivates and reactivates only the selected mode in A-to-R-to-C-to-A-to-R order", async () => {
  const events: string[] = [];
  const ids = ["vehicle-playback", "network-kpi", "scenario-comparison"] as const;
  const releases = ids.map((id) => registerTestudoPackageProvider({ capability: id, factory: {
    async open(_bootstrap, context) {
      return { context, capabilities: [{ id, available: true }], onActivate() { events.push(`activate:${id}`); }, onDeactivate() { events.push(`deactivate:${id}`); } } as any;
    },
  } }, `test-mode-${id}`));
  try {
    const bootstrap: TestudoPackageBootstrap = { ...availablePackage, selectedPlugin: "vehicle-playback", capabilities: ids.map((id) => ({ id, available: true })) };
    const suite = getTestudoPackageProviderSuite(bootstrap)!;
    const session = await suite.open(bootstrap, { tviewId: "mode-view", packageId: "pkg", versionId: "v1", pluginId: "vehicle-playback", generation: 1 }, () => {}, async () => new ArrayBuffer(0), null);
    for (const id of ["network-kpi", "scenario-comparison", "vehicle-playback", "network-kpi"]) await session.selectPlugin?.(id);
    assert.deepEqual(events, [
      "activate:vehicle-playback", "deactivate:vehicle-playback", "activate:network-kpi",
      "deactivate:network-kpi", "activate:scenario-comparison", "deactivate:scenario-comparison",
      "activate:vehicle-playback", "deactivate:vehicle-playback", "activate:network-kpi",
    ]);
    await session.dispose?.();
  } finally { releases.forEach((release) => release()); }
});
