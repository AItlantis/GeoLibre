import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createNetworkKpiSectionPopup } from "../packages/plugins/src/plugins/network-kpi-section-popup";

test("Network KPI section popup shows all three time series and both metric diagrams", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  try {
    const popup = createNetworkKpiSectionPopup({
      sectionId: 42,
      sectionName: "Airport Road",
      selectedInterval: 2,
      timeline: null,
      series: [
        { interval: 1, flow: 100, density: 12, speed: 60, delay: null },
        { interval: 2, flow: 150, density: 18, speed: 45, delay: null },
      ],
      currentStats: { flow: 150, density: 18, speed: 45, delay: null },
    });

    assert.match(popup.textContent ?? "", /Airport Road/);
    assert.match(popup.textContent ?? "", /Flow over time/);
    assert.match(popup.textContent ?? "", /Density over time/);
    assert.match(popup.textContent ?? "", /Speed over time/);
    assert.match(popup.textContent ?? "", /Density vs Flow/);
    assert.match(popup.textContent ?? "", /Speed vs Flow/);
    assert.equal(popup.querySelectorAll(".network-kpi-section-chart").length, 5);
    assert.equal(popup.querySelectorAll(".network-kpi-section-plot circle").length, 10);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});

test("Network KPI section popup gives a clear empty-data state", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  try {
    const popup = createNetworkKpiSectionPopup({ sectionId: 7, series: [], timeline: null, selectedInterval: 0 });
    assert.match(popup.textContent ?? "", /No time-series values are available/);
    assert.equal(popup.querySelectorAll(".network-kpi-section-plot").length, 0);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});
