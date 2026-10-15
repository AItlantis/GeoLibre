// Fix-pass tests: unmatched detectors (no eid), private resource cleanup, no raw HTML sinks,
// manifest path safety and sha256 verification. Synthetic data only; no external files needed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DetController } from "../src/common/controller.ts";
import { buildUnmatchedFeatures, parseDetectorGeo } from "../src/common/geo.ts";
import { DetectorMapLayer, statusColor, withUnmatchedColor } from "../src/common/map-layer.ts";
import { fetchChecked, indexFromManifestUrl, isSafeRelativePath, itemsFromManifest, resolveUrl } from "../src/common/package-source.ts";
import { unmatchedSimSql } from "../src/common/sql.ts";
import { barSvg } from "../../_shared/src/charts.ts";
import { openNodeDb } from "./node-db.ts";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIRS = [join(PLUGIN, "src")];

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "dist") continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// ---------- synthetic package ----------
async function synth(db: Awaited<ReturnType<typeof openNodeDb>>["db"]): Promise<{ sim: Uint8Array; obs: Uint8Array }> {
  await db.exec(`
CREATE TABLE s_sim AS SELECT * FROM (VALUES
  (1, 'E1', 0, 25200, 3600, 100.0), (2, 'E2', 0, 25200, 3600, 200.0),
  (3, NULL, 0, 25200, 3600, 50.0),  (4, '', 0, 25200, 3600, 30.0),
  (5, NULL, 0, 25200, 3600, 0.0),   (7, NULL, 1, 25200, 3600, 99.0)
) t(oid, eid, sid, interval_start_s, duration_s, flow);
CREATE TABLE s_obs AS
SELECT d AS detector_id, ts, f AS flow, 'validation' AS source_file
FROM (VALUES ('E1', 100.0), ('E2', 190.0)) x(d, f),
     (SELECT unnest(generate_series(TIMESTAMP '2025-01-01 07:05:00', TIMESTAMP '2025-01-01 08:00:00', INTERVAL 5 MINUTE)) AS ts);
COPY s_sim TO 'sim.parquet' (FORMAT parquet);
COPY s_obs TO 'obs.parquet' (FORMAT parquet);
`);
  return { sim: new Uint8Array(readFileSync("sim.parquet")), obs: new Uint8Array(readFileSync("obs.parquet")) };
}

const settle = async (c: DetController): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if ((c.state.phase === "ready" && !c.state.busy) || c.state.phase === "error") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("controller did not settle");
};

test("unmatched: sid 0, eid NULL/empty, flow > 0 (own SQL, no shared view needed); dispose cleans up", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim, obs } = await synth(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles(
      [
        { path: "data/R1/detectors_sim.parquet", arrayBuffer: async () => ab(sim) },
        { path: "data/R1/detectors_obs.parquet", arrayBuffer: async () => ab(obs) },
      ],
      "data",
    );
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.deepEqual(c.unmatched.map((u) => [u.oid, u.flow]), [["3", 50], ["4", 30]]); // oid 5 has no flow, oid 7 is another class
    assert.equal(c.aggs.length, 2);
    assert.deepEqual((await db.query<{ oid: string }>(unmatchedSimSql("mcm_"))).map((r) => r.oid), ["3", "4"]);

    let calls = 0;
    c.subscribe(() => calls++);
    await c.dispose();
    await c.dispose(); // idempotent
    const left = await db.query<{ n: number }>("SELECT count(*) AS n FROM duckdb_tables() WHERE table_name LIKE 'dc%'");
    assert.equal(Number(left[0].n), 0);
    const views = await db.query<{ n: number }>("SELECT count(*) AS n FROM duckdb_views() WHERE view_name IN ('v_det_validation','v_det_summary','v_sim_norm','v_obs_norm')");
    assert.equal(Number(views[0].n), 0);
    c.dispatch({ type: "busy", busy: true });
    assert.equal(calls, 0, "listeners cleared");
  } finally {
    close();
  }
});

test("simulation-only package leaves Validation empty while Counts aggregates simulated detectors", async () => {
  const { db, close } = await openNodeDb();
  try {
    const { sim } = await synth(db);
    const c = new DetController({ getDb: async () => db, prefix: "mcm_" });
    await c.loadFiles([{ path: "data/R1/detectors_sim.parquet", arrayBuffer: async () => ab(sim) }], "data");
    await settle(c);
    assert.equal(c.state.phase, "ready", c.state.error ?? "");
    assert.equal(c.hasObs, false);
    assert.equal(c.rows.length, 0);
    assert.deepEqual(c.aggs.map((a) => [a.id, a.sim]), [["E1", 100], ["E2", 200]]);
    assert.equal(c.unmatched.length, 2);
    await c.dispose();
  } finally {
    close();
  }
});

