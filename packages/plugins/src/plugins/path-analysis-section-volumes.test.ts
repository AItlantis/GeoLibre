import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePathSectionVolumes } from "./path-analysis-section-volumes";
import type { PathMatch } from "./path-analysis-data";

const match = (route_id: number, demand: number): PathMatch => ({
  route_id, demand, percentage: 0, origin: 1, destination: 9, vehicle: 1, interval: 0,
});

test("aggregates unique route demand by section and normalizes to the selected section", () => {
  const matches = [match(10, 60), match(11, 40), match(12, 900)];
  const links = [
    { route_id: 10, section_id: 1, pos: 0 },
    { route_id: 10, section_id: 2, pos: 1 },
    { route_id: 10, section_id: 3, pos: 2 },
    { route_id: 11, section_id: 1, pos: 0 },
    { route_id: 11, section_id: 2, pos: 1 },
    { route_id: 11, section_id: 4, pos: 2 },
    { route_id: 12, section_id: 8, pos: 0 }, // unmatched reference: excluded from anchored totals
  ];

  const result = aggregatePathSectionVolumes(matches, links, 2);
  assert.equal(result.selectedVolume, 100);
  assert.deepEqual(result.sections, [
    { section_id: 1, volume: 100, totalVolume: 100, percentage: 100, role: "upstream" },
    { section_id: 2, volume: 100, totalVolume: 100, percentage: 100, role: "selected" },
    { section_id: 3, volume: 60, totalVolume: 60, percentage: 60, role: "downstream" },
    { section_id: 4, volume: 40, totalVolume: 40, percentage: 40, role: "downstream" },
  ]);
});

test("deduplicates route ids and duplicate route-link occurrences", () => {
  const result = aggregatePathSectionVolumes(
    [match(1, 25), match(1, 25)],
    [
      { route_id: 1, section_id: 5, pos: 0 },
      { route_id: 1, section_id: 5, pos: 0 },
      { route_id: 1, section_id: 6, pos: 1 },
      { route_id: 1, section_id: 6, pos: 2 },
    ],
    5,
  );
  assert.equal(result.selectedVolume, 25);
  assert.deepEqual(result.sections, [
    { section_id: 5, volume: 25, totalVolume: 25, percentage: 100, role: "selected" },
    { section_id: 6, volume: 25, totalVolume: 25, percentage: 100, role: "downstream" },
  ]);
});

test("returns no normalized section rows when no matched route traverses the reference", () => {
  const result = aggregatePathSectionVolumes(
    [match(1, 12)],
    [{ route_id: 1, section_id: 8, pos: 0 }],
    5,
  );
  assert.deepEqual(result, { selectedVolume: 0, sections: [] });
});

test("classifies loop sections relative to their nearest selected-section occurrence", () => {
  const result = aggregatePathSectionVolumes(
    [match(1, 10)],
    [
      { route_id: 1, section_id: 5, pos: 0 },
      { route_id: 1, section_id: 6, pos: 1 },
      { route_id: 1, section_id: 7, pos: 2 },
      { route_id: 1, section_id: 5, pos: 3 },
    ],
    5,
  );
  assert.deepEqual(result.sections, [
    { section_id: 5, volume: 10, totalVolume: 10, percentage: 100, role: "selected" },
    { section_id: 6, volume: 10, totalVolume: 10, percentage: 100, role: "downstream" },
    { section_id: 7, volume: 10, totalVolume: 10, percentage: 100, role: "upstream" },
  ]);
});

test("preserves contributions on both sides when the same section occurs across paths", () => {
  const result = aggregatePathSectionVolumes(
    [match(1, 60), match(2, 40)],
    [
      { route_id: 1, section_id: 5, pos: 0 }, { route_id: 1, section_id: 8, pos: 1 },
      { route_id: 2, section_id: 8, pos: 0 }, { route_id: 2, section_id: 5, pos: 1 },
    ],
    5,
  );
  assert.deepEqual(result.sections, [
    { section_id: 5, volume: 100, totalVolume: 100, percentage: 100, role: "selected" },
    { section_id: 8, volume: 40, totalVolume: 100, percentage: 40, role: "upstream" },
    { section_id: 8, volume: 60, totalVolume: 100, percentage: 60, role: "downstream" },
  ]);
});

test("one looping route contributes once to total section volume but on both OD sides", () => {
  const result = aggregatePathSectionVolumes(
    [match(1, 25)],
    [
      { route_id: 1, section_id: 8, pos: 0 },
      { route_id: 1, section_id: 5, pos: 1 },
      { route_id: 1, section_id: 8, pos: 2 },
    ],
    5,
  );
  assert.deepEqual(result.sections, [
    { section_id: 5, volume: 25, totalVolume: 25, percentage: 100, role: "selected" },
    { section_id: 8, volume: 25, totalVolume: 25, percentage: 100, role: "upstream" },
    { section_id: 8, volume: 25, totalVolume: 25, percentage: 100, role: "downstream" },
  ]);
});
