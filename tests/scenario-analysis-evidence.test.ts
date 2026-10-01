import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScenarioAnalysisEvidence } from "../apps/geolibre-desktop/src/components/panels/ScenarioAnalysisEvidence";

const rank = (current: number, baseline: number, delta: number) => ({
  available: true,
  metrics: ["speed", "delay"],
  sections: [{
    section_id: 42,
    score: 0.75,
    interval_ids: [2],
    time_windows: [{ start: "2024-06-27T08:05:00", end: "2024-06-27T08:10:00" }],
    metrics: { speed: { current, baseline, delta }, delay: { current: 10, baseline: 5, delta: 5 } },
  }],
});

test("renders verified current and worsening rankings by observed intervention phase", () => {
  const html = renderToStaticMarkup(createElement(ScenarioAnalysisEvidence, {
    analysis: {
      status: "complete",
      current_severity: rank(10, 8, 2),
      worsening_vs_baseline: rank(10, 8, 2),
      period_analysis: {
        available: true,
        periods: {
          before: { interval_ids: [1], current_severity: rank(8, 9, -1), worsening_vs_baseline: rank(8, 9, -1) },
          during: { interval_ids: [2], current_severity: rank(10, 8, 2), worsening_vs_baseline: rank(10, 8, 2) },
          after: { interval_ids: [3], current_severity: rank(7, 8, -1), worsening_vs_baseline: rank(7, 8, -1) },
        },
      },
    },
  }));

  assert.match(html, /Before \/ during \/ after findings/);
  assert.match(html, /Before the intervention/);
  assert.match(html, /During the intervention/);
  assert.match(html, /After the intervention/);
  assert.match(html, /Current severity · during/);
  assert.match(html, /Worsening versus baseline · during/);
  assert.match(html, /Observed result intervals: 2/);
  assert.match(html, /current 10, baseline 8, delta 2/);
});

test("shows period analysis as unavailable when no periods were backed by results", () => {
  const html = renderToStaticMarkup(createElement(ScenarioAnalysisEvidence, {
    analysis: {
      status: "partial",
      period_analysis: {
        available: false,
        reason: "effective_window_or_matching_result_intervals_unavailable",
        periods: {},
      },
    },
  }));

  assert.match(html, /Phase-specific findings are unavailable/);
  assert.match(html, /effective_window_or_matching_result_intervals_unavailable/);
});

test("distinguishes unavailable observed OD outcomes from assignment metadata capabilities", () => {
  const html = renderToStaticMarkup(createElement(ScenarioAnalysisEvidence, {
    analysis: {
      status: "partial",
      od_evidence: {
        status: "unavailable",
        comparison: "same_od_same_interval",
        metric: "delay",
        reason: "observed_od_journey_time_not_in_source_table",
        source_table: "path_assignment",
        capabilities: {
          affected_paths: true,
          affected_ods: true,
          path_assignment_demand: true,
          od_journey_time: false,
        },
      },
    },
  }));

  assert.match(html, /OD journey-time evidence: unavailable/);
  assert.match(html, /Observed OD travel-time and delay are unavailable/);
  assert.match(html, /affected paths available, affected ODs available, path-assignment demand available/);
  assert.match(html, /same_od_same_interval/);
  assert.match(html, /observed_od_journey_time_not_in_source_table/);
  assert.match(html, /path_assignment/);
});

test("renders version-scoped route assignment rows without describing them as observed outcomes", () => {
  const html = renderToStaticMarkup(createElement(ScenarioAnalysisEvidence, {
    analysis: {
      status: "partial",
      route_assignment_evidence: {
        status: "available",
        source: "version_scoped_path_index",
        rows: [{
          scenario_id: 7,
          assignment_interval: { start: 10, end: 15 },
          route_id: "route-42",
          origin: "A",
          destination: "B",
          ordered_section_ids: [11, 12, 13],
          assigned_demand: 250,
          assignment_percentage: 0.25,
          matched_affected_section_ids: [12],
        }],
        row_limit: 1,
        truncated: true,
        baseline_comparison: { status: "unavailable", reason: "assignment_interval_semantics_unverified" },
        coverage: {
          declared_sections: 4,
          queried_sections: 3,
          unmatched_sections: 1,
          scanned_routes: 50,
          matching_routes: 8,
          returned_routes: 1,
        },
      },
      path_evidence: {
        summary: "route impacts unavailable",
        paths: [{ id: "p-1", sections: [11, 12], metrics: { delay: null } }],
      },
    },
  }));

  assert.match(html, /Verified, version-scoped path-index assignments/);
  assert.match(html, /assigned routes and demand, not observed traffic outcomes or OD travel-time\/delay/);
  assert.match(html, /Scenario 7 · route route-42 · A → B/);
  assert.match(html, /ordered sections 11 → 12 → 13/);
  assert.match(html, /assigned demand 250/);
  assert.match(html, /assignment percentage 0\.25/);
  assert.match(html, /matched affected sections 12/);
  assert.match(html, /Showing up to 1 route rows/);
  assert.match(html, /Baseline route-assignment comparison: unavailable/);
  assert.match(html, /Baseline assignments were not compared/);
  assert.match(html, /assignment_interval_semantics_unverified/);
  assert.match(html, /Route-assignment evidence coverage/);
  assert.match(html, /declared_sections/);
  assert.match(html, /matching_routes/);
  assert.match(html, /Path evidence details/);
  assert.match(html, /route impacts unavailable/);
  assert.match(html, /p-1/);
  assert.match(html, /delay/);
});

test("renders uncalibrated evidence quality scores, their components, and workflow timings", () => {
  const html = renderToStaticMarkup(createElement(ScenarioAnalysisEvidence, {
    analysis: {
      status: "partial",
      evidence_reliability: {
        score: 0.812, calibration: "not_calibrated",
        components: { current_metric_results: 1, baseline_interval_alignment: 0.75 },
      },
      analysis_pertinence: {
        score: 0.625, calibration: "not_calibrated",
        components: { requested_scope_match: 1, requested_comparison_supported: 0 },
      },
      evidence_coverage: { queried_section_count: 12, network_section_universe_count: null },
    },
    diagnostics: {
      stage_latency_ms: { ollaya_intent_ms: 24.5, scenario_analysis_ms: 70, ollama_generation_ms: 950, total_chat_ms: 1050 },
      providers: { ollaya: { provider: "ollaya", model: "laya:en" }, ollama: { provider: "ollama", model: "qwen3" } },
      timing_scope: "server_request_stages",
    },
  }));

  assert.match(html, /Evidence quality and workflow timing/);
  assert.match(html, /Evidence reliability: 0\.812 \/ 1/);
  assert.match(html, /Request pertinence: 0\.625 \/ 1/);
  assert.match(html, /Uncalibrated heuristic; this score is not a probability/);
  assert.match(html, /baseline_interval_alignment/);
  assert.match(html, /requested_comparison_supported/);
  assert.match(html, /queried_section_count/);
  assert.match(html, /ollama_generation_ms/);
  assert.match(html, /laya:en/);
  assert.match(html, /qwen3/);
});
