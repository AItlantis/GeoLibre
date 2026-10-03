export const BLOCKING = new Set(["high", "critical"]);

export const ALLOWLIST = new Map([
  [
    "GHSA-vfj7-8cjw-p6xm",
    {
      packageName: "braces",
      version: "3.0.3",
      advisoryUrl: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
      patchStatus: "GitHub Advisory Database lists no patched version (checked 2026-10-03).",
      dependencyPath:
        "@osmix/geojson@0.0.15 -> @placemarkio/geojson-rewind@1.0.3 -> @changesets/cli -> micromatch -> braces@3.0.3; patch-package@8.0.1 -> find-yarn-workspace-root -> micromatch -> braces@3.0.3",
      reason:
        "The GitHub advisory lists no patched version. @placemarkio/geojson-rewind declares @changesets/cli as a production dependency, but its published runtime entry is a self-contained GeoJSON function and does not import Changesets or micromatch; patch-package is only run by the repository postinstall script. Exact-head module-graph proofs must also show that braces is absent from both GeoLibre and Testudo runtime bundles.",
    },
  ],
  [
    "GHSA-86w9-cpqp-85rv",
    {
      packageName: "node-forge",
      version: "1.4.0",
      advisoryUrl: "https://github.com/advisories/GHSA-86w9-cpqp-85rv",
      patchStatus: "GitHub Advisory Database lists no patched version (checked 2026-10-03).",
      dependencyPath:
        "maplibre-gl-earth-engine / maplibre-gl-geoagent -> @google/earthengine -> googleapis -> google-auth-library -> gtoken -> google-p12-pem -> node-forge@1.4.0",
      reason:
        "The GitHub advisory lists no patched version. The affected ASN.1/RSA verification implementation is not imported into the browser app; exact-head module-graph proofs must show that node-forge is absent from both GeoLibre and Testudo runtime bundles.",
    },
  ],
]);

const SEVERITY = new Set(["low", "moderate", "high", "critical"]);
const SEVERITY_RANK = new Map([["low", 0], ["moderate", 1], ["high", 2], ["critical", 3]]);

function requireSeverity(value, context) {
  if (!SEVERITY.has(value)) throw new Error(`${context} has an invalid or missing severity.`);
  return value;
}

function validateVia(via, context) {
  if (typeof via === "string") {
    const packageName = via.trim();
    if (
      packageName.length === 0 ||
      !/^@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/.test(packageName)
    ) {
      throw new Error(`${context} has a malformed dependency reference.`);
    }
    return;
  }
  if (via === null || typeof via !== "object" || Array.isArray(via)) {
    throw new Error(`${context} has a malformed advisory entry.`);
  }
  if (typeof via.name !== "string" || via.name.trim().length === 0) {
    throw new Error(`${context} advisory has no package name.`);
  }
  requireSeverity(via.severity, `${context} advisory ${via.name}`);
  if (
    (typeof via.url !== "string" || via.url.trim().length === 0) &&
    !((typeof via.source === "string" && via.source.trim().length > 0) ||
      (Number.isSafeInteger(via.source) && via.source > 0))
  ) {
    throw new Error(`${context} advisory ${via.name} has no URL or source identifier.`);
  }
}

export function parseAuditReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("stdout was not JSON.");
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("stdout was JSON but not an object.");
  }
  if (report.error) {
    throw new Error(
      `npm reported an error: ${report.error.detail || report.error.summary || report.message || "no detail"}`,
    );
  }
  if (
    typeof report.vulnerabilities !== "object" ||
    report.vulnerabilities === null ||
    Array.isArray(report.vulnerabilities)
  ) {
    throw new Error("the report has no `vulnerabilities` section.");
  }
  return report;
}

export function collectAdvisories(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("audit report must be an object.");
  }
  if (
    report.vulnerabilities === null ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities)
  ) {
    throw new Error("audit report has a malformed `vulnerabilities` section.");
  }
  const rows = Object.entries(report.vulnerabilities);
  for (const [key, vuln] of rows) {
    const context = `vulnerability ${key}`;
    if (vuln === null || typeof vuln !== "object" || Array.isArray(vuln)) {
      throw new Error(`${context} is malformed.`);
    }
    if (typeof vuln.name !== "string" || vuln.name !== key) {
      throw new Error(`${context} has a missing or mismatched package name.`);
    }
    requireSeverity(vuln.severity, context);
    if (!Array.isArray(vuln.via) || vuln.via.length === 0) {
      throw new Error(`${context} has no advisory/dependency references.`);
    }
    for (const via of vuln.via) validateVia(via, context);
  }

  const advisories = new Map();
  for (const [, vuln] of rows) {
    for (const via of vuln.via) {
      if (typeof via !== "object") continue;
      const id =
        /(GHSA-[\w-]+)/.exec(via.url ?? "")?.[1] ??
        `unidentified advisory (${via.url ?? via.source ?? via.name})`;
      const entry = advisories.get(id) ?? {
        title: via.title,
        severity: via.severity,
        url: via.url,
        packages: new Set(),
      };
      if (SEVERITY_RANK.get(vuln.severity) > SEVERITY_RANK.get(entry.severity)) {
        entry.severity = vuln.severity;
      }
      entry.packages.add(via.name);
      advisories.set(id, entry);
    }
  }
  return advisories;
}

export function isAllowlisted(id, advisory) {
  const entry = ALLOWLIST.get(id);
  return entry !== undefined && advisory.packages.has(entry.packageName);
}
