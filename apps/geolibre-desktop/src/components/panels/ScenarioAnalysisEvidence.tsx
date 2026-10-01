import * as React from "react";

type EvidenceRecord = Record<string, unknown>;

export function ScenarioAnalysisEvidence({ analysis }: { analysis: EvidenceRecord }) {
  const facts = asRecord(analysis.intervention_facts);
  const interventions = Array.isArray(facts?.interventions)
    ? facts.interventions.filter(isRecord) : [];
  const candidates = Array.isArray(analysis.candidates)
    ? analysis.candidates.filter(isRecord) : [];
  const current = asRecord(analysis.current_severity);
  const worsening = asRecord(analysis.worsening_vs_baseline);
  const phases = asRecord(analysis.period_analysis);
  const phaseRows = asRecord(phases?.periods);
  const odEvidence = asRecord(analysis.od_evidence);
  const routeAssignmentEvidence = asRecord(analysis.route_assignment_evidence);
  const modelMatchScore = typeof analysis.model_match_score === "number" ? analysis.model_match_score : null;

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-background/70 p-2 text-xs">
      <div className="font-semibold">Scenario evidence · {String(analysis.status ?? "partial")}</div>
      {modelMatchScore !== null && <div>Scenario match score: {modelMatchScore.toFixed(2)} · calibration has not been validated on held-out scenario data.</div>}
      <section>
        <div className="font-medium">Verified package facts</div>
        {facts ? <>
          <div>Baseline role: {String(facts.baseline_role ?? "unavailable")}; linked baseline: {String(facts.baseline_scenario_id ?? "unavailable")}</div>
          {interventions.length ? interventions.map((item, index) => <div key={index}>
            {String(item.type ?? "intervention")} · location {typeof item.location === "string" ? item.location : item.location ? "declared" : "unavailable"}
            {Array.isArray(item.affected_section_ids) && item.affected_section_ids.length > 0 ? ` · sections ${item.affected_section_ids.join(", ")}` : " · affected sections unavailable"}
            {Array.isArray(item.affected_path_ids) && item.affected_path_ids.length > 0 ? ` · paths ${item.affected_path_ids.join(", ")}` : " · affected paths unavailable"}
            {item.effective_window ? ` · effective window ${JSON.stringify(item.effective_window)}` : " · effective window unavailable"}
            {item.provenance ? ` · provenance ${typeof item.provenance === "string" ? item.provenance : JSON.stringify(item.provenance)}` : " · provenance unavailable"}
          </div>) : <div>No intervention details declared.</div>}
        </> : <div>Intervention metadata is unavailable for this package.</div>}
      </section>
      {current && <RankingEvidence title="Calculated current severity" ranking={current} />}
      {worsening && <RankingEvidence title="Calculated worsening versus baseline" ranking={worsening} />}
      {odEvidence && <OdEvidence evidence={odEvidence} />}
      {routeAssignmentEvidence && <RouteAssignmentEvidence evidence={routeAssignmentEvidence} />}
      {analysis.path_evidence !== undefined && analysis.path_evidence !== null && <details>
        <summary>Path evidence details</summary>
        <EvidenceValue value={analysis.path_evidence} />
      </details>}
      {phases && <details>
        <summary>Before / during / after findings</summary>
        {phases.available === true && phaseRows ? phaseOrder.map(phase => {
          const result = asRecord(phaseRows[phase]);
          if (!result) return null;
          const phaseCurrent = asRecord(result.current_severity);
          const phaseWorsening = asRecord(result.worsening_vs_baseline);
          const intervals = Array.isArray(result.interval_ids) ? result.interval_ids : [];
          const windows = Array.isArray(result.time_windows) ? result.time_windows.filter(isRecord) : [];
          return <section key={phase} aria-label={`${phase} period findings`} className="mt-2 border-t border-border pt-2">
            <div className="font-semibold">{phaseLabel[phase]}</div>
            {intervals.length > 0 && <div>Observed result intervals: {intervals.join(", ")}</div>}
            {windows.length > 0 && <div>Observed simulation windows: {windows.map(window => `${String(window.start)}–${String(window.end)}`).join(", ")}</div>}
            {phaseCurrent && <RankingEvidence title={`Current severity · ${phase}`} ranking={phaseCurrent} />}
            {phaseWorsening && <RankingEvidence title={`Worsening versus baseline · ${phase}`} ranking={phaseWorsening} />}
          </section>;
        }) : <div className="mt-1 text-muted-foreground">Phase-specific findings are unavailable: {String(phases.reason ?? "no matching result periods")}</div>}
      </details>}
      {candidates.length > 0 && <details>
        <summary>Likely candidates and model match scores</summary>
        <ul className="list-inside list-disc">{candidates.map((candidate, index) => <li key={index}>{String(candidate.name ?? candidate.scenario_id ?? "Scenario")} · {typeof candidate.model_match_score === "number" ? candidate.model_match_score.toFixed(2) : "score unavailable"}</li>)}</ul>
        <div>Scores describe the model's match, not probabilities. Calibration has not been validated on held-out scenario data.</div>
      </details>}
      <div className="text-muted-foreground">Model explanation is separate from these verified facts and calculations.</div>
    </div>
  );
}

