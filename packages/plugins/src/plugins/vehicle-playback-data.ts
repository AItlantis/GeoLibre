import proj4, { type Converter } from "proj4";
import {
  resolveVehicleShapeKey,
  VEHICLE_SHAPES,
  type VehicleShapeKey,
} from "./vehicle-shape-catalog";
import { attachGeolibrePackage, getGeolibrePackage, capabilityAvailable } from "./geolibre-package-loader";
import { loadCachedHttpPackageManifests } from "./geolibre-package-cache";

/**
 * Data layer for the vehicle-playback plugin: manifest parsing, gzipped chunk
 * streaming, sparse-event replay with checkpoints, and sub-tick interpolation.
 *
 * Ported from Testudo's viewer animation modules (`vehicle-chunk-loader.js`,
 * `vehicle-event-store.js`, `vehicle-snapshot.js`, `vehicle-coordinates.js`),
 * rewritten as typed modules with GeoLibre's conventions. The three pieces that
 * make continuous multi-vehicle playback work are kept intact:
 *
 * - **Coverage window** — only the chunk under the playhead (plus the next one
 *   while playing) stays resident, so a 2000-tick package does not decompress
 *   into memory all at once.
 * - **Checkpoints** — replaying spawn/update/despawn events forward is cheap,
 *   but seeking backward would otherwise replay from tick 0. Periodic snapshots
 *   of the resolved vehicle table let a backward seek restart from the nearest
 *   earlier checkpoint instead.
 * - **Sub-tick interpolation** — the underlying data is a sparse event stream at
 *   whole ticks (often 0.8 s apart). {@link VehiclePlaybackData.sampleAt}
 *   reconstructs the discrete state either side of a fractional tick and lerps
 *   between them, which is what turns a slideshow into continuous motion.
 */

// ---------------------------------------------------------------------------
// Tunables (ported verbatim from Testudo, which tuned them against real packages).
// ---------------------------------------------------------------------------

/** How far ahead of the playhead coverage is requested while playing. */
const PRELOAD_LOOKAHEAD_TICKS = 120;
/** Chunks fetched in parallel by the background full-load pass. */
const CHUNK_CONCURRENCY = 3;
/** Resident decompressed chunks tolerated during background loading. */
const MAX_RESIDENT_BACKGROUND_CHUNKS = 4;
/** Attempts per chunk before it is marked permanently failed. */
const MAX_CHUNK_RETRIES = 3;
/**
 * A minimal async semaphore. `acquire()` resolves once a slot is free and
 * returns a `release()` callback that must be called exactly once to give the
 * slot back. Used to cap chunk fetch concurrency across independent call
 * sites (see {@link VehiclePlaybackData.chunkFetchLimiter}).
 */
class ConcurrencyLimiter {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        this.available -= 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.available += 1;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.available > 0) tryAcquire();
      else this.waiters.push(tryAcquire);
    });
  }
}

/** Base backoff between chunk retries, multiplied by the attempt number. */
const RETRY_BASE_DELAY_MS = 700;
/** Replay state is snapshotted at least this often, in ticks. */
const CHECKPOINT_INTERVAL_TICKS = 240;
/** Checkpoints retained per chunk; older ones are dropped. */
const MAX_CHECKPOINTS_PER_CHUNK = 2;
/** Seconds a newly spawned vehicle takes to fade in. */
const FADE_IN_DURATION_S = 2.0;
/** Seconds a despawned vehicle takes to fade out. */
const FADE_OUT_DURATION_S = 1.5;
/** Below this opacity a vehicle is dropped from the frame entirely. */
const MIN_VISIBLE_OPACITY = 0.02;
/** Front/rear separation under which heading is treated as unknown (meters). */
const STOPPED_VEHICLE_THRESHOLD_M = 0.5;

const DEFAULT_VEHICLE_LENGTH_M = 4.5;
/**
 * Last-resort width when neither the simulator nor the shape catalog can say.
 * In practice unreachable — `resolveVehicleShapeKey` always returns a key — but
 * kept so the width expression has a finite terminal fallback.
 */
const DEFAULT_VEHICLE_WIDTH_M = 2.0;

// ---------------------------------------------------------------------------
// Articulation (multi-segment bodies, currently trams only).
// ---------------------------------------------------------------------------

/** Shape keys rendered as several lagging body segments instead of one box. */
const ARTICULATED_SHAPE_KEYS: ReadonlySet<VehicleShapeKey> = new Set<VehicleShapeKey>(["tram"]);

/** Nominal length of one articulated body segment, in meters. */
const ARTICULATED_SEGMENT_LENGTH_M = 8;
/** Never fewer than this many segments for an articulated vehicle. */
const MIN_ARTICULATED_SEGMENTS = 2;
/** Guard so a nonsense `Length` cannot explode the polygon count. */
const MAX_ARTICULATED_SEGMENTS = 12;
/**
 * Path history retained per articulated vehicle, in meters of travel. One
 * segment-length of slack past the longest body we will ever draw, so the
 * rearmost segment can always find a pivot without running off the buffer.
 */
const ARTICULATION_HISTORY_METERS =
  (MAX_ARTICULATED_SEGMENTS + 1) * ARTICULATED_SEGMENT_LENGTH_M;
/** Hard cap on retained entries, for a vehicle that barely moves for a long time. */
const ARTICULATION_HISTORY_MAX_ENTRIES = 256;
/** History samples closer together than this add no shape information. */
const ARTICULATION_HISTORY_MIN_STEP_M = 0.5;
/**
 * Longitudinal clearance left between two consecutive body segments, in meters.
 *
 * This is a FIXED absolute clearance, not a fraction of the segment length, and
 * it is deliberately small. It used to be a 0.92 length factor, i.e. 8% of a
 * segment — 0.6 m on a 30 m tram — which is why a tram read correctly through a
 * curve but showed a visible seam on a straight run.
 *
 * Through a curve consecutive segments pivot relative to each other, so the
 * inner side of every joint closes up (measured: 0.60 m nominal collapses to
 * 0.19 m at a 20 m turn radius and 0.01 m at 12 m) while the outer side opens —
 * the joint reads as a hinge and the clearance is masked. On a dead-straight
 * run every segment is colinear, so the very same clearance stays a uniform
 * full-width transverse slot on BOTH sides at once, which is what reads as a
 * gap rather than a joint. Sizing the clearance as a fraction of length made
 * that worst case scale up with the vehicle.
 *
 * 0.12 m is under the ~1 px a joint occupies at the zooms trams are watched at,
 * so segments still articulate visibly through a corner without parting on a
 * straight.
 */
const ARTICULATED_SEGMENT_GAP_M = 0.12;

// ---------------------------------------------------------------------------
// Numeric guards (Testudo's `safeNumber` / `safeInt` / `safePositionComponent`).
// ---------------------------------------------------------------------------

