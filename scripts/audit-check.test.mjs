import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArtifactModuleManifest } from "./audit-artifact-proof.mjs";
import {
  ALLOWLIST,
  collectAdvisories,
  isAllowlisted,
  parseAuditReport,
} from "./audit-policy.mjs";

test("allowlist is scoped to its named advisory and affected package", () => {
  for (const [id, entry] of ALLOWLIST) {
    assert.equal(isAllowlisted(id, { packages: new Set([entry.packageName]) }), true);
    assert.equal(isAllowlisted(id, { packages: new Set(["unexpected-package"]) }), false);
  }
  assert.equal(
    isAllowlisted("GHSA-unknown-0000-0000", { packages: new Set(["braces"]) }),
    false,
  );
});

test("audit parser fails closed for malformed, error-envelope, and missing reports", () => {
  assert.throws(() => parseAuditReport("not json"), /not JSON/);
  assert.throws(
    () => parseAuditReport(JSON.stringify({ error: { detail: "registry offline" } })),
    /registry offline/,
  );
  assert.throws(() => parseAuditReport(JSON.stringify({ vulnerabilities: null })), /no `vulnerabilities`/);
  assert.throws(() => parseAuditReport(JSON.stringify({ vulnerabilities: [] })), /no `vulnerabilities`/);
  assert.deepEqual(parseAuditReport(JSON.stringify({ vulnerabilities: {} })), { vulnerabilities: {} });
});

test("advisory collection keeps only named advisory objects and groups packages", () => {
  const report = {
    vulnerabilities: {
      braces: {
        name: "braces",
        severity: "high",
        via: [
          { name: "braces", severity: "high", url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm" },
        ],
      },
    },
  };
  const advisories = collectAdvisories(report);
  assert.deepEqual([...advisories.keys()], ["GHSA-vfj7-8cjw-p6xm"]);
  assert.equal(isAllowlisted("GHSA-vfj7-8cjw-p6xm", advisories.get("GHSA-vfj7-8cjw-p6xm")), true);
});

test("malformed advisory rows and via entries fail closed", () => {
  const malformedReports = [
    { vulnerabilities: { braces: { name: "braces", via: [] } } },
    { vulnerabilities: { braces: { name: "braces", severity: "high", via: [null] } } },
    { vulnerabilities: { braces: { name: "braces", severity: "high", via: [42] } } },
    { vulnerabilities: { braces: { name: "braces", severity: "high", via: [{}] } } },
    { vulnerabilities: { braces: { name: "braces", severity: "high", via: [{ name: "braces", url: "https://example.test/advisory" }] } } },
    { vulnerabilities: { braces: { name: "braces", severity: "unknown", via: [{ name: "braces", severity: "high", url: "https://example.test/advisory" }] } } },
    { vulnerabilities: { braces: { name: "other", severity: "high", via: [{ name: "braces", severity: "high", url: "https://example.test/advisory" }] } } },
    { vulnerabilities: { braces: { name: "braces", severity: "high", via: ["missing-dependency"] } } },
  ];
  for (const report of malformedReports) assert.throws(() => collectAdvisories(report));
});

test("unrecognized but well-formed advisory identifiers remain blocking candidates", () => {
  const advisories = collectAdvisories({
    vulnerabilities: {
      "custom-package": {
        name: "custom-package",
        severity: "critical",
        via: [{ name: "custom-package", severity: "critical", source: 12345 }],
      },
    },
  });
  const [id, advisory] = [...advisories][0];
  assert.match(id, /unidentified advisory/);
  assert.equal(advisory.severity, "critical");
  assert.equal(isAllowlisted(id, advisory), false);
});

test("emitted-artifact proof requires the exact checkout and omits allowlisted code", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "geolibre-audit-proof-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, "dist");
  const manifestFile = path.join(dist, "geolibre-audit-module-manifest.json");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const advisory = { id: "GHSA-vfj7-8cjw-p6xm", packageName: "braces" };
  await mkdir(dist, { recursive: true });
  await assert.rejects(
    verifyArtifactModuleManifest(dist, [advisory], commit),
    /missing or unreadable emitted module manifest/,
  );

  await writeFile(
    manifestFile,
    JSON.stringify({ schemaVersion: 1, commit, chunks: ["assets/app.js"], modules: ["src/app.ts"] }),
  );
  const proof = await verifyArtifactModuleManifest(dist, [advisory], commit);
  assert.equal(proof.chunks, 1);
  assert.match(proof.message, /manifest sha256 [a-f0-9]{64}/);

  await writeFile(
    manifestFile,
    JSON.stringify({
      schemaVersion: 1,
      commit,
      chunks: ["assets/app.js"],
      modules: ["../../node_modules/braces/lib/parse.js"],
    }),
  );
  await assert.rejects(verifyArtifactModuleManifest(dist, [advisory], commit), /appears in the exact-head/);

  await writeFile(
    manifestFile,
    JSON.stringify({
      schemaVersion: 1,
      commit: "0".repeat(40),
      chunks: ["assets/app.js"],
      modules: ["src/app.ts"],
    }),
  );
  await assert.rejects(verifyArtifactModuleManifest(dist, [advisory], commit), /belongs to/);
});

test("native module proof checks both viewer and esbuild embed-client artifacts", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "geolibre-native-audit-proof-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const manifestFile = path.join(tempRoot, "native-module-manifest.json");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const manifest = {
    schemaVersion: 2,
    commit,
    artifacts: {
      viewer: { chunks: ["assets/app.js"], modules: ["src/app.ts"] },
      embedClient: { chunks: ["embed-client.js"], modules: ["packages/embed/src/index.ts"] },
    },
  };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const advisory = { id: "GHSA-86w9-cpqp-85rv", packageName: "node-forge" };
  const proof = await verifyArtifactModuleManifest(manifestFile, [advisory], commit);
  assert.deepEqual(proof.artifacts, ["viewer", "embedClient"]);

  const { embedClient: _embedClient, ...viewerOnly } = manifest.artifacts;
  await writeFile(manifestFile, JSON.stringify({ ...manifest, artifacts: viewerOnly }));
  await assert.rejects(
    verifyArtifactModuleManifest(manifestFile, [advisory], commit),
    /must prove both viewer and embedClient/,
  );

  manifest.artifacts.embedClient.modules.push("../../node_modules/node-forge/lib/asn1.js");
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(
    verifyArtifactModuleManifest(manifestFile, [advisory], commit),
    /exact-head embedClient artifact/,
  );
});
