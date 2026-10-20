import assert from "node:assert/strict";
import test from "node:test";
import { elevationByKpi, KPI_RAMPS, KPI_RANGES, kpiColorRgb } from "./network-kpi-ramps";

test("network KPI defaults use the fixed section and lane display domains", () => {
  assert.deepEqual(KPI_RANGES.flow, { min: 0, max: 2200 });
  assert.deepEqual(KPI_RANGES.density, { min: 0, max: 160 });
  assert.deepEqual(KPI_RANGES.speed, { min: 0, max: 120 });
  assert.equal(KPI_RAMPS.flow.stops.at(-1), KPI_RANGES.flow.max);
  assert.equal(KPI_RAMPS.density.stops.at(-1), KPI_RANGES.density.max);
  assert.equal(KPI_RAMPS.speed.stops.at(-1), KPI_RANGES.speed.max);
});

test("package ramp overrides keep color and extrusion domains aligned", () => {
  const override = { flow: { stops: [0, 100, 500], colors: ["#000000", "#888888", "#ffffff"], unit: "veh/h", label: "Package flow" } } as const;
  assert.deepEqual(kpiColorRgb(500, "flow", override), [255, 255, 255]);
  assert.equal(elevationByKpi(500, "flow", 10, override), 10);
  assert.equal(elevationByKpi(250, "flow", 10, override), 5.05);
});
