import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync("apps/geolibre-desktop/src/components/panels/NetworkKpiPanel.tsx", "utf8");
const css = readFileSync("apps/geolibre-desktop/src/index.css", "utf8");
const en = JSON.parse(readFileSync("apps/geolibre-desktop/src/i18n/locales/en.json", "utf8"));

test("dashboard charts are tabbed, one visible at a time", () => {
  const start = src.indexOf("function DashboardChartTabs");
  const end = src.indexOf("function DashboardLineChart");
  const body = src.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal((body.match(/<Tabs /g) ?? []).length, 2);
  assert.match(body, /DASHBOARD_METRICS\.map[\s\S]*TabsTrigger/);
  assert.match(body, /<TabsContent value="density"/);
  assert.match(body, /<TabsContent value="speed"/);
  assert.match(body, /aria-label=\{t\("toolbar\.networkKpi\.dashboard\.overTimeTabs"\)\}/);
  // charts are no longer stacked in the dashboard body
  const dash = src.slice(src.indexOf("function NetworkKpiDashboard"), start);
  assert.doesNotMatch(dash, /<DashboardLineChart|<DashboardScatterChart/);
  assert.match(dash, /<DashboardChartTabs/);
});

test("charts fill the panel and i18n keys exist", () => {
  assert.match(css, /\.network-kpi-dashboard-chart--fill \{ height: auto;/);
  assert.equal(en.toolbar.networkKpi.dashboard.overTimeTabs, "Statistics over time");
  assert.equal(en.toolbar.networkKpi.dashboard.relationshipTabs, "Flow relationships");
});
