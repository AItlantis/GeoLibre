import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { invalidateGeolibrePackageCache, loadCachedHttpPackageManifests, setRevalidateWindowForTests } from "../packages/plugins/src/plugins/geolibre-package-cache";

const manifestUrl = "https://example.test/package/manifest.json";
const response = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("geolibre package cache", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => invalidateGeolibrePackageCache());
  afterEach(() => { globalThis.fetch = originalFetch; invalidateGeolibrePackageCache(); setRevalidateWindowForTests(2_000); });

  it("shares one manifest fetch-pair for concurrent callers", async () => {
    let calls = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      calls++;
      return calls === 1 ? response({ chunks: [] }) : response({ schemaVersion: "1", results: { checksum: { algorithm: "sha256", value: "a" } } });
    };
    await Promise.all([loadCachedHttpPackageManifests(manifestUrl), loadCachedHttpPackageManifests(manifestUrl)]);
    assert.equal(calls, 2);
  });

  it("evicts a rejected load so the next caller retries", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("temporary failure"); };
    await assert.rejects(loadCachedHttpPackageManifests(manifestUrl), /temporary failure/);
    await assert.rejects(loadCachedHttpPackageManifests(manifestUrl), /temporary failure/);
    assert.equal(calls, 2);
  });

  it("refetches when the same URL now serves a different package (stale-cache regression)", async () => {
    setRevalidateWindowForTests(0);
    const packageA = { schemaVersion: "1", results: { checksum: { algorithm: "sha256", value: "package-a" } } };
    const packageB = { schemaVersion: "1", results: { checksum: { algorithm: "sha256", value: "package-b" } } };
    let served = packageA;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("geolibre/package.json")) return response(served);
      return response({ chunks: [] });
    };

    const first = (await loadCachedHttpPackageManifests(manifestUrl)) as { __geolibrePackage: { resultsChecksum: { value: string } } };
    assert.equal(first.__geolibrePackage.resultsChecksum.value, "package-a");

    served = packageB;
    const second = (await loadCachedHttpPackageManifests(manifestUrl)) as { __geolibrePackage: { resultsChecksum: { value: string } } };
    assert.equal(second.__geolibrePackage.resultsChecksum.value, "package-b");
  });

  it("keeps serving the cached package when a revalidation fetch fails transiently", async () => {
    setRevalidateWindowForTests(0);
    const packageA = { schemaVersion: "1", results: { checksum: { algorithm: "sha256", value: "package-a" } } };
    let fail = false;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (fail) throw new Error("network blip");
      const url = String(input);
      if (url.endsWith("geolibre/package.json")) return response(packageA);
      return response({ chunks: [] });
    };

    const first = (await loadCachedHttpPackageManifests(manifestUrl)) as { __geolibrePackage: { resultsChecksum: { value: string } } };
    assert.equal(first.__geolibrePackage.resultsChecksum.value, "package-a");

    fail = true;
    const second = (await loadCachedHttpPackageManifests(manifestUrl)) as { __geolibrePackage: { resultsChecksum: { value: string } } };
    assert.equal(second.__geolibrePackage.resultsChecksum.value, "package-a");
  });
});

