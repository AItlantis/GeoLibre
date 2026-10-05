// Build the manifest-verified GeoLibre v3.1 static tree served by Testudo at
// /geolibre-native/. Keep it identical to the Python embed artifact so the
// consumer can pin and verify one immutable directory layout.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = resolve(repoRoot, "python/src/geolibre/static/app");
const testudoDir = resolve(repoRoot, "apps/geolibre-desktop/dist-testudo");

const result = spawnSync("npm", ["run", "build:embed"], {
  cwd: repoRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

rmSync(testudoDir, { recursive: true, force: true });
mkdirSync(testudoDir, { recursive: true });
cpSync(staticDir, testudoDir, { recursive: true });
console.log(`[build-testudo] Staged manifest-verified native iframe tree into ${testudoDir}`);