function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeInt(value: unknown, fallback = Number.NaN): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/** `null`/`undefined` mean "absent", not zero — `Number(null)` is a finite 0. */
function positionComponent(value: unknown): number {
  if (value === null || value === undefined) return Number.NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeHeading(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  return ((value % 360) + 360) % 360;
}

/** Interpolate a bearing the short way around the circle. */
function interpolateHeading(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return normalizeHeading(a + delta * t);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Manifest.
// ---------------------------------------------------------------------------

/** One entry of the manifest's chunk catalog, normalized to tick bounds. */
export interface VehicleChunkEntry {
  id: string;
  index: number;
  /** Chunk path, resolved to an absolute URL against the manifest. */
  url: string;
  startTick: number;
  endTick: number;
}

/** The parts of a VWE `manifest.json` this plugin needs. */
export interface VehicleManifest {
  /** Simulation step in seconds; drives ticks-per-second during playback. */
  dt: number;
  /** Highest addressable tick (`n_ticks - 1`). */
  maxTick: number;
  /** Projected CRS the chunk coordinates are in, e.g. 32630. */
  sourceEpsg: number;
  /** Target CRS, normally 4326. */
  destEpsg: number;
  /** Package extent in WGS84, when the manifest declares one. */
  bounds: [number, number, number, number] | null;
  chunks: VehicleChunkEntry[];
  /** Network geometry files declared by the manifest, all resolved to URLs. */
  geometry: VehicleGeometrySources;
  /** Index into the manifest's scenario catalog this manifest was parsed for. */
  scenarioIndex: number;
}

/**
 * Network geometry declared by a manifest's `geometry` block, with each path
 * resolved to an absolute URL (or left as the raw relative path when the
 * package is read from a local directory handle, which has no base URL).
 *
 * The VWE writer emits `sections`, `lanes` and `turns`. A separate
 * nodes/junctions file is NOT part of the format; `nodes` is carried here only
 * so a package that grows one later is picked up without a parser change, and
 * is null for every package this plugin has seen.
 */
export interface VehicleGeometrySources {
  sections: string | null;
  lanes: string | null;
  turns: string | null;
  nodes: string | null;
}

/** One selectable scenario of a multi-scenario manifest. */
export interface VehicleManifestScenario {
  /** Index into `manifest.animations[]`; 0 for a flat manifest. */
  index: number;
  /** Stable id, from the animation's own `id`/`name`, else `scenario_<n>`. */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** Ticks in this scenario, when its metadata declares them. */
  nTicks: number;
  /** Simulation step in seconds. */
  dt: number;
  /** Explicit package-relative per-animation manifest, when available. */
  manifestPath?: string;
  /** Authoritative scenario id associated with this animation, when declared. */
  scid?: number | string;
  /** Authoritative replication id associated with this animation, when declared. */
  did?: number | string;
  /** Root `animations[]` index used by legacy/named-FZP manifests. */
  rootAnimationIndex?: number;
}

export interface VehicleManifestScenarioOptions {
  /** Include one selectable entry per animation/FZP under a GeoLibre scenario. */
  includeAnimationVariants?: boolean;
}

function sameIdentifier(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

function animationMetadata(animation: Record<string, unknown>, rootMetadata: Record<string, unknown>): Record<string, unknown> {
  return ((animation.metadata ?? rootMetadata) ?? {}) as Record<string, unknown>;
}

function animationPath(animation: Record<string, unknown>): string | undefined {
  const path = animation.path;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

function animationId(animation: Record<string, unknown>, index: number): string {
  const rawId = animation.id ?? animation.name ?? animation.path;
  return typeof rawId === "string" && rawId.trim() ? rawId.trim() : `scenario_${index}`;
}

function animationMatchesScenario(
  animation: Record<string, unknown>,
  scenario: { scid?: number | string; replications?: Array<{ did?: number | string }> },
): boolean {
  if (sameIdentifier(animation.scid, scenario.scid)) return true;
  return Array.isArray(scenario.replications)
    && scenario.replications.some((replication) => sameIdentifier(animation.did, replication.did));
}

/**
 * Every scenario a manifest offers, without committing to one.
 *
 * A flat `manifest.chunks` package yields exactly one entry, so callers treat
 * both layouts identically and only surface a picker when `length > 1`.
 */
export function listVehicleManifestScenarios(
  raw: unknown,
  options: VehicleManifestScenarioOptions = {},
): VehicleManifestScenario[] {
  const root = (raw ?? {}) as Record<string, unknown>;
  const pkg = getGeolibrePackage(raw);
  const animations = Array.isArray(root.animations)
    ? (root.animations as Record<string, unknown>[])
    : [];
  const rootMetadata = (root.metadata ?? {}) as Record<string, unknown>;

  if (pkg?.scenarios.length && !options.includeAnimationVariants) {
    return pkg.scenarios.map((s, index) => ({
      index,
      id: String(s.scid),
      label: s.name ?? `Scenario ${s.scid}`,
      nTicks: 1,
      dt: 1,
      scid: s.scid,
      did: s.replications[0]?.did,
    }));
  }

  if (pkg?.scenarios.length && options.includeAnimationVariants) {
    const variants: VehicleManifestScenario[] = [];
    for (const scenario of pkg.scenarios) {
      const declaredAnimations = scenario.animations?.filter((animation) => Boolean(animation.manifestPath));
      if (declaredAnimations?.length) {
        for (const declared of declaredAnimations) {
          const rootIndex = animations.findIndex((animation) => animationPath(animation) === declared.manifestPath);
          const rootAnimation = rootIndex >= 0 ? animations[rootIndex] : undefined;
          const metadata = rootAnimation ? animationMetadata(rootAnimation, rootMetadata) : rootMetadata;
          const id = declared.name ?? (rootAnimation ? animationId(rootAnimation, variants.length) : declared.manifestPath!);
          variants.push({
            index: variants.length,
            id,
            label: scenarioLabel(rootAnimation ?? { name: id }, metadata, variants.length),
            nTicks: Math.max(1, safeInt(metadata.n_ticks, 1)),
            dt: Math.max(0.0001, safeNumber(metadata.dt, 1)),
            manifestPath: declared.manifestPath,
            scid: declared.scid ?? scenario.scid,
            did: declared.did ?? scenario.replications[0]?.did,
            rootAnimationIndex: rootIndex >= 0 ? rootIndex : undefined,
          });
        }
        continue;
      }

      // Older packages may keep named FZP paths only in the root manifest.
      // Use explicit scid/did matches when present; with one package scenario,
      // the declared root entries are still safe selectable animation variants
      // even when the producer could not map their names to an id.
      const matched = animations.filter((animation) => animationPath(animation)
        && (animationMatchesScenario(animation, scenario) || pkg.scenarios.length === 1));
      if (matched.length) {
        for (const animation of matched) {
          const rootIndex = animations.indexOf(animation);
          const metadata = animationMetadata(animation, rootMetadata);
          variants.push({
            index: variants.length,
            id: animationId(animation, variants.length),
            label: scenarioLabel(animation, metadata, variants.length),
            nTicks: Math.max(1, safeInt(metadata.n_ticks, 1)),
            dt: Math.max(0.0001, safeNumber(metadata.dt, 1)),
            manifestPath: animationPath(animation),
            scid: typeof animation.scid === "number" || typeof animation.scid === "string" ? animation.scid : scenario.scid,
            did: typeof animation.did === "number" || typeof animation.did === "string" ? animation.did : undefined,
            rootAnimationIndex: rootIndex,
          });
        }
      } else {
        variants.push({
          index: variants.length,
          id: String(scenario.scid),
          label: scenario.name ?? `Scenario ${scenario.scid}`,
          nTicks: 1,
          dt: 1,
          scid: scenario.scid,
          did: scenario.replications[0]?.did,
        });
      }
    }
    if (variants.length) return variants;
  }

  if (Array.isArray(root.chunks) || animations.length === 0) {
    return [
      {
        index: 0,
        id: typeof root.id === "string" && root.id ? root.id : "scenario_0",
        label: scenarioLabel(root, rootMetadata, 0),
        nTicks: Math.max(1, safeInt(rootMetadata.n_ticks, 1)),
        dt: Math.max(0.0001, safeNumber(rootMetadata.dt, 1)),
      },
    ];
  }

  return animations.map((animation, index) => {
    const metadata = animationMetadata(animation, rootMetadata);
    return {
      index,
      id: animationId(animation, index),
      label: scenarioLabel(animation, metadata, index),
      nTicks: Math.max(1, safeInt(metadata.n_ticks, 1)),
      dt: Math.max(0.0001, safeNumber(metadata.dt, 1)),
      scid: typeof animation.scid === "number" || typeof animation.scid === "string" ? animation.scid : undefined,
      did: typeof animation.did === "number" || typeof animation.did === "string" ? animation.did : undefined,
      manifestPath: animationPath(animation),
      rootAnimationIndex: index,
    };
  });
}

/** Best available human label for a scenario, falling back to its position. */
function scenarioLabel(
  scope: Record<string, unknown>,
  metadata: Record<string, unknown>,
  index: number,
): string {
  for (const candidate of [
    scope.name,
    scope.label,
    scope.title,
    scope.id,
    metadata.name,
    metadata.experiment,
    metadata.scenario,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return `Scenario ${index + 1}`;
}

/**
 * Resolve a manifest's `geometry` block to absolute URLs.
 *
 * `base` is the manifest URL for an HTTP package. A local directory handle has
 * no URL to resolve against, so passing `null` keeps the declared relative
 * paths verbatim for the directory reader to look up.
 */
function parseGeometrySources(raw: unknown, base: string | null): VehicleGeometrySources {
  const block = (raw ?? {}) as Record<string, unknown>;
  const resolve = (value: unknown): string | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const path = value.trim();
    if (!base) return path;
    try {
      return new URL(path, base).toString();
    } catch {
      return null;
    }
  };
  return {
    sections: resolve(block.sections),
    lanes: resolve(block.lanes),
    turns: resolve(block.turns),
    // Not emitted by the current VWE writer; accepted under either spelling so
    // a future package carrying one needs no parser change.
    nodes: resolve(block.nodes ?? block.junctions),
  };
}

interface RawChunkEntry {
  path?: unknown;
  index?: unknown;
  start_tick?: unknown;
  end_tick?: unknown;
  start_s?: unknown;
  end_s?: unknown;
}

/**
 * Parse a VWE manifest into the catalog the loader consumes.
 *
 * Supports both the flat `manifest.chunks` layout and the multi-scenario
 * `manifest.animations[].chunks` layout. For the latter, `scenarioIndex` picks
 * which animation to parse — it defaults to 0, so every package that worked
 * before this parameter existed keeps parsing identically. Chunk `path`s are
 * resolved against `manifestUrl`, so a package served from any directory works
 * without a separate base setting.
 *
 * @param raw - The parsed manifest JSON
 * @param manifestUrl - Absolute URL the manifest was fetched from, or null when
 *   the package is read from a local directory (paths are then kept relative)
 * @param scenarioIndex - Which `animations[]` entry to parse; ignored by flat
 *   manifests and clamped into range
 * @returns The normalized manifest
 * @throws {Error} When the manifest declares no usable chunks
 */
export function parseVehicleManifest(
  raw: unknown,
  manifestUrl: string | null,
  scenarioIndex = 0,
  chunkSource?: unknown,
): VehicleManifest {
  const root = (raw ?? {}) as Record<string, unknown>;
  const animations = Array.isArray(root.animations)
    ? (root.animations as Record<string, unknown>[])
    : [];
  const flat = Array.isArray(root.chunks) || animations.length === 0;
  // Multi-scenario packages nest metadata/chunks under the chosen animation.
  // Index 0 reproduces the previous hardcoded behavior exactly.
  const selectedIndex = flat
    ? 0
    : Math.min(Math.max(0, Math.trunc(scenarioIndex) || 0), animations.length - 1);
  const scope = flat ? root : animations[selectedIndex];
  const metadata = { ...((root.metadata ?? {}) as Record<string, unknown>), ...((scope.metadata ?? {}) as Record<string, unknown>) };

  const dt = Math.max(0.0001, safeNumber(metadata.dt, 1));
  const nTicks = Math.max(1, safeInt(metadata.n_ticks, 1));
  const rawBounds = (metadata.bounds ?? null) as Record<string, unknown> | null;
  const bounds: [number, number, number, number] | null = rawBounds
    ? [
        safeNumber(rawBounds.min_lon, Number.NaN),
        safeNumber(rawBounds.min_lat, Number.NaN),
        safeNumber(rawBounds.max_lon, Number.NaN),
        safeNumber(rawBounds.max_lat, Number.NaN),
      ]
    : null;

  const chunkRoot = (chunkSource ?? {}) as Record<string, unknown>;
  // The per-scenario catalog is chunk-only; metadata and geometry remain
  // authoritative in the original package manifest.
  const rawChunks = Array.isArray(chunkRoot.chunks)
    ? (chunkRoot.chunks as RawChunkEntry[])
    : (Array.isArray(scope.chunks) ? (scope.chunks as RawChunkEntry[]) : []);
  const sorted = rawChunks.slice().sort((a, b) => safeInt(a?.index, 0) - safeInt(b?.index, 0));

  const chunks: VehicleChunkEntry[] = [];
  for (const entry of sorted) {
    const index = safeInt(entry?.index, -1);
    const path = typeof entry?.path === "string" ? entry.path : "";
    if (index < 0 || !path) continue;
    // Prefer explicit tick bounds; fall back to seconds/dt like Testudo does for
    // older packages that only carry `start_s`/`end_s`.
    const startS = safeNumber(entry?.start_s, 0);
    const endS = safeNumber(entry?.end_s, startS);
    const explicitStart = safeInt(entry?.start_tick, Number.NaN);
    const explicitEnd = safeInt(entry?.end_tick, Number.NaN);
    const startTick = Number.isFinite(explicitStart)
      ? Math.max(0, explicitStart)
      : Math.max(0, Math.floor(startS / dt));
    const endTick = Number.isFinite(explicitEnd)
      ? Math.max(startTick, explicitEnd - 1)
      : Math.max(startTick, Math.ceil(endS / dt) - 1);
    chunks.push({
      id: `chunk_${index}`,
      index,
      // With no manifest URL (local-directory load) the relative path is kept
      // verbatim; the directory reader resolves it against the folder handle.
      url: manifestUrl ? new URL(path, manifestUrl).toString() : path,
      startTick,
      endTick,
    });
  }

  if (chunks.length === 0) {
    throw new Error("The manifest declares no trajectory chunks.");
  }

  return {
    dt,
    maxTick: Math.max(0, nTicks - 1),
    sourceEpsg: safeInt(metadata.source_epsg, 0),
    destEpsg: safeInt(metadata.dest_epsg, 4326) || 4326,
    bounds: bounds && bounds.every(Number.isFinite) ? bounds : null,
    chunks,
    // Geometry can be declared per-scenario or once at the package root.
    geometry: parseGeometrySources(scope.geometry ?? root.geometry, manifestUrl),
    scenarioIndex: selectedIndex,
  };
}

/** Fetch the v2.1 per-scenario animation manifest, when declared by the package. */
export async function loadScenarioAnimationManifest(
  raw: unknown,
  source: VehiclePackageSource,
  scenarioIndex: number,
  selectedScenario?: VehicleManifestScenario,
): Promise<unknown> {
  const root = (raw ?? {}) as Record<string, unknown>;
  if (Array.isArray(root.chunks) && root.chunks.length > 0) return raw;
  const pkg = getGeolibrePackage(raw);
  const scenario = selectedScenario?.scid !== undefined
    ? pkg?.scenarios.find((candidate) => sameIdentifier(candidate.scid, selectedScenario.scid)) ?? pkg?.scenarios[scenarioIndex]
    : selectedScenario?.did !== undefined
      ? pkg?.scenarios.find((candidate) => candidate.replications.some((replication) => sameIdentifier(replication.did, selectedScenario.did))) ?? pkg?.scenarios[scenarioIndex]
      : pkg?.scenarios[scenarioIndex];
  const rootAnimations = Array.isArray(root.animations)
    ? root.animations as Record<string, unknown>[]
    : [];
  const declaredPaths: string[] = [];
  if (selectedScenario?.manifestPath) declaredPaths.push(selectedScenario.manifestPath);
  if (selectedScenario?.rootAnimationIndex !== undefined) {
    const indexedAnimation = rootAnimations[selectedScenario.rootAnimationIndex];
    const path = indexedAnimation ? animationPath(indexedAnimation) : undefined;
    if (path) declaredPaths.push(path);
  }
  if (selectedScenario?.id) {
    const named = rootAnimations.find((animation) => animationId(animation, -1) === selectedScenario.id);
    const path = named ? animationPath(named) : undefined;
    if (path) declaredPaths.push(path);
  }
  if (selectedScenario?.scid !== undefined || selectedScenario?.did !== undefined) {
    const authoritative = rootAnimations.find((animation) =>
      sameIdentifier(animation.scid, selectedScenario.scid)
      || sameIdentifier(animation.did, selectedScenario.did));
    const path = authoritative ? animationPath(authoritative) : undefined;
    if (path) declaredPaths.push(path);
  }
  const indexedAnimation = rootAnimations[scenarioIndex];
  const indexedPath = indexedAnimation ? animationPath(indexedAnimation) : undefined;
  if (indexedPath) declaredPaths.push(indexedPath);
  for (const animation of scenario?.animations ?? []) {
    if (animation.manifestPath) declaredPaths.push(animation.manifestPath);
  }
  if (selectedScenario?.did !== undefined) declaredPaths.push(`chunks/${selectedScenario.did}/animation.json`);
  if (selectedScenario?.scid !== undefined) declaredPaths.push(`chunks/${selectedScenario.scid}/animation.json`);
  if (scenario?.replications[0]?.did !== undefined) declaredPaths.push(`chunks/${scenario.replications[0].did}/animation.json`);
  if (scenario) declaredPaths.push(`chunks/${scenario.scid}/animation.json`);

  // Prefer an explicit manifest pointer from the package envelope or the
  // legacy root animation entry.  The SCID-derived path is only a fallback:
  // valid packages may use named FZP directories when the producer cannot
  // authoritatively map every animation to a scenario.
  for (const path of [...new Set(declaredPaths)]) {
    try { return JSON.parse(new TextDecoder().decode(await source.read(path))); } catch { /* try the next declared/fallback path */ }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Package sources: the same package can be served over HTTP or read from a
// local folder the user picked, so everything below reads bytes through this
// one interface instead of calling `fetch` directly.
// ---------------------------------------------------------------------------

/**
 * Where a package's bytes come from.
 *
 * `loadVehiclePlayback` builds the HTTP implementation; `openLocalVehiclePackage`
 * builds one backed by a `FileSystemDirectoryHandle`. The chunk streamer and
 * the geometry loader only ever see this interface, so neither knows or cares
 * which it is talking to.
 */
export interface VehiclePackageSource {
  /**
   * Base URL for resolving relative paths, or null for a local folder (whose
   * paths stay relative and are looked up against the directory handle).
   */
  readonly baseUrl: string | null;
  /** Read one package-relative path (or absolute URL) as raw bytes. */
  read(path: string): Promise<ArrayBuffer>;
}

function packageAssetPath(source: VehiclePackageSource, path: string): string {
  if (!source.baseUrl) return path;
  try {
    return new URL(path, source.baseUrl).toString();
  } catch {
    return path;
  }
}

function packageAssetError(
  source: VehiclePackageSource,
  path: string,
  kind: "read" | "empty" | "json",
  error?: unknown,
): Error {
  const asset = packageAssetPath(source, path);
  const detail = error instanceof Error ? error.message : error === undefined ? "" : String(error);
  const suffix = detail ? `: ${detail}` : "";
  const description = kind === "empty"
    ? "the file is empty"
    : kind === "json"
      ? "the file is not valid JSON"
      : "the asset could not be read";
  return new Error(`Vehicle playback asset ${asset}: ${description}${suffix}`);
}

/** Read a package served over HTTP, resolving paths against the manifest URL. */
export function createHttpPackageSource(manifestUrl: string): VehiclePackageSource {
  return {
    baseUrl: manifestUrl,
    async read(path: string): Promise<ArrayBuffer> {
      const url = new URL(path, manifestUrl).toString();
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          // Chunk files are immutable within a manifest, but dev servers and
          // object stores can briefly close a large response mid-transfer.
          const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}playback_retry=${attempt}`, { cache: "no-store" });
          if (!response.ok) {
            const viteFsBlock = response.status === 403 && /\/@fs\//i.test(url);
            throw new Error(
              viteFsBlock
                ? `HTTP 403 from the Vite dev server for an external local package path. Use GeoLibre's "Load folder" action for ${url}.`
                : `HTTP ${response.status} ${response.statusText || ""}`.trim(),
            );
          }
          // Await body consumption inside the retry boundary. Returning the
          // promise lets a truncated/failed body escape the catch and makes
          // chunk retries ineffective in Chromium.
          return await response.arrayBuffer();
        } catch (error) {
          lastError = error;
          if (attempt < 3) await delay(250 * attempt);
        }
      }
      throw new Error(`Failed to fetch playback asset ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    },
  };
}

/**
 * Minimal structural types for the File System Access API.
 *
 * Declared locally rather than pulled from `lib.dom` so the package still
 * builds against TypeScript lib versions that predate them, and so nothing
 * here implies the API is always present — it is Chromium-only and every call
 * site feature-detects first.
 */
export interface VehicleDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
  getDirectoryHandle(name: string): Promise<VehicleDirectoryHandle>;
}

/**
 * Whether a read failure means "this file does not exist" rather than a
 * transient error worth retrying.
 *
 * Covers an HTTP 404 from {@link createHttpPackageSource} and the
 * `NotFoundError` a `FileSystemDirectoryHandle` throws for a missing entry.
 */
function isMissingResourceError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "NotFoundError") return true;
    if (error.message.includes(": 404")) return true;
  }
  return false;
}

/** True when this browser can show a directory picker (Chromium only). */
export function supportsLocalPackageFolders(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}

/**
 * Read a package out of a folder the user picked.
 *
 * Package-relative paths like `chunks/chunk_0.json.gz` are split on `/` and
 * walked down the directory handle, which is the only way to reach a
 * subdirectory's file through the File System Access API. A path that escaped
 * the package root (`..`) or arrived absolute is rejected rather than followed.
 */
export function createDirectoryPackageSource(
  root: VehicleDirectoryHandle,
): VehiclePackageSource {
  return {
    baseUrl: null,
    async read(path: string): Promise<ArrayBuffer> {
      const segments = path
        .split(/[\\/]+/)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && segment !== ".");
      // File System Access only accepts a single valid path component here.
      // Reject malformed manifest paths before calling getDirectoryHandle so
      // callers receive a useful package-path error rather than Chromium's
      // opaque "Name is not allowed" DOMException.
      if (
        segments.length === 0 ||
        segments.includes("..") ||
        segments.some((segment) => /[\\/:\u0000-\u001f]/.test(segment))
      ) {
        throw new Error(`Refusing to read "${path}" from outside the package folder.`);
      }
      let directory = root;
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment);
      }
      const handle = await directory.getFileHandle(segments[segments.length - 1]);
      const file = await handle.getFile();
      return file.arrayBuffer();
    },
  };
}

// ---------------------------------------------------------------------------
// Projection: chunk coordinates are in a projected CRS and must reach WGS84.
// ---------------------------------------------------------------------------

/** proj4 definition for a WGS84 UTM zone EPSG code, or null when not a UTM code. */
function utmProjDef(epsg: number): string | null {
  const isNorth = epsg >= 32601 && epsg <= 32660;
  const isSouth = epsg >= 32701 && epsg <= 32760;
  if (!isNorth && !isSouth) return null;
  const zone = isNorth ? epsg - 32600 : epsg - 32700;
  return `+proj=utm +zone=${zone}${isSouth ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

/**
 * Build the source-CRS to WGS84 converter for a manifest.
 *
 * @param manifest - The parsed manifest
 * @returns A proj4 converter, or null when the coordinates are already WGS84
 */
function createConverter(manifest: VehicleManifest): Converter | null {
  const { sourceEpsg, destEpsg } = manifest;
  if (sourceEpsg === destEpsg) return null;
  if (!sourceEpsg) {
    // Missing/unparseable source_epsg is indistinguishable from "already
    // WGS84" once coerced to 0, but silently means the raw (likely projected,
    // e.g. UTM eastings/northings) coordinates will be plotted as lon/lat —
    // vehicles land far off the map with no visible error. Warn like the
    // non-UTM case below rather than passing through unnoticed.
    console.warn(
      "[GeoLibre] vehicle-playback: manifest has no source_epsg; coordinates are assumed to already be WGS84 and will render off-map if they are not.",
    );
    return null;
  }
  const def = utmProjDef(sourceEpsg);
  if (!def) {
    // A non-UTM projected CRS would need its own proj4 definition, which the
    // manifest does not carry; fall back to passing coordinates through so the
    // failure is a visibly wrong position rather than a thrown plugin.
    console.warn(
      `[GeoLibre] vehicle-playback: EPSG:${sourceEpsg} is not a WGS84 UTM zone; coordinates are not reprojected.`,
    );
    return null;
  }
  return proj4(def, `EPSG:${destEpsg}`);
}

// ---------------------------------------------------------------------------
// Events.
// ---------------------------------------------------------------------------

type EventKind = "spawn" | "state" | "update" | "despawn";

/** Sort order within a tick, so a spawn always precedes its own update. */
const EVENT_ORDER: Record<EventKind, number> = {
  spawn: 0,
  state: 1,
  update: 2,
  despawn: 3,
};

/** Position in the source CRS. */
interface SourcePosition {
  x: number;
  y: number;
  z: number;
}

/** The numeric/string fields carried by a spawn state or update delta. */
interface VehicleFields {
  WorldX?: number;
  WorldY?: number;
  WorldZ?: number;
  Length?: number;
  Width?: number;
  Type?: number;
  v?: number;
  speed?: number;
  speed_kmh?: number;
  heading?: number;
  type_name?: string;
  front_position?: SourcePosition;
  rear_position?: SourcePosition;
}

interface NormalizedEvent {
  event: EventKind;
  id: number;
  order: number;
  fields: VehicleFields;
}

const NUMERIC_FIELDS = [
  "WorldX",
  "WorldY",
  "WorldZ",
  "Length",
  "Width",
  "Type",
  "v",
  "speed",
  "speed_kmh",
  "heading",
] as const;

/** Keep only the fields the renderer reads, coerced to finite numbers. */
function compactFields(payload: Record<string, unknown>): VehicleFields {
  const out: VehicleFields = {};
  for (const key of NUMERIC_FIELDS) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = safeNumber(payload[key], Number.NaN);
    if (!Number.isFinite(value)) continue;
    if (key === "Type") out.Type = Math.trunc(value);
    else out[key] = value;
  }
  const typeName = payload.type_name ?? payload.VehTypeName;
  if (typeof typeName === "string" && typeName.trim()) out.type_name = typeName.trim();
  for (const key of ["front_position", "rear_position"] as const) {
    const position = payload[key];
    if (!position || typeof position !== "object") continue;
    const p = position as Record<string, unknown>;
    out[key] = {
      x: positionComponent(p.x),
      y: positionComponent(p.y),
      z: positionComponent(p.z),
    };
  }
  return out;
}

function normalizeEvent(raw: unknown): NormalizedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const event = String(record.event ?? "").toLowerCase() as EventKind;
  if (!(event in EVENT_ORDER)) return null;
  const id = safeInt(record.id ?? record.vehicleId ?? record.VehNr, Number.NaN);
  if (!Number.isFinite(id)) return null;

  if (event === "spawn" || event === "state") {
    const state = record.state;
    if (!state || typeof state !== "object") return null;
    return { event, id, order: EVENT_ORDER[event], fields: compactFields(state as never) };
  }
  if (event === "update") {
    const deltaPayload = record.delta;
    if (!deltaPayload || typeof deltaPayload !== "object") return null;
    return { event, id, order: EVENT_ORDER[event], fields: compactFields(deltaPayload as never) };
  }
  return { event, id, order: EVENT_ORDER.despawn, fields: {} };
}

/** Merge a delta into an accumulated field set (updates are partial). */
function mergeFields(target: VehicleFields, delta: VehicleFields): VehicleFields {
  return { ...target, ...delta };
}

// ---------------------------------------------------------------------------
// Chunk decoding.
// ---------------------------------------------------------------------------

/**
 * Gunzip a chunk body and parse it as JSON.
 *
 * Testudo uses pako; GeoLibre has no pako dependency, so this uses the platform
 * `DecompressionStream`, which every browser GeoLibre targets ships. A chunk
 * that is not actually gzipped (some packages serve them pre-inflated, or a
 * server transparently decompresses) is decoded as plain UTF-8 instead.
 *
 * @param buffer - The raw response body
 * @returns The parsed chunk JSON
 */
async function decodeChunkBody(buffer: ArrayBuffer, sourcePath = ""): Promise<unknown> {
  const bytes = new Uint8Array(buffer);
  const gzipped = (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    || /(?:\.json)?\.gz(?:$|[?#])/i.test(sourcePath);
  let text: string;
  if (gzipped && typeof DecompressionStream !== "undefined") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } catch (error) {
      // Some static servers transparently decompress .gz responses.
      if (!(bytes.length === 0 || bytes[0] === 0x1f && bytes[1] === 0x8b)) {
        text = new TextDecoder("utf-8").decode(bytes);
      } else {
        throw error;
      }
    }
  } else {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  // Empty chunk files are valid for sparse/partitioned exports: they carry no
  // events but should not turn an otherwise usable playback into a parse
  // failure (JSON.parse("") throws "Unexpected end of JSON input").
  if (text.trim() === "") return { events: {} };
  try {
    return JSON.parse(text);
  } catch (error) {
    // Python writers can emit bare NaN/Infinity, which JSON.parse rejects.
    if (!text.includes("NaN") && !text.includes("Infinity")) throw error;
    return JSON.parse(text.replace(/\b(?:-Infinity|Infinity|NaN)\b/g, "null"));
  }
}

// ---------------------------------------------------------------------------
// Replay state.
// ---------------------------------------------------------------------------

/** A vehicle's accumulated state at the currently resolved tick. */
interface VehicleRuntime {
  id: number;
  fields: VehicleFields;
  spawnTick: number;
  lastActiveTick: number;
  despawnTick: number | null;
  /** Last heading that could be derived from geometry, reused while stopped. */
  lastKnownHeading: number | null;
  /** Identity fields latched at spawn, never overwritten by an update. */
  typeName: string | null;
  lengthM: number | null;
  widthM: number | null;
}

function cloneRuntime(src: VehicleRuntime): VehicleRuntime {
  return { ...src, fields: { ...src.fields } };
}

/** One vehicle materialized for a single frame, in map coordinates. */
export interface VehicleSample {
  id: number;
  /** WGS84 longitude of the vehicle center. */
  lon: number;
  /** WGS84 latitude of the vehicle center. */
  lat: number;
  /** Elevation in meters, when the package carries one. */
  z: number;
  /** Bearing in degrees clockwise from north. */
  heading: number;
  /** Fade factor in `[0, 1]` for spawn/despawn transitions. */
  opacity: number;
  /** Speed in km/h, or null when the package omits it. */
  speedKmh: number | null;
  typeName: string | null;
  lengthM: number;
  widthM: number;
  /** Extrusion height in meters, from the resolved shape catalog entry. */
  heightM: number;
  /** Catalog key this vehicle resolved to, so renderers need not re-resolve. */
  shapeKey: VehicleShapeKey;
}

/**
 * One retained point along an articulated vehicle's recent path.
 *
 * Only captured for vehicles whose resolved shape key is in
 * {@link ARTICULATED_SHAPE_KEYS} — ordinary cars and pedestrians carry no
 * history at all, so the common case costs nothing.
 */
export interface VehicleHistoryEntry {
  lon: number;
  lat: number;
  /** Bearing in degrees clockwise from north at this point. */
  heading: number;
  /**
   * Cumulative distance travelled, in meters, from the oldest retained entry.
   * Monotonically increasing; this — not tick index — is what segment pivots
   * are looked up by, so segment spacing stays physically constant whatever
   * the vehicle's speed.
   */
  distanceM: number;
  /** The whole tick this entry was captured at. */
  tick: number;
}

/** Chunk lifecycle as tracked by the loader. */
type ChunkStatus = "pending" | "loading" | "loaded" | "failed";

/**
 * Owns a loaded VWE package: its chunk catalog, the resident event stream, the
 * replay cursor with its checkpoints, and the interpolated per-frame sampler.
 *
 * Construct via {@link loadVehiclePlayback}, which fetches and parses the
 * manifest first.
 */
export class VehiclePlaybackData {
  readonly manifest: VehicleManifest;
  /** Where chunk and geometry bytes are read from (HTTP or a local folder). */
  readonly source: VehiclePackageSource;
  private readonly converter: Converter | null;

  /** Events keyed by tick, then by `id * 10 + order` so re-loads dedupe. */
  private readonly eventsByTick = new Map<number, Map<number, NormalizedEvent>>();
  /** Ticks contributed by each loaded chunk, so eviction can drop exactly them. */
  private readonly ticksByChunk = new Map<string, number[]>();
  private readonly statusById = new Map<string, ChunkStatus>();
  private readonly failureCountById = new Map<string, number>();
  private readonly inFlightById = new Map<string, Promise<boolean>>();

  /** Resolved vehicle table and the tick it corresponds to (-1 = unresolved). */
  private runtimeById = new Map<number, VehicleRuntime>();
  private resolvedTick = -1;
  /**
   * Recent path history, ONLY for vehicles that resolve to an articulated shape
   * key. Ordinary vehicles never get an entry here, so the overwhelmingly
   * common single-rectangle case pays nothing per tick.
   */
  private readonly historyById = new Map<number, VehicleHistoryEntry[]>();
  /** Replay snapshots keyed by tick, for cheap backward seeks. */
  private readonly checkpoints = new Map<number, Map<number, VehicleRuntime>>();
  private readonly checkpointTicksByChunk = new Map<string, number[]>();

  /** Interpolation cache: the two discrete frames bracketing the last sample. */
  private cacheBaseTick = -1;
  private cacheNextTick = -1;
  private cacheBase: VehicleSample[] = [];
  private cacheNext: VehicleSample[] = [];
  /** Bumped whenever loaded events change, invalidating the caches above. */
  private dataVersion = 0;
  private cacheDataVersion = -1;

  private backgroundLoading = false;
  private destroyed = false;
  /** Set while the playhead is advancing, which widens the coverage window. */
  private playing = false;
  private currentTick = 0;
  /**
   * De-duplicates overlapping {@link ensureCoverage} calls (Testudo's
   * `coveragePromise`/`coverageKey`): without this, a slow-resolving call for
   * an older window can finish after a newer call and evict the chunks the
   * newer call just loaded, thrashing fetch/decode/evict during fast
   * playback. Keyed by the resolved chunk-id set, not the raw tick, so two
   * calls that land in the same window share one in-flight load.
   */
  private coverageKey: string | null = null;
  private coveragePromise: Promise<void> | null = null;

  /**
   * Shared limiter so `ensureCoverage`'s on-demand loads and
   * `startBackgroundLoad`'s batching can never together exceed
   * {@link CHUNK_CONCURRENCY} in-flight chunk fetches. Both paths funnel
   * through {@link loadChunkWithRetry}, which acquires a slot here before
   * doing any work — without this, `ensureCoverage` (triggered by seeking or
   * scrubbing) can fire independently of an in-progress background batch,
   * pushing the true concurrency above the intended cap and overwhelming a
   * simple dev HTTP server (connection resets, truncated bodies).
   */
  private readonly chunkFetchLimiter = new ConcurrencyLimiter(CHUNK_CONCURRENCY);

  /**
   * @param manifest - The parsed manifest
   * @param source - Byte source for chunks and geometry. Defaults to an HTTP
   *   source built from the manifest's own base URL, so existing callers that
   *   pass only a manifest keep working unchanged.
   */
  constructor(manifest: VehicleManifest, source?: VehiclePackageSource) {
    this.manifest = manifest;
    this.source =
      source ??
      createHttpPackageSource(manifest.geometry.sections ?? manifest.chunks[0]?.url ?? "");
    this.converter = createConverter(manifest);
    for (const chunk of manifest.chunks) this.statusById.set(chunk.id, "pending");
  }

  /** Stop all loading and release the resident event stream. */
  destroy(): void {
    this.destroyed = true;
    this.eventsByTick.clear();
    this.ticksByChunk.clear();
    this.checkpoints.clear();
    this.checkpointTicksByChunk.clear();
    this.runtimeById.clear();
    this.historyById.clear();
    this.resolvedTick = -1;
  }

  /** Fraction of the catalog currently decompressed and resident, in `[0, 1]`. */
  getLoadedFraction(): number {
    let loaded = 0;
    for (const status of this.statusById.values()) {
      if (status === "loaded") loaded += 1;
    }
    return loaded / Math.max(1, this.manifest.chunks.length);
  }

  /** Tell the data layer where the playhead is, so coverage looks ahead. */
  setPlayhead(tick: number, playing: boolean): void {
    this.currentTick = tick;
    this.playing = playing;
  }

  /** The chunk covering `tick`, clamped to the catalog ends. */
  private findChunk(tick: number): VehicleChunkEntry | null {
    const chunks = this.manifest.chunks;
    if (chunks.length === 0) return null;
    const target = Math.max(0, Math.round(tick));
    for (const chunk of chunks) {
      if (target >= chunk.startTick && target <= chunk.endTick) return chunk;
    }
    return target < chunks[0].startTick ? chunks[0] : chunks[chunks.length - 1];
  }

  /**
   * Ensure the chunks covering the playhead are resident, evicting the rest.
   *
   * While playing, the window is the current chunk plus the one containing
   * `tick + PRELOAD_LOOKAHEAD_TICKS`, so crossing a boundary never stalls. While
   * paused (or seeking backward) only the target chunk is kept.
   *
   * @param tick - The tick that must be covered
   */
  async ensureCoverage(tick: number): Promise<void> {
    if (this.destroyed) return;
    const target = this.playing ? tick + PRELOAD_LOOKAHEAD_TICKS : tick;
    const ids = new Set<string>();
    const current = this.findChunk(tick);
    if (current) ids.add(current.id);
    const ahead = this.findChunk(target);
    if (ahead) ids.add(ahead.id);
    if (ids.size === 0) return;

    const key = Array.from(ids).sort().join(",");
    if (this.coverageKey === key && this.coveragePromise) return this.coveragePromise;

    this.coverageKey = key;
    const promise = (async () => {
      for (const id of ids) {
        await this.loadChunkWithRetry(id);
        if (this.destroyed) return;
      }
      // Only this call's own (still-current) window may evict — a newer call
      // that changed `coverageKey` while this one was in flight owns eviction
      // now, so this call must not undo the newer window it just loaded.
      if (this.coverageKey === key) this.evictOutside(ids);
    })();
    this.coveragePromise = promise;
    try {
      await promise;
    } finally {
      if (this.coveragePromise === promise) {
        this.coveragePromise = null;
        this.coverageKey = null;
      }
    }
  }

  /**
   * Fetch the whole catalog in the background, a few chunks at a time, keeping
   * only {@link MAX_RESIDENT_BACKGROUND_CHUNKS} chunks resident around the
   * playhead. Scrubbing far from the playhead re-fetches on demand.
   */
  startBackgroundLoad(): void {
    if (this.backgroundLoading || this.destroyed) return;
    this.backgroundLoading = true;
    void (async () => {
      try {
        const pending = this.manifest.chunks.filter((chunk) => {
          const status = this.statusById.get(chunk.id);
          return (
            status === "pending" ||
            (status === "failed" &&
              (this.failureCountById.get(chunk.id) ?? 0) < MAX_CHUNK_RETRIES)
          );
        });
        for (let i = 0; i < pending.length; i += CHUNK_CONCURRENCY) {
          if (this.destroyed) return;
          const batch = pending.slice(i, i + CHUNK_CONCURRENCY);
          await Promise.allSettled(batch.map((chunk) => this.loadChunkWithRetry(chunk.id)));
          this.evictBackgroundOverflow();
        }
      } catch (error) {
        console.warn("[GeoLibre] vehicle-playback: background chunk load failed", error);
      } finally {
        this.backgroundLoading = false;
      }
    })();
  }

  private async loadChunkWithRetry(chunkId: string): Promise<boolean> {
    const status = this.statusById.get(chunkId);
    if (status === "loaded") return true;
    const inFlight = this.inFlightById.get(chunkId);
    if (inFlight) return inFlight;

    const priorFailures = this.failureCountById.get(chunkId) ?? 0;
    if (status === "failed" && priorFailures >= MAX_CHUNK_RETRIES) return false;

    const promise = (async () => {
      const release = await this.chunkFetchLimiter.acquire();
      try {
        return await this.runChunkLoad(chunkId, priorFailures);
      } finally {
        release();
      }
    })().finally(() => {
      this.inFlightById.delete(chunkId);
    });
    this.inFlightById.set(chunkId, promise);
    return promise;
  }

  private async runChunkLoad(chunkId: string, priorFailures: number): Promise<boolean> {
    const chunk = this.manifest.chunks.find((c) => c.id === chunkId);
    if (!chunk) return false;
    this.statusById.set(chunkId, "loading");

    for (let attempt = Math.max(1, priorFailures + 1); attempt <= MAX_CHUNK_RETRIES; attempt += 1) {
      if (this.destroyed) return false;
      try {
        let body: ArrayBuffer;
        try {
          body = await this.source.read(chunk.url);
        } catch (readError) {
          // A chunk that is missing (HTTP 404, or NotFoundError from a local
          // directory handle) will never appear; do not burn retries on it.
          if (isMissingResourceError(readError)) {
            this.failureCountById.set(chunkId, MAX_CHUNK_RETRIES);
            this.statusById.set(chunkId, "failed");
            return false;
          }
          throw packageAssetError(this.source, chunk.url, "read", readError);
        }
        const payload = (await decodeChunkBody(body, chunk.url)) as {
          events?: Record<string, unknown[]>;
        };
        if (!payload?.events) {
          throw new Error(`Chunk ${chunk.url} carries no events.`);
        }
        if (this.destroyed) return false;
        this.mergeEvents(chunkId, payload.events);
        this.statusById.set(chunkId, "loaded");
        this.failureCountById.delete(chunkId);
        return true;
      } catch (error) {
        this.failureCountById.set(chunkId, attempt);
        if (attempt >= MAX_CHUNK_RETRIES) {
          this.statusById.set(chunkId, "failed");
          console.warn(`[GeoLibre] vehicle-playback: chunk ${chunk.index} failed`, error);
          return false;
        }
        await delay(RETRY_BASE_DELAY_MS * attempt);
      }
    }
    this.statusById.set(chunkId, "failed");
    return false;
  }

  /** Fold a chunk's events into the resident stream, keyed by tick. */
  private mergeEvents(chunkId: string, events: Record<string, unknown[]>): void {
    const ticks: number[] = [];
    let earliest: number | null = null;

    for (const [tickKey, rawEvents] of Object.entries(events)) {
      const tick = safeInt(tickKey, Number.NaN);
      if (!Number.isFinite(tick) || !Array.isArray(rawEvents)) continue;
      let tickMap = this.eventsByTick.get(tick);
      if (!tickMap) {
        tickMap = new Map();
        this.eventsByTick.set(tick, tickMap);
      }
      for (const raw of rawEvents) {
        const event = normalizeEvent(raw);
        if (!event) continue;
        tickMap.set(event.id * 10 + event.order, event);
      }
      if (tickMap.size === 0) {
        this.eventsByTick.delete(tick);
        continue;
      }
      ticks.push(tick);
      if (earliest === null || tick < earliest) earliest = tick;
    }

    this.ticksByChunk.set(chunkId, ticks);
    this.dataVersion += 1;
    // Events arriving at or before the replay cursor invalidate what was
    // replayed from the (then incomplete) stream.
    if (earliest !== null && earliest <= this.resolvedTick) this.invalidateReplay();
    else this.invalidateInterpolation();
  }

  /** Drop every resident chunk not in `keepIds`. */
  private evictOutside(keepIds: Set<string>): void {
    for (const [chunkId, status] of this.statusById) {
      if (status !== "loaded" || keepIds.has(chunkId)) continue;
      this.unloadChunk(chunkId);
    }
  }

  /** Keep only the chunks nearest the playhead once the resident cap is passed. */
  private evictBackgroundOverflow(): void {
    const loaded: string[] = [];
    for (const [chunkId, status] of this.statusById) {
      if (status === "loaded") loaded.push(chunkId);
    }
    if (loaded.length <= MAX_RESIDENT_BACKGROUND_CHUNKS) return;
    const distance = (chunkId: string): number => {
      const chunk = this.manifest.chunks.find((c) => c.id === chunkId);
      if (!chunk) return Number.POSITIVE_INFINITY;
      if (this.currentTick >= chunk.startTick && this.currentTick <= chunk.endTick) return 0;
      return Math.min(
        Math.abs(chunk.startTick - this.currentTick),
        Math.abs(chunk.endTick - this.currentTick),
      );
    };
    const ordered = loaded.slice().sort((a, b) => distance(a) - distance(b));
    this.evictOutside(new Set(ordered.slice(0, MAX_RESIDENT_BACKGROUND_CHUNKS)));
  }

  private unloadChunk(chunkId: string): void {
    const ticks = this.ticksByChunk.get(chunkId);
    let earliestEvicted: number | null = null;
    if (ticks) {
      for (const tick of ticks) {
        this.eventsByTick.delete(tick);
        if (earliestEvicted === null || tick < earliestEvicted) earliestEvicted = tick;
      }
      this.ticksByChunk.delete(chunkId);
    }
    this.statusById.set(chunkId, "pending");
    this.dataVersion += 1;

    // Drop only this chunk's own checkpoints, not every resident chunk's — a
    // full invalidateReplay() here would force every subsequent resolveTo() to
    // replay from tick 0 over data other, still-resident chunks still have,
    // even though those chunks' checkpoints remain perfectly valid.
    const checkpointTicks = this.checkpointTicksByChunk.get(chunkId);
    if (checkpointTicks) {
      for (const tick of checkpointTicks) this.checkpoints.delete(tick);
      this.checkpointTicksByChunk.delete(chunkId);
    }

    // The replay cursor and its cached runtime table are only invalid if they
    // depended on events this eviction just deleted.
    if (earliestEvicted !== null && earliestEvicted <= this.resolvedTick) {
      this.runtimeById = new Map();
      this.resolvedTick = -1;
      this.invalidateInterpolation();
    }
  }

  private invalidateReplay(): void {
    this.runtimeById = new Map();
    this.resolvedTick = -1;
    this.checkpoints.clear();
    this.checkpointTicksByChunk.clear();
    this.invalidateInterpolation();
  }

  private invalidateInterpolation(): void {
    this.cacheBaseTick = -1;
    this.cacheNextTick = -1;
    this.cacheBase = [];
    this.cacheNext = [];
    this.cacheDataVersion = -1;
  }

  // -------------------------------------------------------------------------
  // Replay (Testudo's vehicle-event-store).
  // -------------------------------------------------------------------------

  private get fadeInTicks(): number {
    return Math.max(1, Math.ceil(FADE_IN_DURATION_S / this.manifest.dt));
  }

  private get fadeOutTicks(): number {
    return Math.max(1, Math.ceil(FADE_OUT_DURATION_S / this.manifest.dt));
  }

  /** Whether `tick` is a chunk's first tick (its replay baseline). */
  private isChunkStart(tick: number): boolean {
    return this.manifest.chunks.some((chunk) => chunk.startTick === tick);
  }

  /** Snapshot-worthy ticks: the start, chunk boundaries, and a fixed interval. */
  private shouldCheckpoint(tick: number): boolean {
    if (tick <= 0) return true;
    if (this.isChunkStart(tick)) return true;
    return tick % CHECKPOINT_INTERVAL_TICKS === 0;
  }

  private captureCheckpoint(tick: number): void {
    const snapshot = new Map<number, VehicleRuntime>();
    for (const [id, runtime] of this.runtimeById) snapshot.set(id, cloneRuntime(runtime));
    this.checkpoints.set(tick, snapshot);

    const chunkId = this.findChunk(tick)?.id ?? "__global__";
    let ticks = this.checkpointTicksByChunk.get(chunkId);
    if (!ticks) {
      ticks = [];
      this.checkpointTicksByChunk.set(chunkId, ticks);
    }
    if (!ticks.includes(tick)) ticks.push(tick);
    ticks.sort((a, b) => a - b);
    // Bound memory: a long package would otherwise accumulate a full vehicle
    // table every CHECKPOINT_INTERVAL_TICKS for its entire length. Evict the
    // oldest non-chunk-start checkpoint first — the chunk-start checkpoint is
    // the only baseline a backward seek into this chunk can restore from once
    // an earlier chunk has been evicted, so dropping it defeats seeking (see
    // Testudo's vehicle-event-store.js, which applies the same rule).
    while (ticks.length > MAX_CHECKPOINTS_PER_CHUNK) {
      let removeIndex = ticks.findIndex((t) => !this.isChunkStart(t));
      if (removeIndex < 0) removeIndex = 0;
      const [dropped] = ticks.splice(removeIndex, 1);
      if (dropped !== undefined) this.checkpoints.delete(dropped);
    }
  }

  /** Rewind the replay cursor to the newest checkpoint at or before `tick`. */
  private restoreCheckpointAtOrBefore(tick: number): void {
    let best = -1;
    for (const checkpointTick of this.checkpoints.keys()) {
      if (checkpointTick <= tick && checkpointTick > best) best = checkpointTick;
    }
    this.runtimeById = new Map();
    if (best < 0) {
      this.resolvedTick = -1;
      return;
    }
    const snapshot = this.checkpoints.get(best);
    if (snapshot) {
      for (const [id, runtime] of snapshot) this.runtimeById.set(id, cloneRuntime(runtime));
    }
    this.resolvedTick = best;
  }

  private applyEvent(tick: number, event: NormalizedEvent): void {
    let runtime = this.runtimeById.get(event.id);

    if (event.event === "spawn" || event.event === "state") {
      // Identity (type/length/width) is latched once and never overwritten by
      // a later spawn/state event that omits it — periodic `state` resync
      // keyframes carry only motion fields, and Testudo's own event store
      // preserves the first-seen identity across these rather than nulling it
      // out (vehicle-event-store.js). Only a fresh, non-null value from THIS
      // event may replace an already-latched one; a still-missing field falls
      // back to whatever the existing runtime already latched.
      const newTypeName = event.fields.type_name ?? null;
      const newLengthM =
        typeof event.fields.Length === "number" && event.fields.Length > 0
          ? event.fields.Length
          : null;
      const newWidthM =
        typeof event.fields.Width === "number" && event.fields.Width > 0
          ? event.fields.Width
          : null;
      runtime = {
        id: event.id,
        fields: { ...event.fields },
        spawnTick: tick,
        lastActiveTick: tick,
        despawnTick: null,
        lastKnownHeading: runtime?.lastKnownHeading ?? null,
        typeName: newTypeName ?? runtime?.typeName ?? null,
        lengthM: newLengthM ?? runtime?.lengthM ?? null,
        widthM: newWidthM ?? runtime?.widthM ?? null,
      };
      this.runtimeById.set(event.id, runtime);
      return;
    }

    if (event.event === "update") {
      if (!runtime) {
        // An update before its spawn happens when playback starts mid-chunk.
        runtime = {
          id: event.id,
          fields: {},
          spawnTick: tick,
          lastActiveTick: tick,
          despawnTick: null,
          lastKnownHeading: null,
          typeName: null,
          lengthM: null,
          widthM: null,
        };
        this.runtimeById.set(event.id, runtime);
      }
      runtime.fields = mergeFields(runtime.fields, event.fields);
      runtime.lastActiveTick = tick;
      runtime.despawnTick = null;
      return;
    }

    if (runtime) {
      runtime.despawnTick = tick;
      runtime.lastActiveTick = tick;
    }
  }

  /** Drop vehicles whose fade-out has finished. */
  private cleanupAtTick(tick: number): void {
    const fadeOut = this.fadeOutTicks;
    for (const [id, runtime] of this.runtimeById) {
      if (runtime.despawnTick !== null && tick - runtime.despawnTick > fadeOut) {
        this.runtimeById.delete(id);
      }
    }
  }

  /**
   * Advance (or rewind) the replay cursor so `this.runtimeById` holds the exact
   * discrete state at `targetTick`.
   */
  private resolveTo(targetTick: number): void {
    const clamped = Math.max(0, Math.min(safeInt(targetTick, 0), this.manifest.maxTick));
    if (this.resolvedTick === clamped) return;
    if (clamped < this.resolvedTick) this.restoreCheckpointAtOrBefore(clamped);

    for (let tick = this.resolvedTick + 1; tick <= clamped; tick += 1) {
      const tickMap = this.eventsByTick.get(tick);
      if (tickMap && tickMap.size > 0) {
        const ordered = Array.from(tickMap.values()).sort((a, b) =>
          a.id !== b.id ? a.id - b.id : a.order - b.order,
        );
        for (const event of ordered) this.applyEvent(tick, event);
      }
      this.cleanupAtTick(tick);
      if (this.shouldCheckpoint(tick)) this.captureCheckpoint(tick);
    }
    this.resolvedTick = clamped;
  }

  // -------------------------------------------------------------------------
  // Materialization (Testudo's vehicle-snapshot).
  // -------------------------------------------------------------------------

  /** Project a source-CRS position to `[lon, lat, z]`, or null when unusable. */
  private project(position: SourcePosition | undefined): [number, number, number] | null {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
    const z = Number.isFinite(position.z) ? position.z : 0;
    if (!this.converter) return [position.x, position.y, z];
    const [lon, lat] = this.converter.forward([position.x, position.y]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat, z];
  }

  /** Front/rear axle positions, falling back to the center when absent. */
  private axlePositions(fields: VehicleFields): {
    front: [number, number, number] | null;
    rear: [number, number, number] | null;
  } {
    const front =
      this.project(fields.front_position) ??
      this.project(
        Number.isFinite(fields.WorldX ?? Number.NaN)
          ? { x: fields.WorldX as number, y: fields.WorldY as number, z: fields.WorldZ ?? 0 }
          : undefined,
      );
    const rear = this.project(fields.rear_position);
    return { front, rear };
  }

  /** Bearing from the rear axle toward the front, or NaN when barely moving. */
  private headingFromAxles(
    front: [number, number, number] | null,
    rear: [number, number, number] | null,
  ): number {
    if (!front || !rear) return Number.NaN;
    const latRef = front[1];
    const dx = (front[0] - rear[0]) * 111_320 * Math.cos((latRef * Math.PI) / 180);
    const dy = (front[1] - rear[1]) * 111_320;
    if (Math.sqrt(dx * dx + dy * dy) < STOPPED_VEHICLE_THRESHOLD_M) return Number.NaN;
    return normalizeHeading((Math.atan2(dx, dy) * 180) / Math.PI);
  }

  /** Materialize one vehicle at a whole tick, or null when it is invisible. */
  private materialize(runtime: VehicleRuntime, tick: number): VehicleSample | null {
    const { front, rear } = this.axlePositions(runtime.fields);
    // The vehicle center is the axle midpoint; with only one axle, use it alone.
    const center =
      front && rear
        ? ([
            (front[0] + rear[0]) / 2,
            (front[1] + rear[1]) / 2,
            (front[2] + rear[2]) / 2,
          ] as [number, number, number])
        : (front ?? rear);
    if (!center) return null;

    let opacity = 1;
    const sinceSpawn = Math.max(0, tick - runtime.spawnTick);
    const fadeIn = this.fadeInTicks;
    if (sinceSpawn < fadeIn) opacity = Math.min(opacity, (sinceSpawn + 1) / fadeIn);
    if (runtime.despawnTick !== null) {
      const afterDespawn = Math.max(0, tick - runtime.despawnTick);
      if (afterDespawn > 0) {
        const fadeOut = this.fadeOutTicks;
        const remaining = Math.max(0, fadeOut - afterDespawn + 1);
        opacity = Math.min(opacity, Math.max(0.05, remaining / fadeOut));
      }
    }
    opacity = clampOpacity(opacity);
    if (opacity < MIN_VISIBLE_OPACITY) return null;

    let heading = this.headingFromAxles(front, rear);
    if (Number.isFinite(heading)) {
      runtime.lastKnownHeading = heading;
    } else {
      // A stopped vehicle keeps pointing where it last pointed rather than
      // snapping to north.
      heading = runtime.lastKnownHeading ?? normalizeHeading(runtime.fields.heading ?? 0) ?? 0;
      if (!Number.isFinite(heading)) heading = 0;
    }

    const speedKmh =
      typeof runtime.fields.speed_kmh === "number"
        ? runtime.fields.speed_kmh
        : typeof runtime.fields.v === "number"
          ? runtime.fields.v * 3.6
          : (runtime.fields.speed ?? null);

    const typeName = runtime.typeName ?? runtime.fields.type_name ?? null;
    // Length still has a 1 m floor: it only ever comes from the simulator here,
    // and a zero/degenerate Length would collapse the footprint entirely.
    const lengthM = Math.max(
      1,
      runtime.lengthM ?? safeNumber(runtime.fields.Length, DEFAULT_VEHICLE_LENGTH_M),
    );
    const shapeKey = resolveVehicleShapeKey(typeName, lengthM);
    const shape = VEHICLE_SHAPES[shapeKey];

    // Width is the root cause of "pedestrians look too wide": the VWE
    // `events_v1` format has no `Width` field at all, so before this every
    // vehicle fell back to a flat 2 m global default and was then floored at
    // 1 m — rendering a 0.4 m pedestrian two and a half times too wide. When
    // the simulator DOES supply a Width (some packages may) it still wins; only
    // the absent case now falls through to the per-shape catalog width, with no
    // 1 m floor so pedestrians (0.4 m) and bicycles (0.5 m) keep their size.
    const suppliedWidth = runtime.widthM ?? safeNumber(runtime.fields.Width, Number.NaN);
    const widthM =
      Number.isFinite(suppliedWidth) && suppliedWidth > 0
        ? suppliedWidth
        : (shape?.widthM ?? DEFAULT_VEHICLE_WIDTH_M);

    return {
      id: runtime.id,
      lon: center[0],
      lat: center[1],
      z: center[2],
      heading,
      opacity,
      speedKmh: typeof speedKmh === "number" && Number.isFinite(speedKmh) ? speedKmh : null,
      typeName,
      lengthM,
      widthM: Math.max(0.1, widthM),
      heightM: shape?.heightM ?? VEHICLE_SHAPES.car_sedan.heightM,
      shapeKey,
    };
  }

  /** Every visible vehicle at a whole tick. */
  private frameAtDiscreteTick(tick: number): VehicleSample[] {
    this.resolveTo(tick);
    const samples: VehicleSample[] = [];
    for (const runtime of this.runtimeById.values()) {
      const sample = this.materialize(runtime, tick);
      if (sample) samples.push(sample);
    }
    this.recordArticulationHistory(samples, tick);
    return samples;
  }

  /**
   * Extend the path history of every articulated vehicle in a **whole-tick**
   * frame.
   *
   * Capture happens here, at discrete ticks only, not on the interpolated
   * frames `sampleAt` returns — option (a) of the two available. The sub-tick
   * interpolator would otherwise push near-duplicate entries at up to 60 Hz and
   * (worse) re-push the same ticks every time the playhead is scrubbed back and
   * forth within one tick, corrupting the distance axis. Whole-tick capture
   * keeps the buffer's distance axis monotone and cheap; the visible cost is
   * that a segment's lag quantizes to the tick grid, which at ~0.8 s ticks and
   * tram speeds is well under one segment length.
   *
   * Frames are rebuilt for `floor(tick)` and `floor(tick) + 1` and cached, so a
   * tick can be presented here more than once (a backward scrub, a cache
   * invalidation after new events arrive). The per-entry `tick` guard makes
   * re-presentation idempotent rather than double-counting distance.
   */
  private recordArticulationHistory(samples: VehicleSample[], tick: number): void {
    const seen = new Set<number>();
    for (const sample of samples) {
      if (!ARTICULATED_SHAPE_KEYS.has(sample.shapeKey)) continue;
      seen.add(sample.id);
      const history = this.historyById.get(sample.id);
      if (!history) {
        this.historyById.set(sample.id, [
          { lon: sample.lon, lat: sample.lat, heading: sample.heading, distanceM: 0, tick },
        ]);
        continue;
      }
      const last = history[history.length - 1];
      // Already captured (or captured ahead of) this tick: a repeat visit.
      if (tick <= last.tick) continue;
      const stepM = metersBetween(last.lon, last.lat, sample.lon, sample.lat);
      if (stepM < ARTICULATION_HISTORY_MIN_STEP_M) {
        // Barely moved: refresh the head in place so a slow crawl still tracks
        // heading changes without inflating the buffer.
        last.heading = sample.heading;
        last.lon = sample.lon;
        last.lat = sample.lat;
        last.tick = tick;
        continue;
      }
      history.push({
        lon: sample.lon,
        lat: sample.lat,
        heading: sample.heading,
        distanceM: last.distanceM + stepM,
        tick,
      });
      trimArticulationHistory(history);
    }
    // Drop history for vehicles no longer in the frame (despawned, or scrubbed
    // away from), so a long package cannot accumulate dead buffers.
    if (this.historyById.size > seen.size) {
      for (const id of this.historyById.keys()) {
        if (!seen.has(id)) this.historyById.delete(id);
      }
    }
  }

  /** Recent path of one articulated vehicle, oldest first; empty when none. */
  getArticulationHistory(id: number): readonly VehicleHistoryEntry[] {
    return this.historyById.get(id) ?? EMPTY_HISTORY;
  }

  /**
   * Every visible vehicle at a **fractional** tick.
   *
   * Reconstructs the discrete frames at `floor(tick)` and `floor(tick) + 1` and
   * interpolates between them with `alpha = tick - floor(tick)`: position and
   * elevation linearly, heading the short way around the circle, speed and
   * opacity linearly. Vehicles present in only one of the two frames fade in or
   * out across the sub-tick rather than popping.
   *
   * This is what makes motion continuous: the underlying events are typically
   * 0.8 s apart, far coarser than a 60 fps frame budget.
   *
   * @param tick - The fractional playhead position
   * @returns The interpolated frame, ready to hand to a deck.gl layer
   */
  sampleAt(tick: number): VehicleSample[] {
    const clamped = Math.max(0, Math.min(safeNumber(tick, 0), this.manifest.maxTick));
    const baseTick = Math.floor(clamped);
    const nextTick = Math.min(this.manifest.maxTick, baseTick + 1);

    // Rebuilding both discrete frames is the expensive part, so it is cached
    // until the playhead crosses a tick boundary or new events arrive.
    if (
      this.cacheBaseTick !== baseTick ||
      this.cacheNextTick !== nextTick ||
      this.cacheDataVersion !== this.dataVersion
    ) {
      this.cacheBase = this.frameAtDiscreteTick(baseTick);
      this.cacheNext = nextTick === baseTick ? this.cacheBase : this.frameAtDiscreteTick(nextTick);
      this.cacheBaseTick = baseTick;
      this.cacheNextTick = nextTick;
      this.cacheDataVersion = this.dataVersion;
    }

    const alpha = nextTick === baseTick ? 0 : clamped - baseTick;
    return interpolateFrames(this.cacheBase, this.cacheNext, alpha);
  }
}

/**
 * Blend two discrete frames into one continuous frame.
 *
 * @param base - The frame at `floor(tick)`
 * @param next - The frame at `floor(tick) + 1`
 * @param alpha - Sub-tick position in `[0, 1]`
 * @returns The interpolated vehicles
 */
export function interpolateFrames(
  base: VehicleSample[],
  next: VehicleSample[],
  alpha: number,
): VehicleSample[] {
  if (base.length === 0) return next;
  if (next.length === 0) return base;
  if (alpha <= 0.001) return base;
  if (alpha >= 0.999) return next;

  const result: VehicleSample[] = [];
  const nextById = new Map<number, VehicleSample>();
  for (const sample of next) nextById.set(sample.id, sample);

  for (const from of base) {
    const to = nextById.get(from.id);
    if (!to) {
      // Despawned across this sub-tick: fade it out instead of popping.
      const opacity = clampOpacity(from.opacity * (1 - alpha));
      if (opacity >= MIN_VISIBLE_OPACITY) result.push({ ...from, opacity });
      continue;
    }
    nextById.delete(from.id);
    const opacity = clampOpacity(lerp(from.opacity, to.opacity, alpha));
    if (opacity < MIN_VISIBLE_OPACITY) continue;
    const speedKmh =
      from.speedKmh !== null && to.speedKmh !== null
        ? lerp(from.speedKmh, to.speedKmh, alpha)
        : (to.speedKmh ?? from.speedKmh);
    result.push({
      ...from,
      lon: lerp(from.lon, to.lon, alpha),
      lat: lerp(from.lat, to.lat, alpha),
      z: lerp(from.z, to.z, alpha),
      heading: interpolateHeading(from.heading, to.heading, alpha),
      opacity,
      speedKmh,
    });
  }

  // Spawned across this sub-tick: fade it in.
  for (const to of nextById.values()) {
    const opacity = clampOpacity(to.opacity * alpha);
    if (opacity < MIN_VISIBLE_OPACITY) continue;
    result.push({ ...to, opacity });
  }

  return result;
}

/**
 * Fetch and parse a VWE package manifest, returning a ready data layer.
 *
 * Only the manifest is fetched here; chunks stream in on demand through
 * {@link VehiclePlaybackData.ensureCoverage}.
 *
 * @param manifestUrl - URL of the package's `manifest.json`
 * @returns The loaded data layer
 * @throws {Error} When the manifest cannot be fetched or declares no chunks
 */
export async function loadVehiclePlayback(
  manifestUrl: string,
  scenarioIndex = 0,
): Promise<VehiclePlaybackData> {
  const raw = await loadCachedHttpPackageManifests(manifestUrl);
  const capability = capabilityAvailable(raw, "animation");
  if (!capability.available) throw new Error(capability.reason ?? "Animation is unavailable.");
  return new VehiclePlaybackData(
    parseVehicleManifest(raw, manifestUrl, scenarioIndex),
    createHttpPackageSource(manifestUrl),
  );
}

/**
 * Fetch and parse only a package's manifest JSON, without building a data
 * layer.
 *
 * Used by the scenario picker: the panel needs the scenario catalog before it
 * can know which scenario's chunks to stream, and a multi-scenario manifest
 * must not commit to one until the user has chosen.
 *
 * @param manifestUrl - URL of the package's `manifest.json`
 * @returns The raw parsed manifest JSON
 */
export async function fetchVehicleManifestJson(manifestUrl: string): Promise<unknown> {
  return loadCachedHttpPackageManifests(manifestUrl);
}

/**
 * Read a package's manifest JSON out of a folder the user picked.
 *
 * @param root - The package root directory handle (the folder holding
 *   `manifest.json`)
 * @returns The raw parsed manifest JSON
 */
export async function readLocalVehicleManifestJson(
  root: VehicleDirectoryHandle,
): Promise<unknown> {
  const source = createDirectoryPackageSource(root);
  const bytes = await source.read("manifest.json");
  const legacy = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  try { const pkg = JSON.parse(new TextDecoder().decode(await source.read("geolibre/package.json"))); return attachGeolibrePackage(legacy, pkg); } catch { return legacy; }
}

/**
 * Build a data layer for a package read from a local folder.
 *
 * The manifest is parsed with a null base URL so chunk and geometry paths stay
 * package-relative, and every subsequent read goes through the directory
 * handle instead of the network.
 *
 * @param root - The package root directory handle
 * @param raw - The already-read manifest JSON
 * @param scenarioIndex - Which scenario to play
 * @returns The loaded data layer
 */
export function openLocalVehiclePackage(
  root: VehicleDirectoryHandle,
  raw: unknown,
  scenarioIndex = 0,
): VehiclePlaybackData {
  return new VehiclePlaybackData(
    parseVehicleManifest(raw, null, scenarioIndex),
    createDirectoryPackageSource(root),
  );
}

/**
 * A network-geometry GeoJSON layer, ready to hand to MapLibre.
 *
 * `data` is deliberately typed loosely: the plugin only forwards it to
 * `map.addSource({ type: "geojson", data })`, which validates it far better
 * than a hand-written structural check here would.
 */
export interface VehicleGeometryLayers {
  sections: unknown | null;
  lanes: unknown | null;
  turns: unknown | null;
  nodes: unknown | null;
}

/**
 * Load a package's network geometry GeoJSON files.
 *
 * Every file is optional and independently best-effort: geometry is a backdrop
 * for the vehicles, so a package missing (or failing to serve) `lanes.geojson`
 * still plays back with its sections and turns drawn. Failures are warned
 * about, never thrown.
 *
 * @param source - The package byte source
 * @param sources - The manifest's resolved geometry paths
 * @returns Parsed GeoJSON per file, with null where a file was absent or bad
 */
export async function loadVehicleGeometry(
  source: VehiclePackageSource,
  sources: VehicleGeometrySources,
): Promise<VehicleGeometryLayers> {
  const read = async (path: string | null, label: string): Promise<unknown | null> => {
    if (!path) return null;
    try {
      const bytes = await source.read(path);
      if (bytes.byteLength === 0) {
        throw packageAssetError(source, path, "empty");
      }
      const text = new TextDecoder("utf-8").decode(bytes);
      if (!text.trim()) {
        throw packageAssetError(source, path, "empty");
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw packageAssetError(source, path, "json", error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GeoLibre] vehicle-playback: ${label} geometry unavailable (${packageAssetPath(source, path)}): ${message}`);
      return null;
    }
  };
  const [sections, lanes, turns, nodes] = await Promise.all([
    read(sources.sections, "sections"),
    read(sources.lanes, "lanes"),
    read(sources.turns, "turns"),
    read(sources.nodes, "nodes"),
  ]);
  return { sections, lanes, turns, nodes };
}

// ---------------------------------------------------------------------------
// Approximate node polygons, derived from turn geometry.
// ---------------------------------------------------------------------------

/** A `[lon, lat]` position. */
type LonLat = [number, number];

/**
 * Groups turn line endpoints into node clusters by geographic proximity.
 *
 * The VWE export format (see {@link VehicleGeometrySources}) has no real
 * node/junction polygon file and carries no explicit node id on a turn
 * feature, so clustering has to be geometric rather than id-based: every turn
 * starts and ends essentially AT the junction it connects (the geometry is a
 * short connector between two sections), so endpoints that land within
 * `toleranceM` of each other are almost certainly the same physical junction.
 *
 * @param toleranceM - Endpoints closer than this (in meters) are merged into
 *   the same node cluster.
 */
function clusterTurnEndpoints(endpoints: LonLat[], toleranceM: number): LonLat[][] {
  if (endpoints.length === 0) return [];
  // Degrees-per-meter varies with latitude only for longitude; use the first
  // point's latitude as a local approximation, which is accurate enough at
  // the scale of a single junction.
  const lat0 = endpoints[0][1];
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const cellSizeDeg = toleranceM / Math.max(metersPerDegLat, metersPerDegLon);

  // Bucket endpoints into a uniform grid keyed by cell coordinate so proximity
  // lookups are O(1) instead of O(n^2); this matters once a package has many
  // thousands of turns.
  const grid = new Map<string, number[]>();
  const cellOf = (p: LonLat): [number, number] => [
    Math.floor(p[0] / cellSizeDeg),
    Math.floor(p[1] / cellSizeDeg),
  ];
  endpoints.forEach((p, i) => {
    const [cx, cy] = cellOf(p);
    const key = `${cx}:${cy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  const parent = endpoints.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const distanceM = (a: LonLat, b: LonLat): number => {
    const dx = (a[0] - b[0]) * metersPerDegLon;
    const dy = (a[1] - b[1]) * metersPerDegLat;
    return Math.hypot(dx, dy);
  };

  endpoints.forEach((p, i) => {
    const [cx, cy] = cellOf(p);
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        const bucket = grid.get(`${gx}:${gy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          if (distanceM(p, endpoints[j]) <= toleranceM) union(i, j);
        }
      }
    }
  });

  const clusters = new Map<number, number[]>();
  endpoints.forEach((_, i) => {
    const root = find(i);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(i);
    else clusters.set(root, [i]);
  });
  return [...clusters.values()].map((indices) => indices.map((i) => endpoints[i]));
}

/**
 * Andrew's monotone chain convex hull.
 *
 * @param points - Points to hull; duplicates and collinear points are fine
 * @returns The hull vertices in counter-clockwise order, or `points` itself
 *   when there are fewer than 3 distinct points (nothing to hull)
 */
function convexHull(points: LonLat[]): LonLat[] {
  const unique = [...new Map(points.map((p) => [`${p[0]}:${p[1]}`, p])).values()];
  if (unique.length < 3) return unique;
  const sorted = [...unique].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: LonLat, a: LonLat, b: LonLat): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: LonLat[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: LonLat[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Minimum footprint radius (meters) given to a hull degenerate to a point/line. */
const NODE_POLYGON_FALLBACK_RADIUS_M = 2;

/**
 * Derives an approximate polygon footprint per network junction from turn
 * connector geometry, for packages (all current VWE exports) that carry no
 * real node/junction polygon file.
 *
 * Each turn's start and end points sit essentially at the junction it
 * connects, so grouping nearby turn endpoints and taking their convex hull
 * gives a reasonable stand-in footprint for that junction — good enough for a
 * `fill` layer, unlike the fixed-radius circles this replaces (see #1250).
 *
 * @param turnsGeoJson - The parsed `turns.geojson` FeatureCollection (or any
 *   GeoJSON-shaped value; malformed/missing input yields no polygons)
 * @param toleranceM - Endpoints within this distance are treated as the same
 *   junction (default 8m, generous enough for typical junction geometry
 *   without merging genuinely distinct nearby junctions)
 * @returns A FeatureCollection of node polygons, one per detected junction
 */
export function deriveNodePolygonsFromTurns(
  turnsGeoJson: unknown,
  toleranceM = 8,
): { type: "FeatureCollection"; features: unknown[] } | null {
  const features = (turnsGeoJson as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features) || features.length === 0) return null;

  const endpoints: LonLat[] = [];
  for (const feature of features) {
    const geometry = (feature as { geometry?: { type?: string; coordinates?: unknown } })
      ?.geometry;
    if (!geometry) continue;
    const lines: unknown[] =
      geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString"
          ? (geometry.coordinates as unknown[])
          : [];
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2) continue;
      const first = line[0] as LonLat;
      const last = line[line.length - 1] as LonLat;
      if (Array.isArray(first) && first.length >= 2) endpoints.push([first[0], first[1]]);
      if (Array.isArray(last) && last.length >= 2) endpoints.push([last[0], last[1]]);
    }
  }
  if (endpoints.length === 0) return null;

  const clusters = clusterTurnEndpoints(endpoints, toleranceM);
  const lonPerM = 1 / (111320 * Math.cos((endpoints[0][1] * Math.PI) / 180) || 1e-6);
  const latPerM = 1 / 111320;

  const outFeatures = clusters.map((cluster, index) => {
    const hull = convexHull(cluster);
    let ring: LonLat[];
    if (hull.length >= 3) {
      ring = [...hull, hull[0]];
    } else {
      // A single-point (or collinear) cluster has no real hull; give it a
      // small square footprint centered on its centroid so it still renders
      // as a visible polygon rather than vanishing.
      const cx = cluster.reduce((s, p) => s + p[0], 0) / cluster.length;
      const cy = cluster.reduce((s, p) => s + p[1], 0) / cluster.length;
      const r = NODE_POLYGON_FALLBACK_RADIUS_M;
      ring = [
        [cx - r * lonPerM, cy - r * latPerM],
        [cx + r * lonPerM, cy - r * latPerM],
        [cx + r * lonPerM, cy + r * latPerM],
        [cx - r * lonPerM, cy + r * latPerM],
        [cx - r * lonPerM, cy - r * latPerM],
      ];
    }
    return {
      type: "Feature",
      properties: { node_id: index },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  });

  return { type: "FeatureCollection", features: outFeatures };
}

/**
 * Oriented ground footprint of a vehicle, as a closed deck.gl polygon ring.
 *
 * Meters are converted to degrees at the vehicle's own latitude so the rectangle
 * keeps its real proportions anywhere on the map.
 *
 * @param sample - The vehicle to outline
 * @returns Four `[lon, lat]` corners, clockwise from the front-left
 */
export function vehicleFootprint(sample: VehicleSample): [number, number][] {
  return orientedRectangle(
    sample.lon,
    sample.lat,
    sample.heading,
    sample.lengthM,
    sample.widthM,
  );
}

/**
 * One oriented rectangle ring, centered on `lon`/`lat`.
 *
 * Shared by {@link vehicleFootprint} and {@link articulatedVehicleFootprints}:
 * both need exactly this meters-to-degrees rotation, the only difference being
 * which center and heading they feed it.
 *
 * @param lon - Center longitude
 * @param lat - Center latitude
 * @param heading - Bearing in degrees clockwise from north
 * @param lengthM - Along-heading extent
 * @param widthM - Across-heading extent
 * @returns Four `[lon, lat]` corners, clockwise from the front-left
 */
function orientedRectangle(
  lon: number,
  lat: number,
  heading: number,
  lengthM: number,
  widthM: number,
): [number, number][] {
  const latScale = 1 / 111_320;
  const lonScale = latScale / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const halfLength = lengthM / 2;
  const halfWidth = widthM / 2;
  // Heading is clockwise from north, so the along-vehicle axis is
  // (sin, cos) and the across axis is its perpendicular.
  const rad = (heading * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const corner = (along: number, across: number): [number, number] => [
    lon + (along * sin + across * cos) * lonScale,
    lat + (along * cos - across * sin) * latScale,
  ];
  return [
    corner(halfLength, -halfWidth),
    corner(halfLength, halfWidth),
    corner(-halfLength, halfWidth),
    corner(-halfLength, -halfWidth),
  ];
}

/** Planar meters between two WGS84 points, good enough at vehicle scale. */
function metersBetween(lonA: number, latA: number, lonB: number, latB: number): number {
  const latRef = ((latA + latB) / 2) * (Math.PI / 180);
  const dx = (lonB - lonA) * 111_320 * Math.cos(latRef);
  const dy = (latB - latA) * 111_320;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Signed along-path displacement of a live point from a history entry, in
 * meters, measured along that entry's own heading.
 *
 * Positive means the live point is ahead of the entry (the normal sub-tick
 * case, where the interpolated sample has advanced past the last whole-tick
 * head); negative means it is behind. Cross-track offset is discarded, which is
 * what makes this an along-path distance comparable to a history entry's
 * `distanceM` rather than a chord.
 */
function alongHeadingOffsetM(
  from: VehicleHistoryEntry,
  lon: number,
  lat: number,
): number {
  const latRef = ((from.lat + lat) / 2) * (Math.PI / 180);
  const dx = (lon - from.lon) * 111_320 * Math.cos(latRef);
  const dy = (lat - from.lat) * 111_320;
  // Heading is clockwise from north, so its unit vector is (sin, cos).
  const rad = (from.heading * Math.PI) / 180;
  if (!Number.isFinite(rad)) return 0;
  return dx * Math.sin(rad) + dy * Math.cos(rad);
}

const EMPTY_HISTORY: readonly VehicleHistoryEntry[] = [];

/**
 * Evict path history older than any segment could need.
 *
 * Distance-based, not age-based: the buffer exists to answer "where was the
 * body `d` meters back along its path", so the retention bound is exactly
 * {@link ARTICULATION_HISTORY_METERS} of travel behind the head. A stationary
 * vehicle accumulates nothing (its head is refreshed in place), so the entry
 * cap is only a backstop. Mutates `history` in place.
 */
function trimArticulationHistory(history: VehicleHistoryEntry[]): void {
  const head = history[history.length - 1];
  if (!head) return;
  const cutoff = head.distanceM - ARTICULATION_HISTORY_METERS;
  let drop = 0;
  // Keep the first entry at or before the cutoff, so a pivot landing exactly on
  // the cutoff still has two entries to interpolate between.
  while (drop + 1 < history.length && history[drop + 1].distanceM <= cutoff) drop += 1;
  if (history.length - drop > ARTICULATION_HISTORY_MAX_ENTRIES) {
    drop = history.length - ARTICULATION_HISTORY_MAX_ENTRIES;
  }
  if (drop > 0) history.splice(0, drop);
}

/** Number of body segments an articulated vehicle of `lengthM` is drawn with. */
export function articulatedSegmentCount(lengthM: number): number {
  const raw = Math.round(lengthM / ARTICULATED_SEGMENT_LENGTH_M);
  return Math.min(MAX_ARTICULATED_SEGMENTS, Math.max(MIN_ARTICULATED_SEGMENTS, raw));
}

/**
 * Position and heading `backM` meters back along a recorded path.
 *
 * Linearly interpolates between the two bracketing history entries (headings
 * the short way around the circle). When the buffer does not reach that far
 * back — a tram that just spawned, or one that has barely moved — it falls back
 * to the oldest entry's heading, which degrades gracefully to the rigid-body
 * look rather than to a wrong one.
 */
function pathPointBack(
  history: readonly VehicleHistoryEntry[],
  backM: number,
): { lon: number; lat: number; heading: number } | null {
  if (history.length === 0) return null;
  const head = history[history.length - 1];
  const target = head.distanceM - Math.max(0, backM);
  const oldest = history[0];
  if (target <= oldest.distanceM) {
    return { lon: oldest.lon, lat: oldest.lat, heading: oldest.heading };
  }
  for (let i = history.length - 1; i > 0; i -= 1) {
    const to = history[i];
    const from = history[i - 1];
    if (target >= from.distanceM && target <= to.distanceM) {
      const span = to.distanceM - from.distanceM;
      const t = span > 1e-9 ? (target - from.distanceM) / span : 0;
      return {
        lon: lerp(from.lon, to.lon, t),
        lat: lerp(from.lat, to.lat, t),
        heading: interpolateHeading(from.heading, to.heading, t),
      };
    }
  }
  return { lon: head.lon, lat: head.lat, heading: head.heading };
}

/**
 * Footprint of an articulated vehicle, as one ring per body segment.
 *
 * The front segment sits at the sample's own position and heading. Each further
 * segment is placed at the point the vehicle's body actually occupied that many
 * meters back along its recorded path, taking that point's heading with it —
 * so through a corner the rear segments are still aligned with the straight
 * they have not left yet while the front one has already turned, which is the
 * visible joint bend. With no usable history every segment falls back to the
 * sample's own heading, reproducing today's rigid block.
 *
 * @param sample - The vehicle to outline
 * @param history - Its recent path, oldest first (see `getArticulationHistory`)
 * @returns One closed `[lon, lat]` ring per segment, front segment first
 */
export function articulatedVehicleFootprints(
  sample: VehicleSample,
  history: readonly VehicleHistoryEntry[] = EMPTY_HISTORY,
): [number, number][][] {
  const segments = articulatedSegmentCount(sample.lengthM);
  const spacingM = sample.lengthM / segments;
  // A small inter-segment clearance reads as a joint rather than one long box.
  // Absolute, not proportional: see ARTICULATED_SEGMENT_GAP_M for why a
  // proportional gap produced a visible seam on straight trajectories. Floored
  // so a degenerate spacing can never invert the rectangle.
  const segmentLengthM = Math.max(0.05, spacingM - ARTICULATED_SEGMENT_GAP_M);
  // History heads are captured at whole ticks while `sample` is interpolated
  // sub-tick, so the live center can be up to one tick ahead of the head. That
  // gap is subtracted from every lookup, keeping the segments rigidly spaced
  // relative to each other instead of the train telescoping within each tick.
  //
  // Projected onto the head's own heading rather than taken as a raw distance,
  // so it is SIGNED. A raw distance is always positive, which silently treated
  // "the live sample is 2 m behind the head" (a backward scrub, or the in-place
  // head refresh that moves the head without advancing its `distanceM`) as if
  // the vehicle had moved 2 m FORWARD, shifting every trailing segment the
  // wrong way along the path. The projection also makes this an along-path
  // displacement in the same units `pathPointBack` measures `backM` in, instead
  // of a chord that understates travel through a curve.
  const head = history[history.length - 1];
  const headLagM = head ? alongHeadingOffsetM(head, sample.lon, sample.lat) : 0;

  const rings: [number, number][][] = [];
  for (let i = 0; i < segments; i += 1) {
    // Segment centers measured back from the vehicle's own (front-axle-derived)
    // center: the first segment straddles it, each later one trails by one
    // spacing.
    const backM = i * spacingM - headLagM;
    const point = i === 0 ? null : pathPointBack(history, backM);
    rings.push(
      orientedRectangle(
        point?.lon ?? sample.lon,
        point?.lat ?? sample.lat,
        point?.heading ?? sample.heading,
        segmentLengthM,
        sample.widthM,
      ),
    );
  }
  return rings;
}

/** True when `sample` renders as several lagging segments rather than one box. */
export function isArticulatedSample(sample: VehicleSample): boolean {
  return ARTICULATED_SHAPE_KEYS.has(sample.shapeKey);
}
