// node smoke/run.mjs [chrome.exe]
// Serves the built plugins + real data (server.mjs) and drives headless Chrome over raw CDP.
// Prerequisite: both plugins built (npm run build in each folder). Exit code 0 = OK.
import { start } from "./server.mjs";

if (!process.env.AIMSUN_DATA_DIR) {
  console.log("SKIP: AIMSUN_DATA_DIR is not set (data root holding <RUN>/detectors_*.parquet)");
  process.exit(0);
}

const server = await start(0);
const url = `http://127.0.0.1:${server.address().port}/smoke/index.html`;
// smoke/run.ps1 owns a dedicated Chrome process and passes its debugging port. Keeping
// process ownership in PowerShell lets cleanup terminate only that process tree by PID.
const port = Number(process.env.CHROME_REMOTE_PORT ?? 0);
if (!port) throw new Error("CHROME_REMOTE_PORT is required; start this run with smoke/run.ps1");
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
  if (!targets) throw new Error("Chrome did not start or attach");
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
  server.close();
  process.exit(code);
}
