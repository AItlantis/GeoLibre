// Runs smoke cases in headless Chrome, one fresh browser per case, reusing _shared/smoke/run-chrome.mjs
// (raw CDP; exits 0 when #out starts with "OK"). Usage from a plugin's smoke/run.mjs:
//   await runCases({ casesFile: "cases-jt.js", names: [...], config: { roots, packages } })
// env CHROME overrides the browser path; env CASE runs a single case.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { start } from "./server.mjs";

const RUN_CHROME = fileURLToPath(new URL("../../_shared/smoke/run-chrome.mjs", import.meta.url));
const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

function runOne(url, chrome) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUN_CHROME, url, chrome], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    p.on("exit", (code) => resolve({ code, text }));
  });
}

export async function runCases({ casesFile, names, config }) {
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) throw new Error("No Chrome/Edge found; set CHROME");
  const server = await start(config);
  const base = `http://127.0.0.1:${server.address().port}`;
  const only = process.env.CASE;
  let failed = 0;
  for (const name of only ? [only] : names) {
    const url = `${base}/smoke/index.html?cases=${encodeURIComponent("/smoke/" + casesFile)}&case=${encodeURIComponent(name)}`;
    const { code, text } = await runOne(url, chrome);
    const ok = code === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${casesFile}:${name}\n  ${text.trim().replace(/\n/g, "\n  ").slice(0, 3000)}`);
  }
  server.close();
  console.log(failed ? `${failed} smoke case(s) FAILED` : "all smoke cases passed");
  process.exit(failed ? 1 : 0);
}