function fakeDb(log: string[], failCreate = false): any {
  return {
    query: async () => [],
    exec: async (sql: string) => {
      log.push(sql);
      if (failCreate && sql.includes("CREATE OR REPLACE TABLE")) throw new Error("boom");
    },
    registerBuffer: async (n: string) => void log.push(`reg ${n}`),
    dropFile: async (n: string) => void log.push(`drop ${n}`),
  };
}
const twoFiles = [
  { path: "R/detectors_sim.parquet", arrayBuffer: async () => new ArrayBuffer(1) },
  { path: "R/detectors_obs.parquet", arrayBuffer: async () => new ArrayBuffer(1) },
];

test("dispose before any load touches nothing; a load racing dispose registers nothing", async () => {
  const log: string[] = [];
  const c = new DetController({ getDb: async () => fakeDb(log) as never, prefix: "mcm_" });
  await c.dispose();
  assert.deepEqual(log, []);
  const c2 = new DetController({ getDb: async () => fakeDb(log) as never, prefix: "mcm_" });
  const p = c2.loadFiles(twoFiles, "R");
  await c2.dispose();
  await p;
  assert.ok(!log.some((l) => String(l).startsWith("reg ")), log.join("|"));
});

test("failed registration drops the virtual files; dispose still drops tables and views", async () => {
  const log: string[] = [];
  const c = new DetController({ getDb: async () => fakeDb(log, true) as never, prefix: "mcm_" });
  await c.loadFiles(twoFiles, "R");
  await settle(c);
  assert.equal(c.state.phase, "error");
  assert.ok(log.includes("drop pkg_mcm_sim_raw.parquet"));
  await c.dispose();
  assert.ok(log.some((l) => l.includes("DROP TABLE IF EXISTS mcm_sim_raw")));
  assert.ok(log.some((l) => l.includes("DROP VIEW IF EXISTS v_det_validation")));
});

// ---------- map: unmatched flagged, cleanup ----------
test("unmatched detectors become 'unmatched' features only where geometry exists", () => {
  const geo = parseDetectorGeo({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [55, 25] }, properties: { oid: 3, eid: null } }] });
  const f = buildUnmatchedFeatures([{ oid: "3", flow: 50 }, { oid: "4", flow: 30 }], geo);
  assert.equal(f.length, 1);
  assert.equal(f[0].properties.status, "unmatched");
  assert.equal(f[0].properties.eid, "");
  assert.equal(JSON.stringify(statusColor()).includes("#7a7a7a"), true);
  assert.equal((withUnmatchedColor("x") as unknown[])[0], "case");
});

class FakeMap {
  sources = new Map<string, unknown>();
  layers = new Set<string>();
  handlers: Array<[string, unknown]> = [];
  addSource(id: string, s: unknown) { this.sources.set(id, s); }
  getSource(id: string) { return this.sources.has(id) ? { setData: () => undefined } : undefined; }
  removeSource(id: string) { this.sources.delete(id); }
  addLayer(l: { id: string }) { this.layers.add(l.id); }
  getLayer(id: string) { return this.layers.has(id) ? {} : undefined; }
  removeLayer(id: string) { this.layers.delete(id); }
  setPaintProperty() {}
  setLayoutProperty() {}
  on(type: string, a: unknown, b?: unknown) { this.handlers.push([type, b ?? a]); }
  off(type: string, a: unknown, b?: unknown) { const h = b ?? a; this.handlers = this.handlers.filter(([t, f]) => !(t === type && f === h)); }
  getContainer() { return {} as HTMLElement; }
  getCanvas() { return { style: {} } as HTMLCanvasElement; }
  getZoom() { return 1; }
  flyTo() {}
}

test("map layer dispose removes sources/layers/listeners and unregisters the native layer", () => {
  const map = new FakeMap();
  const unreg: string[] = [];
  const reg: string[] = [];
  const app = { getMap: () => map as never, registerExternalNativeLayer: (l: { id: string }) => void reg.push(l.id), unregisterExternalNativeLayer: (id: string) => void unreg.push(id) };
  const layer = new DetectorMapLayer(app as never, "x-layer", "X", { describe: () => [], onSelect: () => undefined }, { radius: 6, color: "#000" });
  const fc = { type: "FeatureCollection" as const, features: [] };
  layer.update(fc, { radius: 6, color: "#000" });
  assert.ok(map.sources.size === 2 && map.layers.size === 2 && map.handlers.length > 0);
  layer.dispose();
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
  assert.equal(map.handlers.length, 0, "no leaked map listeners");
  assert.deepEqual(unreg, reg);
  assert.equal(reg.length, 1);
  layer.update(fc, { radius: 6, color: "#000" }); // late update after dispose
  assert.equal(map.sources.size, 0);
});

