import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeGeoAiInvestigation } from "../apps/geolibre-desktop/src/lib/testudo-investigation";

test("creates a compact parent digest from scenario analysis without forwarding the full evidence object", () => {
  const summary = summarizeGeoAiInvestigation("The intervention worsens delay.", {
    status: "partial",
    scenario: { scenario_id: 12, name: "Roadworks North" },
    current_severity: {
      available: true,
      sections: [1, 2, 3, 4].map(section_id => ({ section_id, score: section_id / 10, metrics: { delay: { current: section_id, baseline: 2, delta: section_id - 2 } } })),
    },
    worsening_vs_baseline: { available: false, reason: "baseline_result_rows_missing", sections: [] },
    period_analysis: { available: false, reason: "phase_intervals_missing" },
    od_evidence: { capabilities: { od_journey_time: false }, reason: "od_journey_time_source_unavailable" },
    route_assignment_evidence: {
      status: "available",
      baseline_comparison: { status: "unavailable", reason: "assignment_interval_semantics_unverified" },
      rows: [{ route_id: "route-1", huge_payload: "must not escape into parent digest" }],
    },
    raw_table_dump: "must not escape into parent digest",
  });

  assert.deepEqual(summary.selectedScenario, { id: 12, name: "Roadworks North" });
  assert.equal(summary.currentTopSections.length, 3);
  assert.equal(summary.currentTopSections[0]?.sectionId, 1);
  assert.deepEqual(summary.currentTopSections[0]?.metrics, { delay: { current: 1, baseline: 2, delta: -1 } });
  assert.deepEqual(summary.worseningTopSections, []);
  assert.ok(summary.evidenceGaps.includes("baseline_result_rows_missing"));
  assert.ok(summary.evidenceGaps.includes("phase_intervals_missing"));
  assert.ok(summary.evidenceGaps.includes("od_journey_time_source_unavailable"));
  assert.ok(summary.evidenceGaps.includes("assignment_interval_semantics_unverified"));
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("raw_table_dump"), false);
  assert.equal(serialized.includes("must not escape"), false);
});

test("bounds narrative text and evidence gap strings in the parent digest", () => {
  const summary = summarizeGeoAiInvestigation("r".repeat(2000), {
    evidence_gaps: Array.from({ length: 12 }, (_, index) => `gap-${index}-${"x".repeat(240)}`),
  });
  assert.equal(summary.reply.length, 1200);
  assert.equal(summary.evidenceGaps.length, 8);
  assert.ok(summary.evidenceGaps.every(gap => gap.length <= 180));
});
