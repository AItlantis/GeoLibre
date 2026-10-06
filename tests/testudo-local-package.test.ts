import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pickTestudoLocalDirectory,
  TestudoLocalPackageError,
  validateTestudoLocalPackage,
  type TestudoLocalDirectoryHandle,
} from "../apps/geolibre-desktop/src/lib/testudo-local-package";

function directory(name: string, files: Record<string, string>): TestudoLocalDirectoryHandle {
  const tree = new Map<string, string>();
  for (const [path, value] of Object.entries(files)) tree.set(path, value);
  const at = (prefix: string): TestudoLocalDirectoryHandle => ({
    name,
    async getDirectoryHandle(child) {
      const next = prefix ? `${prefix}/${child}` : child;
      if (![...tree.keys()].some((path) => path.startsWith(`${next}/`))) throw new DOMException("Missing", "NotFoundError");
      return at(next);
    },
    async getFileHandle(file) {
      const path = prefix ? `${prefix}/${file}` : file;
      const contents = tree.get(path);
      if (contents === undefined) throw new DOMException("Missing", "NotFoundError");
      return { async getFile() { return new Blob([contents]); } };
    },
  });
  return at("");
}

const validFiles = {
  "manifest.json": JSON.stringify({ name: "Fixture package", scenarios: [{ id: "baseline" }], kpiTimeSeries: { "1": [1] } }),
  "geolibre/package.json": JSON.stringify({ name: "Fixture package", capabilities: { animation: { state: "available" }, results: { state: "available" } } }),
  "geolibre/data.bin": "local bytes",
};

describe("Testudo local package picker and validation", () => {
  it("returns a validated package and reads nested artifacts from the selected folder", async () => {
    const pkg = await validateTestudoLocalPackage(directory("fixture", validFiles));
    assert.equal(pkg.label, "Fixture package");
    assert.equal(pkg.capabilities.find((item) => item.id === "vehicle-playback")?.available, true);
    assert.equal(new TextDecoder().decode(await pkg.readArtifact("geolibre/data.bin")), "local bytes");
    await assert.rejects(pkg.readArtifact("../outside"), /unsafe artifact path/);
  });

  it("rejects folders without valid Testudo manifests", async () => {
    await assert.rejects(
      validateTestudoLocalPackage(directory("bad", { "manifest.json": "{broken" })),
      (error: unknown) => error instanceof TestudoLocalPackageError && error.code === "invalid-package",
    );
    await assert.rejects(
      validateTestudoLocalPackage(directory("bad", { "manifest.json": "{}", "geolibre/package.json": "{}" })),
      /must declare package capabilities/,
    );
  });

  it("reports unsupported folder pickers with a typed error", async () => {
    await assert.rejects(
      pickTestudoLocalDirectory({} as Window),
      (error: unknown) => error instanceof TestudoLocalPackageError && error.code === "unsupported",
    );
  });

  it("reports picker cancellation with a typed error", async () => {
    await assert.rejects(
      pickTestudoLocalDirectory({ showDirectoryPicker: async () => { throw new DOMException("cancelled", "AbortError"); } } as unknown as Window),
      (error: unknown) => error instanceof TestudoLocalPackageError && error.code === "cancelled",
    );
  });
});