function RankingEvidence({ title, ranking }: { title: string; ranking: EvidenceRecord }) {
  const sections = Array.isArray(ranking.sections) ? ranking.sections.filter(isRecord) : [];
  const metrics = Array.isArray(ranking.metrics) ? ranking.metrics.map(String).join(", ") : "none";
  const metricRankings = asRecord(ranking.metric_rankings) ?? {};
  const metricOnly = ranking.available !== true && Object.keys(metricRankings).length > 0;
  return <section>
    <div className="font-medium">{title}</div>
    {ranking.available === true ? <>
      <div>Metrics contributing: {metrics}</div>
      <ol className="list-inside list-decimal">{sections.slice(0, 5).map((section, index) => {
        const values = asRecord(section.metrics)
          ? Object.entries(section.metrics as EvidenceRecord).map(([key, value]) => {
            if (value && typeof value === "object") {
              const parts = value as EvidenceRecord;
              return `${key}: current ${String(parts.current ?? "unavailable")}, baseline ${String(parts.baseline ?? "not compared")}, delta ${String(parts.delta ?? "not compared")}`;
            }
            return `${key} ${String(value)}`;
          }).join("; ") : "values unavailable";
        const intervals = Array.isArray(section.interval_ids) && section.interval_ids.length ? ` · intervals ${section.interval_ids.join(", ")}` : "";
        const windows = Array.isArray(section.time_windows) ? section.time_windows.map(value => {
          const window = asRecord(value);
          return window ? `${String(window.start)}–${String(window.end)}` : null;
        }).filter(Boolean) : [];
        const timeWindow = windows.length ? ` · simulation windows ${[...new Set(windows)].join(", ")}` : "";
        return <li key={index}>Section {String(section.section_id)} · score {typeof section.score === "number" ? section.score.toFixed(2) : "unavailable"}{intervals}{timeWindow} · {values}</li>;
      })}</ol>
    </> : metricOnly ? <>
      <div>Composite ranking unavailable: {String(ranking.reason ?? "insufficient metrics")}. Metric-specific results use {metrics}.</div>
      {Object.entries(metricRankings).map(([metric, value]) => {
        const rows = Array.isArray(value) ? value.filter(isRecord) : [];
        return <div key={metric}>
          <div className="font-medium">{metric} ranking</div>
          <ol className="list-inside list-decimal">{rows.slice(0, 5).map((row, index) => {
            const valueRecord = asRecord(row.values);
            const valueLabel = valueRecord
              ? `current ${String(valueRecord.current ?? "unavailable")}, baseline ${String(valueRecord.baseline ?? "unavailable")}, delta ${String(valueRecord.delta ?? "unavailable")}`
              : String(row.values ?? "unavailable");
            return <li key={index}>Section {String(row.section_id)} · percentile {typeof row.percentile === "number" ? (row.percentile * 100).toFixed(0) : "unavailable"} · {valueLabel}</li>;
          })}</ol>
        </div>;
      })}
    </> : <div>Composite ranking unavailable: {String(ranking.reason ?? "insufficient metrics")}.</div>}
  </section>;
}

function OdEvidence({ evidence }: { evidence: EvidenceRecord }) {
  const capabilities = asRecord(evidence.capabilities) ?? {};
  const yesNo = (value: unknown) => value === true ? "available" : value === false ? "unavailable" : "not reported";
  const journeyTime = capabilities.od_journey_time;
  return <section aria-label="OD evidence">
    <div className="font-medium">OD evidence</div>
    <div>Status: {displayValue(evidence.status)} · comparison: {displayValue(evidence.comparison)} · metric: {displayValue(evidence.metric)}</div>
    <div>OD journey-time evidence: {yesNo(journeyTime)}.</div>
    {journeyTime === false && <div>Observed OD travel-time and delay are unavailable; route assignment records below do not measure traffic outcomes.</div>}
    <div>Assignment metadata capabilities: affected paths {yesNo(capabilities.affected_paths)}, affected ODs {yesNo(capabilities.affected_ods)}, path-assignment demand {yesNo(capabilities.path_assignment_demand)}.</div>
    {evidence.source_table !== undefined && <div>OD evidence source table: {displayValue(evidence.source_table)}</div>}
    {evidence.reason !== undefined && <div className="text-muted-foreground">{displayValue(evidence.reason)}</div>}
  </section>;
}