// ---------- no raw HTML sinks ----------
test("no innerHTML / insertAdjacentHTML / outerHTML in the plugin sources", () => {
  for (const dir of SRC_DIRS) {
    for (const f of walk(dir).filter((p) => /\.(ts|js)$/.test(p))) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(code), `${f} uses an HTML sink`);
    }
  }
});

test("chart labels from eid names are escaped by the shared SVG builder", () => {
  const svg = barSvg([{ label: `<img src=x onerror=alert(1)>"&`, value: 3 }], { yTitle: "<b>", label: `"><script>` });
  assert.ok(!/<img|<script|<b>/.test(svg), svg);
  assert.ok(svg.includes("&lt;img"));
});

test("no hard-coded drive paths in the plugin folder (tests, smoke, src)", () => {
  const bad = /[A-Za-z]:[\\/]repos/;
  for (const f of walk(PLUGIN).filter((p) => /\.(ts|js|mjs)$/.test(p) && !p.endsWith("hardening.test.ts"))) {
    assert.ok(!bad.test(readFileSync(f, "utf8")), `${f} hard-codes a drive path`);
  }
});

test("adopts the shared mutex and path helpers", async () => {
  const { withDuckDbLock } = await import("../../_shared/src/lock.ts");
  const { resolveInsidePackage } = await import("../../_shared/src/package.ts");
  const { withLock } = await import("../src/common/controller.ts");
  assert.equal(withLock, withDuckDbLock);
  assert.equal(resolveUrl, resolveInsidePackage);
});

// ---------- manifest path safety + sha256 ----------
test("encoded and tricky traversal in manifest paths is rejected", () => {
  const bad = ["../x.parquet", "%2e%2e/x.parquet", "%2E%2E/x", "a/%2e%2e/%2e%2e/x", "a%2f..%2fx", "%252e%252e/x", "a%5c..%5cx", "a\\b", "..%2fx", "/abs", "C:/x", "https://evil/x", "a/%00b", "a/%zz", "", "a/\u0001b"];
  for (const p of bad) assert.equal(isSafeRelativePath(p), false, p);
  for (const p of ["AMPK_3/detectors_sim.parquet", "./AMPK_3/d.parquet", "a b/c.parquet"]) assert.equal(isSafeRelativePath(p), true, p);
  const f = async () => new Uint8Array();
  assert.throws(() => itemsFromManifest("http://h/m.json", { schema_version: 1, files: [{ path: "%2e%2e/secret.parquet" }] }, f), /relative/);
  assert.throws(() => itemsFromManifest("http://h/m.json", { schema_version: 1, outputs_sha256: { "%2e%2e/secret": "a".repeat(64) } }, f), /unsafe/);
  assert.throws(() => resolveUrl("http://h/data/manifest.json", "%2e%2e/secret"), /unsafe/);
  assert.equal(resolveUrl("http://h/data/manifest.json", "./A/b.parquet"), "http://h/data/A/b.parquet");
});

test("sha256: malformed declarations rejected, conflicts detected, declared digest verified on read", async () => {
  const f = async () => new Uint8Array();
  assert.throws(() => itemsFromManifest("http://h/m.json", { schema_version: 1, files: [{ path: "A/detectors_sim.parquet", sha256: "xyz" }] }, f), /64 hex/);
  assert.throws(
    () => itemsFromManifest("http://h/m.json", { schema_version: 1, files: [{ path: "A/d.parquet", sha256: "a".repeat(64) }], outputs_sha256: { "A/d.parquet": "b".repeat(64) } }, f),
    /conflicting/,
  );
  const bytes = new TextEncoder().encode("hello");
  const good = createHash("sha256").update(bytes).digest("hex");
  const fetchImpl = (async (u: string) =>
    String(u).endsWith("manifest.json")
      ? new Response(JSON.stringify({ schema_version: 1, files: [{ path: "R/detectors_sim.parquet", sha256: good.toUpperCase() }, { path: "R/detectors_obs.parquet", sha256: "0".repeat(64) }] }))
      : new Response(bytes)) as unknown as typeof fetch;
  const idx = await indexFromManifestUrl("http://h/data/manifest.json", fetchImpl);
  assert.deepEqual(Array.from(await idx.runs[0].sim.read()), Array.from(bytes));
  await assert.rejects(() => idx.runs[0].obs!.read(), /sha256 mismatch/);
  await assert.rejects(() => fetchChecked("http://h/x", "x", "f".repeat(64), fetchImpl), /sha256 mismatch/);
});
