// Headless Chrome smoke for the three OD plugins against REAL AMPK_3 data, via raw CDP.
//   node _od/smoke/run-chrome.mjs [plugin-id ...] [--files] [--browser <exe>]
// Starts the static server (server.mjs), then one fresh browser profile per run. Exit code 1 on any failure.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./server.mjs";

const args = process.argv.slice(2);
const files = args.includes("--files");
const bi = args.indexOf("--browser");
const exe = bi >= 0 ? args[bi + 1] : "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--browser");
const plugins = ids.length ? ids : ["aimsun-trips", "aimsun-od-before-after", "aimsun-od-diff"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await start(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function runOne(id, mode, port) {
  const profile = mkdtempSync(join(tmpdir(), "od-chr-"));
  const p = spawn(exe, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-precise-memory-info", "about:blank"], { stdio: "ignore" });
  try {
    let targets;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        break;
      } catch {
        await sleep(200);
      }
    }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const pending = new Map();
    const logs = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) pending.get(d.id)(d);
      else if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(d.params.exceptionDetails).slice(0, 400));
      else if (d.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(d.params.type)) logs.push("console." + d.params.type + " " + d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
      else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") logs.push("LOG " + d.params.entry.text.slice(0, 300) + " " + (d.params.entry.url ?? ""));
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.navigate", { url: `${base}/od-smoke.html?plugin=${id}&mode=${mode}` });
    let text = "";
    for (let i = 0; i < Number(process.env.POLLS ?? 1200); i++) {
      await sleep(500);
      const r = await send("Runtime.evaluate", { expression: 'document.getElementById("out")?.textContent ?? ""' });
      text = r.result?.result?.value ?? "";
      if (process.env.DBG && i % 10 === 0) console.log("poll", i, JSON.stringify(text).slice(0, 200), logs.slice(-3)); if (text && text !== "running") break;
    }
    ws.close();
    return { text, logs };
  } finally {
    p.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked profile, ignore */ }
  }
}

let bad = 0;
let port = 9400;
for (const id of plugins) {
  const mode = files ? "files" : "url";
  const { text, logs } = await runOne(id, mode, port++);
  const ok = text.startsWith("OK ");
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} [${mode}]`);
  const j = text.slice(text.indexOf("{"));
  try {
    const r = JSON.parse(j);
    console.log("  timings:", JSON.stringify(r.timings), "heapMB:", r.heapMB, "entryBytes:", r.entryBytes);
    if (r.timingsText) console.log("  " + r.timingsText);
    console.log("  status:", r.status);
    for (const c of r.checks) if (!c.ok) console.log("  CHECK FAILED:", c.name, JSON.stringify(c.extra));
  } catch {
    console.log(text.slice(0, 1500));
  }
  if (!ok) console.log(text.slice(0, 1200));
  if (logs.length) console.log("  console/exception:\n   " + logs.slice(0, 8).join("\n   "));
}
server.close();
process.exit(bad ? 1 : 0);
