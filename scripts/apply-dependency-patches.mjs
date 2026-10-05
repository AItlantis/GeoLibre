import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync("node_modules/node-forge/package.json") || existsSync("node_modules/braces/package.json")) {
  const security = spawnSync(process.execPath, ["scripts/apply-security-backports.mjs"], { stdio: "inherit" });
  if (security.error) throw security.error;
  if ((security.status ?? 1) !== 0) process.exit(security.status ?? 1);
}

// Workspace-scoped production installs, such as the collaboration worker
// image, do not install the desktop app's dependencies (every patched package
// is one of them). There is nothing to patch in those trees, and asking
// patch-package to find @cogeotiff/core would make an otherwise valid
// `npm ci --omit=dev` fail.
if (!existsSync("node_modules/@cogeotiff/core/package.json")) {
  process.exit(0);
}

const result = spawnSync("patch-package", [], {
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
