import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// MITURN tables carry no `density` column (turns have no density). Selecting a
// turn must not reference it, or DuckDB raises a Binder Error and the panel
// shows "Dashboard data could not be loaded".
const source = readFileSync("packages/plugins/src/plugins/network-kpi-parquet-data.ts", "utf8");

test("turn entity query does not select a real density column", () => {
  assert.match(source, /kind === "lane" \? "density" : "NULL AS density"/);
  assert.doesNotMatch(source, /SELECT ent, flow, density, speed FROM \$\{table\} WHERE \$\{entityPredicate\}/);
});

test("turn SQLite fallback does not request density", () => {
  assert.match(source, /table === "MILANE" \? \["ent", "flow", "density", "speed"\] : \["ent", "flow", "speed"\]/);
});
