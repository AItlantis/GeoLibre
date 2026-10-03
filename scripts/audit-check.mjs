// CI dependency gate: `npm audit --omit=dev` with a documented allowlist.
// Run with: node scripts/audit-check.mjs  (or `npm run audit:ci`)
//
// Plain `npm audit --audit-level=high` has no way to accept a single advisory,
// so one unpatchable transitive finding reddens every PR until upstream ships a
// fix — which, for an unmaintained leaf package, may be never. This keeps the
// gate blocking on high/critical, but lets ALLOWLIST carry the advisories that
// have no fix to upgrade to *and* no reachable GeoLibre code path.
//
// Rules for adding an entry: there must be no patched version available, the
// vulnerable code must not reach a GeoLibre runtime path, and the reason has to
// say why on both counts. Anything upgradeable gets upgraded instead.
import { spawnSync } from "node:child_process";
import { verifyArtifactModuleManifest } from "./audit-artifact-proof.mjs";
import {
  ALLOWLIST,
  BLOCKING,
  collectAdvisories,
  isAllowlisted,
  parseAuditReport,
} from "./audit-policy.mjs";

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  // npm is npm.cmd on Windows, which Node will not resolve without a shell.
  shell: process.platform === "win32",
});

// The gate must fail closed: anything short of a report we can actually read is
// an error, never an implicit "clean". npm's exit code can't carry that, since
// it also goes non-zero merely because vulnerabilities exist — so the report
// itself is the signal.
function unusable(why, detail) {
  console.error(`npm audit did not return a usable report: ${why}`);
  if (detail) console.error(detail);
  process.exit(1);
}

if (audit.error) unusable("npm could not be run.", audit.error.message);
if (audit.signal) unusable(`npm was killed by ${audit.signal}.`, audit.stderr);

let report;
try {
  report = parseAuditReport(audit.stdout);
} catch (error) {
  unusable(error.message, audit.stdout || audit.stderr);
}

const advisories = collectAdvisories(report);

const blocking = [...advisories].filter(([id, a]) => {
  if (!BLOCKING.has(a.severity)) return false;
  return !isAllowlisted(id, a);
});
const allowed = [...advisories].filter(([id]) => ALLOWLIST.has(id));

for (const [id, a] of allowed) {
  const allow = ALLOWLIST.get(id);
  if (!a.packages.has(allow.packageName)) continue;
  console.log(`allowed  ${a.severity.padEnd(8)} ${id}  ${[...a.packages].join(", ")}`);
  console.log(`         ${allow.advisoryUrl}; ${allow.patchStatus}`);
  console.log(`         lockfile: ${allow.packageName}@${allow.version}; ${allow.dependencyPath}`);
  console.log(`         ${allow.reason}`);
}

const activeAllowlist = allowed.filter(([id, a]) =>
  isAllowlisted(id, a),
);
if (activeAllowlist.length > 0) {
  const nativeManifestPath = process.env.GEOLIBRE_AUDIT_NATIVE_MANIFEST;
  if (!nativeManifestPath) {
    unusable(
      "the Testudo native/embedded module manifest was not provided.",
      "Set GEOLIBRE_AUDIT_NATIVE_MANIFEST to the manifest emitted by scripts/build-testudo.mjs.",
    );
  }
  const checkout = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (checkout.error || checkout.status !== 0) {
    unusable("the checked-out commit could not be identified.", checkout.error?.message || checkout.stderr);
  }
  const manifests = [
    ["GeoLibre web runtime", new URL("../apps/geolibre-desktop/dist", import.meta.url)],
    ["Testudo native/embedded runtime", nativeManifestPath],
  ];
  try {
    for (const [label, manifestPath] of manifests) {
      const proof = await verifyArtifactModuleManifest(
        manifestPath,
        activeAllowlist.map(([id]) => ({ id, ...ALLOWLIST.get(id) })),
        checkout.stdout.trim(),
      );
      console.log(`${label}: ${proof.message}`);
    }
  } catch (error) {
    unusable("an exact-head runtime artifact could not be verified.", error.stack || error.message);
  }
}

// Stale entries are a warning, not a failure: the advisory database is a live
// service, so a transient omission must not redden an unrelated PR. The warning
// is still worth acting on — delete the entry once upstream has a fix.
for (const id of ALLOWLIST.keys()) {
  if (!advisories.has(id)) {
    console.warn(`warning: ${id} is allowlisted but no longer reported — drop it.`);
  }
}

if (blocking.length === 0) {
  console.log(`\nNo unallowed high/critical advisories (${allowed.length} allowlisted).`);
  process.exit(0);
}

console.error(
  `\n${blocking.length} unallowed high/critical advisor${blocking.length === 1 ? "y" : "ies"}:`,
);
for (const [id, a] of blocking) {
  console.error(`  ${a.severity.padEnd(8)} ${id}  ${[...a.packages].join(", ")}`);
  console.error(`           ${a.title}`);
  if (a.url) console.error(`           ${a.url}`);
}
console.error("\nUpgrade the dependency, or add an entry to ALLOWLIST in scripts/audit-check.mjs.");
process.exit(1);
