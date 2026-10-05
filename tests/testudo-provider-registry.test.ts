import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTestudoPackageProvidersForOwner, getTestudoPackageProvider, registerTestudoPackageProvider } from "../packages/plugins/src/testudo-provider-registry";
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
