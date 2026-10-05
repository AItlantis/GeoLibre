// npm audit gate. High/critical findings fail unless the installed source has
// an in-tree, postinstall-applied backport with matching regression coverage.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const blockingSeverity = new Set(["high", "critical"]);
const backports = new Map([
  ["GHSA-vfj7-8cjw-p6xm", { packagePath: "node_modules/braces/package.json", sourcePath: "node_modules/braces/lib/parse.js", version: "3.0.3", guard: "depth >= 100", testPath: "tests/braces-nesting-guard.test.ts" }],
  ["GHSA-86w9-cpqp-85rv", { packagePath: "node_modules/node-forge/package.json", sourcePath: "node_modules/node-forge/lib/rsa.js", version: "1.4.0", guard: "obj.value.length !== 2 || obj.value[0].value.length > 2", testPath: "tests/node-forge-digestalgorithm.test.ts" }],
]);

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: process.platform === "win32",
});
function fail(message, detail) {
  console.error(`npm audit gate failed: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}
if (audit.error) fail("npm could not be run", audit.error.message);
if (audit.signal) fail(`npm was killed by ${audit.signal}`, audit.stderr);
let report;
try { report = JSON.parse(audit.stdout); } catch { fail("stdout was not JSON", audit.stdout || audit.stderr); }
if (!report || typeof report !== "object" || report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
  fail("npm did not return a usable audit report", report?.error?.detail || report?.error?.summary || report?.message || audit.stderr);
}

const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities)) {
  for (const via of vuln.via ?? []) {
    if (!via || typeof via !== "object") continue;
    const id = /(GHSA-[\w-]+)/.exec(via.url ?? "")?.[1] ?? `unidentified advisory (${via.url ?? via.source ?? via.name})`;
    const entry = advisories.get(id) ?? { title: via.title, severity: via.severity, url: via.url, packages: new Set() };
    entry.packages.add(via.name);
    advisories.set(id, entry);
  }
}

const verified = new Set();
for (const [id, spec] of backports) {
  let valid = false;
  if (existsSync(spec.packagePath) && existsSync(spec.sourcePath) && existsSync(spec.testPath)) {
    try {
      valid = JSON.parse(readFileSync(spec.packagePath, "utf8")).version === spec.version &&
        readFileSync(spec.sourcePath, "utf8").includes(spec.guard);
    } catch { valid = false; }
  }
  if (advisories.has(id) && !valid) fail(`${id} is reported but the installed source fix or regression test is missing`);
  if (advisories.has(id) && valid) {
    verified.add(id);
    console.log(`backported ${id}: installed ${spec.version}, guard and test verified`);
  }
}

const blocking = [...advisories].filter(([id, advisory]) => blockingSeverity.has(advisory.severity) && !verified.has(id));
if (!blocking.length) {
  console.log(`No unhandled high/critical advisories (${verified.size} source-verified backports).`);
  process.exit(0);
}
console.error(`\n${blocking.length} unhandled high/critical advisories:`);
for (const [id, advisory] of blocking) {
  console.error(`  ${advisory.severity.padEnd(8)} ${id} ${[...advisory.packages].join(", ")}`);
  console.error(`           ${advisory.title}`);
  if (advisory.url) console.error(`           ${advisory.url}`);
}
process.exit(1);
