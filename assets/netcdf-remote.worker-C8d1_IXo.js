//#region ../../packages/plugins/src/plugins/local-netcdf.ts
/** HDF5 datatype classes we can render (numeric grids only). */
const H5T_INTEGER = 0;
const H5T_FLOAT = 1;
/** Common coordinate-variable names, longest/most-specific first. */
const LAT_NAMES = [
	"latitude",
	"lat",
	"y",
	"nav_lat"
];
const LON_NAMES = [
	"longitude",
	"lon",
	"lng",
	"x",
	"nav_lon"
];
const GENERIC_COORD_NAMES = /* @__PURE__ */ new Set(["x", "y"]);
const LAT_RANGE = [-91, 91];
const LON_RANGE = [-181, 361];
let modulePromise = null;
let fileCounter = 0;
/**
* Lazily load and initialize h5wasm. The (~5.6 MB) single-file WASM module is
* only fetched the first time a user opens a local HDF5/NetCDF-4 file, keeping
* it out of the main bundle.
*
* @returns The initialized h5wasm module namespace.
*/
async function loadH5wasm() {
	modulePromise ??= (async () => {
		const ns = await import("./hdf5_hl-BVsd_NSe.js");
		const api = ns.default ?? ns;
		const ready = api.ready ?? ns.ready;
		const File = api.File ?? ns.File;
		if (!ready || !File) throw new Error("h5wasm did not expose the expected File/ready API.");
		return {
			FS: (await ready).FS,
			File
		};
	})();
	try {
		return await modulePromise;
	} catch (err) {
		modulePromise = null;
		throw err;
	}
}
/**
* A local HDF5/NetCDF-4 file backed by h5wasm.
*/
var Hdf5NetcdfFile = class Hdf5NetcdfFile {
	mod;
	file;
	fsPath;
	/** Memoized dimension-id -> name map; see {@link dimensionScaleNames}. */
	scaleNames = null;
	constructor(mod, file, fsPath) {
		this.mod = mod;
		this.file = file;
		this.fsPath = fsPath;
	}
	/**
	* Open a local file's bytes with h5wasm.
	*
	* @param buffer The raw file bytes.
	* @returns An open file. Call {@link close} when done.
	* @throws If the bytes are not a readable HDF5 file.
	*/
	static async open(buffer) {
		const mod = await loadH5wasm();
		const fsPath = `geolibre-netcdf-${fileCounter++}.h5`;
		mod.FS.writeFile(fsPath, new Uint8Array(buffer));
		let file = null;
		try {
			file = new mod.File(fsPath, "r");
			file.keys();
			return new Hdf5NetcdfFile(mod, file, fsPath);
		} catch (err) {
			try {
				file?.close();
			} catch {}
			try {
				mod.FS.unlink(fsPath);
			} catch {}
			throw new Error(`Could not read the file as HDF5/NetCDF-4. (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	/**
	* Mount a remote file lazily and open it. See {@link openRemoteNetcdf} for the
	* constraints; this assumes they have already been checked.
	*/
	static async openLazy(url, fsPath) {
		const mod = await loadH5wasm();
		const fs = mod.FS;
		if (typeof fs.createLazyFile !== "function") throw new Error("This h5wasm build cannot read a file over HTTP without downloading it.");
		let file = null;
		try {
			fs.createLazyFile("/", fsPath, url, true, false);
			file = new mod.File(fsPath, "r");
			file.keys();
			return new Hdf5NetcdfFile(mod, file, fsPath);
		} catch (err) {
			try {
				file?.close();
			} catch {}
			try {
				mod.FS.unlink(fsPath);
			} catch {}
			throw new Error(`Could not read ${url} as HDF5/NetCDF-4 over HTTP. The server must allow cross-origin range requests. (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	close() {
		try {
			this.file.close();
		} catch {}
		try {
			this.mod.FS.unlink(this.fsPath);
		} catch {}
	}
	/** Recursively collect every dataset path in the file (no leading slash). */
	datasetPaths() {
		const out = [];
		const visit = (group, prefix) => {
			for (const key of group.keys()) {
				const entity = tryGet(group, key);
				if (!entity) continue;
				const path = prefix ? `${prefix}/${key}` : key;
				if (isDataset(entity)) out.push(path);
				else if (isGroup(entity)) visit(entity, path);
			}
		};
		visit(this.file, "");
		return out;
	}
	listVariables() {
		const out = [];
		for (const path of this.datasetPaths()) {
			const ds = tryGet(this.file, path);
			if (!isDataset(ds)) continue;
			const shape = ds.shape ?? ds.metadata.shape ?? [];
			if (shape.length < 2) continue;
			if (!isRenderableH5Dtype(ds.metadata)) continue;
			out.push({
				name: path,
				dims: this.dimensionNames(ds, shape),
				shape,
				...optionalText("longName", h5StringAttr(ds, "long_name")),
				...optionalText("units", h5StringAttr(ds, "units"))
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}
	listAxes(variable) {
		const { ds, shape, dims } = this.openVariable(variable);
		return dims.slice(0, Math.max(0, shape.length - 2)).map((name, index) => this.describeAxis(name, shape[index], variable));
	}
	/** One axis with its coordinate values, when the file provides them. */
	describeAxis(name, size, variable) {
		return {
			name,
			size,
			...this.findAxisCoordinate(name, size, variable) ?? {}
		};
	}
	buildLayerRefs(variable, selector = {}) {
		const { ds, shape, dims } = this.openVariable(variable);
		const ny = shape[shape.length - 2];
		const nx = shape[shape.length - 1];
		const sliceData = this.readPlane(ds, shape, dims, selector, variable, resolveWindow(void 0, ny, nx));
		const fillValue = h5FillValue(ds);
		const { lat, lon } = this.readCoordinates(ny, nx, variable);
		const { refs, bounds } = buildInlineZarrStore({
			variable,
			ny,
			nx,
			data: sliceData,
			dtype: h5ZarrDtype(ds.metadata),
			lat: lat.data,
			latDtype: lat.dtype,
			lon: lon.data,
			lonDtype: lon.dtype,
			fillValue,
			scaleFactor: h5NumericAttr(ds, "scale_factor"),
			addOffset: h5NumericAttr(ds, "add_offset")
		});
		return {
			refs,
			variable,
			bounds,
			clim: percentileClim(sliceData, {
				fillValue,
				scale: h5NumericAttr(ds, "scale_factor"),
				offset: h5NumericAttr(ds, "add_offset")
			})
		};
	}
	buildRgbImage(variable, options) {
		const { ds, shape, dims } = this.openVariable(variable);
		const ny = shape[shape.length - 2];
		const nx = shape[shape.length - 1];
		const axisPosition = leadingAxisPosition(dims, shape, options.axis);
		const fillValue = h5FillValue(ds);
		const whole = resolveWindow(void 0, ny, nx);
		const channels = options.indices.map((index) => this.readPlane(ds, shape, dims, {
			...options.selector,
			[dims[axisPosition]]: index
		}, variable, whole));
		const { lat, lon } = this.readCoordinates(ny, nx, variable);
		return composeRgbImage({
			ny,
			nx,
			channels,
			lat: lat.data,
			lon: lon.data,
			fillValue,
			scaleFactor: h5NumericAttr(ds, "scale_factor"),
			addOffset: h5NumericAttr(ds, "add_offset"),
			stretchPercent: options.stretchPercent,
			maxSize: options.maxSize
		});
	}
	readGrid(variable, selector = {}, window) {
		const { ds, shape, dims } = this.openVariable(variable);
		const ny = shape[shape.length - 2];
		const nx = shape[shape.length - 1];
		const view = resolveWindow(window, ny, nx);
		const { lat, lon } = this.readCoordinates(ny, nx, variable);
		const values = this.readPlane(ds, shape, dims, selector, variable, view);
		const fillValue = h5FillValue(ds);
		const scaleFactor = h5NumericAttr(ds, "scale_factor");
		const addOffset = h5NumericAttr(ds, "add_offset");
		return {
			ny: view.outRows,
			nx: view.outColumns,
			values,
			lat: decimateCoordinate(lat.data, view.row, view.outRows, view.step),
			lon: decimateCoordinate(lon.data, view.column, view.outColumns, view.step),
			fillValue,
			scaleFactor,
			addOffset,
			dataClim: percentileClim(values, {
				fillValue,
				scale: scaleFactor,
				offset: addOffset
			}) ?? [0, 1]
		};
	}
	readProfile(variable, options) {
		const { ds, shape, dims } = this.openVariable(variable);
		const axisPosition = leadingAxisPosition(dims, shape, options.axis);
		const ny = shape[shape.length - 2];
		const nx = shape[shape.length - 1];
		const row = clampIndex(options.row, ny);
		const column = clampIndex(options.column, nx);
		const ranges = [];
		for (let i = 0; i < shape.length - 2; i++) {
			if (i === axisPosition) {
				ranges.push([0, shape[i]]);
				continue;
			}
			const index = clampIndex(options.selector?.[dims[i]] ?? 0, shape[i]);
			ranges.push([index, index + 1]);
		}
		ranges.push([row, row + 1]);
		ranges.push([column, column + 1]);
		const raw = ds.slice(ranges);
		if (!isTypedArray(raw)) throw new Error(`Could not read a profile for variable "${variable}".`);
		return {
			axis: this.describeAxis(dims[axisPosition], shape[axisPosition], variable),
			values: unpackProfile(raw, {
				fillValue: h5FillValue(ds),
				scale: h5NumericAttr(ds, "scale_factor"),
				offset: h5NumericAttr(ds, "add_offset")
			})
		};
	}
	/** Resolve a variable path to its dataset, shape, and dimension names. */
	openVariable(variable) {
		const ds = tryGet(this.file, variable);
		if (!isDataset(ds)) throw new Error(`Variable "${variable}" not found in the file.`);
		const shape = ds.shape ?? ds.metadata.shape ?? [];
		if (shape.length < 2) throw new Error(`Variable "${variable}" is not a 2-D+ grid.`);
		if (!isRenderableH5Dtype(ds.metadata)) throw new Error(`Variable "${variable}" has an unsupported data type.`);
		return {
			ds,
			shape,
			dims: this.dimensionNames(ds, shape)
		};
	}
	/**
	* Read one 2-D plane, fixing every leading dimension from `selector` and
	* restricting the spatial extent to `view`.
	*/
	readPlane(ds, shape, dims, selector, variable, view) {
		const ranges = [];
		for (let i = 0; i < shape.length - 2; i++) {
			const idx = clampIndex(selector[dims[i]] ?? 0, shape[i]);
			ranges.push([idx, idx + 1]);
		}
		ranges.push([view.row, view.row + view.rows]);
		ranges.push([view.column, view.column + view.columns]);
		const data = ds.slice(ranges);
		if (!isTypedArray(data)) throw new Error(`Could not read data for variable "${variable}".`);
		return decimatePlane(data, view);
	}
	/**
	* Dimension names for a dataset, best effort and in this order:
	*
	* 1. HDF5 dimension *labels*, when the writer set them.
	* 2. The NetCDF-4 dimension ids in `_Netcdf4Coordinates`, resolved through the
	*    file's dimension scales. This is the case that matters in practice —
	*    netCDF-4 writers (EMIT among them) attach dimension *scales* and leave the
	*    label list empty, so without this every axis reads back as `dim_0`.
	* 3. `dim_<i>` for an axis nothing names.
	*/
	dimensionNames(ds, shape) {
		let labels = [];
		try {
			labels = ds.get_dimension_labels() ?? [];
		} catch {
			labels = [];
		}
		const dimIds = h5NumericArrayAttr(ds, "_Netcdf4Coordinates");
		const scales = dimIds ? this.dimensionScaleNames() : null;
		return shape.map((_, i) => {
			if (labels[i]) return labels[i];
			return (dimIds && scales ? scales.get(dimIds[i]) : void 0) ?? `dim_${i}`;
		});
	}
	/** NetCDF-4 dimension id -> dimension name, from the file's dimension scales. */
	dimensionScaleNames() {
		if (this.scaleNames) return this.scaleNames;
		const names = /* @__PURE__ */ new Map();
		for (const path of this.datasetPaths()) {
			const ds = tryGet(this.file, path);
			if (!isDataset(ds)) continue;
			if (h5StringAttr(ds, "CLASS") !== "DIMENSION_SCALE") continue;
			const id = h5NumericAttr(ds, "_Netcdf4Dimid");
			if (id === void 0) continue;
			const name = h5StringAttr(ds, "NAME") ?? path.split("/").pop() ?? path;
			if (!names.has(id)) names.set(id, name);
		}
		this.scaleNames = names;
		return names;
	}
	/** The 1-D coordinate variable that labels an axis, when the file has one. */
	findAxisCoordinate(name, size, variablePath) {
		const slash = variablePath.lastIndexOf("/");
		const group = slash >= 0 ? variablePath.slice(0, slash) : "";
		for (const path of group ? [`${group}/${name}`, name] : [name]) {
			const entity = tryGet(this.file, path);
			if (!isDataset(entity)) continue;
			const shape = entity.shape ?? entity.metadata.shape ?? [];
			if (shape.length !== 1 || shape[0] !== size) continue;
			if (!isRenderableH5Dtype(entity.metadata)) continue;
			const raw = entity.value;
			if (!isTypedArray(raw)) continue;
			const scale = h5NumericAttr(entity, "scale_factor");
			const offset = h5NumericAttr(entity, "add_offset");
			const scaled = scale !== void 0 || offset !== void 0 ? applyScale(raw, scale ?? 1, offset ?? 0) : raw;
			return {
				values: Array.from(scaled, Number),
				...optionalText("units", h5StringAttr(entity, "units")),
				...optionalText("longName", h5StringAttr(entity, "long_name"))
			};
		}
		return null;
	}
	/** Read the variable's lat/lon coordinate arrays (see {@link acceptCoordinate}). */
	readCoordinates(ny, nx, variable) {
		const lat = this.readCoordinate(LAT_NAMES, ny, variable, LAT_RANGE);
		const lon = this.readCoordinate(LON_NAMES, nx, variable, LON_RANGE);
		if (!lat || !lon) throw new Error(NO_COORDINATES_MESSAGE);
		return {
			lat,
			lon
		};
	}
	/**
	* Find a 1-D coordinate variable by common names. Grouped files often keep
	* `lat`/`lon` in the same subgroup as the variable, so every candidate name in
	* the variable's own group is tried before falling back to root.
	*/
	readCoordinate(names, length, variablePath, range) {
		const slash = variablePath.lastIndexOf("/");
		const group = slash >= 0 ? variablePath.slice(0, slash) : "";
		const candidates = group ? [...names.map((name) => `${group}/${name}`), ...names] : names;
		for (const path of candidates) {
			const entity = tryGet(this.file, path);
			if (!isDataset(entity)) continue;
			const shape = entity.shape ?? entity.metadata.shape ?? [];
			if (shape.length !== 1 || shape[0] !== length) continue;
			if (!isRenderableH5Dtype(entity.metadata)) continue;
			if (!isTrustedCoordinate(path.split("/").pop() ?? path, h5StringAttr(entity, "units"), h5StringAttr(entity, "standard_name"))) continue;
			const raw = entity.value;
			if (!isTypedArray(raw)) continue;
			const accepted = acceptCoordinate(raw, h5ZarrDtype(entity.metadata), h5NumericAttr(entity, "scale_factor"), h5NumericAttr(entity, "add_offset"), range);
			if (accepted) return accepted;
		}
		return null;
	}
};
/**
* Open a **remote** HDF5/NetCDF-4 file over HTTP without downloading it, reading
* only the byte ranges the caller actually touches.
*
* Backed by emscripten's lazy filesystem, which faults in 1 MiB ranges on
* demand. Two consequences the caller has to live with:
*
* - It uses **synchronous** `XMLHttpRequest`, which browsers forbid on the main
*   thread, so this only runs inside a Web Worker. It throws a clear error
*   rather than emscripten's `abort()` when called anywhere else.
* - Those requests are issued one at a time with no readahead, so a read that
*   touches many ranges is latency-bound. Reading one 285-band EMIT scene's
*   band plane pulls ~135 MB of a 1.1 GB file (an 8x saving) but takes ~20 s,
*   and a whole-band-axis profile at one pixel takes ~35 s. It is the right
*   trade for a cube far larger than the slice wanted, and the wrong one for a
*   file small enough to just fetch (see {@link openLocalNetcdf}).
*
* The server must send `Accept-Ranges: bytes` and permit the origin via CORS;
* without byte serving emscripten silently falls back to fetching everything, so
* {@link assertByteServing} checks for it up front rather than letting a 1 GB
* cube download itself one blocking chunk at a time.
*
* @param url The file's URL.
* @param name A filesystem name for the mount, unique per open.
* @returns An open {@link LocalNetcdfFile}, identical in behaviour to a local one.
* @throws If called outside a worker, the server does not serve byte ranges, or
*   the file is not readable as HDF5.
*/
async function openRemoteNetcdf(url, name) {
	if (typeof WorkerGlobalScope === "undefined") throw new Error("Reading a NetCDF/HDF file over HTTP without downloading it needs a Web Worker (it uses synchronous range requests).");
	await assertByteServing(url);
	return Hdf5NetcdfFile.openLazy(url, name ?? `geolibre-remote-${fileCounter++}.h5`);
}
/**
* Reject a URL whose server will not serve byte ranges, before anything mounts it.
*
* The lazy filesystem has no way to report this: a server that ignores `Range`
* answers with the whole entity, which emscripten accepts, so the "read only what
* you look at" mount quietly becomes a full download — issued as blocking
* synchronous requests, which for a 1 GB cube is an unresponsive worker with no
* error and no progress. One 1-byte request up front turns that into a message.
*
* The status is the check that matters: `206` cannot be faked by a server that
* ignored the header, and unlike `Content-Range` it is readable cross-origin
* regardless of `Access-Control-Expose-Headers` — so a range-capable server that
* simply does not expose that header must still pass. It is validated only when
* the response actually carries it.
*
* @param url The file's URL.
* @throws If the URL is unreachable, errors, or answers a range request whole.
*/
async function assertByteServing(url) {
	let response;
	try {
		response = await fetch(url, { headers: { Range: "bytes=0-0" } });
	} catch (err) {
		throw new Error(`Could not reach ${url}. The server must allow cross-origin requests. (${err instanceof Error ? err.message : String(err)})`);
	}
	response.body?.cancel().catch(() => {});
	if (!response.ok) throw new Error(`The server answered ${response.status} ${response.statusText} for ${url}.`);
	if (response.status !== 206) throw new Error(`${url} cannot be read in place: the server ignored a byte-range request (answered ${response.status}, not 206). Download the file and open it locally instead.`);
	const contentRange = response.headers.get("content-range");
	if (contentRange && !/^\s*bytes\s+0-0\//i.test(contentRange)) throw new Error(`${url} cannot be read in place: the server answered a byte-range request with an unexpected range ("${contentRange}").`);
}
const NO_COORDINATES_MESSAGE = "Could not find geographic latitude/longitude coordinate variables. Only NetCDF/HDF grids on a WGS84 lat/lon axis are supported.";
/**
* Apply a coordinate's scale_factor/add_offset (so packed scaled-integer lat/lon
* become degrees) and reject it unless every value is finite and inside the
* geographic range (guards generic `x`/`y` projected axes in metres).
*/
function acceptCoordinate(raw, nativeDtype, scale, offset, range) {
	const { data, dtype } = scale !== void 0 || offset !== void 0 ? {
		data: applyScale(raw, scale ?? 1, offset ?? 0),
		dtype: "<f8"
	} : {
		data: raw,
		dtype: nativeDtype
	};
	return valuesWithin(data, range) ? {
		data,
		dtype
	} : null;
}
/**
* Whether a candidate coordinate should be accepted for the given name. A
* strong name (lat/latitude/lon/longitude/...) is trusted directly; a generic
* `x`/`y` is only trusted when a CF `units` ("degrees_north"/"degrees_east"/...)
* or `standard_name` ("latitude"/"longitude") attribute confirms it is
* geographic, so projected/pixel-index axes are not read as degrees.
*
* @param name The candidate variable's base name (case-insensitive).
* @param units The variable's `units` attribute, if any.
* @param standardName The variable's `standard_name` attribute, if any.
*/
function isTrustedCoordinate(name, units, standardName) {
	if (!GENERIC_COORD_NAMES.has(name.toLowerCase())) return true;
	if (units && /degree/i.test(units)) return true;
	const s = standardName?.toLowerCase();
	return s === "latitude" || s === "longitude";
}
/**
* Normalize a fill/nodata value into a Zarr v2 fill value. Non-finite values
* need their string form; a bare Infinity would otherwise be turned into null
* by JSON.stringify, dropping the marker.
*/
function normalizeFillValue(value) {
	if (typeof value !== "number") return null;
	if (Number.isNaN(value)) return "NaN";
	if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
	return value;
}
/**
* {@link buildInlineZarrRefs} plus the grid's geographic extent.
*
* The extent has to come from here rather than from the caller's own lat/lon,
* because the longitude roll below can move the data: reporting the pre-roll
* extent would fly the camera to the wrong hemisphere. It is what makes "Zoom
* to layer" work for the resulting layer — the renderer never tells the host
* where the grid landed.
*
* @param grid The grid values, coordinate arrays, dtypes, and optional
*   fill/scale/offset attributes.
* @returns The reference map and its `[west, south, east, north]` extent.
*/
function buildInlineZarrStore(grid) {
	if (grid.variable === "lat" || grid.variable === "lon") throw new Error(`Variable name "${grid.variable}" collides with a coordinate array.`);
	const refs = { ".zgroup": "{\"zarr_format\":2}" };
	const rolled = rollLongitude(grid);
	const data = rolled?.data ?? grid.data;
	const lon = rolled?.lon ?? grid.lon;
	const lonDtype = rolled ? "<f8" : grid.lonDtype;
	const attrs = { _ARRAY_DIMENSIONS: ["lat", "lon"] };
	if (grid.scaleFactor !== void 0) attrs.scale_factor = grid.scaleFactor;
	if (grid.addOffset !== void 0) attrs.add_offset = grid.addOffset;
	writeZarrArray(refs, grid.variable, {
		shape: [grid.ny, grid.nx],
		dtype: grid.dtype,
		data: typedArrayBytes(data),
		fillValue: grid.fillValue ?? null,
		attrs
	});
	writeZarrArray(refs, "lat", {
		shape: [grid.ny],
		dtype: grid.latDtype,
		data: typedArrayBytes(grid.lat),
		attrs: { _ARRAY_DIMENSIONS: ["lat"] }
	});
	writeZarrArray(refs, "lon", {
		shape: [grid.nx],
		dtype: lonDtype,
		data: typedArrayBytes(lon),
		attrs: { _ARRAY_DIMENSIONS: ["lon"] }
	});
	return {
		refs,
		bounds: gridBounds(grid.lat, lon)
	};
}
/**
* The geographic extent covered by a grid, from its cell-centre coordinates.
*
* Coordinate arrays name cell *centres*, so the extent runs half a cell past the
* first and last entry — without that a single-row grid would have zero height
* and `fitBounds` would refuse it.
*
* @param lat Latitude cell centres.
* @param lon Longitude cell centres.
* @returns `[west, south, east, north]`, clamped to valid WGS84 ranges.
*/
function gridBounds(lat, lon) {
	const [south, north] = centresToEdges(lat);
	const [west, east] = centresToEdges(lon);
	return [
		Math.max(-180, west),
		Math.max(-90, south),
		Math.min(180, east),
		Math.min(90, north)
	];
}
/** Min/max of cell centres, expanded by half the mean cell size. */
function centresToEdges(values) {
	let min = Infinity;
	let max = -Infinity;
	for (let i = 0; i < values.length; i++) {
		const v = Number(values[i]);
		if (!Number.isFinite(v)) continue;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 0];
	const half = values.length > 1 ? (max - min) / (values.length - 1) / 2 : 0;
	return [min - half, max + half];
}
/**
* Roll a grid whose longitude runs 0..360 into a -180..180 layout, reordering
* both the longitude coordinate and the data columns. Returns null (no change)
* for grids already on a -180..180 (or non-monotonic) longitude axis.
*
* @param grid The grid to inspect.
* @returns The rolled data and longitude, or null if no roll is needed.
*/
function rollLongitude(grid) {
	const { nx, ny } = grid;
	const split = longitudeRollSplit(grid.lon, nx);
	if (split === null) return null;
	const newLon = rollLongitudeValues(grid.lon, split);
	const src = grid.data;
	const dst = emptyLike(src);
	for (let r = 0; r < ny; r++) {
		const row = r * nx;
		for (let j = 0; j < nx - split; j++) dst[row + j] = src[row + split + j];
		for (let j = 0; j < split; j++) dst[row + nx - split + j] = src[row + j];
	}
	return {
		data: dst,
		lon: newLon
	};
}
/**
* The column a 0..360 longitude axis has to be rotated about to become
* -180..180, or null when the axis needs no roll.
*
* Shared by the Zarr and RGB paths so a global grid lands in the same place
* whichever one draws it.
*
* @param lon The longitude cell centres.
* @param nx Their count.
* @returns The index of the first entry at or past 180, or null.
*/
function longitudeRollSplit(lon, nx) {
	let min = Infinity;
	let max = -Infinity;
	let ascending = true;
	for (let i = 0; i < nx; i++) {
		const v = Number(lon[i]);
		if (!Number.isFinite(v)) {
			ascending = false;
			continue;
		}
		if (v < min) min = v;
		if (v > max) max = v;
		if (i > 0 && v <= Number(lon[i - 1])) ascending = false;
	}
	if (!ascending || min < 0 || max <= 180 || max >= 360) return null;
	let split = 0;
	while (split < nx && Number(lon[split]) < 180) split++;
	return split === 0 || split >= nx ? null : split;
}
/** Rotate a longitude axis about `split`, wrapping the tail to negative degrees. */
function rollLongitudeValues(lon, split) {
	const nx = lon.length;
	const rolled = new Float64Array(nx);
	for (let j = 0; j < nx - split; j++) rolled[j] = Number(lon[split + j]) - 360;
	for (let j = 0; j < split; j++) rolled[nx - split + j] = Number(lon[j]);
	return rolled;
}
/** Allocate a new, zero-filled typed array of the same kind and length. */
function emptyLike(a) {
	const Ctor = a.constructor;
	return new Ctor(a.length);
}
/**
* Write the `.zarray`, `.zattrs`, and single inline chunk for one array into a
* reference map. The chunk spans the whole array (chunks == shape), so the key
* is `name/0`, `name/0.0`, ... depending on rank.
*/
function writeZarrArray(refs, name, spec) {
	refs[`${name}/.zarray`] = JSON.stringify({
		zarr_format: 2,
		shape: spec.shape,
		chunks: spec.shape,
		dtype: spec.dtype,
		compressor: null,
		fill_value: spec.fillValue ?? null,
		filters: null,
		order: "C"
	});
	refs[`${name}/.zattrs`] = JSON.stringify(spec.attrs);
	const chunkKey = `${name}/${spec.shape.map(() => "0").join(".")}`;
	refs[chunkKey] = `base64:${base64Encode(spec.data)}`;
}
/** Default percentile trimmed off each end of a channel/color range. */
const DEFAULT_STRETCH_PERCENT = 2;
/** Default cap on the longest edge of a composed RGB image. */
const DEFAULT_MAX_IMAGE_SIZE = 4096;
/** Ceiling on the sample drawn for a percentile; larger grids are strided. */
const MAX_PERCENTILE_SAMPLES = 2e5;
/**
* Robust color limits for a grid: the `stretchPercent`/`100 - stretchPercent`
* percentiles of its finite, non-fill values, in physical units.
*
* A NetCDF grid's natural range is rarely the renderer's stock 0-300 default —
* reflectance is 0-1, a sensor zenith angle 0-90 — so without this the first
* paint is a flat wash and the layer reads as broken. Percentiles rather than
* min/max so a handful of outliers do not flatten everything else.
*
* @param data The raw (still packed) grid values.
* @param decoding Fill value and any `scale_factor`/`add_offset`.
* @param stretchPercent Percentile trimmed off each end (default 2).
* @returns `[min, max]` in physical units, or null when the sample has no
*   spread (an all-fill or constant grid).
*/
function percentileClim(data, decoding = {}, stretchPercent = DEFAULT_STRETCH_PERCENT) {
	const sample = sampleValues(data, decoding);
	if (sample.length === 0) return null;
	sample.sort((a, b) => a - b);
	const fraction = Math.min(Math.max(stretchPercent, 0), 49) / 100;
	const min = quantile(sample, fraction);
	const max = quantile(sample, 1 - fraction);
	if (min < max) return [min, max];
	const low = sample[0];
	const high = sample[sample.length - 1];
	return low < high ? [low, high] : null;
}
/** Finite, non-fill values in physical units, strided down to a bounded sample. */
function sampleValues(data, decoding) {
	const fill = typeof decoding.fillValue === "number" ? decoding.fillValue : null;
	const scale = decoding.scale ?? 1;
	const offset = decoding.offset ?? 0;
	const stride = Math.max(1, Math.ceil(data.length / MAX_PERCENTILE_SAMPLES));
	const out = [];
	for (let i = 0; i < data.length; i += stride) {
		const raw = Number(data[i]);
		if (!Number.isFinite(raw)) continue;
		if (fill !== null && raw === fill) continue;
		const value = raw * scale + offset;
		if (Number.isFinite(value)) out.push(value);
	}
	return out;
}
/** Linearly interpolated quantile of an ascending sample. */
function quantile(sorted, fraction) {
	const position = fraction * (sorted.length - 1);
	const lower = Math.floor(position);
	const upper = Math.min(sorted.length - 1, Math.ceil(position));
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
/**
* Compose three grid planes into a north-up RGBA image plus the corner
* coordinates a MapLibre `image` source needs.
*
* Each channel is stretched independently (the usual per-band percentile
* stretch), so a natural-color composite from a hyperspectral cube is legible
* without the user hand-tuning three sets of limits. Fill/nodata cells become
* fully transparent rather than black, so the scene's ragged swath edges do not
* paint a rectangle over the basemap.
*
* The output is always north-up and west-first regardless of how the file
* orders its coordinates, because an `image` source's corners are fixed points
* and cannot express a flipped axis.
*
* @param input The three channels, their coordinates, and the stretch options.
* @returns The RGBA image, its extent, and the per-channel ranges used.
* @throws If `channels` does not hold exactly three `ny * nx` planes.
*/
function composeRgbImage(input) {
	const { ny, nx, channels } = input;
	if (channels.length !== 3) throw new Error("An RGB composite needs exactly three channels.");
	for (const channel of channels) if (channel.length < ny * nx) throw new Error("A channel is smaller than the grid it belongs to.");
	const decoding = {
		fillValue: input.fillValue,
		scale: input.scaleFactor,
		offset: input.addOffset
	};
	const fill = typeof input.fillValue === "number" ? input.fillValue : null;
	const scale = input.scaleFactor ?? 1;
	const offset = input.addOffset ?? 0;
	const ranges = channels.map((channel) => percentileClim(channel, decoding, input.stretchPercent) ?? [0, 1]);
	const layout = imageLayout(input);
	const pixels = new Uint8ClampedArray(layout.width * layout.height * 4);
	for (let row = 0; row < layout.height; row++) for (let col = 0; col < layout.width; col++) {
		const index = layout.sourceIndex(row, col);
		const target = (row * layout.width + col) * 4;
		let opaque = true;
		for (let c = 0; c < 3; c++) {
			const raw = Number(channels[c][index]);
			if (!Number.isFinite(raw) || fill !== null && raw === fill) {
				opaque = false;
				break;
			}
			const [min, max] = ranges[c];
			const value = raw * scale + offset;
			pixels[target + c] = Math.round((value - min) / (max - min) * 255);
		}
		if (!opaque) {
			pixels[target] = 0;
			pixels[target + 1] = 0;
			pixels[target + 2] = 0;
		}
		pixels[target + 3] = opaque ? 255 : 0;
	}
	return {
		...layout.frame(),
		width: layout.width,
		height: layout.height,
		pixels,
		channelRanges: ranges
	};
}
/**
* Whether a coordinate axis runs high-to-low, decided from its first and last
* **finite** entries.
*
* The endpoints cannot be trusted blindly: a swath-edge quality artifact can
* leave `NaN` in the first or last cell centre while the rest of the axis is
* monotonic, and every comparison against `NaN` is false — which would read a
* descending axis as ascending and mirror the image, over a `gridBounds` extent
* computed from the same array that still comes out right. `centresToEdges`
* already skips non-finite entries for exactly this reason.
*
* @param values The cell centres.
* @param count How many of them the grid uses.
* @returns True when the axis descends; false when it ascends, is flat, or has
*   fewer than two finite entries to compare.
*/
function axisDescends(values, count) {
	let first = null;
	let last = null;
	for (let i = 0; i < count; i++) {
		const v = Number(values[i]);
		if (!Number.isFinite(v)) continue;
		if (first === null) first = v;
		last = v;
	}
	if (first === null || last === null) return false;
	return first > last;
}
/**
* The output size and the source-index mapping shared by both image composers:
* decimation to `maxSize`, the 0..360 longitude roll, and the row/column flips
* that make the result north-up and west-first (an `image` source's corners are
* fixed points and cannot express a flipped axis).
*/
function imageLayout(input) {
	const { ny, nx } = input;
	const split = longitudeRollSplit(input.lon, nx);
	const columnOf = (x) => split === null ? x : (x + split) % nx;
	const rolledLon = split === null ? input.lon : rollLongitudeValues(input.lon, split);
	const latDescending = axisDescends(input.lat, ny);
	const lonDescending = axisDescends(rolledLon, nx);
	const step = Math.max(1, Math.ceil(Math.max(ny, nx) / Math.max(1, input.maxSize ?? DEFAULT_MAX_IMAGE_SIZE)));
	const height = Math.ceil(ny / step);
	return {
		width: Math.ceil(nx / step),
		height,
		sourceIndex: (row, col) => {
			const sourceRow = latDescending ? row * step : ny - 1 - row * step;
			const sourceCol = lonDescending ? nx - 1 - col * step : col * step;
			return sourceRow * nx + columnOf(sourceCol);
		},
		frame: () => {
			const bounds = gridBounds(input.lat, rolledLon);
			const [west, south, east, north] = bounds;
			return {
				bounds,
				coordinates: [
					[west, north],
					[east, north],
					[east, south],
					[west, south]
				]
			};
		}
	};
}
/**
* Unpack raw profile readings into physical units, nulling out fill and
* non-finite entries so a chart breaks its line instead of plotting a spike at
* the nodata value.
*
* @param raw The readings straight from the file.
* @param decoding Fill value and any `scale_factor`/`add_offset`.
* @returns One value (or null) per reading.
*/
function unpackProfile(raw, decoding) {
	const fill = typeof decoding.fillValue === "number" ? decoding.fillValue : null;
	const scale = decoding.scale ?? 1;
	const offset = decoding.offset ?? 0;
	return Array.from(raw, (entry) => {
		const value = Number(entry);
		if (!Number.isFinite(value) || fill !== null && value === fill) return null;
		const physical = value * scale + offset;
		return Number.isFinite(physical) ? physical : null;
	});
}
/** Index of the leading dimension named `axis`, or a thrown explanation. */
function leadingAxisPosition(dims, shape, axis) {
	const leading = Math.max(0, shape.length - 2);
	const position = dims.slice(0, leading).indexOf(axis);
	if (position < 0) throw new Error(`"${axis}" is not one of this variable's non-spatial dimensions (${dims.slice(0, leading).join(", ") || "none"}).`);
	return position;
}
/** A `{ key: value }` fragment, or nothing when the value is absent/blank. */
function optionalText(key, value) {
	return value ? { [key]: value } : {};
}
/** Map an h5wasm datatype to a little-endian Zarr v2 dtype string. */
function h5ZarrDtype(meta) {
	if (meta.type === H5T_FLOAT) return `<f${meta.size}`;
	if (meta.type === H5T_INTEGER) return `${meta.signed ? "<i" : "<u"}${meta.size}`;
	throw new Error(`Unsupported HDF5 datatype (class ${meta.type}).`);
}
/** Whether an HDF5 datatype is a numeric class we can render. */
function isRenderableH5Dtype(meta) {
	if (meta.type === H5T_FLOAT) return meta.size === 4 || meta.size === 8;
	if (meta.type === H5T_INTEGER) return meta.size === 1 || meta.size === 2 || meta.size === 4;
	return false;
}
/**
* Copy a typed array's raw bytes. x86/ARM hosts are little-endian, which
* matches the `<`-prefixed Zarr dtypes we emit, so no byte-swapping is needed.
*/
function typedArrayBytes(arr) {
	return new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}
/** Encode bytes as base64 in chunks (avoids String.fromCharCode arg limits). */
function base64Encode(bytes) {
	const parts = [];
	const CHUNK = 32768;
	for (let i = 0; i < bytes.length; i += CHUNK) parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
	return btoa(parts.join(""));
}
/** Read a numeric scalar HDF5 attribute, or undefined if absent/non-numeric. */
function h5NumericAttr(ds, name) {
	const value = unwrapScalar(ds.attrs[name]?.value);
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/**
* Read a numeric *vector* HDF5 attribute (e.g. NetCDF-4's `_Netcdf4Coordinates`,
* the dimension ids of each axis), or undefined when absent or non-numeric.
*/
function h5NumericArrayAttr(ds, name) {
	const value = ds.attrs[name]?.value;
	if (isTypedArray(value)) return Array.from(value, Number);
	if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) return value;
}
/** Read a string HDF5 attribute, or undefined if absent/non-string. */
function h5StringAttr(ds, name) {
	const value = unwrapScalar(ds.attrs[name]?.value);
	return typeof value === "string" ? value : void 0;
}
/** Determine the Zarr fill value from an HDF5 `_FillValue`/`missing_value`. */
function h5FillValue(ds) {
	for (const key of ["_FillValue", "missing_value"]) {
		const value = unwrapScalar(ds.attrs[key]?.value);
		if (typeof value === "number") return normalizeFillValue(value);
	}
	return null;
}
/** Reduce a possibly-array attribute value to its first scalar. */
function unwrapScalar(value) {
	if (isTypedArray(value)) return value.length > 0 ? value[0] : void 0;
	if (Array.isArray(value)) return value.length > 0 ? value[0] : void 0;
	return value;
}
/** Apply `value * scale + offset` to every element, into a new Float64Array. */
function applyScale(arr, scale, offset) {
	const out = new Float64Array(arr.length);
	for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]) * scale + offset;
	return out;
}
/** Whether every value in the array is finite and falls within `[min, max]`. */
function valuesWithin(arr, [min, max]) {
	for (let i = 0; i < arr.length; i++) {
		const v = Number(arr[i]);
		if (!Number.isFinite(v) || v < min || v > max) return false;
	}
	return true;
}
/** Look up a child entity, returning null if h5wasm throws (broken link). */
function tryGet(group, name) {
	try {
		return group.get(name);
	} catch {
		return null;
	}
}
/** Clamp a selector index into `[0, size)`. */
function clampIndex(index, size) {
	if (!Number.isFinite(index)) return 0;
	return Math.min(Math.max(0, Math.trunc(index)), Math.max(0, size - 1));
}
/**
* Clamp a requested window to a grid and resolve its decimation stride.
*
* One stride for both axes rather than one each, so the result keeps the
* window's aspect ratio: a cube drawn from a stretched grid would be visibly
* wrong, and there is no cheap way to un-stretch it afterwards.
*
* @param window - The requested window, or undefined for the whole plane.
* @param ny - The variable's row count.
* @param nx - The variable's column count.
* @returns The window actually readable, and the result's size.
*/
function resolveWindow(window, ny, nx) {
	const row = window ? clampIndex(window.row, ny) : 0;
	const column = window ? clampIndex(window.column, nx) : 0;
	const span = (requested, start, size) => Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), size - start) : size - start;
	const rows = window ? span(window.rows, row, ny) : ny;
	const columns = window ? span(window.columns, column, nx) : nx;
	const maxSize = window?.maxSize;
	const step = maxSize !== void 0 && Number.isFinite(maxSize) && maxSize >= 1 ? Math.max(1, Math.ceil(Math.max(rows, columns) / Math.trunc(maxSize))) : 1;
	return {
		row,
		column,
		rows,
		columns,
		step,
		outRows: Math.ceil(rows / step),
		outColumns: Math.ceil(columns / step)
	};
}
/** A new typed array of the same kind as `like`. */
function makeLike(like, length) {
	const Ctor = like.constructor;
	return new Ctor(length);
}
/**
* Decimate a window-sized plane by its stride, taking every `step`-th cell.
*
* Nearest neighbour, not an average: the values may be packed integers or carry
* a fill value, and averaging either would invent readings the file does not
* contain.
*
* @param plane - The `window.rows * window.columns` cells, row-major.
* @param window - The resolved window the plane was read for.
* @returns The decimated plane, or `plane` itself when the stride is 1.
*/
function decimatePlane(plane, window) {
	if (window.step === 1) return plane;
	const out = makeLike(plane, window.outRows * window.outColumns);
	for (let y = 0; y < window.outRows; y++) {
		const sourceRow = y * window.step * window.columns;
		const targetRow = y * window.outColumns;
		for (let x = 0; x < window.outColumns; x++) out[targetRow + x] = plane[sourceRow + x * window.step];
	}
	return out;
}
/** The window's slice of a coordinate axis, decimated to match the plane. */
function decimateCoordinate(coordinate, start, count, step) {
	if (step === 1 && start === 0 && count === coordinate.length) return coordinate;
	const out = makeLike(coordinate, count);
	for (let i = 0; i < count; i++) out[i] = coordinate[start + i * step];
	return out;
}
function isTypedArray(value) {
	return ArrayBuffer.isView(value) && !(value instanceof DataView);
}
function isDataset(value) {
	return typeof value === "object" && value !== null && "metadata" in value && typeof value.slice === "function";
}
function isGroup(value) {
	return typeof value === "object" && value !== null && typeof value.keys === "function" && typeof value.get === "function";
}
//#endregion
//#region src/workers/netcdf-remote.worker.ts
let file = null;
/** The open file, or a thrown explanation when `open` has not run. */
function requireFile() {
	if (!file) throw new Error("No remote NetCDF file is open in this worker.");
	return file;
}
async function handle(request) {
	switch (request.type) {
		case "open":
			file?.close();
			file = await openRemoteNetcdf(request.url);
			return file.listVariables();
		case "listAxes": return requireFile().listAxes(request.variable);
		case "readGrid": return requireFile().readGrid(request.variable, request.selector, request.window);
		case "readProfile": return requireFile().readProfile(request.variable, {
			axis: request.axis,
			row: request.row,
			column: request.column,
			selector: request.selector
		});
	}
}
self.onmessage = async (event) => {
	const request = event.data;
	try {
		const result = await handle(request);
		const transfer = request.type === "readGrid" ? [
			result.values.buffer,
			result.lat.buffer,
			result.lon.buffer
		].filter((buffer) => buffer instanceof ArrayBuffer) : [];
		self.postMessage({
			id: request.id,
			ok: true,
			result
		}, transfer);
	} catch (error) {
		self.postMessage({
			id: request.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}
};
self.postMessage({ ready: true });
//#endregion
