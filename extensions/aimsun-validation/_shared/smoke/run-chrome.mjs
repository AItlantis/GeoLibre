// Headless Chrome/Edge smoke via raw CDP: node smoke/run-chrome.mjs <url> [browser.exe]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = process.argv[2];
const exe = process.argv[3] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9333;
const p = spawn(exe, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "chr-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) pending.get(d.id)(d); else if (d.method === "Runtime.consoleAPICalled" || d.method === "Log.entryAdded") logs.push(JSON.stringify(d.params).slice(0, 300)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable"); await send("Log.enable"); await send("Page.navigate", { url });
let text = "";
for (let i = 0; i < 120; i++) { await sleep(500); const r = await send("Runtime.evaluate", { expression: 'document.getElementById("out")?.textContent ?? ""' }); text = r.result?.result?.value ?? ""; if (text && text !== "running") break; }
console.log(text.slice(0, 2000)); if (logs.length) console.log("LOGS:\n" + logs.join("\n"));
ws.close(); p.kill(); process.exit(text.startsWith("OK") ? 0 : 1);
