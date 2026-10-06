import type { TestudoCapability, TestudoCapabilityId } from "@geolibre/embed";

export interface TestudoLocalFileHandle {
  getFile(): Promise<Blob>;
}

export interface TestudoLocalDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string): Promise<TestudoLocalFileHandle>;
  getDirectoryHandle(name: string): Promise<TestudoLocalDirectoryHandle>;
}

export class TestudoLocalPackageError extends Error {
  constructor(readonly code: "unsupported" | "cancelled" | "invalid-package", message: string) {
    super(message);
    this.name = "TestudoLocalPackageError";
  }
}

export type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<TestudoLocalDirectoryHandle>;
};

/** Invoke the picker synchronously before yielding, preserving a parent click's activation where supported. */
export async function pickTestudoLocalDirectory(win: PickerWindow = window as PickerWindow): Promise<TestudoLocalDirectoryHandle> {
  if (typeof win.showDirectoryPicker !== "function") {
    throw new TestudoLocalPackageError("unsupported", "Opening a local package requires a browser with folder access (Chrome or Edge).");
  }
  let selection: Promise<TestudoLocalDirectoryHandle>;
  try {
    selection = win.showDirectoryPicker({ mode: "read" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TestudoLocalPackageError("cancelled", "Local package selection was cancelled.");
    }
    throw error;
  }
  try {
    return await selection;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TestudoLocalPackageError("cancelled", "Local package selection was cancelled.");
    }
    throw error;
  }
}

async function readBytes(root: TestudoLocalDirectoryHandle, path: string): Promise<ArrayBuffer> {
  const parts = path.split("/");
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch { throw new TestudoLocalPackageError("invalid-package", "The package contains an unsafe artifact path."); }
  if (!path || path.startsWith("/") || /[?#\\\u0000-\u001f]/.test(path)
    || decoded.split(/[\\/]/).some((part) => !part || part === "." || part === ".." || /[:\u0000-\u001f]/.test(part))) {
    throw new TestudoLocalPackageError("invalid-package", "The package contains an unsafe artifact path.");
  }
  let directory = root;
  for (const segment of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(segment);
  const file = await (await directory.getFileHandle(parts.at(-1)!)).getFile();
  return file.arrayBuffer();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(bytes: ArrayBuffer, label: string): Record<string, unknown> {
  try {
    const parsed = record(JSON.parse(new TextDecoder("utf-8").decode(bytes)));
    if (parsed) return parsed;
  } catch { /* normalized below */ }
  throw new TestudoLocalPackageError("invalid-package", `${label} is missing or is not a valid JSON object.`);
}

export interface ValidatedTestudoLocalPackage {
  label: string;
  packageId: string;
  manifest: Record<string, unknown>;
  capabilities: TestudoCapability[];
  readArtifact: (path: string) => Promise<ArrayBuffer>;
}

/** Validates the same manifest plus geolibre/package.json pair used by native local package loading. */
export async function validateTestudoLocalPackage(root: TestudoLocalDirectoryHandle): Promise<ValidatedTestudoLocalPackage> {
  let manifest: Record<string, unknown>;
  let nativePackage: Record<string, unknown>;
  try {
    manifest = parseJson(await readBytes(root, "manifest.json"), "manifest.json");
    nativePackage = parseJson(await readBytes(root, "geolibre/package.json"), "geolibre/package.json");
  } catch (error) {
    if (error instanceof TestudoLocalPackageError) throw error;
    throw new TestudoLocalPackageError("invalid-package", "Choose a built Testudo package containing manifest.json and geolibre/package.json.");
  }
  const sourceCapabilities = record(nativePackage.capabilities);
  if (!sourceCapabilities) {
    throw new TestudoLocalPackageError("invalid-package", "geolibre/package.json must declare package capabilities.");
  }
  const isAvailable = (name: string) => record(sourceCapabilities[name])?.state === "available";
  const aliases: Array<[TestudoCapabilityId, string]> = [
    ["vehicle-playback", "animation"], ["network-kpi", "results"], ["path-analysis", "unsupported"],
    ["emissions-h3", "results"], ["scenario-comparison", "results"],
  ];
  const capabilities = aliases.map(([id, name]) => ({ id, available: isAvailable(name) }));
  if (!capabilities.some((item) => item.available)) {
    throw new TestudoLocalPackageError("invalid-package", "This package has no supported Testudo viewer capability.");
  }
  const packageName = typeof nativePackage.name === "string" && nativePackage.name.trim()
    ? nativePackage.name.trim()
    : typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : root.name;
  return {
    label: packageName || "Local package",
    packageId: packageName || "local-package",
    manifest,
    capabilities,
    readArtifact: (path) => readBytes(root, path),
  };
}
