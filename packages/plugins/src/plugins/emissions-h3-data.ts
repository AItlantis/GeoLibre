/**
 * Shared emissions/noise row contract for the H3 environment plugin.
 *
 * The Parquet reader owns extraction and scenario filtering; this module only
 * contains the small, pure domain helpers that are also used by compatibility
 * consumers.  Keep the formula inputs explicit because Aimsun exports can be
 * either aggregate (sid=0) or vehicle-class rows.
 */
export interface EmissionsNoise {
  laeqSrcDb: number;
}

export interface EmissionsRow {
  oid: number;
  eid: number;
  ent: number;
  noise: EmissionsNoise;
  co2: number | null;
  nox: number | null;
}

export { energyWeightedDb } from "./emissions-h3-aggregation";

/**
 * Compute the roadway-source noise indicator used by the first environment
 * renderer.  The final coefficients remain intentionally conservative until
 * the exported CO2/NOx/noise units are confirmed in the package contract.
 * Inputs not present in a given Aimsun table are accepted as zero.
 */
export function computeNoiseSource(
  flow: number,
  speedKmh: number | null,
  stops: number,
  _lengthM: number,
  _gradient: number,
  heavyFlow: number,
  _acceleration: number,
  _heavyPct: number,
): EmissionsNoise {
  const safeFlow = Math.max(0, Number(flow) || 0);
  const safeSpeed = Math.max(1, Number(speedKmh) || 1);
  const safeStops = Math.max(0, Number(stops) || 0);
  const safeHeavy = Math.max(0, Number(heavyFlow) || 0);
  const heavyShare = safeFlow > 0 ? Math.min(1, safeHeavy / safeFlow) : 0;

  // Flow and speed drive the source level; stops and HGV share are explicit
  // additive penalties.  The lower bound keeps empty/unknown rows visibly
  // distinct from a valid zero-emission result.
  const level =
    35 +
    10 * Math.log10(Math.max(1, safeFlow)) +
    6 * Math.log10(1 + safeSpeed / 50) +
    Math.min(12, safeStops * 0.5) +
    heavyShare * 5;

  return { laeqSrcDb: Math.max(35, Math.min(120, level)) };
}
