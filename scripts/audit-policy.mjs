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
        "The GitHub advisory lists no patched version. @placemarkio/geojson-rewind declares @changesets/cli as a production dependency, but its published runtime entry is a self-contained GeoJSON function and does not import Changesets or micromatch; patch-package is only run by the repository postinstall script. The exact-head app source-map audit must also show no braces module in emitted JavaScript.",
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
        "The GitHub advisory lists no patched version. The affected ASN.1/RSA verification implementation is not imported into the browser app; the exact-head app source-map audit must show no node-forge module in emitted JavaScript.",
    },
  ],
]);

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
  const advisories = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
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
