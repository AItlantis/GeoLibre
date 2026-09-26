//#region ../../packages/processing/src/terrain-viewshed.ts
/** Metres per degree of latitude, near enough for a local viewshed. */
const METERS_PER_DEGREE_LAT = 111320;
/**
* Compute which cells of a DEM are visible from an observer.
*
* Walks a straight line from the observer to each cell, tracking the greatest
* slope seen so far; a cell is visible when its own slope from the observer
* exceeds every slope along the way. This is the standard R3-style line-of-sight
* — exact per ray, and simple enough to reason about, at the cost of resampling
* the same near-observer cells for many rays.
*
* The grid is treated as uniform in latitude, while its rows come from tiles
* uniform in Web Mercator Y. The crop compensates when locating the window
* (see `rowOf`), but the cell height used here is still a single constant for
* the whole grid, so a tall square at high latitude carries a small north-south
* stretch. At the radii this is capped to it stays well under a cell.
*
* Earth curvature and refraction are **not** modelled. Over the radii this is
* capped to (50 km) curvature drop reaches ~180 m, which matters for a
* long-range radio study but not for the "what can I see from this overlook"
* question this answers. The Whitebox tool remains the rigorous option.
*
* @param dem - The elevation grid to analyse.
* @param observer - Position and height above ground.
* @param radiusMeters - Ignore cells beyond this distance, or 0 for no limit.
*/
function computeViewshed(dem, observer, radiusMeters = 0) {
	const { width, height, values, bbox } = dem;
	const [west, south, east, north] = bbox;
	const visible = new Uint8Array(width * height);
	const col = Math.round((observer.lng - west) / (east - west) * (width - 1));
	const row = Math.round((north - observer.lat) / (north - south) * (height - 1));
	const clampedCol = Math.min(width - 1, Math.max(0, col));
	const clampedRow = Math.min(height - 1, Math.max(0, row));
	const groundMeters = values[clampedRow * width + clampedCol] ?? 0;
	const eyeMeters = groundMeters + observer.heightMeters;
	const cellLatMeters = (north - south) / Math.max(height - 1, 1) * METERS_PER_DEGREE_LAT;
	const midLat = (north + south) / 2;
	const cellLonMeters = (east - west) / Math.max(width - 1, 1) * METERS_PER_DEGREE_LAT * Math.cos(midLat * Math.PI / 180);
	let visibleCells = 0;
	const markVisible = (index) => {
		if (visible[index] === 0) {
			visible[index] = 1;
			visibleCells += 1;
		}
	};
	markVisible(clampedRow * width + clampedCol);
	for (let targetRow = 0; targetRow < height; targetRow += 1) for (let targetCol = 0; targetCol < width; targetCol += 1) {
		if (targetRow === clampedRow && targetCol === clampedCol) continue;
		const dCol = targetCol - clampedCol;
		const dRow = targetRow - clampedRow;
		const groundDistance = Math.hypot(dCol * cellLonMeters, dRow * cellLatMeters);
		if (radiusMeters > 0 && groundDistance > radiusMeters) continue;
		const steps = Math.max(Math.abs(dCol), Math.abs(dRow));
		let maxSlope = -Infinity;
		let blocked = false;
		for (let step = 1; step < steps; step += 1) {
			const t = step / steps;
			const sampleCol = Math.round(clampedCol + dCol * t);
			const sampleRow = Math.round(clampedRow + dRow * t);
			const elevation = values[sampleRow * width + sampleCol];
			if (elevation === void 0) continue;
			const distance = Math.hypot((sampleCol - clampedCol) * cellLonMeters, (sampleRow - clampedRow) * cellLatMeters);
			if (distance <= 0) continue;
			const slope = (elevation - eyeMeters) / distance;
			if (slope > maxSlope) maxSlope = slope;
		}
		const targetElevation = values[targetRow * width + targetCol];
		if (targetElevation === void 0 || groundDistance <= 0) continue;
		blocked = (targetElevation - eyeMeters) / groundDistance <= maxSlope;
		if (!blocked) markVisible(targetRow * width + targetCol);
	}
	return {
		width,
		height,
		visible,
		bbox,
		observerGroundMeters: groundMeters,
		visibleCells
	};
}
//#endregion
//#region ../../packages/processing/src/terrain-viewshed.worker.ts
const worker = self;
worker.addEventListener("message", (event) => {
	const { dem, observer, radiusMeters } = event.data;
	try {
		const result = computeViewshed(dem, observer, radiusMeters);
		worker.postMessage({
			ok: true,
			...result
		}, [result.visible.buffer]);
	} catch (error) {
		worker.postMessage({
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}
});
//#endregion
