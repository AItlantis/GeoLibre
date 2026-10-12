// node smoke/run.mjs [chrome.exe]
// Serves the built plugins + real data (server.mjs) and drives headless Chrome over raw CDP.
// Prerequisite: both plugins built (npm run build in each folder). Exit code 0 = OK.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./server.mjs";

if (!process.env.AIMSUN_DATA_DIR) {
  console.log("SKIP: AIMSUN_DATA_DIR is not set (data root holding <RUN>/detectors_*.parquet)");
  process.exit(0);
}

const exe = process.argv[2] ?? process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const server = await start(0);
const url = `http://127.0.0.1:${server.address().port}/smoke/index.html`;
// a random debugging port so parallel runs do not collide
const port = 9400 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "av-smoke-"));
const chrome = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 1;
try {
  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!targets) throw new Error("Chrome did not start");
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
    else if (d.method === "Runtime.consoleAPICalled") logs.push(`console.${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300)}`);
    else if (d.method === "Runtime.exceptionThrown") logs.push(`EXC: ${JSON.stringify(d.params.exceptionDetails).slice(0, 400)}`);
    else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") logs.push(`log.error: ${d.params.entry.text} ${d.params.entry.url ?? ""}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  let text = "";
  for (let i = 0; i < 360; i++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", { expression: 'document.getElementById("out")?.textContent ?? ""' });
    text = r.result?.result?.value ?? "";
    if (text && text !== "running") break;
  }
  console.log(text.slice(0, 3000));
  if (!text.startsWith("OK") && logs.length) console.log("LOGS:\n" + logs.join("\n"));
  code = text.startsWith("OK") ? 0 : 1;
  ws.close();
} catch (e) {
  console.error(e);
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
  process.exit(code);
}