function RouteAssignmentEvidence({ evidence }: { evidence: EvidenceRecord }) {
  const rows = Array.isArray(evidence.rows) ? evidence.rows.filter(isRecord).slice(0, 20) : [];
  const baselineComparison = asRecord(evidence.baseline_comparison);
  const coverage = asRecord(evidence.coverage);
  const source = evidence.source === "version_scoped_path_index"
    ? "Verified, version-scoped path-index assignments"
    : "Route assignment evidence";
  return <section aria-label="Route assignment evidence">
    <div className="font-medium">{source} · {displayValue(evidence.status)}</div>
    <div>These rows describe assigned routes and demand, not observed traffic outcomes or OD travel-time/delay.</div>
    {rows.length > 0 ? <ul className="list-inside list-disc">
      {rows.map((row, index) => <li key={index}>
        Scenario {displayValue(row.scenario_id)} · route {displayValue(row.route_id)} · {displayValue(row.origin)} → {displayValue(row.destination)}
        {row.assignment_interval !== undefined && <> · assignment interval <EvidenceValue value={row.assignment_interval} /></>}
        {Array.isArray(row.ordered_section_ids) && <> · ordered sections {row.ordered_section_ids.map(displayValue).join(" → ")}</>}
        {row.assigned_demand !== undefined && <> · assigned demand {displayValue(row.assigned_demand)}</>}
        {row.assignment_percentage !== undefined && <> · assignment percentage {displayValue(row.assignment_percentage)}</>}
        {Array.isArray(row.matched_affected_section_ids) && row.matched_affected_section_ids.length > 0 && <> · matched affected sections {row.matched_affected_section_ids.map(displayValue).join(", ")}</>}
      </li>)}
    </ul> : <div>{displayValue(evidence.reason ?? "No route-assignment rows are available.")}</div>}
    {evidence.truncated === true && <div>Showing up to {displayValue(evidence.row_limit ?? rows.length)} route rows; additional rows were omitted.</div>}
    {evidence.reason !== undefined && rows.length > 0 && <div className="text-muted-foreground">{displayValue(evidence.reason)}</div>}
    {baselineComparison && <div>
      <div>Baseline route-assignment comparison: {displayValue(baselineComparison.status)}.</div>
      {baselineComparison.status === "unavailable" && <div>Baseline assignments were not compared; route assignment intervals are not verified as comparable.</div>}
      {baselineComparison.reason !== undefined && <div className="text-muted-foreground">{displayValue(baselineComparison.reason)}</div>}
    </div>}
    {coverage && <div>
      <div className="font-medium">Route-assignment evidence coverage</div>
      <EvidenceValue value={coverage} />
    </div>}
  </section>;
}

function EvidenceValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth >= 4) return <span>Additional nested evidence omitted.</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span>None</span>;
    return <ul className="list-inside list-disc">{value.slice(0, 20).map((item, index) => <li key={index}><EvidenceValue value={item} depth={depth + 1} /></li>)}{value.length > 20 && <li>{value.length - 20} more values omitted.</li>}</ul>;
  }
  const record = asRecord(value);
  if (record) {
    const entries = Object.entries(record).slice(0, 20);
    if (!entries.length) return <span>None</span>;
    return <dl className="ms-2 border-s border-border ps-2">{entries.map(([key, item]) => <div key={key}>
      <dt className="inline font-medium">{key}: </dt><dd className="inline"><EvidenceValue value={item} depth={depth + 1} /></dd>
    </div>)}{Object.keys(record).length > 20 && <div>Additional fields omitted.</div>}</dl>;
  }
  return <span>{displayValue(value)}</span>;
}

function asRecord(value: unknown): EvidenceRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as EvidenceRecord : null;
}

function isRecord(value: unknown): value is EvidenceRecord {
  return asRecord(value) !== null;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "unavailable";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

const phaseOrder = ["before", "during", "after"] as const;
const phaseLabel = { before: "Before the intervention", during: "During the intervention", after: "After the intervention" } as const;
