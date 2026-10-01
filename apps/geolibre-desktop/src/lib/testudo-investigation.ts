type RecordValue = Record<string, unknown>;

export interface GeoAiInvestigationSummary {
  reply: string;
  selectedScenario: { id: string | number; name?: string } | null;
  currentTopSections: Array<{ sectionId: string | number; score: number | null; metrics: Record<string, unknown> }>;
  worseningTopSections: Array<{ sectionId: string | number; score: number | null; metrics: Record<string, unknown> }>;
  evidenceGaps: string[];
}

/** Return a bounded parent-facing digest; never forward the full scenario analysis object. */
export function summarizeGeoAiInvestigation(reply: string, rawAnalysis: unknown): GeoAiInvestigationSummary {
  const analysis = asRecord(rawAnalysis);
  const scenario = asRecord(analysis?.scenario);
  const scenarioId = scalar(scenario?.scenario_id ?? analysis?.selected_scenario_id);
  const scenarioName = shortText(scenario?.name ?? scenario?.label ?? scenario?.scenario_name);
  const gaps: string[] = [];

  if (!analysis) gaps.push("Structured scenario evidence was not returned.");
  else {
    if (analysis.status === "partial") gaps.push("Some scenario evidence is partial.");
    const current = asRecord(analysis.current_severity);
    if (current?.available !== true) gaps.push(reasonText(current?.reason, "Current severity evidence is unavailable."));
    const worsening = asRecord(analysis.worsening_vs_baseline);
    if (worsening?.available !== true) gaps.push(reasonText(worsening?.reason, "Baseline worsening comparison is unavailable."));
    const period = asRecord(analysis.period_analysis);
    if (period && period.available !== true) gaps.push(reasonText(period.reason, "Before/during/after evidence is unavailable."));
    const od = asRecord(analysis.od_evidence);
    const odCapabilities = asRecord(od?.capabilities);
    if (odCapabilities?.od_journey_time === false) gaps.push(reasonText(od?.reason, "Observed OD travel-time/delay is unavailable."));
    const assignments = asRecord(analysis.route_assignment_evidence);
    if (assignments?.status === "unavailable") gaps.push(reasonText(assignments.reason, "Route-assignment evidence is unavailable."));
    const baseline = asRecord(assignments?.baseline_comparison);
    if (baseline?.status === "unavailable") gaps.push(reasonText(baseline.reason, "Baseline route assignments were not compared."));
    const explicit = Array.isArray(analysis.evidence_gaps) ? analysis.evidence_gaps : [];
    for (const gap of explicit) if (typeof gap === "string" && gap.trim()) gaps.push(shortText(gap) ?? "Evidence gap reported.");
  }

  return {
    reply: reply.slice(0, 1200),
    selectedScenario: scenarioId === null ? null : {
      id: scenarioId,
      ...(scenarioName ? { name: scenarioName } : {}),
    },
    currentTopSections: topSections(analysis?.current_severity),
    worseningTopSections: topSections(analysis?.worsening_vs_baseline),
    evidenceGaps: [...new Set(gaps)].slice(0, 8),
  };
}

function topSections(raw: unknown): GeoAiInvestigationSummary["currentTopSections"] {
  const ranking = asRecord(raw);
  const sections = Array.isArray(ranking?.sections) ? ranking.sections.filter(isRecord).slice(0, 3) : [];
  return sections.flatMap(section => {
    const sectionId = scalar(section.section_id);
    if (sectionId === null) return [];
    const rawMetrics = asRecord(section.metrics) ?? {};
    const metrics: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(rawMetrics).slice(0, 4)) {
      const record = asRecord(value);
      if (record) {
        const compact = Object.fromEntries(["current", "baseline", "delta"].flatMap(key => {
          const item = scalar(record[key]);
          return item === null ? [] : [[key, item]];
        }));
        if (Object.keys(compact).length) metrics[name] = compact;
      } else {
        const item = scalar(value);
        if (item !== null) metrics[name] = item;
      }
    }
    return [{ sectionId, score: typeof section.score === "number" && Number.isFinite(section.score) ? section.score : null, metrics }];
  });
}

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function isRecord(value: unknown): value is RecordValue { return asRecord(value) !== null; }

function scalar(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) return value.slice(0, 128);
  return null;
}

function shortText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 180) : null;
}

function reasonText(reason: unknown, fallback: string): string {
  return shortText(reason) ?? fallback;
}
