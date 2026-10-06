//#region src/lib/osm-shared-array-buffer-shim.ts
if (typeof globalThis.SharedArrayBuffer === "undefined") globalThis.SharedArrayBuffer = ArrayBuffer;
//#endregion
//#region ../../node_modules/@osmix/shared/dist/content-hasher.js
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
/**
* FNV-1a hash implementation for Uint8Array.
* Fast, non-cryptographic hash suitable for content comparison.
*/
function fnv1aHash(data, initialHash = FNV_OFFSET_BASIS) {
	let hash = initialHash;
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i];
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return hash >>> 0;
}
/**
* Hash state that can be incrementally updated with multiple buffers.
*/
var ContentHasher = class {
	hash = FNV_OFFSET_BASIS;
	/**
	* Update the hash with a typed array's underlying bytes.
	*/
	update(data) {
		const buffer = data instanceof ArrayBuffer ? data : data.buffer;
		const bytes = new Uint8Array(buffer);
		this.hash = fnv1aHash(bytes, this.hash);
		return this;
	}
	/**
	* Update the hash with a number (as 8 bytes).
	*/
	updateNumber(n) {
		const buffer = /* @__PURE__ */ new ArrayBuffer(8);
		new Float64Array(buffer)[0] = n;
		return this.update(buffer);
	}
	/**
	* Get the final hash as a hex string.
	*/
	digest() {
		return this.hash.toString(16).padStart(8, "0");
	}
	/**
	* Get the raw hash value.
	*/
	digestNumber() {
		return this.hash;
	}
};
//#endregion
//#region ../../node_modules/@osmix/shared/dist/assert.js
/**
* Assertion utilities for defensive programming.
*
* Provides typed assertion helpers that throw errors when conditions are not met,
* commonly used for index bounds checking and null/undefined guards.
*
* @module
*/
/**
* Assert that a value is neither null nor undefined.
*
* @param value - The value to check.
* @param message - Optional error message if assertion fails.
* @throws Error if value is null or undefined.
*
* @example
* ```ts
* const item = array[index]
* assertValue(item, `No item at index ${index}`)
* // TypeScript now knows item is non-nullable
* ```
*/
function assertValue(value, message) {
	if (value === void 0 || value === null) throw Error(message ?? "Value is undefined or null");
}
//#endregion
//#region ../../node_modules/@osmix/shared/dist/coordinates.js
/**
* Coordinate precision utilities for OSM data.
*
* OSM stores coordinates as integer microdegrees (7 decimal places) for
* compact storage and consistent precision. This module provides conversions
* between floating-point degrees and integer microdegrees.
*
* @module
*/
/**
* OSM coordinate scale: coordinates are stored as integer microdegrees.
* 1 microdegree = 1e-7 degrees = 0.0000001 degrees
*/
const OSM_COORD_SCALE = 1e7;
/**
* Convert degrees to microdegrees (integer).
*/
function toMicroDegrees(degrees) {
	return Math.round(degrees * OSM_COORD_SCALE);
}
/**
* Convert microdegrees (integer) to degrees (float).
*/
function microToDegrees(microdegrees) {
	return microdegrees / OSM_COORD_SCALE;
}
//#endregion
//#region ../../node_modules/geokdbush/node_modules/tinyqueue/index.js
var TinyQueue = class {
	constructor(data = [], compare = (a, b) => a < b ? -1 : a > b ? 1 : 0) {
		this.data = data;
		this.length = this.data.length;
		this.compare = compare;
		if (this.length > 0) for (let i = (this.length >> 1) - 1; i >= 0; i--) this._down(i);
	}
	push(item) {
		this.data.push(item);
		this._up(this.length++);
	}
	pop() {
		if (this.length === 0) return void 0;
		const top = this.data[0];
		const bottom = this.data.pop();
		if (--this.length > 0) {
			this.data[0] = bottom;
			this._down(0);
		}
		return top;
	}
	peek() {
		return this.data[0];
	}
	_up(pos) {
		const { data, compare } = this;
		const item = data[pos];
		while (pos > 0) {
			const parent = pos - 1 >> 1;
			const current = data[parent];
			if (compare(item, current) >= 0) break;
			data[pos] = current;
			pos = parent;
		}
		data[pos] = item;
	}
	_down(pos) {
		const { data, compare } = this;
		const halfLength = this.length >> 1;
		const item = data[pos];
		while (pos < halfLength) {
			let bestChild = (pos << 1) + 1;
			const right = bestChild + 1;
			if (right < this.length && compare(data[right], data[bestChild]) < 0) bestChild = right;
			if (compare(data[bestChild], item) >= 0) break;
			data[pos] = data[bestChild];
			pos = bestChild;
		}
		data[pos] = item;
	}
};
//#endregion
//#region ../../node_modules/geokdbush/index.js
const earthRadius$1 = 6371;
const rad$1 = Math.PI / 180;
/**
* @typedef {object} Node
* @prop {number} left left index in the kd-tree array
* @prop {number} right right index in the kd-tree array
* @prop {number} axis 0 for longitude and 1 for latitude axis
* @prop {number} dist the lower bound of children's distances to the query point
* @prop {number} minLng
* @prop {number} minLat
* @prop {number} maxLng
* @prop {number} maxLat
*/
/**
* @typedef {{ id: number, dist: number }} QueueItem
*/
/**
* Returns an array of the closest points from a given location in order of increasing distance.
*
* @param {import('kdbush').default} index kdbush index
* @param {number} lng Query point longitude
* @param {number} lat Query point latitude
* @param {number} [maxResults] Maximum number of points to return
* @param {number} [maxDistance] Maximum distance in kilometers to search within
* @param {(item: number) => boolean} [predicate] A function to filter the results
*/
function around$1(index, lng, lat, maxResults = Infinity, maxDistance = Infinity, predicate) {
	let maxHaverSinDist = 1;
	const result = [];
	if (maxResults === void 0) maxResults = Infinity;
	if (maxDistance !== void 0) maxHaverSinDist = haverSin(maxDistance / earthRadius$1);
	/**
	* a distance-sorted priority queue that will contain both points and kd-tree nodes
	* @type {TinyQueue<QueueItem|Node>}
	*/
	const q = new TinyQueue([], compareDist);
	/**
	* an object that represents the top kd-tree node (the whole Earth)
	* @type {Node|undefined}
	*/
	let node = {
		left: 0,
		right: index.ids.length - 1,
		axis: 0,
		dist: 0,
		minLng: -180,
		minLat: -90,
		maxLng: 180,
		maxLat: 90
	};
	const cosLat = Math.cos(lat * rad$1);
	while (node) {
		const right = node.right;
		const left = node.left;
		if (right - left <= index.nodeSize) for (let i = left; i <= right; i++) {
			const id = index.ids[i];
			if (!predicate || predicate(id)) {
				const dist = haverSinDist(lng, lat, index.coords[2 * i], index.coords[2 * i + 1], cosLat);
				q.push({
					id,
					dist
				});
			}
		}
		else {
			const m = left + right >> 1;
			const midLng = index.coords[2 * m];
			const midLat = index.coords[2 * m + 1];
			const id = index.ids[m];
			if (!predicate || predicate(id)) {
				const dist = haverSinDist(lng, lat, midLng, midLat, cosLat);
				q.push({
					id,
					dist
				});
			}
			const nextAxis = (node.axis + 1) % 2;
			const leftNode = {
				left,
				right: m - 1,
				axis: nextAxis,
				minLng: node.minLng,
				minLat: node.minLat,
				maxLng: node.axis === 0 ? midLng : node.maxLng,
				maxLat: node.axis === 1 ? midLat : node.maxLat,
				dist: 0
			};
			const rightNode = {
				left: m + 1,
				right,
				axis: nextAxis,
				minLng: node.axis === 0 ? midLng : node.minLng,
				minLat: node.axis === 1 ? midLat : node.minLat,
				maxLng: node.maxLng,
				maxLat: node.maxLat,
				dist: 0
			};
			leftNode.dist = boxDist(lng, lat, cosLat, leftNode);
			rightNode.dist = boxDist(lng, lat, cosLat, rightNode);
			q.push(leftNode);
			q.push(rightNode);
		}
		let candidate;
		while ((candidate = q.pop()) && "id" in candidate) {
			if (candidate.dist > maxHaverSinDist) return result;
			result.push(candidate.id);
			if (result.length === maxResults) return result;
		}
		node = candidate;
	}
	return result;
}
/**
* lower bound for distance from a location to points inside a bounding box
* @param {number} lng
* @param {number} lat
* @param {number} cosLat
* @param {{ minLng: number, maxLng: number, minLat: number, maxLat: number }} node
*/
function boxDist(lng, lat, cosLat, node) {
	const minLng = node.minLng;
	const maxLng = node.maxLng;
	const minLat = node.minLat;
	const maxLat = node.maxLat;
	if (lng >= minLng && lng <= maxLng) {
		if (lat < minLat) return haverSin((lat - minLat) * rad$1);
		if (lat > maxLat) return haverSin((lat - maxLat) * rad$1);
		return 0;
	}
	const haverSinDLng = Math.min(haverSin((lng - minLng) * rad$1), haverSin((lng - maxLng) * rad$1));
	const extremumLat = vertexLat(lat, haverSinDLng);
	if (extremumLat > minLat && extremumLat < maxLat) return haverSinDistPartial(haverSinDLng, cosLat, lat, extremumLat);
	return Math.min(haverSinDistPartial(haverSinDLng, cosLat, lat, minLat), haverSinDistPartial(haverSinDLng, cosLat, lat, maxLat));
}
/**
* @param {QueueItem|Node} a
* @param {QueueItem|Node} b
*/
function compareDist(a, b) {
	return a.dist - b.dist;
}
/** @param {number} theta */
function haverSin(theta) {
	const s = Math.sin(theta / 2);
	return s * s;
}
/**
* @param {number} haverSinDLng
* @param {number} cosLat1
* @param {number} lat1
* @param {number} lat2
*/
function haverSinDistPartial(haverSinDLng, cosLat1, lat1, lat2) {
	return cosLat1 * Math.cos(lat2 * rad$1) * haverSinDLng + haverSin((lat1 - lat2) * rad$1);
}
/**
* @param {number} lng1
* @param {number} lat1
* @param {number} lng2
* @param {number} lat2
* @param {number} cosLat1
*/
function haverSinDist(lng1, lat1, lng2, lat2, cosLat1) {
	return haverSinDistPartial(haverSin((lng1 - lng2) * rad$1), cosLat1, lat1, lat2);
}
/**
* @param {number} lat
* @param {number} haverSinDLng
*/
function vertexLat(lat, haverSinDLng) {
	const cosDLng = 1 - 2 * haverSinDLng;
	if (cosDLng <= 0) return lat > 0 ? 90 : -90;
	return Math.atan(Math.tan(lat * rad$1) / cosDLng) / rad$1;
}
//#endregion
//#region ../../node_modules/kdbush/index.js
const ARRAY_TYPES$1 = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array
];
/** @typedef {Int8ArrayConstructor | Uint8ArrayConstructor | Uint8ClampedArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor} TypedArrayConstructor */
/** @typedef {Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array} TypedArray */
const VERSION$1 = 1;
const HEADER_SIZE = 8;
const STACK = /* @__PURE__ */ new Uint32Array(96);
var KDBush = class KDBush {
	/**
	* Creates an index from raw `ArrayBuffer` data.
	* @param {ArrayBufferLike} data
	*/
	static from(data) {
		if (!data || data.byteLength === void 0 || data.buffer) throw new Error("Data must be an instance of ArrayBuffer or SharedArrayBuffer.");
		const [magic, versionAndType] = new Uint8Array(data, 0, 2);
		if (magic !== 219) throw new Error("Data does not appear to be in a KDBush format.");
		const version = versionAndType >> 4;
		if (version !== VERSION$1) throw new Error(`Got v${version} data when expected v${VERSION$1}.`);
		const ArrayType = ARRAY_TYPES$1[versionAndType & 15];
		if (!ArrayType) throw new Error("Unrecognized array type.");
		const [nodeSize] = new Uint16Array(data, 2, 1);
		const [numItems] = new Uint32Array(data, 4, 1);
		return new KDBush(numItems, nodeSize, ArrayType, void 0, data);
	}
	/**
	* Creates an index that will hold a given number of items.
	* @param {number} numItems
	* @param {number} [nodeSize=64] Size of the KD-tree node (64 by default).
	* @param {TypedArrayConstructor} [ArrayType=Float64Array] The array type used for coordinates storage (`Float64Array` by default).
	* @param {ArrayBufferConstructor | SharedArrayBufferConstructor} [ArrayBufferType=ArrayBuffer] The array buffer type used for storage (`ArrayBuffer` by default).
	* @param {ArrayBufferLike} [data] (For internal use only)
	*/
	constructor(numItems, nodeSize = 64, ArrayType = Float64Array, ArrayBufferType = ArrayBuffer, data) {
		if (isNaN(numItems) || numItems < 0) throw new Error(`Unexpected numItems value: ${numItems}.`);
		this.numItems = +numItems;
		this.nodeSize = Math.min(Math.max(+nodeSize, 2), 65535);
		this.ArrayType = ArrayType;
		this.IndexArrayType = numItems < 65536 ? Uint16Array : Uint32Array;
		const arrayTypeIndex = ARRAY_TYPES$1.indexOf(this.ArrayType);
		const coordsByteSize = numItems * 2 * this.ArrayType.BYTES_PER_ELEMENT;
		const idsByteSize = numItems * this.IndexArrayType.BYTES_PER_ELEMENT;
		const padCoords = (8 - idsByteSize % 8) % 8;
		if (arrayTypeIndex < 0) throw new Error(`Unexpected typed array class: ${ArrayType}.`);
		if (data) {
			this.data = data;
			this.ids = new this.IndexArrayType(data, HEADER_SIZE, numItems);
			this.coords = new ArrayType(data, HEADER_SIZE + idsByteSize + padCoords, numItems * 2);
			this._pos = numItems * 2;
			this._finished = true;
		} else {
			const data = this.data = new ArrayBufferType(HEADER_SIZE + coordsByteSize + idsByteSize + padCoords);
			this.ids = new this.IndexArrayType(data, HEADER_SIZE, numItems);
			this.coords = new ArrayType(data, HEADER_SIZE + idsByteSize + padCoords, numItems * 2);
			this._pos = 0;
			this._finished = false;
			new Uint8Array(data, 0, 2).set([219, 16 + arrayTypeIndex]);
			new Uint16Array(data, 2, 1)[0] = nodeSize;
			new Uint32Array(data, 4, 1)[0] = numItems;
		}
	}
	/**
	* Add a point to the index.
	* @param {number} x
	* @param {number} y
	* @returns {number} An incremental index associated with the added item (starting from `0`).
	*/
	add(x, y) {
		const index = this._pos >> 1;
		this.ids[index] = index;
		this.coords[this._pos++] = x;
		this.coords[this._pos++] = y;
		return index;
	}
	/**
	* Perform indexing of the added points.
	*/
	finish() {
		const numAdded = this._pos >> 1;
		if (numAdded !== this.numItems) throw new Error(`Added ${numAdded} items when expected ${this.numItems}.`);
		sort$1(this.ids, this.coords, this.nodeSize, 0, this.numItems - 1, 0);
		this._finished = true;
		return this;
	}
	/**
	* Search the index for items within a given bounding box.
	* @param {number} minX
	* @param {number} minY
	* @param {number} maxX
	* @param {number} maxY
	* @returns {number[]} An array of indices correponding to the found items.
	*/
	range(minX, minY, maxX, maxY) {
		if (!this._finished) throw new Error("Data not yet indexed - call index.finish().");
		const { ids, coords, nodeSize } = this;
		STACK[0] = 0;
		STACK[1] = ids.length - 1;
		STACK[2] = 0;
		let sp = 3;
		const result = [];
		while (sp > 0) {
			const axis = STACK[--sp];
			const right = STACK[--sp];
			const left = STACK[--sp];
			if (right - left <= nodeSize) {
				for (let i = left; i <= right; i++) {
					const x = coords[2 * i];
					const y = coords[2 * i + 1];
					if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(ids[i]);
				}
				continue;
			}
			const m = left + right >> 1;
			const x = coords[2 * m];
			const y = coords[2 * m + 1];
			if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(ids[m]);
			if (axis === 0 ? minX <= x : minY <= y) {
				STACK[sp++] = left;
				STACK[sp++] = m - 1;
				STACK[sp++] = 1 - axis;
			}
			if (axis === 0 ? maxX >= x : maxY >= y) {
				STACK[sp++] = m + 1;
				STACK[sp++] = right;
				STACK[sp++] = 1 - axis;
			}
		}
		return result;
	}
	/**
	* Search the index for items within a given radius.
	* @param {number} qx
	* @param {number} qy
	* @param {number} r Query radius.
	* @returns {number[]} An array of indices correponding to the found items.
	*/
	within(qx, qy, r) {
		const result = [];
		this.withinInto(qx, qy, r, result);
		return result;
	}
	/**
	* Search the index for items within a given radius, writing matching ids into `out`
	* via indexed assignment (`out[i] = id`). Accepts any indexed-writable container —
	* a typed array sized to the expected upper bound (allocation-free, fast) or a plain
	* `Array` (which will grow as needed). Returns the number of matches written.
	* @param {number} qx
	* @param {number} qy
	* @param {number} r Query radius.
	* @param {number[] | TypedArray} out Container to write matching ids into.
	* @returns {number} The number of matches written to `out`.
	*/
	withinInto(qx, qy, r, out) {
		if (!this._finished) throw new Error("Data not yet indexed - call index.finish().");
		const { ids, coords, nodeSize } = this;
		STACK[0] = 0;
		STACK[1] = ids.length - 1;
		STACK[2] = 0;
		let sp = 3;
		let count = 0;
		const r2 = r * r;
		while (sp > 0) {
			const axis = STACK[--sp];
			const right = STACK[--sp];
			const left = STACK[--sp];
			if (right - left <= nodeSize) {
				for (let i = left; i <= right; i++) if (sqDist(coords[2 * i], coords[2 * i + 1], qx, qy) <= r2) out[count++] = ids[i];
				continue;
			}
			const m = left + right >> 1;
			const x = coords[2 * m];
			const y = coords[2 * m + 1];
			if (sqDist(x, y, qx, qy) <= r2) out[count++] = ids[m];
			if (axis === 0 ? qx - r <= x : qy - r <= y) {
				STACK[sp++] = left;
				STACK[sp++] = m - 1;
				STACK[sp++] = 1 - axis;
			}
			if (axis === 0 ? qx + r >= x : qy + r >= y) {
				STACK[sp++] = m + 1;
				STACK[sp++] = right;
				STACK[sp++] = 1 - axis;
			}
		}
		return count;
	}
};
/**
* @param {Uint16Array | Uint32Array} ids
* @param {TypedArray} coords
* @param {number} nodeSize
* @param {number} left
* @param {number} right
* @param {number} axis
*/
function sort$1(ids, coords, nodeSize, left, right, axis) {
	if (right - left <= nodeSize) return;
	const m = left + right >> 1;
	select(ids, coords, m, left, right, axis);
	sort$1(ids, coords, nodeSize, left, m - 1, 1 - axis);
	sort$1(ids, coords, nodeSize, m + 1, right, 1 - axis);
}
/**
* Custom Floyd-Rivest selection algorithm: sort ids and coords so that
* [left..k-1] items are smaller than k-th item (on either x or y axis)
* @param {Uint16Array | Uint32Array} ids
* @param {TypedArray} coords
* @param {number} k
* @param {number} left
* @param {number} right
* @param {number} axis
*/
function select(ids, coords, k, left, right, axis) {
	while (right > left) {
		if (right - left > 600) {
			const n = right - left + 1;
			const m = k - left + 1;
			const z = Math.log(n);
			const s = .5 * Math.exp(2 * z / 3);
			const sd = .5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1);
			select(ids, coords, k, Math.max(left, Math.floor(k - m * s / n + sd)), Math.min(right, Math.floor(k + (n - m) * s / n + sd)), axis);
		}
		const t = coords[2 * k + axis];
		let i = left;
		let j = right;
		swapItem(ids, coords, left, k);
		if (coords[2 * right + axis] > t) swapItem(ids, coords, left, right);
		while (i < j) {
			swapItem(ids, coords, i, j);
			i++;
			j--;
			while (coords[2 * i + axis] < t) i++;
			while (coords[2 * j + axis] > t) j--;
		}
		if (coords[2 * left + axis] === t) swapItem(ids, coords, left, j);
		else {
			j++;
			swapItem(ids, coords, j, right);
		}
		if (j <= k) left = j + 1;
		if (k <= j) right = j - 1;
	}
}
/**
* @param {Uint16Array | Uint32Array} ids
* @param {TypedArray} coords
* @param {number} i
* @param {number} j
*/
function swapItem(ids, coords, i, j) {
	swap$1(ids, i, j);
	swap$1(coords, 2 * i, 2 * j);
	swap$1(coords, 2 * i + 1, 2 * j + 1);
}
/**
* @param {TypedArray} arr
* @param {number} i
* @param {number} j
*/
function swap$1(arr, i, j) {
	const tmp = arr[i];
	arr[i] = arr[j];
	arr[j] = tmp;
}
/**
* @param {number} ax
* @param {number} ay
* @param {number} bx
* @param {number} by
*/
function sqDist(ax, ay, bx, by) {
	const dx = ax - bx;
	const dy = ay - by;
	return dx * dx + dy * dy;
}
//#endregion
//#region ../../node_modules/@osmix/core/dist/entities.js
/**
* Base class for OSM entity collections.
*
* Provides common ID and tag storage, streaming iteration, and sorted access.
* Subclasses implement entity-specific storage and spatial indexing.
*
* @module
*/
/**
* Abstract base for typed entity collections.
*
* Lifecycle:
* 1. **Ingest**: `addEntity()` (no lookups).
* 2. **Finalize**: `buildIndex()`.
* 3. **Query**: Lookups and iteration enabled.
*/
var Entities = class {
	/** The type of entity stored in this collection ("node", "way", or "relation"). */
	indexType;
	/** ID storage and lookup */
	ids;
	/** Tag storage and search */
	tags;
	/** Whether buildIndex() has been called */
	indexBuilt = false;
	/**
	* Create a new Entities collection.
	* @param indexType - The entity type ("node", "way", or "relation").
	* @param ids - The ID storage instance.
	* @param tags - The tag storage instance.
	*/
	constructor(indexType, ids, tags) {
		this.indexType = indexType;
		this.ids = ids;
		this.tags = tags;
	}
	/**
	* Get transferable objects for passing to another thread.
	*/
	transferables() {
		return {
			...this.ids.transferables(),
			...this.tags.transferables()
		};
	}
	/**
	* Check if the index is built and ready for use.
	*/
	isReady() {
		return this.ids.isReady() && this.tags.isReady() && this.indexBuilt;
	}
	/** Number of entities in this collection. */
	get size() {
		return this.ids.size;
	}
	/**
	* Finalize indexes.
	* Must be called after adding entities and before querying.
	*/
	buildIndex() {
		if (this.indexBuilt) return;
		console.time(`${this.indexType}Index.buildIndex`);
		this.ids.buildIndex();
		this.tags.buildIndex();
		this.buildEntityIndex();
		this.indexBuilt = true;
		console.timeEnd(`${this.indexType}Index.buildIndex`);
	}
	addEntity(id, tags, values) {
		const entityIndex = this.ids.add(id);
		if (Array.isArray(tags)) {
			if (values === void 0) throw Error("Values are required when tags is an array");
			this.tags.addTagKeysAndValues(entityIndex, tags, values);
		} else this.tags.addTags(entityIndex, tags);
		return entityIndex;
	}
	/**
	* Get an entity by ID or index.
	*/
	get(idOrIndex) {
		const [index, id] = this.ids.idOrIndex(idOrIndex);
		if (index === -1) return null;
		return this.getFullEntity(index, id, this.tags.getTags(index));
	}
	/**
	* Get an entity by index.
	*/
	getByIndex(index) {
		return this.getFullEntity(index, this.ids.at(index), this.tags.getTags(index));
	}
	/**
	* Get multiple entities by their indexes.
	*/
	getEntitiesByIndex(indexes) {
		const entities = [];
		for (const index of indexes) {
			const entity = this.getByIndex(index);
			if (entity) entities.push(entity);
			else throw Error(`Entity not found at index ${index}`);
		}
		return entities;
	}
	/**
	* Iterate over all entities in the index.
	*/
	*[Symbol.iterator]() {
		for (let i = 0; i < this.size; i++) yield this.getFullEntity(i, this.ids.at(i), this.tags.getTags(i));
	}
	/**
	* Get an entity by ID.
	*/
	getById(id) {
		const index = this.ids.getIndexFromId(id);
		if (index !== -1) return this.getFullEntity(index, id, this.tags.getTags(index));
		return null;
	}
	/**
	* Iterate over entities sorted by ID.
	*/
	*sorted() {
		for (const id of this.ids.sorted) {
			const index = this.ids.getIndexFromId(id);
			if (index === -1) throw Error(`Entity not found at id ${id}`);
			yield this.getFullEntity(index, id, this.tags.getTags(index));
		}
	}
	/**
	* Search for entities with a specific tag key and optional value.
	*/
	search(key, val) {
		const keyIndex = this.tags.find(key);
		const entities = this.tags.hasKey(keyIndex).map((index) => this.getByIndex(index));
		if (val === void 0) return entities;
		return entities.filter((entity) => entity.tags?.[key] === val);
	}
	/**
	* Update a ContentHasher with this entity collection's base data (IDs and tags).
	* Subclasses should override to add entity-specific data.
	*/
	updateHash(hasher) {
		return this.ids.updateHash(this.tags.updateHash(hasher));
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/typed-arrays.js
/**
* Resizable typed array utilities.
*
* Wraps typed arrays with automatic buffer expansion (ArrayList semantics).
* Uses SharedArrayBuffer (if available) for zero-copy worker transfer.
*
* @module
*/
/**
* Use SharedArrayBuffer if the runtime supports it, otherwise fall back to ArrayBuffer.
* SharedArrayBuffer enables zero-copy transfer between workers.
*/
const BufferConstructor = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : ArrayBuffer;
/**
* Float64Array for storing OSM IDs.
*
* OSM IDs are 64-bit integers. JavaScript's number type (IEEE 754 double)
* can exactly represent integers up to 2^53, which covers all current OSM IDs.
* Float64Array allows typed array operations while maintaining precision.
*/
const IdArrayType = Float64Array;
/**
* Initial buffer size for ResizeableTypedArray.
* 1 MiB provides reasonable initial capacity while avoiding excessive memory allocation.
*/
const DEFAULT_BUFFER_SIZE = 2 ** 20;
/**
* Auto-expanding typed array wrapper.
*
* - `push()` appends elements, doubling buffer size as needed.
* - `compact()` shrinks buffer to fit data.
* - Supports growable SharedArrayBuffer and resizable ArrayBuffer.
*/
var ResizeableTypedArray = class ResizeableTypedArray {
	/** The typed array constructor for this instance */
	ArrayType;
	/** The current typed array view into the buffer */
	array;
	/** Number of items actually stored (may be less than array.length) */
	items = 0;
	/** The underlying ArrayBuffer or SharedArrayBuffer */
	buffer;
	/** Current buffer size in bytes */
	bufferSize;
	/** Maximum byte length for growable buffers */
	maxByteLength;
	/** Buffer constructor (SharedArrayBuffer or ArrayBuffer) */
	BC;
	/**
	* Reconstruct a ResizeableTypedArray from an existing buffer.
	*
	* Used after transferring buffers between workers. The resulting array
	* is considered "compacted" with items = array.length.
	*
	* @param ArrayType - The typed array constructor.
	* @param buffer - The existing buffer to wrap.
	* @returns A new ResizeableTypedArray wrapping the buffer.
	*/
	static from(ArrayType, buffer) {
		const rta = new ResizeableTypedArray(ArrayType, buffer instanceof SharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer);
		rta.buffer = buffer;
		rta.array = new ArrayType(buffer);
		rta.items = rta.array.length;
		return rta;
	}
	/**
	* Create a new ResizeableTypedArray with an empty buffer.
	*
	* @param ArrayType - The typed array constructor (e.g., Float64Array).
	* @param BC - Buffer constructor to use (defaults to SharedArrayBuffer if available).
	*/
	constructor(ArrayType, BC = BufferConstructor) {
		this.ArrayType = ArrayType;
		this.bufferSize = DEFAULT_BUFFER_SIZE;
		this.maxByteLength = DEFAULT_BUFFER_SIZE * 2;
		this.BC = BC;
		this.buffer = new BC(this.bufferSize, { maxByteLength: this.maxByteLength });
		this.array = new this.ArrayType(this.buffer);
	}
	/**
	* Iterate over the array values.
	*/
	[Symbol.iterator]() {
		return this.array[Symbol.iterator]();
	}
	/**
	* Double the buffer capacity.
	* Uses in-place grow/resize if supported, otherwise allocates new buffer and copies.
	*/
	expandArray() {
		this.bufferSize *= 2;
		if (this.bufferSize > this.buffer.maxByteLength) {
			this.maxByteLength *= 2;
			const newBuffer = new this.BC(this.bufferSize, { maxByteLength: this.maxByteLength });
			const newArray = new this.ArrayType(newBuffer);
			newArray.set(this.array);
			this.buffer = newBuffer;
			this.array = newArray;
		} else if (this.buffer instanceof SharedArrayBuffer && this.buffer.growable) this.buffer.grow(this.bufferSize);
		else if (this.buffer instanceof ArrayBuffer && this.buffer.resizable) this.buffer.resize(this.bufferSize);
		else throw Error("Buffer is not growable or resizable");
	}
	/**
	* Get the value at an index. Handles negative indices.
	*/
	at(index) {
		if (index < -this.length || index >= this.length) throw Error(`Index out of bounds: ${index}. Length: ${this.length}`);
		if (index < 0) return this.at(this.length + index);
		const result = this.array[index];
		if (result === void 0) throw Error(`No value at index: ${index}`);
		return result;
	}
	/**
	* Get a slice of the array.
	*/
	slice(start, end) {
		return this.array.slice(start, end);
	}
	get length() {
		return this.items;
	}
	/**
	* Push a value to the end of the array.
	*/
	push(value) {
		if (this.length >= this.array.length) this.expandArray();
		this.array[this.items++] = value;
		return this.length - 1;
	}
	/**
	* Set a value at a specific index. Expands array if needed.
	*/
	set(index, value) {
		if (index < 0) throw Error("Index out of bounds");
		if (index >= this.length) {
			while (index >= this.array.length) this.expandArray();
			this.items = index + 1;
		}
		this.array[index] = value;
	}
	/**
	* Push multiple values to the end of the array.
	*/
	pushMany(values) {
		while (this.length + values.length > this.array.length) this.expandArray();
		this.array.set(values, this.length);
		this.items += values.length;
	}
	/**
	* Shrink the buffer to exactly fit stored items.
	* Buffer becomes fixed-length after compacting.
	*/
	compact() {
		if (this.buffer instanceof SharedArrayBuffer) this.buffer = this.buffer.slice(0, this.length * this.ArrayType.BYTES_PER_ELEMENT);
		else this.buffer = this.buffer.transferToFixedLength(this.length * this.ArrayType.BYTES_PER_ELEMENT);
		this.array = new this.ArrayType(this.buffer);
		return this.array;
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/ids.js
/**
* ID storage and lookup for OSM entities.
*
* Uses a two-level binary search (anchor array + block search) to map 64-bit OSM IDs
* to internal array indices. Balances memory usage with O(log n) lookup speed.
*
* @module
*/
/**
* Number of IDs per anchor block for the two-level binary search.
* Smaller values increase anchor array size but speed up block-level search;
* larger values reduce anchor overhead but slow the final search.
*/
const BLOCK_SIZE = 256;
/**
* Efficiently store and lookup OSM entity IDs.
*
* Stores 64-bit IDs in a Float64Array and maintains a sorted index for O(log n) lookups.
* Max capacity: ~2^32 entities.
*/
var Ids = class {
	/** All IDs in insertion order */
	ids;
	/** Whether buildIndex() has been called */
	indexBuilt = false;
	/** True if IDs were added in ascending order (allows index optimization) */
	idsAreSorted = true;
	/** Sorted view of IDs for binary search */
	idsSorted;
	/** Maps position in sorted array → original insertion index */
	sortedIdPositionToIndex;
	/** Anchor array for two-level binary search: every BLOCK_SIZE-th sorted ID */
	anchors;
	/**
	* Create a new Ids index.
	* @param transferables - Optional serialized state to reconstruct from.
	*/
	constructor(transferables) {
		if (transferables) {
			this.ids = ResizeableTypedArray.from(Float64Array, transferables.ids);
			this.idsSorted = new Float64Array(transferables.sortedIds);
			this.sortedIdPositionToIndex = new Uint32Array(transferables.sortedIdPositionToIndex);
			this.anchors = new Float64Array(transferables.anchors);
			this.idsAreSorted = transferables.idsAreSorted;
			this.indexBuilt = true;
		} else {
			this.ids = new ResizeableTypedArray(Float64Array);
			this.idsSorted = new Float64Array(new BufferConstructor(0));
			this.sortedIdPositionToIndex = new Uint32Array(new BufferConstructor(0));
			this.anchors = new Float64Array(new BufferConstructor(0));
		}
	}
	/** Number of IDs stored in this index. */
	get size() {
		return this.ids.length;
	}
	/** Returns true if buildIndex() has been called and lookups are enabled. */
	isReady() {
		return this.indexBuilt;
	}
	/** Returns true if IDs were inserted in ascending order. */
	isSorted() {
		return this.idsAreSorted;
	}
	/**
	* Add an ID to the index.
	* @param id - The OSM entity ID to add.
	* @returns The internal array index where this ID was stored.
	* @throws If the index has already been built.
	*/
	add(id) {
		if (this.indexBuilt) throw Error("ID index already built.");
		if (this.ids.length > 0 && id < this.ids.at(-1)) this.idsAreSorted = false;
		return this.ids.push(id);
	}
	/**
	* Get the ID at a specific internal index.
	* @param index - The internal array index.
	* @returns The OSM entity ID at that index.
	*/
	at(index) {
		return this.ids.at(index);
	}
	/**
	* Check if an ID exists in this index.
	* @param id - The OSM entity ID to check.
	* @returns True if the ID exists in this index.
	*/
	has(id) {
		return this.getIndexFromId(id) !== -1;
	}
	/**
	* Build the index of IDs to positions.
	*
	* If the IDs are not sorted, we need to sort them and build a new index.
	* If the IDs are sorted, we can use the existing index.
	*/
	buildIndex() {
		if (this.indexBuilt) throw Error("ID index already built.");
		this.ids.compact();
		if (!this.idsAreSorted) {
			const idsBuffer = new BufferConstructor(this.size * Float64Array.BYTES_PER_ELEMENT);
			const posBuffer = new BufferConstructor(this.size * Uint32Array.BYTES_PER_ELEMENT);
			this.idsSorted = new Float64Array(idsBuffer);
			this.sortedIdPositionToIndex = new Uint32Array(posBuffer);
			for (let i = 0; i < this.size; i++) {
				this.idsSorted[i] = this.ids.at(i);
				this.sortedIdPositionToIndex[i] = i;
			}
			const tmp = Array.from({ length: this.size }, (_, i) => ({
				id: this.idsSorted[i],
				pos: this.sortedIdPositionToIndex[i]
			}));
			tmp.sort((a, b) => a.id - b.id);
			tmp.forEach(({ id, pos }, i) => {
				this.idsSorted[i] = id;
				this.sortedIdPositionToIndex[i] = pos;
			});
		} else {
			this.idsSorted = this.ids.array;
			const posBuffer = new BufferConstructor(this.size * Uint32Array.BYTES_PER_ELEMENT);
			this.sortedIdPositionToIndex = new Uint32Array(posBuffer);
			for (let i = 0; i < this.size; i++) this.sortedIdPositionToIndex[i] = i;
		}
		const aLen = Math.ceil(this.size / BLOCK_SIZE);
		const sab = new BufferConstructor(aLen * Float64Array.BYTES_PER_ELEMENT);
		this.anchors = new Float64Array(sab, 0, aLen);
		for (let j = 0; j < aLen; j++) {
			const id = this.idsSorted[Math.min(j * BLOCK_SIZE, this.size - 1)];
			assertValue(id, "ID is undefined");
			this.anchors[j] = id;
		}
		this.indexBuilt = true;
	}
	/**
	* Look up the internal array index for an OSM entity ID.
	*
	* @param id - The OSM entity ID to look up.
	* @returns The internal array index, or -1 if not found.
	* @throws If the index has not been built.
	*/
	getIndexFromId(id) {
		if (!this.indexBuilt) throw Error("IdIndex not built.");
		let lo = 0;
		let hi = this.anchors.length - 1;
		while (lo < hi) {
			const mid = lo + hi + 1 >>> 1;
			const anchor = this.anchors[mid];
			assertValue(anchor, "Anchor is undefined");
			if (anchor <= id) lo = mid;
			else hi = mid - 1;
		}
		const start = lo * BLOCK_SIZE;
		const end = Math.min(start + BLOCK_SIZE, this.idsSorted.length);
		let l = start;
		let r = end - 1;
		while (l <= r) {
			const m = l + r >>> 1;
			const v = this.idsSorted[m];
			assertValue(v, "Value is undefined");
			if (v === id) {
				if (this.idsAreSorted) return m;
				const index = this.sortedIdPositionToIndex[m];
				assertValue(index, "Position is undefined");
				return index;
			}
			if (v < id) l = m + 1;
			else r = m - 1;
		}
		return -1;
	}
	/**
	* Pass an ID or an index, get both.
	*/
	idOrIndex(i) {
		if ("id" in i) return [this.getIndexFromId(i.id), i.id];
		return [i.index, this.at(i.index)];
	}
	/** Returns the sorted array of IDs for iteration. */
	get sorted() {
		return this.idsSorted;
	}
	/**
	* Get transferable buffers for passing to another thread.
	* @returns Serializable representation of this index.
	*/
	transferables() {
		return {
			ids: this.ids.array.buffer,
			sortedIds: this.idsSorted.buffer,
			sortedIdPositionToIndex: this.sortedIdPositionToIndex.buffer,
			anchors: this.anchors.buffer,
			idsAreSorted: this.idsAreSorted
		};
	}
	/**
	* Get the approximate memory requirements for a given number of IDs in bytes.
	*/
	static getBytesRequired(count) {
		if (count === 0) return 0;
		return count * Float64Array.BYTES_PER_ELEMENT + count * Float64Array.BYTES_PER_ELEMENT + count * Uint32Array.BYTES_PER_ELEMENT + Math.ceil(count / BLOCK_SIZE) * Float64Array.BYTES_PER_ELEMENT;
	}
	/**
	* Update a ContentHasher with the IDs data.
	* Uses the sorted IDs for consistent hashing regardless of insertion order.
	*/
	updateHash(hasher) {
		return hasher.update(this.idsSorted);
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/stringtable.js
/**
* Deduplicated UTF-8 string storage.
*
* Strings are stored in a flat buffer and referenced by index.
* Supports fast deduplication (string→index) and lazy reconstruction (index→string).
*
* @module
*/
/**
* Append-only deduplicated string table.
*
* Limits: Max string length 65,535 bytes.
* Rebuilds reverse index lazily after transfer.
*/
var StringTable = class {
	/** UTF-8 encoder for string→bytes conversion */
	enc = new TextEncoder();
	/** UTF-8 decoder for bytes→string conversion */
	dec = new TextDecoder();
	/** Concatenated UTF-8 bytes of all strings */
	bytes;
	/** Maps string index → byte offset in bytes array */
	start;
	/** Maps string index → byte length */
	count;
	/** Forward lookup: string → index (populated during add) */
	stringToIndex = /* @__PURE__ */ new Map();
	/** Whether the reverse index has been built (lazy after transfer) */
	reverseIndexBuilt = false;
	/** Cache of decoded strings to avoid repeated UTF-8 decoding */
	indexToString = /* @__PURE__ */ new Map();
	/**
	* Create a new StringTable.
	*/
	constructor(opts) {
		this.bytes = opts?.bytes ? ResizeableTypedArray.from(Uint8Array, opts.bytes) : new ResizeableTypedArray(Uint8Array);
		this.start = opts?.start ? ResizeableTypedArray.from(Uint32Array, opts.start) : new ResizeableTypedArray(Uint32Array);
		this.count = opts?.count ? ResizeableTypedArray.from(Uint16Array, opts.count) : new ResizeableTypedArray(Uint16Array);
	}
	/**
	* Get transferable objects for passing to another thread.
	*/
	transferables() {
		return {
			bytes: this.bytes.array.buffer,
			start: this.start.array.buffer,
			count: this.count.array.buffer
		};
	}
	/**
	* Add a string to the table and return its index.
	*/
	add(str) {
		const existingIndex = this.stringToIndex.get(str);
		if (existingIndex !== void 0) return existingIndex;
		const startIndex = this.start.length;
		const encoded = this.enc.encode(str);
		this.start.push(this.bytes.length);
		this.bytes.pushMany(encoded);
		this.count.push(encoded.length);
		this.stringToIndex.set(str, startIndex);
		return startIndex;
	}
	/**
	* Decode all the strings in a primitive block and add them to the string table.
	* Return a mapping of block index -> string table index
	*/
	createBlockIndexMap(blockStringtable) {
		const index = new Uint32Array(blockStringtable.length);
		for (let i = 0; i < blockStringtable.length; i++) {
			const bytesString = blockStringtable[i];
			const str = this.dec.decode(bytesString);
			const existingIndex = this.stringToIndex.get(str);
			if (existingIndex !== void 0) {
				index[i] = existingIndex;
				continue;
			}
			index[i] = this.add(str);
		}
		return index;
	}
	/**
	* Get a string by its index.
	* Caches results to avoid repeated UTF-8 decoding.
	*/
	get(index) {
		const string = this.indexToString.get(index);
		if (string) return string;
		const bytes = this.getBytes(index);
		const tempBuffer = new ArrayBuffer(bytes.byteLength);
		const tempBytes = new Uint8Array(tempBuffer);
		tempBytes.set(bytes);
		const decoded = this.dec.decode(tempBytes);
		this.indexToString.set(index, decoded);
		return decoded;
	}
	/**
	* Get the raw UTF-8 bytes of a string.
	* Returns a subarray view (not a copy).
	*/
	getBytes(index) {
		if (index < 0 || index >= this.length) throw Error(`String index out of range: ${index}`);
		const start = this.start.at(index);
		const count = this.count.at(index);
		return this.bytes.array.subarray(start, start + count);
	}
	/** Number of strings in the table. */
	get length() {
		return this.start.length;
	}
	/**
	* Finalize the string table by compacting internal arrays.
	*
	* This releases unused buffer capacity and marks the reverse index as built
	* (since all strings were added before this call).
	*/
	buildIndex() {
		this.bytes.compact();
		this.start.compact();
		this.count.compact();
		this.reverseIndexBuilt = true;
	}
	/**
	* Convert the string table to an OSM PBF string table.
	*/
	toOsmPbfStringTable() {
		const stringTable = [];
		for (let i = 0; i < this.length; i++) stringTable.push(this.getBytes(i));
		return stringTable;
	}
	/**
	* Lazily build the reverse index (string → index).
	* Decodes all strings once to populate the lookup map.
	*/
	ensureReverseIndex() {
		if (this.reverseIndexBuilt) return;
		for (let i = 0; i < this.length; i++) this.stringToIndex.set(this.get(i), i);
		this.reverseIndexBuilt = true;
	}
	/**
	* Find the index of a string.
	*/
	find(str) {
		const existing = this.stringToIndex.get(str);
		if (existing !== void 0) return existing;
		this.ensureReverseIndex();
		return this.stringToIndex.get(str) ?? -1;
	}
	/**
	* Update a ContentHasher with the string table's data.
	* Hashes the bytes, start offsets, and counts.
	*/
	updateHash(hasher) {
		return hasher.update(this.bytes.array).update(this.start.array).update(this.count.array);
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/tags.js
/**
* Tag storage and lookup.
*
* Stores key=value pairs using string table indices. Supports:
* 1. **Entity → Tags**: Retrieve tags for a given entity.
* 2. **Key → Entities**: Find entities with a specific tag key.
*
* @module
*/
/**
* Bidirectional tag storage.
*
* Limits: Max 255 tags per entity.
* Note: String indices reference a shared `StringTable`.
*/
var Tags = class Tags {
	/** Reference to the shared string table for key/value storage */
	stringTable = new StringTable();
	/** Maps entity index → start position in tagKeys/tagVals */
	tagStart;
	/** Maps entity index → number of tags (max 255) */
	tagCount;
	/** All tag key string indices, concatenated */
	tagKeys;
	/** All tag value string indices, concatenated (parallel to tagKeys) */
	tagVals;
	/**
	* Flattened array of entity indices that have each tag key.
	* Indexed via keyIndexStart and keyIndexCount.
	*/
	keyEntities;
	/** Maps key string index → start position in keyEntities */
	keyIndexStart;
	/** Maps key string index → count of entities with that key */
	keyIndexCount;
	/**
	* Temporary map used during ingestion to collect entity indices per key.
	* Converted to flat arrays during buildIndex() and then cleared.
	*/
	keyEntityIndexBuilder = /* @__PURE__ */ new Map();
	/** Whether buildIndex() has been called */
	indexBuilt = false;
	/**
	* Create a new Tags index.
	*/
	constructor(stringTable, transferables) {
		this.stringTable = stringTable;
		if (transferables) {
			this.tagStart = ResizeableTypedArray.from(Uint32Array, transferables.tagStart);
			this.tagCount = ResizeableTypedArray.from(Uint8Array, transferables.tagCount);
			this.tagKeys = ResizeableTypedArray.from(Uint32Array, transferables.tagKeys);
			this.tagVals = ResizeableTypedArray.from(Uint32Array, transferables.tagVals);
			this.keyEntities = ResizeableTypedArray.from(Uint32Array, transferables.keyEntities);
			this.keyIndexStart = ResizeableTypedArray.from(Uint32Array, transferables.keyIndexStart);
			this.keyIndexCount = ResizeableTypedArray.from(Uint32Array, transferables.keyIndexCount);
			this.indexBuilt = true;
		} else {
			this.tagStart = new ResizeableTypedArray(Uint32Array);
			this.tagCount = new ResizeableTypedArray(Uint8Array);
			this.tagKeys = new ResizeableTypedArray(Uint32Array);
			this.tagVals = new ResizeableTypedArray(Uint32Array);
			this.keyEntities = new ResizeableTypedArray(Uint32Array);
			this.keyIndexStart = new ResizeableTypedArray(Uint32Array);
			this.keyIndexCount = new ResizeableTypedArray(Uint32Array);
		}
	}
	/**
	* Add tags to an entity.
	*/
	addTags(index, tags) {
		const tagKeys = [];
		const tagValues = [];
		if (tags) for (const [key, value] of Object.entries(tags)) {
			tagKeys.push(this.stringTable.add(key));
			tagValues.push(this.stringTable.add(String(value)));
		}
		this.addTagKeysAndValues(index, tagKeys, tagValues);
		return [tagKeys, tagValues];
	}
	/**
	* Add tags to an entity using key and value indexes.
	*/
	addTagKeysAndValues(index, keys, values) {
		this.tagStart.set(index, this.tagKeys.length);
		this.tagCount.set(index, keys.length);
		this.tagKeys.pushMany(keys);
		this.tagVals.pushMany(values);
		keys.forEach((key) => {
			const keyEntities = this.keyEntityIndexBuilder.get(key);
			if (keyEntities) keyEntities.push(index);
			else this.keyEntityIndexBuilder.set(key, [index]);
		});
	}
	/**
	* Finalize the tag index.
	*
	* Compacts arrays and builds the reverse key→entity index.
	* Must be called before `hasKey()`.
	*/
	buildIndex() {
		this.tagStart.compact();
		this.tagCount.compact();
		this.tagKeys.compact();
		this.tagVals.compact();
		for (const [keyIndex, entityIndexes] of this.keyEntityIndexBuilder) {
			this.keyIndexStart.set(keyIndex, this.keyEntities.length);
			this.keyIndexCount.set(keyIndex, entityIndexes.length);
			this.keyEntities.pushMany(entityIndexes);
		}
		this.keyIndexStart.compact();
		this.keyIndexCount.compact();
		this.keyEntityIndexBuilder.clear();
		this.indexBuilt = true;
	}
	/**
	* Check if the index is built and ready for use.
	*/
	isReady() {
		return this.indexBuilt;
	}
	/**
	* Get the number of tags for an entity.
	*/
	cardinality(index) {
		return this.tagCount.at(index) ?? 0;
	}
	/**
	* Get the tags for an entity.
	*/
	getTags(index) {
		const tagCount = this.tagCount.at(index) ?? 0;
		if (tagCount === 0) return;
		const tagStart = this.tagStart.at(index) ?? 0;
		const tagKeyIndexes = this.tagKeys.array.slice(tagStart, tagStart + tagCount);
		const tagValIndexes = this.tagVals.array.slice(tagStart, tagStart + tagCount);
		const tags = {};
		for (let i = 0; i < tagCount; i++) {
			const keyIndex = tagKeyIndexes[i];
			const valIndex = tagValIndexes[i];
			if (keyIndex === void 0 || valIndex === void 0) throw Error("Tag key or value not found");
			tags[this.stringTable.get(keyIndex)] = this.stringTable.get(valIndex);
		}
		return tags;
	}
	/**
	* Get tags from key and value indexes.
	*/
	getTagsFromIndices(keys, values) {
		const tags = {};
		for (let i = 0; i < keys.length; i++) {
			const keyIndex = keys[i];
			const valIndex = values[i];
			if (keyIndex === void 0 || valIndex === void 0) throw Error("Tag key or value not found");
			tags[this.stringTable.get(keyIndex)] = this.stringTable.get(valIndex);
		}
		return tags;
	}
	/**
	* Find the index of a tag key.
	*/
	find(key) {
		return this.stringTable.find(key);
	}
	/**
	* Get all entity indexes that have a specific tag key.
	*/
	hasKey(keyIndex) {
		if (keyIndex < 0) return [];
		const start = this.keyIndexStart.at(keyIndex) ?? 0;
		const count = this.keyIndexCount.at(keyIndex) ?? 0;
		return Array.from(this.keyEntities.array.subarray(start, start + count));
	}
	/**
	* Create a unique composite index for a key=value pair.
	* Uses row-major indexing: `key * width + val`.
	*/
	kvToIndex(key, val) {
		return key * this.stringTable.length + val;
	}
	/**
	* Get transferable objects for passing to another thread.
	*/
	transferables() {
		return {
			tagStart: this.tagStart.array.buffer,
			tagCount: this.tagCount.array.buffer,
			tagKeys: this.tagKeys.array.buffer,
			tagVals: this.tagVals.array.buffer,
			keyEntities: this.keyEntities.array.buffer,
			keyIndexStart: this.keyIndexStart.array.buffer,
			keyIndexCount: this.keyIndexCount.array.buffer
		};
	}
	/**
	* Get the approximate memory requirements for a given number of tags in bytes.
	*/
	static getBytesRequired(count) {
		return count * Uint32Array.BYTES_PER_ELEMENT + count * Uint8Array.BYTES_PER_ELEMENT;
	}
	/**
	* Reconstruct a Tags index from transferable objects.
	*/
	static fromTransferables(stringTable, transferables) {
		const tagIndex = new Tags(stringTable, transferables);
		tagIndex.indexBuilt = true;
		return tagIndex;
	}
	/**
	* Update a ContentHasher with the tags data.
	* Hashes tag keys and values for each entity.
	*/
	updateHash(hasher) {
		return hasher.update(this.tagStart.array).update(this.tagCount.array).update(this.tagKeys.array).update(this.tagVals.array);
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/nodes.js
var Nodes = class extends Entities {
	/**
	* Coordinates are stored as integer microdegrees (Int32Array).
	* Use OSM_COORD_SCALE (1e7) to convert between degrees and microdegrees.
	*/
	lons;
	lats;
	bbox = [
		Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER,
		Number.MIN_SAFE_INTEGER,
		Number.MIN_SAFE_INTEGER
	];
	spatialIndex = new KDBush(0, 128, Float64Array, BufferConstructor);
	spatialIndexBuilt = false;
	/**
	* Create a new Nodes index.
	*/
	constructor(stringTable, transferables) {
		if (transferables) {
			super("node", new Ids(transferables), new Tags(stringTable, transferables));
			this.lons = ResizeableTypedArray.from(Int32Array, transferables.lons);
			this.lats = ResizeableTypedArray.from(Int32Array, transferables.lats);
			if (transferables.spatialIndex?.byteLength) {
				this.spatialIndex = KDBush.from(transferables.spatialIndex);
				this.spatialIndexBuilt = true;
			}
			this.bbox = transferables.bbox;
			this.indexBuilt = true;
		} else {
			super("node", new Ids(), new Tags(stringTable));
			this.lons = new ResizeableTypedArray(Int32Array);
			this.lats = new ResizeableTypedArray(Int32Array);
			this.spatialIndex = new KDBush(0, 128, Float64Array, BufferConstructor);
		}
	}
	/**
	* Add a single node to the index.
	*/
	addNode(node) {
		const nodeIndex = this.addEntity(node.id, node.tags ?? {});
		const lonMicro = toMicroDegrees(node.lon);
		const latMicro = toMicroDegrees(node.lat);
		this.lons.push(lonMicro);
		this.lats.push(latMicro);
		if (node.lon < this.bbox[0]) this.bbox[0] = node.lon;
		if (node.lat < this.bbox[1]) this.bbox[1] = node.lat;
		if (node.lon > this.bbox[2]) this.bbox[2] = node.lon;
		if (node.lat > this.bbox[3]) this.bbox[3] = node.lat;
		return nodeIndex;
	}
	/**
	* Add dense nodes from a PBF block.
	*/
	addDenseNodes(dense, block, blockStringIndexMap, filter) {
		const lon_offset = block.lon_offset ?? 0;
		const lat_offset = block.lat_offset ?? 0;
		const granularity = block.granularity ?? 1e7;
		const delta = {
			id: 0,
			lat: 0,
			lon: 0,
			timestamp: 0,
			changeset: 0,
			uid: 0,
			user_sid: 0
		};
		const getStringTableIndex = (keyIndex) => {
			const key = dense.keys_vals[keyIndex];
			assertValue(key, "Block string key is undefined");
			const index = blockStringIndexMap[key];
			assertValue(index, "Block string not found");
			return index;
		};
		let keysValsIndex = 0;
		let added = 0;
		for (let i = 0; i < dense.id.length; i++) {
			const idSid = dense.id[i];
			const latSid = dense.lat[i];
			const lonSid = dense.lon[i];
			assertValue(idSid, "ID SID is undefined");
			assertValue(latSid, "Latitude SID is undefined");
			assertValue(lonSid, "Longitude SID is undefined");
			delta.id += idSid;
			delta.lat += latSid;
			delta.lon += lonSid;
			const lon = lon_offset + delta.lon / granularity;
			const lat = lat_offset + delta.lat / granularity;
			const lonMicro = toMicroDegrees(lon);
			const latMicro = toMicroDegrees(lat);
			const tagKeys = [];
			const tagValues = [];
			if (dense.keys_vals.length > 0) {
				while (dense.keys_vals[keysValsIndex] !== 0) {
					const key = getStringTableIndex(keysValsIndex);
					const val = getStringTableIndex(keysValsIndex + 1);
					if (key && val) {
						tagKeys.push(key);
						tagValues.push(val);
					}
					keysValsIndex += 2;
				}
				keysValsIndex++;
			}
			if (!(filter ? filter({
				id: delta.id,
				lon,
				lat,
				tags: this.tags.getTagsFromIndices(tagKeys, tagValues)
			}) : true)) continue;
			this.addEntity(delta.id, tagKeys, tagValues);
			this.lons.push(lonMicro);
			this.lats.push(latMicro);
			if (lon < this.bbox[0]) this.bbox[0] = lon;
			if (lat < this.bbox[1]) this.bbox[1] = lat;
			if (lon > this.bbox[2]) this.bbox[2] = lon;
			if (lat > this.bbox[3]) this.bbox[3] = lat;
			added++;
		}
		return added;
	}
	/**
	* Compact the internal arrays to free up memory.
	*/
	buildEntityIndex() {
		this.lons.compact();
		this.lats.compact();
	}
	/**
	* Build the spatial index for nodes.
	* Spatial index stores degrees (Float64Array) for geokdbush compatibility.
	*/
	buildSpatialIndex() {
		console.time("NodeIndex.buildSpatialIndex");
		this.spatialIndex = new KDBush(this.size, 64, Float64Array, BufferConstructor);
		for (let i = 0; i < this.size; i++) {
			const lon = microToDegrees(this.lons.at(i));
			const lat = microToDegrees(this.lats.at(i));
			this.spatialIndex.add(lon, lat);
		}
		this.spatialIndex.finish();
		this.spatialIndexBuilt = true;
		console.timeEnd("NodeIndex.buildSpatialIndex");
	}
	/**
	* Check if the spatial index has been built.
	*/
	hasSpatialIndex() {
		return this.spatialIndexBuilt;
	}
	/**
	* Get the bounding box of all nodes.
	*/
	getBbox() {
		return this.bbox;
	}
	/**
	* Get the bounding box of a specific node.
	*/
	getEntityBbox(i) {
		const index = "index" in i ? i.index : this.ids.idOrIndex(i)[0];
		const lon = microToDegrees(this.lons.at(index));
		const lat = microToDegrees(this.lats.at(index));
		return [
			lon,
			lat,
			lon,
			lat
		];
	}
	/**
	* Get the longitude and latitude of a specific node.
	*/
	getNodeLonLat(i) {
		const index = "index" in i ? i.index : this.ids.idOrIndex(i)[0];
		return [microToDegrees(this.lons.at(index)), microToDegrees(this.lats.at(index))];
	}
	/**
	* Get the full node entity.
	*/
	getFullEntity(index, id, tags) {
		const [lon, lat] = this.getNodeLonLat({ index });
		if (tags) return {
			id,
			lat,
			lon,
			tags
		};
		return {
			id,
			lat,
			lon
		};
	}
	/**
	* Find node indexes within a bounding box.
	*/
	findIndexesWithinBbox(bbox) {
		return this.spatialIndex.range(bbox[0], bbox[1], bbox[2], bbox[3]);
	}
	/**
	* Find node indexes within a radius of a point.
	* Uses geokdbush for proper great-circle distance calculations.
	* @param lon - Longitude in degrees.
	* @param lat - Latitude in degrees.
	* @param radiusKm - Radius in kilometers.
	* @returns Array of node indexes within the radius.
	*/
	findIndexesWithinRadius(lon, lat, radiusKm) {
		return around$1(this.spatialIndex, lon, lat, Number.POSITIVE_INFINITY, radiusKm);
	}
	/**
	* Get nodes within a bounding box.
	* @param bbox - The bounding box to search within.
	* @param include - A function to filter nodes. If provided, only nodes for which the function returns true will be included.
	* @returns An object containing the IDs and positions of the nodes within the bounding box.
	*/
	withinBbox(bbox, include) {
		console.time("Nodes.withinBbox");
		const nodeCandidates = this.findIndexesWithinBbox(bbox);
		const nodePositions = new Float64Array(nodeCandidates.length * 2);
		const ids = new Float64Array(nodeCandidates.length);
		let skipped = 0;
		nodeCandidates.forEach((nodeIndex, i) => {
			if (include && !include(nodeIndex)) {
				skipped++;
				return;
			}
			const [lon, lat] = this.getNodeLonLat({ index: nodeIndex });
			ids[i - skipped] = this.ids.at(nodeIndex);
			nodePositions[(i - skipped) * 2] = lon;
			nodePositions[(i - skipped) * 2 + 1] = lat;
		});
		console.timeEnd("Nodes.withinBbox");
		return {
			ids: ids.subarray(0, nodeCandidates.length - skipped),
			positions: nodePositions.slice(0, (nodeCandidates.length - skipped) * 2)
		};
	}
	/**
	* Get transferable objects for passing to another thread.
	* Only includes spatialIndex if it has been built.
	*/
	transferables() {
		const base = {
			...super.transferables(),
			lons: this.lons.array.buffer,
			lats: this.lats.array.buffer,
			bbox: this.bbox
		};
		if (this.spatialIndexBuilt) return {
			...base,
			spatialIndex: this.spatialIndex.data
		};
		return base;
	}
	/**
	* Get the approximate memory requirements for a given number of nodes in bytes.
	*/
	static getBytesRequired(count) {
		if (count === 0) return 0;
		const indexBytes = (count < 65536 ? 2 : 4) * count;
		const coordsBytes = count * 2 * Float64Array.BYTES_PER_ELEMENT;
		const padding = (8 - indexBytes % 8) % 8;
		const spatialIndexBytes = 8 + indexBytes + coordsBytes + padding;
		return Ids.getBytesRequired(count) + Tags.getBytesRequired(count) + count * Int32Array.BYTES_PER_ELEMENT + count * Int32Array.BYTES_PER_ELEMENT + spatialIndexBytes;
	}
	/**
	* Update a ContentHasher with node-specific data (coordinates).
	*/
	updateHash(hasher) {
		return super.updateHash(hasher).update(this.lons.array).update(this.lats.array);
	}
};
//#endregion
//#region ../../node_modules/@osmix/shared/dist/relation-kind.js
/**
* Relation kind detection and geometry building.
*
* Determines the semantic type of OSM relations (area, line, point, logic, super)
* based on their type tag and member structure. Also provides utilities for
* building geometries from relation members.
*
* @module
*/
/**
* Get the semantic kind of a relation based on its type tag.
* Based on [OSM relation documentation](https://wiki.openstreetmap.org/wiki/Relation):
* - Areas: multipolygon, boundary, site
* - Lines: route, waterway, multilinestring, canal
* - Points: multipoint
* - Logic: restriction, route_master, network, collection
* - [Super: relations that contain other relations](https://wiki.openstreetmap.org/wiki/Super-relation)
*/
function getRelationKind(relation) {
	const typeTag = relation.tags?.["type"];
	if (!typeTag || typeof typeTag !== "string") {
		if (relation.members.some((m) => m.type === "relation")) return "super";
		return "logic";
	}
	const normalizedType = typeTag.toLowerCase();
	if (normalizedType === "multipolygon" || normalizedType === "boundary" || normalizedType === "site") return "area";
	if (normalizedType === "route" || normalizedType === "waterway" || normalizedType === "multilinestring" || normalizedType === "canal") return "line";
	if (normalizedType === "multipoint") return "point";
	if (relation.members.some((m) => m.type === "relation")) return "super";
	return "logic";
}
/**
* Check if a relation is an area relation.
*/
function isAreaRelation(relation) {
	return getRelationKind(relation) === "area";
}
/**
* Check if a relation is a line relation.
*/
function isLineRelation(relation) {
	return getRelationKind(relation) === "line";
}
/**
* Check if a relation is a point relation.
*/
function isPointRelation(relation) {
	return getRelationKind(relation) === "point";
}
/**
* Check if a relation is a super-relation (contains other relations).
*/
function isSuperRelation(relation) {
	return getRelationKind(relation) === "super";
}
/**
* Build MultiLineString geometry from a line relation by connecting way members.
* Orders way members using their refs and handles role-based reversal.
* Returns an array of LineString coordinates (each LineString is an array of LonLat).
*/
function buildRelationLineStrings(relation, getWay, getNodeCoordinates) {
	const lineStrings = [];
	const wayMembers = relation.members.filter((m) => m.type === "way");
	if (wayMembers.length === 0) return lineStrings;
	const roleGroups = /* @__PURE__ */ new Map();
	for (const member of wayMembers) {
		const role = member.role?.toLowerCase() ?? "";
		let roleGroup = roleGroups.get(role);
		if (!roleGroup) {
			roleGroup = [];
			roleGroups.set(role, roleGroup);
		}
		roleGroup.push(member);
	}
	const groupsToProcess = roleGroups.size === 1 || !relation.members.some((m) => m.role) ? [wayMembers] : Array.from(roleGroups.values());
	for (const group of groupsToProcess) {
		const connected = connectWaysToLineStrings(group, getWay, getNodeCoordinates);
		lineStrings.push(...connected);
	}
	return lineStrings;
}
/**
* Connect ways that share endpoints to form continuous LineStrings.
* Returns an array of LineStrings (each is an array of LonLat coordinates).
*/
function connectWaysToLineStrings(wayMembers, getWay, getNodeCoordinates) {
	if (wayMembers.length === 0) return [];
	const lineStrings = [];
	const used = /* @__PURE__ */ new Set();
	const wayMap = /* @__PURE__ */ new Map();
	for (const member of wayMembers) {
		const way = getWay(member.ref);
		if (way) wayMap.set(member.ref, way);
	}
	for (const member of wayMembers) {
		if (used.has(member.ref)) continue;
		const startWay = wayMap.get(member.ref);
		if (!startWay || startWay.refs.length < 2) continue;
		const coords = [];
		const currentWay = startWay;
		used.add(member.ref);
		for (const nodeId of currentWay.refs) {
			const coord = getNodeCoordinates(nodeId);
			if (coord) coords.push(coord);
		}
		while (true) {
			let found = false;
			const lastCoord = coords[coords.length - 1];
			if (!lastCoord) break;
			for (const nextMember of wayMembers) {
				if (used.has(nextMember.ref)) continue;
				const nextWay = wayMap.get(nextMember.ref);
				if (!nextWay || nextWay.refs.length < 2) continue;
				const nextStart = getNodeCoordinates(nextWay.refs[0]);
				const nextEnd = getNodeCoordinates(nextWay.refs[nextWay.refs.length - 1]);
				if (!nextStart || !nextEnd) continue;
				if (lastCoord[0] === nextStart[0] && lastCoord[1] === nextStart[1]) {
					for (let i = 1; i < nextWay.refs.length; i++) {
						const nodeId = nextWay.refs[i];
						if (nodeId === void 0) continue;
						const coord = getNodeCoordinates(nodeId);
						if (coord) coords.push(coord);
					}
					used.add(nextMember.ref);
					found = true;
					break;
				}
				if (lastCoord[0] === nextEnd[0] && lastCoord[1] === nextEnd[1]) {
					for (let i = nextWay.refs.length - 2; i >= 0; i--) {
						const nodeId = nextWay.refs[i];
						if (nodeId === void 0) continue;
						const coord = getNodeCoordinates(nodeId);
						if (coord) coords.push(coord);
					}
					used.add(nextMember.ref);
					found = true;
					break;
				}
			}
			if (!found) break;
		}
		while (true) {
			let found = false;
			const firstCoord = coords[0];
			if (!firstCoord) break;
			for (const prevMember of wayMembers) {
				if (used.has(prevMember.ref)) continue;
				const prevWay = wayMap.get(prevMember.ref);
				if (!prevWay || prevWay.refs.length < 2) continue;
				const prevStart = getNodeCoordinates(prevWay.refs[0]);
				const prevEnd = getNodeCoordinates(prevWay.refs[prevWay.refs.length - 1]);
				if (!prevStart || !prevEnd) continue;
				if (firstCoord[0] === prevEnd[0] && firstCoord[1] === prevEnd[1]) {
					const newCoords = [];
					for (let i = 0; i < prevWay.refs.length - 1; i++) {
						const nodeId = prevWay.refs[i];
						if (nodeId === void 0) continue;
						const coord = getNodeCoordinates(nodeId);
						if (coord) newCoords.push(coord);
					}
					coords.unshift(...newCoords);
					used.add(prevMember.ref);
					found = true;
					break;
				}
				if (firstCoord[0] === prevStart[0] && firstCoord[1] === prevStart[1]) {
					const newCoords = [];
					for (let i = prevWay.refs.length - 1; i > 0; i--) {
						const nodeId = prevWay.refs[i];
						if (nodeId === void 0) continue;
						const coord = getNodeCoordinates(nodeId);
						if (coord) newCoords.push(coord);
					}
					coords.unshift(...newCoords);
					used.add(prevMember.ref);
					found = true;
					break;
				}
			}
			if (!found) break;
		}
		if (coords.length >= 2) lineStrings.push(coords);
	}
	return lineStrings;
}
/**
* Collect point coordinates from a point relation.
* Returns an array of LonLat coordinates from node members.
*/
function collectRelationPoints(relation, getNodeCoordinates) {
	const points = [];
	for (const member of relation.members) if (member.type === "node") {
		const coord = getNodeCoordinates(member.ref);
		if (coord) points.push(coord);
	}
	return points;
}
/**
* Resolve nested relation members, flattening the hierarchy with cycle detection.
* Returns all nodes, ways, and relations that are members (directly or indirectly).
* @param relation - The relation to resolve
* @param getRelation - Function to get a relation by ID
* @param maxDepth - Maximum recursion depth (default: 10)
* @param visited - Set of relation IDs already visited (for cycle detection)
*/
function resolveRelationMembers(relation, getRelation, maxDepth = 10, visited = /* @__PURE__ */ new Set()) {
	const nodes = /* @__PURE__ */ new Set();
	const ways = /* @__PURE__ */ new Set();
	const relations = /* @__PURE__ */ new Set();
	if (visited.has(relation.id) || maxDepth <= 0) return {
		nodes: [],
		ways: [],
		relations: []
	};
	visited.add(relation.id);
	for (const member of relation.members) if (member.type === "node") {
		if (!nodes.has(member.ref)) nodes.add(member.ref);
	} else if (member.type === "way") {
		if (!ways.has(member.ref)) ways.add(member.ref);
	} else if (member.type === "relation") {
		if (!relations.has(member.ref)) {
			relations.add(member.ref);
			const nestedRelation = getRelation(member.ref);
			if (nestedRelation) {
				const nested = resolveRelationMembers(nestedRelation, getRelation, maxDepth - 1, visited);
				for (const nodeId of nested.nodes) if (!nodes.has(nodeId)) nodes.add(nodeId);
				for (const wayId of nested.ways) if (!ways.has(wayId)) ways.add(wayId);
				for (const relId of nested.relations) if (!relations.has(relId)) relations.add(relId);
			}
		}
	}
	return {
		nodes: Array.from(nodes),
		ways: Array.from(ways),
		relations: Array.from(relations)
	};
}
//#endregion
//#region ../../node_modules/@osmix/shared/dist/relation-multipolygon.js
/**
* Multipolygon relation building utilities.
*
* Implements the OSM multipolygon relation specification to construct
* polygon geometries from way members. Handles outer/inner roles,
* way connection, and ring closure.
*
* @see https://wiki.openstreetmap.org/wiki/Relation:multipolygon
*
* @module
*/
/**
* Get way members from a relation, grouped by role (outer/inner).
*/
function getWayMembersByRole(relation) {
	const outer = [];
	const inner = [];
	for (const member of relation.members) {
		if (member.type !== "way") continue;
		const role = member.role?.toLowerCase() ?? "";
		if (role === "outer") outer.push(member);
		else if (role === "inner") inner.push(member);
	}
	return {
		outer,
		inner
	};
}
/**
* Connect ways that share endpoints to form a continuous ring.
* Returns an array of rings (each ring is an array of way IDs in order).
*
* This function handles:
* - Ways that are reversed (end matches end, or start matches start).
* - Closed ways (single ways that form a ring).
* - Disconnected chains (multiple independent rings).
*/
function connectWaysToRings(wayMembers) {
	if (wayMembers.length === 0) return [];
	const rings = [];
	const used = /* @__PURE__ */ new Set();
	const wayMap = /* @__PURE__ */ new Map();
	for (const member of wayMembers) wayMap.set(member.id, member);
	const reverseWay = (way) => ({
		...way,
		refs: [...way.refs].reverse()
	});
	for (const startWay of wayMembers) {
		if (used.has(startWay.id)) continue;
		if (startWay.refs.length < 2) throw Error("Way has less than 2 refs");
		const ring = [startWay];
		used.add(startWay.id);
		let currentStart = startWay.refs[0];
		let currentEnd = startWay.refs[startWay.refs.length - 1];
		while (true) {
			let found = false;
			for (const nextWay of wayMembers) {
				if (used.has(nextWay.id)) continue;
				if (nextWay.refs.length < 2) throw Error("Way has less than 2 refs");
				const nextStart = nextWay.refs[0];
				const nextEnd = nextWay.refs[nextWay.refs.length - 1];
				if (currentEnd === nextStart) {
					ring.push(nextWay);
					used.add(nextWay.id);
					currentEnd = nextEnd;
					found = true;
					break;
				}
				if (currentEnd === nextEnd) {
					ring.push(reverseWay(nextWay));
					used.add(nextWay.id);
					currentEnd = nextStart;
					found = true;
					break;
				}
			}
			if (!found) break;
		}
		currentStart = startWay.refs[0];
		currentEnd = startWay.refs[startWay.refs.length - 1];
		while (true) {
			let found = false;
			for (const nextWay of wayMembers) {
				if (used.has(nextWay.id)) continue;
				if (nextWay.refs.length < 2) throw Error("Way has less than 2 refs");
				const nextStart = nextWay.refs[0];
				const nextEnd = nextWay.refs[nextWay.refs.length - 1];
				if (currentStart === nextEnd) {
					ring.unshift(nextWay);
					used.add(nextWay.id);
					currentStart = nextStart;
					found = true;
					break;
				}
				if (currentStart === nextStart) {
					ring.unshift(reverseWay(nextWay));
					used.add(nextWay.id);
					currentStart = nextEnd;
					found = true;
					break;
				}
			}
			if (!found) break;
		}
		if (ring.length > 0) {
			const firstWay = ring[0];
			const lastWay = ring[ring.length - 1];
			if (firstWay?.refs[0] === lastWay?.refs[lastWay.refs.length - 1]) rings.push(ring);
		}
	}
	return rings;
}
/**
* Build polygon rings from way members of a relation.
* Returns an array where each element is an array of coordinate rings (outer + inner).
*
* Based on OSM multipolygon relation specification:
* https://wiki.openstreetmap.org/wiki/Relation:multipolygon
*
* This implementation connects way members into closed rings, and then groups them
* into polygons. Currently, it associates all inner rings with every outer ring
* found in the relation, which is a simplification. A robust implementation would
* use point-in-polygon checks to strictly nest holes inside their parent outer ring.
*/
function buildRelationRings(relation, getWay, getNodeCoordinates) {
	const { outer, inner } = getWayMembersByRole(relation);
	const outerRings = connectWaysToRings(outer.map((m) => getWay(m.ref)).filter((w) => w !== null));
	const innerRings = connectWaysToRings(inner.map((m) => getWay(m.ref)).filter((w) => w !== null));
	const wayRingToCoords = (ring) => {
		const coords = [];
		for (const way of ring) for (const nodeId of way.refs) {
			const coord = getNodeCoordinates(nodeId);
			if (coord) coords.push(coord);
		}
		if (coords.length > 0) {
			const first = coords[0];
			const last = coords[coords.length - 1];
			if (first && last && (first[0] !== last[0] || first[1] !== last[1])) coords.push([first[0], first[1]]);
		}
		return coords;
	};
	const coordinateRings = [];
	for (const outerRing of outerRings) {
		const outerCoordinates = wayRingToCoords(outerRing);
		if (outerCoordinates.length >= 3) {
			const innerCoordinates = [];
			for (const innerRing of innerRings) {
				const innerCoords = wayRingToCoords(innerRing);
				if (innerCoords.length >= 3) innerCoordinates.push(innerCoords);
			}
			coordinateRings.push([outerCoordinates, ...innerCoordinates]);
		}
	}
	return coordinateRings;
}
//#endregion
//#region ../../node_modules/@osmix/shared/dist/utils.js
/** Type guard: check if entity is a Node. */
function isNode(entity) {
	return "lon" in entity && "lat" in entity;
}
/** Type guard: check if entity is a Way. */
function isWay(entity) {
	return "refs" in entity;
}
/** Type guard: check if entity is a Relation. */
function isRelation(entity) {
	return "members" in entity;
}
/**
* Compute the bounding box of a set of coordinates.
* Returns `[minLon, minLat, maxLon, maxLat]`.
*/
function bboxFromLonLats(lonLats) {
	let minLon = Number.POSITIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	for (const [lon, lat] of lonLats) {
		if (lon < minLon) minLon = lon;
		if (lat < minLat) minLat = lat;
		if (lon > maxLon) maxLon = lon;
		if (lat > maxLat) maxLat = lat;
	}
	return [
		minLon,
		minLat,
		maxLon,
		maxLat
	];
}
//#endregion
//#region ../../node_modules/flatqueue/index.js
/**
* @typedef {Float64ArrayConstructor | Float32ArrayConstructor |
*   Uint32ArrayConstructor | Int32ArrayConstructor | Uint16ArrayConstructor |
*   Int16ArrayConstructor | Uint8ArrayConstructor | Int8ArrayConstructor} TypedArrayConstructor
*/
/** @template [T=number] */
var FlatQueue = class {
	/**
	* Creates an empty queue. If `capacity` is provided, the queue is backed by fixed-size typed
	* arrays for better performance and memory use, but can't grow beyond `capacity`. `values` uses
	* `ValuesArray` (default `Float64Array`) and `ids` uses `IdsArray` (default `Uint32Array`); pass
	* narrower constructors like `Uint16Array` if your values or ids are known to fit them.
	*
	* @param {number} [capacity]
	* @param {TypedArrayConstructor} [ValuesArray]
	* @param {TypedArrayConstructor} [IdsArray]
	*/
	constructor(capacity = Infinity, ValuesArray = Float64Array, IdsArray = Uint32Array) {
		const fixed = capacity !== Infinity;
		/** @type {T[]} */
		this.ids = fixed ? new IdsArray(capacity) : [];
		/** @type {number[]} */
		this.values = fixed ? new ValuesArray(capacity) : [];
		/** Maximum number of items the queue can hold; `Infinity` for regular-array queues, which grow on demand. */
		this.capacity = capacity;
		/** Number of items in the queue. */
		this.length = 0;
	}
	/** Removes all items from the queue. */
	clear() {
		this.length = 0;
	}
	/**
	* Adds `item` to the queue with the specified `priority`.
	*
	* `priority` must be a number. Items are sorted and returned from low to high priority. Multiple items
	* with the same priority value can be added to the queue, but there is no guaranteed order between these items.
	*
	* For fixed-capacity queues, throws a `RangeError` if the queue is already full.
	*
	* @param {T} item
	* @param {number} priority
	*/
	push(item, priority) {
		if (this.length === this.capacity) throw new RangeError("Queue is at capacity.");
		let pos = this.length++;
		while (pos > 0) {
			const parent = pos - 1 >> 1;
			const parentValue = this.values[parent];
			if (priority >= parentValue) break;
			this.ids[pos] = this.ids[parent];
			this.values[pos] = parentValue;
			pos = parent;
		}
		this.ids[pos] = item;
		this.values[pos] = priority;
	}
	/**
	* Removes and returns the item from the head of this queue, which is one of
	* the items with the lowest priority. If this queue is empty, returns `undefined`.
	*/
	pop() {
		if (this.length === 0) return void 0;
		const ids = this.ids, values = this.values, top = ids[0], last = --this.length;
		if (last > 0) {
			const id = ids[last];
			const value = values[last];
			let pos = 0;
			const halfLen = last >> 1;
			while (pos < halfLen) {
				const left = (pos << 1) + 1;
				const right = left + 1;
				const child = left + (+(right < last) & +(values[right] < values[left]));
				if (values[child] >= value) break;
				ids[pos] = ids[child];
				values[pos] = values[child];
				pos = child;
			}
			ids[pos] = id;
			values[pos] = value;
		}
		return top;
	}
	/** Returns the item from the head of this queue without removing it. If this queue is empty, returns `undefined`. */
	peek() {
		return this.length > 0 ? this.ids[0] : void 0;
	}
	/**
	* Returns the priority value of the item at the head of this queue without
	* removing it. If this queue is empty, returns `undefined`.
	*/
	peekValue() {
		return this.length > 0 ? this.values[0] : void 0;
	}
	/**
	* Shrinks the internal arrays to `this.length`. No-op for queues with fixed capacity.
	*
	* `pop()` and `clear()` calls don't free memory automatically to avoid unnecessary resize operations.
	* This also means that items that have been added to the queue can't be garbage collected until
	* a new item is pushed in their place, or this method is called.
	*/
	shrink() {
		if (Array.isArray(this.ids)) this.ids.length = this.length;
		if (Array.isArray(this.values)) this.values.length = this.length;
	}
};
//#endregion
//#region ../../node_modules/flatbush/index.js
const ARRAY_TYPES = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array
];
const VERSION = 3;
/** @typedef {Int8ArrayConstructor | Uint8ArrayConstructor | Uint8ClampedArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor} TypedArrayConstructor */
/** @typedef {Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array} TypedArray */
var Flatbush = class Flatbush {
	/**
	* Recreate a Flatbush index from raw `ArrayBuffer` or `SharedArrayBuffer` data.
	* @param {ArrayBufferLike} data
	* @param {number} [byteOffset=0] byte offset to the start of the Flatbush buffer in the referenced ArrayBuffer.
	* @returns {Flatbush} index
	*/
	static from(data, byteOffset = 0) {
		if (byteOffset % 8 !== 0) throw new Error("byteOffset must be 8-byte aligned.");
		if (!data || data.byteLength === void 0 || "buffer" in data) throw new Error("Data must be an instance of ArrayBuffer or SharedArrayBuffer.");
		const [magic, versionAndType] = new Uint8Array(data, byteOffset + 0, 2);
		if (magic !== 251) throw new Error("Data does not appear to be in a Flatbush format.");
		const version = versionAndType >> 4;
		if (version !== VERSION) throw new Error(`Got v${version} data when expected v${VERSION}.`);
		const ArrayType = ARRAY_TYPES[versionAndType & 15];
		if (!ArrayType) throw new Error("Unrecognized array type.");
		const [nodeSize] = new Uint16Array(data, byteOffset + 2, 1);
		const [numItems] = new Uint32Array(data, byteOffset + 4, 1);
		return new Flatbush(numItems, nodeSize, ArrayType, void 0, data, byteOffset);
	}
	/**
	* Create a Flatbush index that will hold a given number of items.
	* @param {number} numItems
	* @param {number} [nodeSize=16] Size of the tree node (16 by default).
	* @param {TypedArrayConstructor} [ArrayType=Float64Array] The array type used for coordinates storage (`Float64Array` by default).
	* @param {ArrayBufferConstructor | SharedArrayBufferConstructor} [ArrayBufferType=ArrayBuffer] The array buffer type used to store data (`ArrayBuffer` by default).
	* @param {ArrayBufferLike} [data] (Only used internally)
	* @param {number} [byteOffset=0] (Only used internally)
	*/
	constructor(numItems, nodeSize = 16, ArrayType = Float64Array, ArrayBufferType = ArrayBuffer, data, byteOffset = 0) {
		if (numItems === void 0) throw new Error("Missing required argument: numItems.");
		if (isNaN(numItems) || numItems <= 0) throw new Error(`Unexpected numItems value: ${numItems}.`);
		this.numItems = +numItems;
		this.nodeSize = Math.min(Math.max(+nodeSize, 2), 65535);
		this.byteOffset = byteOffset;
		let n = numItems;
		let numNodes = n;
		this._levelBounds = [n * 4];
		do {
			n = Math.ceil(n / this.nodeSize);
			numNodes += n;
			this._levelBounds.push(numNodes * 4);
		} while (n !== 1);
		this.ArrayType = ArrayType;
		this.IndexArrayType = numNodes < 16384 ? Uint16Array : Uint32Array;
		const arrayTypeIndex = ARRAY_TYPES.indexOf(ArrayType);
		const nodesByteSize = numNodes * 4 * ArrayType.BYTES_PER_ELEMENT;
		if (arrayTypeIndex < 0) throw new Error(`Unexpected typed array class: ${ArrayType}.`);
		/** @type {new(b: ArrayBufferLike, o: number, l: number) => TypedArray} */
		const BoxCtor = ArrayType;
		/** @type {new(b: ArrayBufferLike, o: number, l: number) => Uint16Array | Uint32Array} */
		const IdxCtor = this.IndexArrayType;
		if (data) {
			this.data = data;
			this._boxes = new BoxCtor(data, byteOffset + 8, numNodes * 4);
			this._indices = new IdxCtor(data, byteOffset + 8 + nodesByteSize, numNodes);
			this._pos = numNodes * 4;
			this.minX = this._boxes[this._pos - 4];
			this.minY = this._boxes[this._pos - 3];
			this.maxX = this._boxes[this._pos - 2];
			this.maxY = this._boxes[this._pos - 1];
		} else {
			const data = this.data = new ArrayBufferType(8 + nodesByteSize + numNodes * this.IndexArrayType.BYTES_PER_ELEMENT);
			this._boxes = new BoxCtor(data, 8, numNodes * 4);
			this._indices = new IdxCtor(data, 8 + nodesByteSize, numNodes);
			this._pos = 0;
			this.minX = Infinity;
			this.minY = Infinity;
			this.maxX = -Infinity;
			this.maxY = -Infinity;
			new Uint8Array(data, 0, 2).set([251, 48 + arrayTypeIndex]);
			new Uint16Array(data, 2, 1)[0] = nodeSize;
			new Uint32Array(data, 4, 1)[0] = numItems;
		}
		/** @type FlatQueue<number> */
		this._queue = new FlatQueue();
	}
	/**
	* Add a given rectangle to the index.
	* @param {number} minX
	* @param {number} minY
	* @param {number} maxX
	* @param {number} maxY
	* @returns {number} A zero-based, incremental number that represents the newly added rectangle.
	*/
	add(minX, minY, maxX = minX, maxY = minY) {
		const pos = this._pos;
		const index = pos >> 2;
		const boxes = this._boxes;
		this._indices[index] = index;
		boxes[pos] = minX;
		boxes[pos + 1] = minY;
		boxes[pos + 2] = maxX;
		boxes[pos + 3] = maxY;
		this._pos = pos + 4;
		if (minX < this.minX) this.minX = minX;
		if (minY < this.minY) this.minY = minY;
		if (maxX > this.maxX) this.maxX = maxX;
		if (maxY > this.maxY) this.maxY = maxY;
		return index;
	}
	/** Perform indexing of the added rectangles. */
	finish() {
		if (this._pos >> 2 !== this.numItems) throw new Error(`Added ${this._pos >> 2} items when expected ${this.numItems}.`);
		const boxes = this._boxes;
		if (this.numItems <= this.nodeSize) {
			boxes[this._pos++] = this.minX;
			boxes[this._pos++] = this.minY;
			boxes[this._pos++] = this.maxX;
			boxes[this._pos++] = this.maxY;
			return;
		}
		const { numItems, minX, minY, nodeSize, _indices: indices, _levelBounds: levelBounds } = this;
		const width = this.maxX - minX || 1;
		const height = this.maxY - minY || 1;
		const hilbertValues = new Int32Array(numItems);
		const hilbertMax = 65535;
		const sx = hilbertMax / width;
		const sy = hilbertMax / height;
		for (let i = 0, pos = 0; i < numItems; i++) {
			const itemMinX = boxes[pos++];
			const itemMinY = boxes[pos++];
			const itemMaxX = boxes[pos++];
			const itemMaxY = boxes[pos++];
			const x = sx * ((itemMinX + itemMaxX) / 2 - minX) | 0;
			const y = sy * ((itemMinY + itemMaxY) / 2 - minY) | 0;
			hilbertValues[i] = hilbert(x, y);
		}
		sort(hilbertValues, boxes, indices, 0, numItems - 1, nodeSize);
		let pos = numItems * 4;
		for (let i = 0, readPos = 0; i < levelBounds.length - 1; i++) {
			const end = levelBounds[i];
			while (readPos < end) {
				const nodeIndex = readPos;
				let nodeMinX = boxes[readPos++];
				let nodeMinY = boxes[readPos++];
				let nodeMaxX = boxes[readPos++];
				let nodeMaxY = boxes[readPos++];
				for (let j = 1; j < nodeSize && readPos < end; j++) {
					nodeMinX = Math.min(nodeMinX, boxes[readPos++]);
					nodeMinY = Math.min(nodeMinY, boxes[readPos++]);
					nodeMaxX = Math.max(nodeMaxX, boxes[readPos++]);
					nodeMaxY = Math.max(nodeMaxY, boxes[readPos++]);
				}
				indices[pos >> 2] = nodeIndex;
				boxes[pos++] = nodeMinX;
				boxes[pos++] = nodeMinY;
				boxes[pos++] = nodeMaxX;
				boxes[pos++] = nodeMaxY;
			}
		}
		this._pos = pos;
	}
	/**
	* Search the index by a bounding box.
	* @param {number} minX
	* @param {number} minY
	* @param {number} maxX
	* @param {number} maxY
	* @param {(index: number, x0: number, y0: number, x1: number, y1: number) => boolean} [filterFn] An optional function that is called on every found item; if supplied, only items for which this function returns true will be included in the results array.
	* @returns {number[]} An array of indices of items intersecting or touching the given bounding box.
	*/
	search(minX, minY, maxX, maxY, filterFn) {
		if (this._pos !== this._boxes.length) throw new Error("Data not yet indexed - call index.finish().");
		const { _boxes: boxes, _levelBounds: levelBounds, _indices: indices, nodeSize } = this;
		const numItems4 = this.numItems * 4;
		/** @type number | undefined */
		let nodeIndex = boxes.length - 4;
		let level = levelBounds.length - 1;
		const q = [];
		const results = [];
		let contained = false;
		while (nodeIndex !== void 0) {
			const end = Math.min(nodeIndex + nodeSize * 4, levelBounds[level]);
			const isNode = nodeIndex >= numItems4;
			if (contained) this._collectContained(nodeIndex, end, level, numItems4, results, filterFn);
			else for (let pos = nodeIndex; pos < end; pos += 4) {
				const x0 = boxes[pos];
				if (maxX < x0) continue;
				const y0 = boxes[pos + 1];
				if (maxY < y0) continue;
				const x1 = boxes[pos + 2];
				if (minX > x1) continue;
				const y1 = boxes[pos + 3];
				if (minY > y1) continue;
				const index = indices[pos >> 2] | 0;
				if (isNode) {
					const c = +(minX <= x0 && minY <= y0 && maxX >= x1 && maxY >= y1);
					q.push(index | c, level - 1);
				} else if (filterFn === void 0 || filterFn(index, x0, y0, x1, y1)) results.push(index);
			}
			level = q.pop();
			nodeIndex = q.pop();
			if (nodeIndex !== void 0) {
				contained = (nodeIndex & 1) === 1;
				nodeIndex &= -2;
			}
		}
		return results;
	}
	/**
	* Collect all leaves of a subtree that's fully inside the query, skipping intersection tests.
	* Because the tree is packed bottom-up, those leaves occupy one contiguous block of the leaf
	* level, so we skip traversal entirely: descend to the first leaf, then sweep the flat range.
	* @param {number} nodeIndex
	* @param {number} end
	* @param {number} level
	* @param {number} numItems4
	* @param {number[]} results
	* @param {((index: number, x0: number, y0: number, x1: number, y1: number) => boolean) | undefined} filterFn
	*/
	_collectContained(nodeIndex, end, level, numItems4, results, filterFn) {
		const boxes = this._boxes;
		const indices = this._indices;
		let pos = nodeIndex;
		for (let l = level; l > 0; l--) pos = indices[pos >> 2];
		const leafEnd = Math.min(pos + (end - nodeIndex) * this.nodeSize ** level, numItems4);
		if (filterFn === void 0) for (; pos < leafEnd; pos += 4) results.push(indices[pos >> 2] | 0);
		else for (; pos < leafEnd; pos += 4) {
			const index = indices[pos >> 2] | 0;
			if (filterFn(index, boxes[pos], boxes[pos + 1], boxes[pos + 2], boxes[pos + 3])) results.push(index);
		}
	}
	/**
	* Search items in order of distance from the given point.
	* @param {number} x
	* @param {number} y
	* @param {number} [maxResults=Infinity]
	* @param {number} [maxDistance=Infinity]
	* @param {(index: number) => boolean} [filterFn] An optional function for filtering the results.
	* @returns {number[]} An array of indices of items found.
	*/
	neighbors(x, y, maxResults = Infinity, maxDistance = Infinity, filterFn) {
		if (this._pos !== this._boxes.length) throw new Error("Data not yet indexed - call index.finish().");
		const { _boxes: boxes, _levelBounds: levelBounds, _indices: indices, _queue: q, nodeSize } = this;
		const numItems4 = this.numItems * 4;
		const nodeSize4 = nodeSize * 4;
		const results = [];
		const maxDistSquared = maxDistance * maxDistance;
		const trackNearest = maxResults === 1;
		let bound = maxDistSquared;
		q.push(boxes.length - 4 << 1, 0);
		while (q.length) {
			const top = q.ids[0];
			if (top & 1) {
				q.pop();
				results.push(top >> 1);
				if (results.length === maxResults) break;
				continue;
			}
			q.pop();
			const nodeIndex = top >> 1;
			const isLeafLevel = nodeIndex < numItems4;
			const end = Math.min(nodeIndex + nodeSize4, upperBound$1(nodeIndex, levelBounds));
			for (let pos = nodeIndex; pos < end; pos += 4) {
				const minX = boxes[pos];
				const minY = boxes[pos + 1];
				const maxX = boxes[pos + 2];
				const maxY = boxes[pos + 3];
				const dx = Math.max(Math.max(minX - x, x - maxX), 0);
				const dy = Math.max(Math.max(minY - y, y - maxY), 0);
				const dist = dx * dx + dy * dy;
				if (dist > bound) continue;
				const childIndex = indices[pos >> 2] | 0;
				if (isLeafLevel) {
					if (filterFn === void 0 || filterFn(childIndex)) {
						q.push(childIndex << 1 | 1, dist);
						if (trackNearest && dist < bound) bound = dist;
					}
				} else q.push(childIndex << 1, dist);
			}
		}
		q.clear();
		return results;
	}
};
/**
* Binary search for the first value in the array bigger than the given.
* @param {number} value
* @param {number[]} arr
*/
function upperBound$1(value, arr) {
	let i = 0;
	let j = arr.length - 1;
	while (i < j) {
		const m = i + j >> 1;
		if (arr[m] > value) j = m;
		else i = m + 1;
	}
	return arr[i];
}
/**
* Custom quicksort that partially sorts bbox data alongside the hilbert values.
* @param {Int32Array} values
* @param {TypedArray} boxes
* @param {Uint16Array | Uint32Array} indices
* @param {number} left
* @param {number} right
* @param {number} nodeSize
*/
function sort(values, boxes, indices, left, right, nodeSize) {
	const stack = [left, right];
	while (stack.length) {
		const r = stack.pop() || 0;
		const l = stack.pop() || 0;
		if (r - l <= nodeSize && Math.floor(l / nodeSize) >= Math.floor(r / nodeSize)) continue;
		const a = values[l];
		const b = values[l + r >> 1];
		const c = values[r];
		const pivot = a > b !== a > c ? a : b < a !== b < c ? b : c;
		let i = l - 1;
		let j = r + 1;
		while (true) {
			do
				i++;
			while (values[i] < pivot);
			do
				j--;
			while (values[j] > pivot);
			if (i >= j) break;
			swap(values, boxes, indices, i, j);
		}
		stack.push(l, j, j + 1, r);
	}
}
/**
* Swap two values and two corresponding boxes.
* @param {Int32Array} values
* @param {TypedArray} boxes
* @param {Uint16Array | Uint32Array} indices
* @param {number} i
* @param {number} j
*/
function swap(values, boxes, indices, i, j) {
	const temp = values[i];
	values[i] = values[j];
	values[j] = temp;
	const k = 4 * i;
	const m = 4 * j;
	const a = boxes[k];
	const b = boxes[k + 1];
	const c = boxes[k + 2];
	const d = boxes[k + 3];
	boxes[k] = boxes[m];
	boxes[k + 1] = boxes[m + 1];
	boxes[k + 2] = boxes[m + 2];
	boxes[k + 3] = boxes[m + 3];
	boxes[m] = a;
	boxes[m + 1] = b;
	boxes[m + 2] = c;
	boxes[m + 3] = d;
	const e = indices[i];
	indices[i] = indices[j];
	indices[j] = e;
}
/**
* Fast Hilbert curve algorithm by http://threadlocalmutex.com/
* Ported from C++ https://github.com/rawrunprotected/hilbert_curves (public domain)
* @param {number} x
* @param {number} y
*/
function hilbert(x, y) {
	let a = x ^ y;
	let b = 65535 ^ a;
	let c = 65535 ^ (x | y);
	let d = x & (y ^ 65535);
	let A = a | b >> 1;
	let B = a >> 1 ^ a;
	let C = c ^ (c >> 1 ^ b & d >> 1);
	let D = d ^ (a & c >> 1 ^ d >> 1);
	a = A & A >> 2 ^ B & B >> 2;
	b = A & B >> 2 ^ B & (A ^ B) >> 2;
	c = C ^ (A & C >> 2 ^ B & D >> 2);
	d = D ^ (B & C >> 2 ^ (A ^ B) & D >> 2);
	A = a & a >> 4 ^ b & b >> 4;
	B = a & b >> 4 ^ b & (a ^ b) >> 4;
	C = c ^ (a & c >> 4 ^ b & d >> 4);
	D = d ^ (b & c >> 4 ^ (a ^ b) & d >> 4);
	c = C ^ (A & C >> 8 ^ B & D >> 8);
	d = D ^ (B & C >> 8 ^ (A ^ B) & D >> 8);
	c ^= c >> 1;
	d ^= d >> 1;
	a = x ^ y;
	b = d | 65535 ^ (a | c);
	a = (a | a << 8) & 16711935;
	a = (a | a << 4) & 252645135;
	a = (a | a << 2) & 858993459;
	a = (a | a << 1) & 1431655765;
	b = (b | b << 8) & 16711935;
	b = (b | b << 4) & 252645135;
	b = (b | b << 2) & 858993459;
	b = (b | b << 1) & 1431655765;
	return ((b << 1 | a) >>> 0) - 2147483648;
}
//#endregion
//#region ../../node_modules/geoflatbush/index.js
/** @import Flatbush from 'flatbush' */
const earthRadius = 6371;
const rad = Math.PI / 180;
/**
* Search items in a given Flatbush index in order of geographical distance from the given point.
* Assumes the index contains bbox values of the form [minLng, minLat, maxLng, maxLat].
*
* @param {Flatbush} index Flatbush index.
* @param {number} lng Longitude.
* @param {number} lat Latitude.
* @param {number} [maxResults=Infinity] Number of items to return (if not provided, search will return all the items in the index, sorted).
* @param {number} [maxDistance=Infinity] Maximum distance to search for in kilometers.
* @param {(index: number) => boolean} [filterFn] An optional function for filtering the results.
* @returns {number[]} An array of indices of items found.
*/
function around(index, lng, lat, maxResults = Infinity, maxDistance = Infinity, filterFn) {
	const result = [];
	const cosLat = Math.cos(lat * rad);
	const sinLat = Math.sin(lat * rad);
	const negCosMaxDist = maxDistance === Infinity ? Infinity : -Math.cos(maxDistance / earthRadius);
	const { _boxes: boxes, _indices: indices, _queue: q, _levelBounds: levelBounds } = index;
	const nodeSize4 = index.nodeSize * 4;
	const numItems4 = index.numItems * 4;
	q.push(boxes.length - 4 << 1, 0);
	while (q.length) {
		const top = q.ids[0];
		if (top & 1) {
			if (q.values[0] > negCosMaxDist) break;
			q.pop();
			result.push(top >> 1);
			if (result.length === maxResults) break;
			continue;
		}
		q.pop();
		const nodeIndex = top >> 1;
		const isLeafLevel = nodeIndex < numItems4;
		const end = Math.min(nodeIndex + nodeSize4, upperBound(nodeIndex, levelBounds));
		for (let pos = nodeIndex; pos < end; pos += 4) {
			const childIndex = indices[pos >> 2] | 0;
			const negCosDist = boxNegCosDist(lng, lat, boxes[pos], boxes[pos + 1], boxes[pos + 2], boxes[pos + 3], cosLat, sinLat);
			if (isLeafLevel) {
				if (!filterFn || filterFn(childIndex)) q.push(childIndex << 1 | 1, negCosDist);
			} else q.push(childIndex << 1, negCosDist);
		}
	}
	q.clear();
	return result;
}
/**
* Binary search for the first value in the array bigger than the given.
* @param {number} value
* @param {number[]} arr
*/
function upperBound(value, arr) {
	let i = 0;
	let j = arr.length - 1;
	while (i < j) {
		const m = i + j >> 1;
		if (arr[m] > value) j = m;
		else i = m + 1;
	}
	return arr[i];
}
/**
* Lower bound for distance from a location to points inside a bounding box,
* expressed as the negative cosine of the angular distance (monotonic with real distance,
* but avoids a Math.acos call on every comparison).
* @param {number} lng
* @param {number} lat
* @param {number} minLng
* @param {number} minLat
* @param {number} maxLng
* @param {number} maxLat
* @param {number} cosLat
* @param {number} sinLat
*/
function boxNegCosDist(lng, lat, minLng, minLat, maxLng, maxLat, cosLat, sinLat) {
	if (lng >= minLng && lng <= maxLng) {
		if (lat < minLat) return -Math.cos((minLat - lat) * rad);
		if (lat > maxLat) return -Math.cos((lat - maxLat) * rad);
		return -1;
	}
	let westGap = minLng - lng;
	if (westGap < 0) westGap += 360;
	let eastGap = lng - maxLng;
	if (eastGap < 0) eastGap += 360;
	const cosLngDelta = Math.cos(((westGap <= eastGap ? minLng : maxLng) - lng) * rad);
	const dMin = cosAngular(minLat, cosLat, sinLat, cosLngDelta);
	if (minLat === maxLat) return -dMin;
	let d = Math.max(dMin, cosAngular(maxLat, cosLat, sinLat, cosLngDelta));
	const extremumLat = Math.atan(sinLat / (cosLat * cosLngDelta)) / rad;
	if (extremumLat > minLat && extremumLat < maxLat) d = Math.max(d, cosAngular(extremumLat, cosLat, sinLat, cosLngDelta));
	return -d;
}
/**
* Cosine of angular distance between query point and (any_lng_with_cosLngDelta, lat).
* @param {number} lat
* @param {number} cosLat
* @param {number} sinLat
* @param {number} cosLngDelta
*/
function cosAngular(lat, cosLat, sinLat, cosLngDelta) {
	const d = sinLat * Math.sin(lat * rad) + cosLat * Math.cos(lat * rad) * cosLngDelta;
	return d < 1 ? d : 1;
}
//#endregion
//#region ../../node_modules/@osmix/core/dist/relations.js
const RELATION_MEMBER_TYPES = [
	"node",
	"way",
	"relation"
];
var Relations = class extends Entities {
	stringTable;
	memberStart;
	memberCount;
	memberRefs;
	memberTypes;
	memberRoles;
	spatialIndex = new Flatbush(1);
	spatialIndexBuilt = false;
	bbox;
	nodes;
	ways;
	/**
	* Create a new Relations index.
	*/
	constructor(stringTable, nodes, ways, transferables) {
		if (transferables) {
			super("relation", new Ids(transferables), new Tags(stringTable, transferables));
			this.memberStart = ResizeableTypedArray.from(Uint32Array, transferables.memberStart);
			this.memberCount = ResizeableTypedArray.from(Uint16Array, transferables.memberCount);
			this.memberRefs = ResizeableTypedArray.from(IdArrayType, transferables.memberRefs);
			this.memberTypes = ResizeableTypedArray.from(Uint8Array, transferables.memberTypes);
			this.memberRoles = ResizeableTypedArray.from(Uint32Array, transferables.memberRoles);
			this.bbox = ResizeableTypedArray.from(Float64Array, transferables.bbox);
			if (transferables.spatialIndex?.byteLength) {
				this.spatialIndex = Flatbush.from(transferables.spatialIndex);
				this.spatialIndexBuilt = true;
			}
			this.indexBuilt = true;
		} else {
			super("relation", new Ids(), new Tags(stringTable));
			this.memberStart = new ResizeableTypedArray(Uint32Array);
			this.memberCount = new ResizeableTypedArray(Uint16Array);
			this.memberRefs = new ResizeableTypedArray(IdArrayType);
			this.memberTypes = new ResizeableTypedArray(Uint8Array);
			this.memberRoles = new ResizeableTypedArray(Uint32Array);
			this.bbox = new ResizeableTypedArray(Float64Array);
		}
		this.nodes = nodes;
		this.ways = ways;
		this.stringTable = stringTable;
	}
	/**
	* Add a single relation to the index.
	*/
	addRelation(relation) {
		const relationIndex = this.addEntity(relation.id, relation.tags ?? {});
		this.memberStart.push(this.memberRefs.length);
		this.memberCount.push(relation.members.length);
		for (const member of relation.members) {
			this.memberRefs.push(member.ref);
			this.memberTypes.push(RELATION_MEMBER_TYPES.indexOf(member.type));
			this.memberRoles.push(this.stringTable.add(member.role ?? ""));
		}
		return relationIndex;
	}
	/**
	* Bulk add relations directly from a PBF PrimitiveBlock.
	*/
	addRelations(relations, blockStringIndexMap, filter) {
		const blockToStringTable = (k) => {
			const index = blockStringIndexMap[k];
			if (index === void 0) throw Error("Tag key not found");
			return index;
		};
		let added = 0;
		for (const relation of relations) {
			const members = [];
			const memberRefs = [];
			const memberTypes = [];
			const memberRoles = [];
			let refId = 0;
			for (let i = 0; i < relation.memids.length; i++) {
				const memid = relation.memids[i];
				const roleSid = relation.roles_sid[i];
				const typeIndex = relation.types[i];
				assertValue(memid, "Relation member ID is undefined");
				assertValue(roleSid, "Relation member role SID is undefined");
				assertValue(typeIndex, "Relation member type is undefined");
				refId += memid;
				const roleIndex = blockToStringTable(roleSid);
				const type = RELATION_MEMBER_TYPES[typeIndex];
				assertValue(type, "Relation member type not found");
				if (filter) members.push({
					type,
					ref: refId,
					role: this.stringTable.get(roleIndex)
				});
				memberRefs.push(refId);
				memberTypes.push(typeIndex);
				memberRoles.push(roleIndex);
			}
			const tagKeys = relation.keys.map(blockToStringTable);
			const tagValues = relation.vals.map(blockToStringTable);
			const filteredRelation = filter ? filter({
				id: relation.id,
				members,
				tags: this.tags.getTagsFromIndices(tagKeys, tagValues)
			}) : null;
			if (filter && filteredRelation === null) continue;
			added++;
			this.addEntity(relation.id, tagKeys, tagValues);
			this.memberStart.push(this.memberRefs.length);
			this.memberCount.push(filteredRelation?.members.length ?? memberRefs.length);
			this.memberRefs.pushMany(filteredRelation?.members.map((m) => m.ref) ?? memberRefs);
			this.memberTypes.pushMany(filteredRelation?.members.map((m) => RELATION_MEMBER_TYPES.indexOf(m.type)) ?? memberTypes);
			this.memberRoles.pushMany(filteredRelation?.members.map((m) => this.stringTable.add(m.role ?? "")) ?? memberRoles);
		}
		return added;
	}
	/**
	* Compact the internal arrays to free up memory.
	*/
	buildEntityIndex() {
		this.memberStart.compact();
		this.memberCount.compact();
		this.memberRefs.compact();
		this.memberTypes.compact();
		this.memberRoles.compact();
	}
	/**
	* Build the spatial index for relations.
	* Handles nested relations by resolving all descendant nodes and ways.
	* If bbox data already exists (e.g., loaded from storage), reuses it.
	*/
	buildSpatialIndex() {
		if (!this.nodes.isReady()) throw Error("Node index is not ready.");
		if (!this.ways.isReady()) throw Error("Way index is not ready.");
		if (this.size === 0) return this.spatialIndex;
		console.time("RelationIndex.buildSpatialIndex");
		this.spatialIndex = new Flatbush(this.size, 128, Float64Array, BufferConstructor);
		const hasBboxData = this.bbox.length >= this.size * 4;
		for (let i = 0; i < this.size; i++) {
			let minX;
			let minY;
			let maxX;
			let maxY;
			if (hasBboxData) {
				minX = this.bbox.at(i * 4);
				minY = this.bbox.at(i * 4 + 1);
				maxX = this.bbox.at(i * 4 + 2);
				maxY = this.bbox.at(i * 4 + 3);
			} else {
				const bbox = bboxFromLonLats(this.collectRelationCoordinates(i));
				minX = bbox[0];
				minY = bbox[1];
				maxX = bbox[2];
				maxY = bbox[3];
				this.bbox.push(minX);
				this.bbox.push(minY);
				this.bbox.push(maxX);
				this.bbox.push(maxY);
			}
			this.spatialIndex.add(minX, minY, maxX, maxY);
		}
		if (!hasBboxData) this.bbox.compact();
		this.spatialIndex.finish();
		this.spatialIndexBuilt = true;
		console.timeEnd("RelationIndex.buildSpatialIndex");
		return this.spatialIndex;
	}
	/**
	* Check if the spatial index has been built.
	*/
	hasSpatialIndex() {
		return this.spatialIndexBuilt;
	}
	/**
	* Collect all coordinates from a relation, including nested relations.
	* Used for building bounding boxes and spatial indexes.
	*/
	collectRelationCoordinates(index) {
		const lls = [];
		const resolved = resolveRelationMembers(this.getByIndex(index), (relId) => {
			const relIndex = this.ids.getIndexFromId(relId);
			if (relIndex === -1) return null;
			return this.getByIndex(relIndex);
		}, 10);
		for (const nodeId of resolved.nodes) {
			const ll = this.nodes.getNodeLonLat({ id: nodeId });
			if (ll) lls.push(ll);
		}
		for (const wayId of resolved.ways) {
			const wayIndex = this.ways.ids.getIndexFromId(wayId);
			if (wayIndex === -1) continue;
			const wayPositions = this.ways.getCoordinates(wayIndex);
			lls.push(...wayPositions);
		}
		return lls;
	}
	/**
	* Get the bounding box of a relation.
	*/
	getEntityBbox(i) {
		const index = "index" in i ? i.index : this.ids.idOrIndex(i)[0];
		return [
			this.bbox.at(index * 4),
			this.bbox.at(index * 4 + 1),
			this.bbox.at(index * 4 + 2),
			this.bbox.at(index * 4 + 3)
		];
	}
	/**
	* Get the full relation entity.
	*/
	getFullEntity(index, id, tags) {
		return {
			id,
			members: this.getMembersByIndex(index),
			tags
		};
	}
	/**
	* Get the members of a relation.
	*/
	getMembersByIndex(index, relationMemberTypes = RELATION_MEMBER_TYPES) {
		const start = this.memberStart.at(index);
		const count = this.memberCount.at(index);
		const members = [];
		for (let i = start; i < start + count; i++) {
			const ref = this.memberRefs.at(i);
			const type = RELATION_MEMBER_TYPES[this.memberTypes.at(i)];
			if (type === void 0) throw Error(`Member type not found: ${i}`);
			if (!relationMemberTypes.includes(type)) continue;
			const role = this.stringTable.get(this.memberRoles.at(i));
			members.push({
				ref,
				type,
				role
			});
		}
		return members;
	}
	/**
	* Check if a relation includes a specific member.
	*/
	includesMember(index, memberRef, memberType, memberRole) {
		const start = this.memberStart.at(index);
		const count = this.memberCount.at(index);
		for (let i = start; i < start + count; i++) {
			if (RELATION_MEMBER_TYPES[this.memberTypes.at(i)] !== memberType) continue;
			if (this.memberRefs.at(i) !== memberRef) continue;
			if (memberRole !== void 0 && this.stringTable.get(this.memberRoles.at(i)) !== memberRole) continue;
			return true;
		}
		return false;
	}
	/**
	* Get all way IDs that are members of relations, including nested relations.
	* Used to exclude these ways from individual rendering.
	*/
	getWayMemberIds() {
		const wayIds = /* @__PURE__ */ new Set();
		for (let i = 0; i < this.size; i++) {
			const resolved = resolveRelationMembers(this.getByIndex(i), (relId) => {
				const relIndex = this.ids.getIndexFromId(relId);
				if (relIndex === -1) return null;
				return this.getByIndex(relIndex);
			}, 10);
			for (const wayId of resolved.ways) wayIds.add(wayId);
		}
		return wayIds;
	}
	/**
	* Get relation geometry based on its kind.
	* Returns coordinates suitable for rendering based on relation type.
	* @param index - Relation index
	* @returns Object with geometry data based on relation kind
	*/
	getRelationGeometry(index) {
		const relation = this.getByIndex(index);
		if (isAreaRelation(relation)) return { rings: buildRelationRings(relation, (ref) => this.ways.getById(ref), (id) => this.nodes.getNodeLonLat({ id })) };
		if (isPointRelation(relation)) return { points: collectRelationPoints(relation, (id) => this.nodes.getNodeLonLat({ id })) };
		if (isLineRelation(relation)) return { lineStrings: buildRelationLineStrings(relation, (ref) => this.ways.getById(ref), (id) => this.nodes.getNodeLonLat({ id })) };
		if (isSuperRelation(relation)) return {};
		return {};
	}
	/**
	* Find relations that intersect a bounding box.
	*/
	intersects(bbox, filterFn) {
		if (this.size === 0) return [];
		return this.spatialIndex.search(bbox[0], bbox[1], bbox[2], bbox[3], filterFn);
	}
	/**
	* Find relation indexes near a point using great-circle distance.
	* @param lon - Longitude in degrees.
	* @param lat - Latitude in degrees.
	* @param maxResults - Maximum number of results to return.
	* @param maxDistanceKm - Maximum distance in kilometers.
	* @returns Array of relation indexes sorted by distance.
	*/
	neighbors(lon, lat, maxResults, maxDistanceKm) {
		if (this.size === 0) return [];
		return around(this.spatialIndex, lon, lat, maxResults, maxDistanceKm);
	}
	/**
	* Get transferable objects for passing to another thread.
	* Only includes spatialIndex if it has been built.
	*/
	transferables() {
		const base = {
			...super.transferables(),
			memberStart: this.memberStart.array.buffer,
			memberCount: this.memberCount.array.buffer,
			memberRefs: this.memberRefs.array.buffer,
			memberTypes: this.memberTypes.array.buffer,
			memberRoles: this.memberRoles.array.buffer,
			bbox: this.bbox.array.buffer
		};
		if (this.spatialIndexBuilt) return {
			...base,
			spatialIndex: this.spatialIndex.data
		};
		return base;
	}
	/**
	* Get the approximate memory requirements for a given number of relations in bytes.
	*/
	static getBytesRequired(count) {
		if (count === 0) return 0;
		let numNodes = count;
		let n = count;
		while (n !== 1) {
			n = Math.ceil(n / 128);
			numNodes += n;
		}
		const indexBytes = (numNodes < 16384 ? 2 : 4) * numNodes;
		const boxesBytes = numNodes * 4 * Float64Array.BYTES_PER_ELEMENT;
		const spatialIndexBytes = 8 + indexBytes + boxesBytes;
		return Ids.getBytesRequired(count) + Tags.getBytesRequired(count) + count * Uint32Array.BYTES_PER_ELEMENT + count * Uint16Array.BYTES_PER_ELEMENT + count * 4 * Float64Array.BYTES_PER_ELEMENT + spatialIndexBytes;
	}
	/**
	* Update a ContentHasher with relation-specific data (members).
	*/
	updateHash(hasher) {
		return super.updateHash(hasher).update(this.memberStart.array).update(this.memberCount.array).update(this.memberRefs.array).update(this.memberTypes.array).update(this.memberRoles.array);
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/ways.js
var Ways = class extends Entities {
	spatialIndex = new Flatbush(1);
	spatialIndexBuilt = false;
	refStart;
	refCount;
	refs;
	bbox;
	nodes;
	/**
	* Create a new Ways index.
	*/
	constructor(stringTable, nodes, transferables) {
		if (transferables) {
			super("way", new Ids(transferables), new Tags(stringTable, transferables));
			this.refStart = ResizeableTypedArray.from(Uint32Array, transferables.refStart);
			this.refCount = ResizeableTypedArray.from(Uint16Array, transferables.refCount);
			this.refs = ResizeableTypedArray.from(IdArrayType, transferables.refs);
			this.bbox = ResizeableTypedArray.from(Float64Array, transferables.bbox);
			if (transferables.spatialIndex?.byteLength) {
				this.spatialIndex = Flatbush.from(transferables.spatialIndex);
				this.spatialIndexBuilt = true;
			}
			this.indexBuilt = true;
		} else {
			super("way", new Ids(), new Tags(stringTable));
			this.refStart = new ResizeableTypedArray(Uint32Array);
			this.refCount = new ResizeableTypedArray(Uint16Array);
			this.refs = new ResizeableTypedArray(IdArrayType);
			this.bbox = new ResizeableTypedArray(Float64Array);
		}
		this.nodes = nodes;
	}
	/**
	* Add a single way to the index.
	*/
	addWay(way) {
		const wayIndex = this.addEntity(way.id, way.tags ?? {});
		this.refStart.push(this.refs.length);
		this.refCount.push(way.refs.length);
		for (const ref of way.refs) this.refs.push(ref);
		return wayIndex;
	}
	/**
	* Bulk add ways directly from a PBF PrimitiveBlock.
	*/
	addWays(ways, blockStringIndexMap, filter) {
		let added = 0;
		for (const way of ways) {
			let prevRefId = 0;
			const refs = way.refs.map((refId) => {
				prevRefId += refId;
				return prevRefId;
			});
			const filteredWay = filter ? filter({
				id: way.id,
				refs,
				tags: this.tags.getTagsFromIndices(way.keys, way.vals)
			}) : null;
			if (filter && filteredWay === null) continue;
			const tagKeys = way.keys.map((key) => {
				const index = blockStringIndexMap[key];
				if (index === void 0) throw Error("Tag key not found");
				return index;
			});
			const tagValues = way.vals.map((val) => {
				const index = blockStringIndexMap[val];
				if (index === void 0) throw Error("Tag value not found");
				return index;
			});
			this.addEntity(way.id, tagKeys, tagValues);
			this.refStart.push(this.refs.length);
			this.refCount.push(filteredWay?.refs.length ?? refs.length);
			this.refs.pushMany(filteredWay?.refs ?? refs);
			added++;
		}
		return added;
	}
	/**
	* Compact the internal arrays to free up memory.
	*/
	buildEntityIndex() {
		this.refStart.compact();
		this.refCount.compact();
		this.refs.compact();
	}
	/**
	* Build the spatial index for ways.
	* If bbox data already exists (e.g., loaded from storage), reuses it.
	*/
	buildSpatialIndex() {
		if (!this.nodes.isReady()) throw Error("Node index is not ready.");
		if (this.size === 0) return this.spatialIndex;
		this.spatialIndex = new Flatbush(this.size, 128, Float64Array, BufferConstructor);
		const hasBboxData = this.bbox.length >= this.size * 4;
		for (let i = 0; i < this.size; i++) {
			let minX;
			let minY;
			let maxX;
			let maxY;
			if (hasBboxData) {
				minX = this.bbox.at(i * 4);
				minY = this.bbox.at(i * 4 + 1);
				maxX = this.bbox.at(i * 4 + 2);
				maxY = this.bbox.at(i * 4 + 3);
			} else {
				minX = Number.POSITIVE_INFINITY;
				minY = Number.POSITIVE_INFINITY;
				maxX = Number.NEGATIVE_INFINITY;
				maxY = Number.NEGATIVE_INFINITY;
				const start = this.refStart.at(i);
				const count = this.refCount.at(i);
				for (let j = start; j < start + count; j++) {
					const refId = this.refs.at(j);
					const [lon, lat] = this.nodes.getNodeLonLat({ id: refId });
					if (lon < minX) minX = lon;
					if (lon > maxX) maxX = lon;
					if (lat < minY) minY = lat;
					if (lat > maxY) maxY = lat;
				}
				this.bbox.push(minX);
				this.bbox.push(minY);
				this.bbox.push(maxX);
				this.bbox.push(maxY);
			}
			this.spatialIndex.add(minX, minY, maxX, maxY);
		}
		if (!hasBboxData) this.bbox.compact();
		this.spatialIndex.finish();
		this.spatialIndexBuilt = true;
		return this.spatialIndex;
	}
	/**
	* Check if the spatial index has been built.
	*/
	hasSpatialIndex() {
		return this.spatialIndexBuilt;
	}
	/**
	* Get the full way entity.
	*/
	getFullEntity(index, id, tags) {
		return {
			id,
			refs: [...this.getRefIds(index)],
			tags
		};
	}
	/**
	* Get the node IDs referenced by a way.
	*/
	getRefIds(index) {
		const start = this.refStart.at(index);
		const count = this.refCount.at(index);
		return Array.from(this.refs.slice(start, start + count));
	}
	/**
	* Get the bounding box of a way.
	*/
	getEntityBbox(idOrIndex) {
		const index = "index" in idOrIndex ? idOrIndex.index : this.ids.idOrIndex(idOrIndex)[0];
		return [
			this.bbox.at(index * 4),
			this.bbox.at(index * 4 + 1),
			this.bbox.at(index * 4 + 2),
			this.bbox.at(index * 4 + 3)
		];
	}
	/**
	* Get the coordinates of a way as a flat array.
	*/
	getLine(index) {
		const count = this.refCount.at(index);
		const start = this.refStart.at(index);
		const line = new Float64Array(count * 2);
		for (let i = 0; i < count; i++) {
			const ref = this.refs.at(start + i);
			const [lon, lat] = this.nodes.getNodeLonLat({ id: ref });
			line[i * 2] = lon;
			line[i * 2 + 1] = lat;
		}
		return line;
	}
	/**
	* Get the coordinates of a way as an array of [lon, lat] pairs.
	*/
	getCoordinates(index) {
		const count = this.refCount.at(index);
		const start = this.refStart.at(index);
		const coords = [];
		for (let refIndex = start; refIndex < start + count; refIndex++) {
			const ref = this.refs.at(refIndex);
			const coord = this.nodes.getNodeLonLat({ id: ref });
			if (coord === void 0 || coord[0] === void 0 || coord[1] === void 0) throw Error(`Invalid coordinate for way id ${this.ids.at(index)}, index ${index}, node ref ${ref}, ref index ${refIndex}`);
			coords.push(coord);
		}
		return coords;
	}
	/**
	* Find way indexes that intersect a bounding box.
	*/
	intersects(bbox, filterFn) {
		if (this.size === 0) return [];
		return this.spatialIndex.search(bbox[0], bbox[1], bbox[2], bbox[3], filterFn);
	}
	/**
	* Find way indexes near a point using great-circle distance.
	* @param lon - Longitude in degrees.
	* @param lat - Latitude in degrees.
	* @param maxResults - Maximum number of results to return.
	* @param maxDistanceKm - Maximum distance in kilometers.
	* @returns Array of way indexes sorted by distance.
	*/
	neighbors(lon, lat, maxResults, maxDistanceKm) {
		if (this.size === 0) return [];
		return around(this.spatialIndex, lon, lat, maxResults, maxDistanceKm);
	}
	/**
	* Get ways within a bounding box.
	*/
	withinBbox(bbox, include) {
		const wayCandidates = this.intersects(bbox, include);
		const ids = new Float64Array(wayCandidates.length);
		const wayPositions = [];
		const wayStartIndices = new Uint32Array(wayCandidates.length + 1);
		wayStartIndices[0] = 0;
		let size = 0;
		wayCandidates.forEach((wayIndex, i) => {
			ids[i] = this.ids.at(wayIndex);
			const way = this.getLine(wayIndex);
			size += way.length;
			wayPositions.push(way);
			const prevIndex = wayStartIndices[i];
			if (prevIndex === void 0) throw Error("Previous index is undefined");
			wayStartIndices[i + 1] = prevIndex + way.length / 2;
		});
		const wayPositionsArray = new Float64Array(size);
		let pIndex = 0;
		for (const way of wayPositions) {
			wayPositionsArray.set(way, pIndex);
			pIndex += way.length;
		}
		return {
			ids,
			positions: wayPositionsArray,
			startIndices: wayStartIndices
		};
	}
	/**
	* Get transferable objects for passing to another thread.
	* Only includes spatialIndex if it has been built.
	*/
	transferables() {
		const base = {
			...super.transferables(),
			refStart: this.refStart.array.buffer,
			refCount: this.refCount.array.buffer,
			refs: this.refs.array.buffer,
			bbox: this.bbox.array.buffer
		};
		if (this.spatialIndexBuilt) return {
			...base,
			spatialIndex: this.spatialIndex.data
		};
		return base;
	}
	/**
	* Get the approximate memory requirements for a given number of ways in bytes.
	*/
	static getBytesRequired(count) {
		if (count === 0) return 0;
		let numNodes = count;
		let n = count;
		while (n !== 1) {
			n = Math.ceil(n / 128);
			numNodes += n;
		}
		const indexBytes = (numNodes < 16384 ? 2 : 4) * numNodes;
		const boxesBytes = numNodes * 4 * Float64Array.BYTES_PER_ELEMENT;
		const spatialIndexBytes = 8 + indexBytes + boxesBytes;
		return Ids.getBytesRequired(count) + Tags.getBytesRequired(count) + count * Uint32Array.BYTES_PER_ELEMENT + count * Uint16Array.BYTES_PER_ELEMENT + count * 4 * Float64Array.BYTES_PER_ELEMENT + spatialIndexBytes;
	}
	/**
	* Update a ContentHasher with way-specific data (node references).
	*/
	updateHash(hasher) {
		return super.updateHash(hasher).update(this.refStart.array).update(this.refCount.array).update(this.refs.array);
	}
};
//#endregion
//#region ../../node_modules/@osmix/core/dist/osm.js
/**
* OSM Entity Index.
*/
var Osm = class Osm {
	id;
	header;
	stringTable;
	nodes;
	ways;
	relations;
	indexBuilt = false;
	_contentHash = "";
	/**
	* Create a new OSM Entity index.
	*/
	constructor(opts) {
		this.id = opts?.id ?? "unknown";
		this.header = opts?.header ?? {
			required_features: [],
			optional_features: []
		};
		if (opts && "stringTable" in opts) {
			if (opts instanceof Osm) {
				this.stringTable = new StringTable(opts.stringTable.transferables());
				this.nodes = new Nodes(this.stringTable, opts.nodes.transferables());
				this.ways = new Ways(this.stringTable, this.nodes, opts.ways.transferables());
				this.relations = new Relations(this.stringTable, this.nodes, this.ways, opts.relations.transferables());
				this._contentHash = opts._contentHash;
				this.indexBuilt = true;
			} else {
				this.stringTable = new StringTable(opts.stringTable);
				this.nodes = new Nodes(this.stringTable, opts.nodes);
				this.ways = new Ways(this.stringTable, this.nodes, opts.ways);
				this.relations = new Relations(this.stringTable, this.nodes, this.ways, opts.relations);
				this._contentHash = opts.contentHash;
				this.indexBuilt = true;
			}
		} else {
			this.stringTable = new StringTable();
			this.nodes = new Nodes(this.stringTable);
			this.ways = new Ways(this.stringTable, this.nodes);
			this.relations = new Relations(this.stringTable, this.nodes, this.ways);
		}
	}
	/**
	* Build the internal indexes for all entities.
	* Also computes the content hash after indexes are built.
	*/
	buildIndexes() {
		this.stringTable.buildIndex();
		this.nodes.buildIndex();
		this.ways.buildIndex();
		this.relations.buildIndex();
		this.indexBuilt = true;
		this._contentHash = this.computeContentHash();
	}
	/**
	* Check if the index is built and ready for use.
	*/
	isReady() {
		return this.nodes.isReady() && this.ways.isReady() && this.relations.isReady() && this.indexBuilt;
	}
	/**
	* Build spatial indexes for all entities.
	*/
	buildSpatialIndexes() {
		this.nodes.buildSpatialIndex();
		this.ways.buildSpatialIndex();
		this.relations.buildSpatialIndex();
	}
	/**
	* Check if spatial indexes have been built for all entity types.
	*/
	hasSpatialIndexes() {
		return this.nodes.hasSpatialIndex() && this.ways.hasSpatialIndex() && this.relations.hasSpatialIndex();
	}
	/**
	* Get the bounding box of all entities in the OSM index.
	*/
	bbox() {
		return this.nodes.getBbox();
	}
	/**
	* Get information about the OSM index.
	*/
	info() {
		return {
			id: this.id,
			bbox: this.bbox(),
			header: this.header,
			stats: {
				nodes: this.nodes.size,
				ways: this.ways.size,
				relations: this.relations.size
			}
		};
	}
	/**
	* Get transferable objects for passing to another thread.
	*/
	transferables() {
		return {
			id: this.id,
			header: this.header,
			contentHash: this._contentHash,
			stringTable: this.stringTable.transferables(),
			nodes: this.nodes.transferables(),
			ways: this.ways.transferables(),
			relations: this.relations.transferables()
		};
	}
	/**
	* Get the content hash of this OSM dataset.
	* The hash is computed when indexes are built.
	*
	* @returns A hex string hash uniquely identifying the content.
	*/
	contentHash() {
		return this._contentHash;
	}
	/**
	* Check if this OSM dataset has identical content to another.
	* Uses the pre-computed content hash for fast comparison.
	*
	* @param other - The other Osm instance to compare with.
	* @returns True if both datasets have identical content.
	*/
	isEqual(other) {
		if (!other) return false;
		return this._contentHash === other._contentHash;
	}
	/**
	* Compute a content hash of all underlying data.
	* This hash uniquely identifies the dataset content regardless of metadata.
	*
	* @returns A hex string hash of the content.
	*/
	computeContentHash() {
		const hasher = new ContentHasher();
		this.stringTable.updateHash(hasher);
		this.nodes.updateHash(hasher);
		this.ways.updateHash(hasher);
		this.relations.updateHash(hasher);
		return hasher.digest();
	}
};
//#endregion
//#region ../../node_modules/@osmix/shared/dist/way-is-area.js
/**
* Area detection for OSM ways.
*
* Implements the OSM wiki heuristics for determining whether a closed way
* should be rendered as an area (polygon) or a closed linear feature.
*
* @see https://wiki.openstreetmap.org/wiki/Key:area
* @see https://wiki.openstreetmap.org/wiki/Overpass_turbo/Polygon_Features
*
* @module
*/
/**
* Tags that imply an area unless their value is exactly "no"
*/
const IMPLIED_ANY_VALUE_BUT_NO = /* @__PURE__ */ new Set([
	"amenity",
	"boundary",
	"building",
	"building:part",
	"craft",
	"historic",
	"indoor",
	"landuse",
	"leisure",
	"military",
	"office",
	"place",
	"public_transport",
	"ruins",
	"shop",
	"tourism"
]);
/**
* Tags that imply an area only for these specific values
*/
const INCLUDED_VALUE_TAGS = {
	barrier: /* @__PURE__ */ new Set([
		"city_wall",
		"ditch",
		"hedge",
		"retaining_wall",
		"wall",
		"spikes"
	]),
	highway: /* @__PURE__ */ new Set([
		"services",
		"rest_area",
		"escape",
		"elevator"
	]),
	power: /* @__PURE__ */ new Set([
		"plant",
		"substation",
		"generator",
		"transformer"
	]),
	railway: /* @__PURE__ */ new Set([
		"station",
		"turntable",
		"roundhouse",
		"platform"
	]),
	waterway: /* @__PURE__ */ new Set([
		"riverbank",
		"dock",
		"boatyard",
		"dam"
	])
};
/**
* Tags that imply an area unless the value is in this exclusion list
*/
const EXCLUDED_VALUE_TAGS = {
	aeroway: /* @__PURE__ */ new Set(["no", "taxiway"]),
	"area:highway": /* @__PURE__ */ new Set(["no"]),
	man_made: /* @__PURE__ */ new Set([
		"no",
		"cutline",
		"embankment",
		"pipeline"
	]),
	natural: /* @__PURE__ */ new Set([
		"no",
		"coastline",
		"cliff",
		"ridge",
		"arete",
		"tree_row"
	])
};
/**
* Determine if a way is an area based on its tags and nodes.
*
* This function implements the logic described in the OSM wiki:
* https://wiki.openstreetmap.org/wiki/Key:area
* https://wiki.openstreetmap.org/wiki/Overpass_turbo/Polygon_Features
*
* @param way - The way to check.
* @returns `true` if the way is an area, `false` otherwise.
*/
function wayIsArea(way) {
	if (!way) return false;
	const { refs, tags } = way;
	if (refs.length < 3) return false;
	if (refs[0] !== refs[refs.length - 1]) return false;
	if (!tags || Object.keys(tags).length === 0) return true;
	if ("area" in tags) return tags["area"] !== "no";
	for (const key of IMPLIED_ANY_VALUE_BUT_NO) {
		const v = tags[key];
		if (v && v !== "no") return true;
	}
	for (const [key, included] of Object.entries(INCLUDED_VALUE_TAGS)) {
		const v = tags[key];
		if (v && included.has(`${v}`)) return true;
	}
	for (const [key, excluded] of Object.entries(EXCLUDED_VALUE_TAGS)) {
		const v = tags[key];
		if (v && !excluded.has(`${v}`)) return true;
	}
	return false;
}
//#endregion
//#region ../../node_modules/@osmix/geojson/dist/entity-to-feature.js
/**
* OSM entity to GeoJSON Feature conversion.
*
* Converts OSM nodes, ways, and relations into GeoJSON Features with
* appropriate geometry types and preserved properties.
*
* @module
*/
/**
* Convert an OSM node to a GeoJSON Point feature.
*
* @param node - OSM node with id, lon, lat, and optional tags.
* @returns GeoJSON Point Feature with OSM properties.
*
* @example
* ```ts
* const feature = nodeToFeature({ id: 1, lon: -122.4, lat: 47.6, tags: { name: "Seattle" } })
* // { type: "Feature", geometry: { type: "Point", coordinates: [-122.4, 47.6] }, ... }
* ```
*/
function nodeToFeature(node) {
	return {
		type: "Feature",
		id: node.id,
		geometry: {
			type: "Point",
			coordinates: [node.lon, node.lat]
		},
		properties: {
			id: node.id,
			type: "node",
			...node.info,
			...node.tags
		}
	};
}
/**
* Convert an OSM way to a GeoJSON LineString or Polygon feature.
*
* Geometry type is determined by the `wayIsArea` helper, which checks for
* area-indicating tags (building, landuse, etc.) and ring closure.
*
* @param way - OSM way with id, refs, and optional tags.
* @param refToPosition - Function to resolve node ID to [lon, lat] coordinates.
* @returns GeoJSON LineString or Polygon Feature with OSM properties.
*
* @example
* ```ts
* const feature = wayToFeature(way, (ref) => osm.nodes.getNodeLonLat({ id: ref }))
* ```
*/
function wayToFeature(way, refToPosition) {
	return {
		type: "Feature",
		id: way.id,
		geometry: wayIsArea(way) ? {
			type: "Polygon",
			coordinates: [way.refs.map((r) => refToPosition(r))]
		} : {
			type: "LineString",
			coordinates: way.refs.map((r) => refToPosition(r))
		},
		properties: {
			id: way.id,
			type: "way",
			...way.info,
			...way.tags
		}
	};
}
/**
* Convert an OSM relation to a GeoJSON feature.
*
* Geometry type is determined by relation type and tags:
* - **Multipolygon/boundary**: MultiPolygon or Polygon
* - **Route/multilinestring**: MultiLineString or LineString
* - **Site/collection**: MultiPoint or Point
* - **Other**: GeometryCollection (empty for logical relations)
*
* @param relation - OSM relation with id, members, and optional tags.
* @param refToPosition - Function to resolve node ID to [lon, lat] coordinates.
* @param getWay - Optional function to resolve way ID to OsmWay (required for polygons/lines).
* @returns GeoJSON Feature with appropriate geometry type.
*
* @example
* ```ts
* const feature = relationToFeature(
*   relation,
*   (ref) => osm.nodes.getNodeLonLat({ id: ref }),
*   (ref) => osm.ways.getById(ref)
* )
* ```
*/
function relationToFeature(relation, refToPosition, getWay) {
	const getNodeCoordinates = (nodeId) => {
		const pos = refToPosition(nodeId);
		return pos ? [pos[0], pos[1]] : void 0;
	};
	const kind = getRelationKind(relation);
	if (isAreaRelation(relation) && getWay) {
		const rings = buildRelationRings(relation, getWay, getNodeCoordinates);
		if (rings.length === 0) return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiPolygon",
				coordinates: []
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
		if (rings.length === 1) return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "Polygon",
				coordinates: rings[0]
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
		return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiPolygon",
				coordinates: rings
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
	}
	if (kind === "line" && getWay) {
		const lineStrings = buildRelationLineStrings(relation, getWay, getNodeCoordinates);
		if (lineStrings.length === 0) return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiLineString",
				coordinates: []
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
		if (lineStrings.length === 1) return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "LineString",
				coordinates: lineStrings[0]
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
		return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiLineString",
				coordinates: lineStrings
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
	}
	if (kind === "point") {
		const points = collectRelationPoints(relation, getNodeCoordinates);
		if (points.length === 0) return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiPoint",
				coordinates: []
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
		if (points.length === 1) return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "Point",
				coordinates: points[0]
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
		return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiPoint",
				coordinates: points
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
	}
	if (kind === "logic" || kind === "super") return {
		type: "Feature",
		id: relation.id,
		geometry: {
			type: "GeometryCollection",
			geometries: []
		},
		properties: {
			id: relation.id,
			type: "relation",
			...relation.info,
			...relation.tags
		}
	};
	if (getWay) {
		const { outer } = getWayMembersByRole(relation);
		const coordinates = [];
		if (outer.length > 0) coordinates.push([outer.map((member) => refToPosition(member.ref))]);
		return {
			type: "Feature",
			id: relation.id,
			geometry: {
				type: "MultiPolygon",
				coordinates: coordinates.length > 0 ? coordinates : []
			},
			properties: {
				id: relation.id,
				type: "relation",
				...relation.info,
				...relation.tags
			}
		};
	}
	return {
		type: "Feature",
		id: relation.id,
		geometry: {
			type: "GeometryCollection",
			geometries: []
		},
		properties: {
			id: relation.id,
			type: "relation",
			...relation.info,
			...relation.tags
		}
	};
}
/**
* Convert any OSM entity to a GeoJSON feature using an Osm index.
*
* Convenience function that handles entity type detection and coordinate
* resolution automatically using the provided Osm index.
*
* @param osm - Osm index for coordinate lookups.
* @param entity - Any OSM entity (node, way, or relation).
* @returns GeoJSON Feature with appropriate geometry.
* @throws If entity type is unknown.
*
* @example
* ```ts
* for (const way of osm.ways) {
*   const feature = osmEntityToGeoJSONFeature(osm, way)
*   features.push(feature)
* }
* ```
*/
function osmEntityToGeoJSONFeature(osm, entity) {
	if (isNode(entity)) return nodeToFeature(entity);
	if (isWay(entity)) return wayToFeature(entity, (ref) => osm.nodes.getNodeLonLat({ id: ref }));
	if (isRelation(entity)) return relationToFeature(entity, (ref) => osm.nodes.getNodeLonLat({ id: ref }), (ref) => osm.ways.getById(ref));
	throw new Error("Unknown entity type");
}
//#endregion
//#region node_modules/pbf/index.js
const SHIFT_LEFT_32 = 4294967296;
const TEXT_DECODER_MIN_LENGTH = 12;
const utf8TextDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8");
const PBF_VARINT = 0;
const PBF_FIXED64 = 1;
const PBF_BYTES = 2;
const PBF_FIXED32 = 5;
var PbfReader = class {
	/**
	* @param {Uint8Array | ArrayBuffer} buf
	*/
	constructor(buf) {
		this.buf = ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
		this.dataView = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
		this.pos = 0;
		this.type = 0;
		this._valueStart = -1;
		this.length = this.buf.length;
	}
	/**
	* @template T
	* @param {(tag: number, result: T, pbf: PbfReader) => void} readField
	* @param {T} result
	* @param {number} [end]
	*/
	readFields(readField, result, end = this.length) {
		let field;
		while (field = this.nextField(end)) readField(field, result, this);
		return result;
	}
	/**
	* @template T
	* @param {(tag: number, result: T, pbf: PbfReader) => void} readField
	* @param {T} result
	*/
	readMessage(readField, result) {
		return this.readFields(readField, result, this.readVarint() + this.pos);
	}
	readFixed32() {
		const val = this.dataView.getUint32(this.pos, true);
		this.pos += 4;
		return val;
	}
	readSFixed32() {
		const val = this.dataView.getInt32(this.pos, true);
		this.pos += 4;
		return val;
	}
	readFixed64() {
		const val = this.dataView.getUint32(this.pos, true) + this.dataView.getUint32(this.pos + 4, true) * SHIFT_LEFT_32;
		this.pos += 8;
		return val;
	}
	readSFixed64() {
		const val = this.dataView.getUint32(this.pos, true) + this.dataView.getInt32(this.pos + 4, true) * SHIFT_LEFT_32;
		this.pos += 8;
		return val;
	}
	readFloat() {
		const val = this.dataView.getFloat32(this.pos, true);
		this.pos += 4;
		return val;
	}
	readDouble() {
		const val = this.dataView.getFloat64(this.pos, true);
		this.pos += 8;
		return val;
	}
	/**
	* @param {boolean} [isSigned]
	*/
	readVarint(isSigned) {
		const buf = this.buf;
		const b0 = buf[this.pos++];
		if (b0 < 128) return b0;
		let val = b0 & 127, b;
		b = buf[this.pos++];
		val |= (b & 127) << 7;
		if (b < 128) return val;
		b = buf[this.pos++];
		val |= (b & 127) << 14;
		if (b < 128) return val;
		b = buf[this.pos++];
		val |= (b & 127) << 21;
		if (b < 128) return val;
		b = buf[this.pos];
		val |= (b & 15) << 28;
		return readVarintRemainder(val, isSigned, this);
	}
	readSVarint() {
		const num = this.readVarint();
		return num % 2 === 1 ? (num + 1) / -2 : num / 2;
	}
	readBoolean() {
		return Boolean(this.readVarint());
	}
	readString() {
		const end = this.readVarint() + this.pos;
		const pos = this.pos;
		this.pos = end;
		if (end - pos >= TEXT_DECODER_MIN_LENGTH && utf8TextDecoder) return utf8TextDecoder.decode(this.buf.subarray(pos, end));
		return readUtf8(this.buf, pos, end);
	}
	readBytes() {
		const end = this.readVarint() + this.pos, buffer = this.buf.subarray(this.pos, end);
		this.pos = end;
		return buffer;
	}
	/**
	* @param {number[]} [arr]
	* @param {boolean} [isSigned]
	*/
	readPackedVarint(arr = [], isSigned) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readVarint(isSigned));
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedSVarint(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readSVarint());
		return arr;
	}
	/** @param {boolean[]} [arr] */
	readPackedBoolean(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readBoolean());
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedFloat(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readFloat());
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedDouble(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readDouble());
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedFixed32(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readFixed32());
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedSFixed32(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readSFixed32());
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedFixed64(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readFixed64());
		return arr;
	}
	/** @param {number[]} [arr] */
	readPackedSFixed64(arr = []) {
		const end = this.readPackedEnd();
		while (this.pos < end) arr.push(this.readSFixed64());
		return arr;
	}
	readPackedEnd() {
		return this.type === PBF_BYTES ? this.readVarint() + this.pos : this.pos + 1;
	}
	/**
	* Advance to the next field. Returns the field number, or 0 at end-of-message.
	* @param {number} [end]
	*/
	nextField(end = this.length) {
		if (this.pos === this._valueStart) this.skip(this.type);
		if (this.pos >= end) return 0;
		const tag = this.readVarint();
		this.type = tag & 7;
		this._valueStart = this.pos;
		return tag >>> 3;
	}
	/** @param {number} val */
	skip(val) {
		const type = val & 7;
		if (type === PBF_VARINT) while (this.buf[this.pos++] > 127);
		else if (type === PBF_BYTES) this.pos = this.readVarint() + this.pos;
		else if (type === PBF_FIXED32) this.pos += 4;
		else if (type === PBF_FIXED64) this.pos += 8;
		else throw new Error(`Unimplemented type: ${type}`);
	}
};
/**
* @param {number} l
* @param {boolean | undefined} s
* @param {PbfReader} p
*/
function readVarintRemainder(l, s, p) {
	const buf = p.buf;
	let h, b;
	b = buf[p.pos++];
	h = (b & 112) >> 4;
	if (b < 128) return toNum(l, h, s);
	b = buf[p.pos++];
	h |= (b & 127) << 3;
	if (b < 128) return toNum(l, h, s);
	b = buf[p.pos++];
	h |= (b & 127) << 10;
	if (b < 128) return toNum(l, h, s);
	b = buf[p.pos++];
	h |= (b & 127) << 17;
	if (b < 128) return toNum(l, h, s);
	b = buf[p.pos++];
	h |= (b & 127) << 24;
	if (b < 128) return toNum(l, h, s);
	b = buf[p.pos++];
	h |= (b & 1) << 31;
	if (b < 128) return toNum(l, h, s);
	throw new Error("Expected varint not more than 10 bytes");
}
/**
* @param {number} low
* @param {number} high
* @param {boolean} [isSigned]
*/
function toNum(low, high, isSigned) {
	return isSigned ? high * 4294967296 + (low >>> 0) : (high >>> 0) * 4294967296 + (low >>> 0);
}
/**
* @param {Uint8Array} buf
* @param {number} pos
* @param {number} end
*/
function readUtf8(buf, pos, end) {
	let str = "";
	let i = pos;
	while (i < end) {
		const b0 = buf[i];
		let c = null;
		let bytesPerSequence = b0 > 239 ? 4 : b0 > 223 ? 3 : b0 > 191 ? 2 : 1;
		if (i + bytesPerSequence > end) break;
		let b1, b2, b3;
		if (bytesPerSequence === 1) {
			if (b0 < 128) c = b0;
		} else if (bytesPerSequence === 2) {
			b1 = buf[i + 1];
			if ((b1 & 192) === 128) {
				c = (b0 & 31) << 6 | b1 & 63;
				if (c <= 127) c = null;
			}
		} else if (bytesPerSequence === 3) {
			b1 = buf[i + 1];
			b2 = buf[i + 2];
			if ((b1 & 192) === 128 && (b2 & 192) === 128) {
				c = (b0 & 15) << 12 | (b1 & 63) << 6 | b2 & 63;
				if (c <= 2047 || c >= 55296 && c <= 57343) c = null;
			}
		} else if (bytesPerSequence === 4) {
			b1 = buf[i + 1];
			b2 = buf[i + 2];
			b3 = buf[i + 3];
			if ((b1 & 192) === 128 && (b2 & 192) === 128 && (b3 & 192) === 128) {
				c = (b0 & 15) << 18 | (b1 & 63) << 12 | (b2 & 63) << 6 | b3 & 63;
				if (c <= 65535 || c >= 1114112) c = null;
			}
		}
		if (c === null) {
			c = 65533;
			bytesPerSequence = 1;
		} else if (c > 65535) {
			c -= 65536;
			str += String.fromCharCode(c >>> 10 & 1023 | 55296);
			c = 56320 | c & 1023;
		}
		str += String.fromCharCode(c);
		i += bytesPerSequence;
	}
	return str;
}
//#endregion
//#region node_modules/@osmix/pbf/dist/proto/osmformat.js
/**
* Reads an `OsmPbfHeaderBlock` message from the provided Pbf reader.
*/
function readHeaderBlock(pbf, end) {
	return pbf.readFields(readHeaderBlockField, {
		required_features: [],
		optional_features: []
	}, end);
}
/**
* Populates header block fields based on the protobuf tag encountered.
*/
function readHeaderBlockField(tag, obj, pbf) {
	if (tag === 1) obj.bbox = readHeaderBBox(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 4) obj.required_features.push(pbf.readString());
	else if (tag === 5) obj.optional_features.push(pbf.readString());
	else if (tag === 16) obj.writingprogram = pbf.readString();
	else if (tag === 17) obj.source = pbf.readString();
	else if (tag === 32) obj.osmosis_replication_timestamp = pbf.readVarint(true);
	else if (tag === 33) obj.osmosis_replication_sequence_number = pbf.readVarint(true);
	else if (tag === 34) obj.osmosis_replication_base_url = pbf.readString();
}
/**
* Reads a header bounding box and converts nanodegrees to degrees.
*/
function readHeaderBBox(pbf, end) {
	return pbf.readFields(readHeaderBBoxField, {
		left: 0,
		right: 0,
		top: 0,
		bottom: 0
	}, end);
}
/**
* Populates bounding box properties while converting from nanodegrees.
*/
function readHeaderBBoxField(tag, obj, pbf) {
	if (tag === 1) obj.left = pbf.readSVarint() / 1e9;
	else if (tag === 2) obj.right = pbf.readSVarint() / 1e9;
	else if (tag === 3) obj.top = pbf.readSVarint() / 1e9;
	else if (tag === 4) obj.bottom = pbf.readSVarint() / 1e9;
}
/**
* Reads a primitive block containing string tables and primitive groups.
*/
function readPrimitiveBlock(pbf, end) {
	return pbf.readFields(readPrimitiveBlockField, {
		stringtable: [],
		primitivegroup: []
	}, end);
}
/**
* Populates primitive block fields based on protobuf tags.
*/
function readPrimitiveBlockField(tag, obj, pbf) {
	if (tag === 1) obj.stringtable = readStringTable(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 2) obj.primitivegroup.push(readPrimitiveGroup(pbf, pbf.readVarint() + pbf.pos));
	else if (tag === 17) {
		obj.granularity = pbf.readVarint(true);
		obj.granularity = !obj.granularity ? 1e7 : 1e9 / obj.granularity;
	} else if (tag === 19) obj.lat_offset = pbf.readVarint(true) * 1e-9;
	else if (tag === 20) obj.lon_offset = pbf.readVarint(true) * 1e-9;
	else if (tag === 18) obj.date_granularity = pbf.readVarint(true) ?? 1e3;
}
/**
* Reads a primitive group with collections of primitives.
*/
function readPrimitiveGroup(pbf, end) {
	return pbf.readFields(readPrimitiveGroupField, {
		nodes: [],
		ways: [],
		relations: []
	}, end);
}
/**
* Populates primitive group collections from protobuf data.
*/
function readPrimitiveGroupField(tag, obj, pbf) {
	if (tag === 1) obj.nodes.push(readNode(pbf, pbf.readVarint() + pbf.pos));
	else if (tag === 2) obj.dense = readDenseNodes(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 3) obj.ways.push(readWay(pbf, pbf.readVarint() + pbf.pos));
	else if (tag === 4) obj.relations.push(readRelation(pbf, pbf.readVarint() + pbf.pos));
}
/**
* Reads the shared string table for a primitive block.
*/
function readStringTable(pbf, end) {
	return pbf.readFields(readStringTableField, [], end);
}
/**
* Appends string table entries as they are encountered.
*/
function readStringTableField(tag, obj, pbf) {
	if (tag === 1) obj.push(pbf.readBytes());
}
/**
* Reads metadata describing a single primitive.
*/
function readInfo(pbf, end) {
	return pbf.readFields(readInfoField, {}, end);
}
/**
* Populates primitive metadata fields.
*/
function readInfoField(tag, obj, pbf) {
	if (tag === 1) obj.version = pbf.readVarint(true);
	else if (tag === 2) obj.timestamp = pbf.readVarint(true);
	else if (tag === 3) obj.changeset = pbf.readVarint(true);
	else if (tag === 4) obj.uid = pbf.readVarint(true);
	else if (tag === 5) obj.user_sid = pbf.readVarint();
	else if (tag === 6) obj.visible = pbf.readBoolean();
}
/**
* Reads dense node metadata collections.
*/
function readDenseInfo(pbf, end) {
	return pbf.readFields(readDenseInfoField, {
		version: [],
		timestamp: [],
		changeset: [],
		uid: [],
		user_sid: [],
		visible: []
	}, end);
}
/**
* Populates dense node metadata arrays from packed fields.
*/
function readDenseInfoField(tag, obj, pbf) {
	if (tag === 1) pbf.readPackedVarint(obj.version, true);
	else if (tag === 2) pbf.readPackedSVarint(obj.timestamp);
	else if (tag === 3) pbf.readPackedSVarint(obj.changeset);
	else if (tag === 4) pbf.readPackedSVarint(obj.uid);
	else if (tag === 5) pbf.readPackedSVarint(obj.user_sid);
	else if (tag === 6) pbf.readPackedBoolean(obj.visible);
}
/**
* Reads a node primitive from the protobuf stream.
*/
function readNode(pbf, end) {
	return pbf.readFields(readNodeField, {
		id: 0,
		keys: [],
		vals: [],
		lat: 0,
		lon: 0
	}, end);
}
/**
* Populates node fields based on protobuf tags.
*/
function readNodeField(tag, obj, pbf) {
	if (tag === 1) obj.id = pbf.readSVarint();
	else if (tag === 2) pbf.readPackedVarint(obj.keys);
	else if (tag === 3) pbf.readPackedVarint(obj.vals);
	else if (tag === 4) obj.info = readInfo(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 8) obj.lat = pbf.readSVarint();
	else if (tag === 9) obj.lon = pbf.readSVarint();
}
/**
* Reads dense node collections from the protobuf stream.
*/
function readDenseNodes(pbf, end) {
	return pbf.readFields(readDenseNodesField, {
		id: [],
		lat: [],
		lon: [],
		keys_vals: []
	}, end);
}
/**
* Populates dense node arrays using packed encoding.
*/
function readDenseNodesField(tag, obj, pbf) {
	if (tag === 1) pbf.readPackedSVarint(obj.id);
	else if (tag === 5) obj.denseinfo = readDenseInfo(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 8) pbf.readPackedSVarint(obj.lat);
	else if (tag === 9) pbf.readPackedSVarint(obj.lon);
	else if (tag === 10) pbf.readPackedVarint(obj.keys_vals, true);
}
/**
* Reads a way primitive from the protobuf stream.
*/
function readWay(pbf, end) {
	return pbf.readFields(readWayField, {
		id: 0,
		keys: [],
		vals: [],
		refs: [],
		lat: [],
		lon: []
	}, end);
}
/**
* Populates way fields based on protobuf tags.
*/
function readWayField(tag, obj, pbf) {
	if (tag === 1) obj.id = pbf.readVarint(true);
	else if (tag === 2) pbf.readPackedVarint(obj.keys);
	else if (tag === 3) pbf.readPackedVarint(obj.vals);
	else if (tag === 4) obj.info = readInfo(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 8) pbf.readPackedSVarint(obj.refs);
}
/**
* Reads a relation primitive from the protobuf stream.
*/
function readRelation(pbf, end) {
	return pbf.readFields(readRelationField, {
		id: 0,
		keys: [],
		vals: [],
		roles_sid: [],
		memids: [],
		types: []
	}, end);
}
/**
* Populates relation fields based on protobuf tags.
*/
function readRelationField(tag, obj, pbf) {
	if (tag === 1) obj.id = pbf.readVarint(true);
	else if (tag === 2) pbf.readPackedVarint(obj.keys);
	else if (tag === 3) pbf.readPackedVarint(obj.vals);
	else if (tag === 4) obj.info = readInfo(pbf, pbf.readVarint() + pbf.pos);
	else if (tag === 8) pbf.readPackedVarint(obj.roles_sid, true);
	else if (tag === 9) pbf.readPackedSVarint(obj.memids);
	else if (tag === 10) pbf.readPackedVarint(obj.types);
}
const MAX_HEADER_SIZE_BYTES = 65536;
const MAX_BLOB_SIZE_BYTES = 33554432;
//#endregion
//#region node_modules/@osmix/pbf/dist/utils.js
/**
* Normalize supported values, streams, and iterables into one async generator.
*/
async function* toAsyncGenerator(input) {
	const value = await input;
	if (value == null) throw Error("Value is null");
	if (value instanceof ReadableStream) {
		const reader = value.getReader();
		let completed = false;
		try {
			while (true) {
				const { done, value: chunk } = await reader.read();
				if (done) {
					completed = true;
					break;
				}
				yield chunk;
			}
		} finally {
			if (!completed) await reader.cancel().catch(() => void 0);
			reader.releaseLock();
		}
		return;
	}
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		yield value;
		return;
	}
	if (typeof value === "object" && Symbol.asyncIterator in value) {
		for await (const item of value) yield item;
		return;
	}
	if (typeof value === "object" && Symbol.iterator in value) {
		for (const item of value) yield item;
		return;
	}
	yield value;
}
function bytesToStream(bytes) {
	return new ReadableStream({ start(controller) {
		controller.enqueue(bytes);
		controller.close();
	} });
}
async function streamToBytes(stream, maxBytes = Number.POSITIVE_INFINITY) {
	const reader = stream.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === void 0) continue;
			if (value.byteLength > maxBytes - total) {
				await reader.cancel("Decompressed output exceeds the maximum size");
				throw Error(`Decompressed blob exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const p of chunks) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}
async function transformBytes(bytes, transformStream, maxBytes = Number.POSITIVE_INFINITY) {
	return streamToBytes(bytesToStream(bytes).pipeThrough(transformStream), maxBytes);
}
/**
* Web decompression stream
*/
async function webDecompress(data, maxBytes = MAX_BLOB_SIZE_BYTES) {
	return transformBytes(data, new DecompressionStream("deflate"), maxBytes);
}
//#endregion
//#region node_modules/@osmix/pbf/dist/pbf-to-blocks.js
/**
* Parse an OSM PBF file from various input sources.
*
* Accepts `ArrayBuffer`, `Uint8Array`, `ReadableStream<Uint8Array>`, or async generators.
* Returns the file header and a lazy async generator of primitive blocks for on-demand parsing.
*
* @param data - PBF bytes as buffer, stream, or async iterable.
* @returns Object with `header` (file metadata) and `blocks` (async generator of primitive blocks).
* @throws If the header block is missing or malformed.
*
* @example
* ```ts
* import { readOsmPbf } from "@osmix/pbf"
*
* // From a file stream
* const { header, blocks } = await readOsmPbf(Bun.file('./monaco.pbf').stream())
*
* // From a fetch response
* const response = await fetch('/data/monaco.pbf')
* const { header, blocks } = await readOsmPbf(response.body!)
*
* // Iterate blocks lazily
* for await (const block of blocks) {
*   for (const group of block.primitivegroup) {
*     console.log(group.dense?.id.length ?? 0, "dense nodes")
*   }
* }
* ```
*/
async function readOsmPbf(data) {
	const parser = createOsmPbfBlobFrameGenerator();
	const blocks = osmPbfBlobsToBlocksGenerator((async function* () {
		for await (const chunk of toAsyncGenerator(data)) for (const frame of parser.nextChunk(chunk)) yield frame;
		parser.finish();
	})());
	const header = (await blocks.next()).value;
	if (header == null || !("required_features" in header)) throw Error("OSM PBF header block not found");
	return {
		header,
		blocks
	};
}
TransformStream;
//#endregion
//#region node_modules/@osmix/pbf/dist/proto/fileformat.js
/**
* Reads an `OsmPbfBlob` message from the current position in the Pbf reader.
*/
function readBlob(pbf, end) {
	return pbf.readFields(readBlobField, { raw_size: 0 }, end);
}
/**
* Dispatches individual Blob fields based on their protobuf tag.
*/
function readBlobField(tag, obj, pbf) {
	if (tag === 2) obj.raw_size = pbf.readVarint(true);
	else if (tag === 1) obj.raw = pbf.readBytes();
	else if (tag === 3) obj.zlib_data = pbf.readBytes();
}
/**
* Reads an `OsmPbfBlobHeader` from the current position in the Pbf reader.
*/
function readBlobHeader(pbf, end) {
	return pbf.readFields(readBlobHeaderField, {
		type: "OSMData",
		datasize: 0
	}, end);
}
/**
* Dispatches individual BlobHeader fields based on their protobuf tag.
*/
function readBlobHeaderField(tag, obj, pbf) {
	if (tag === 1) obj.type = pbf.readString();
	else if (tag === 3) obj.datasize = pbf.readVarint(true);
}
//#endregion
//#region node_modules/@osmix/pbf/dist/pbf-to-blobs.js
const invalidFrame = (message) => /* @__PURE__ */ new Error(`Invalid PBF frame: ${message}`);
/**
* Create the internal parser for framed PBF blobs.
*
* The parser retains the declared raw size so readers can enforce decompression
* budgets without reparsing the blob headers. Call `finish()` after the input
* ends to reject an incomplete prefix, header, or blob.
*/
function createOsmPbfBlobFrameGenerator() {
	let pbf = new PbfReader(/* @__PURE__ */ new Uint8Array(0));
	let state = "header-length";
	let bytesNeeded = 4;
	let blobHeader = null;
	const nextChunk = function* (chunk) {
		const chunkBytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
		const currentBuffer = pbf.buf.subarray(pbf.pos);
		if (currentBuffer.byteLength === 0) pbf = new PbfReader(chunkBytes);
		else {
			const tmpBuffer = new Uint8Array(currentBuffer.byteLength + chunkBytes.byteLength);
			tmpBuffer.set(currentBuffer);
			tmpBuffer.set(chunkBytes, currentBuffer.byteLength);
			pbf = new PbfReader(tmpBuffer);
		}
		while (pbf.pos + bytesNeeded <= pbf.length) if (state === "header-length") {
			const headerSize = new DataView(pbf.buf.buffer, pbf.buf.byteOffset, pbf.buf.byteLength).getUint32(pbf.pos, false);
			if (headerSize === 0) throw invalidFrame("header length is zero");
			if (headerSize > 65536) throw invalidFrame(`header length exceeds ${MAX_HEADER_SIZE_BYTES} bytes`);
			pbf.pos += 4;
			bytesNeeded = headerSize;
			state = "header";
		} else if (state === "header") {
			blobHeader = readBlobHeader(pbf, pbf.pos + bytesNeeded);
			if (blobHeader.datasize === 0) throw invalidFrame("blob size is zero");
			if (blobHeader.datasize > 33554432) throw invalidFrame(`blob size exceeds ${MAX_BLOB_SIZE_BYTES} bytes`);
			bytesNeeded = blobHeader.datasize;
			state = "blob";
		} else {
			if (blobHeader == null) throw Error("Blob header has not been read");
			const blob = readBlob(pbf, pbf.pos + bytesNeeded);
			if (blob.zlib_data === void 0 || blob.zlib_data.length === 0) throw Error("Blob has no zlib data. Format is unsupported.");
			if (blob.raw_size === 0) throw invalidFrame("raw size is zero");
			if (blob.raw_size != null && blob.raw_size > 33554432) throw invalidFrame(`raw size exceeds ${MAX_BLOB_SIZE_BYTES} bytes`);
			yield {
				data: blob.zlib_data,
				rawSize: blob.raw_size && blob.raw_size > 0 ? blob.raw_size : void 0
			};
			state = "header-length";
			bytesNeeded = 4;
			blobHeader = null;
		}
	};
	const finish = () => {
		if (state !== "header-length" || pbf.pos !== pbf.length) throw invalidFrame(`truncated ${state}`);
	};
	return {
		nextChunk,
		finish
	};
}
//#endregion
//#region node_modules/@osmix/pbf/dist/blobs-to-blocks.js
/**
* Blob-to-block conversion utilities.
*
* Handles decompression and protobuf decoding of raw OSM PBF blobs into
* typed header and primitive block structures.
*
* @module
*/
function frameData(blob) {
	return blob instanceof Uint8Array ? { data: blob } : blob;
}
async function decompressBlob(blob, decompress) {
	const decompressed = await decompress(blob.data, MAX_BLOB_SIZE_BYTES);
	if (decompressed.byteLength > 33554432) throw Error(`Decompressed blob exceeds ${MAX_BLOB_SIZE_BYTES} bytes`);
	if (blob.rawSize !== void 0 && decompressed.byteLength !== blob.rawSize) throw Error(`Decompressed blob size ${decompressed.byteLength} does not match declared raw size ${blob.rawSize}`);
	return decompressed;
}
/**
* Decompress and decode a stream of raw PBF blobs into typed blocks.
*
* This async generator handles the transition from compressed bytes to parsed
* protobuf structures. The first blob is always decoded as a header block;
* subsequent blobs are decoded as primitive blocks containing OSM entities.
*
* @param blobs - Async or sync generator yielding compressed blob payloads.
* @param decompress - Optional decompression function (defaults to Web Streams zlib).
* @yields Header block first, then primitive blocks.
*
* @example
* ```ts
* import { osmPbfBlobsToBlocksGenerator, createOsmPbfBlobGenerator } from "@osmix/pbf"
*
* const generateBlobs = createOsmPbfBlobGenerator()
* const blobsGen = (async function* () {
*   for await (const chunk of stream) {
*     yield* generateBlobs(chunk)
*   }
* })()
*
* for await (const block of osmPbfBlobsToBlocksGenerator(blobsGen)) {
*   // First iteration yields header, rest yield primitive blocks
* }
* ```
*/
async function* osmPbfBlobsToBlocksGenerator(blobs, decompress = webDecompress) {
	let headerRead = false;
	for await (const blob of blobs) {
		const frame = frameData(blob);
		if (!headerRead) {
			headerRead = true;
			yield readOsmHeaderBlock(frame, decompress);
		} else yield readOsmPrimitiveBlock(frame, decompress);
	}
}
/**
* Decompress and parse a header block from a compressed blob.
*
* @param compressedBlob - Zlib-compressed protobuf header blob.
* @param decompress - Optional decompression function.
* @returns Parsed header block with required/optional features and bbox.
*/
async function readOsmHeaderBlock(compressedBlob, decompress = webDecompress) {
	return readHeaderBlock(new PbfReader(await decompressBlob(frameData(compressedBlob), decompress)));
}
/**
* Decompress and parse a primitive block from a compressed blob.
*
* @param compressedBlob - Zlib-compressed protobuf primitive blob.
* @param decompress - Optional decompression function.
* @returns Parsed primitive block with string table and primitive groups.
*/
async function readOsmPrimitiveBlock(compressedBlob, decompress = webDecompress) {
	return readPrimitiveBlock(new PbfReader(await decompressBlob(frameData(compressedBlob), decompress)));
}
TransformStream;
//#endregion
//#region src/lib/osm-pbf.ts
/**
* Post a progress update roughly every this many classified entities. Frequent
* enough that the loading dialog moves on a large extract, sparse enough that
* the postMessage traffic never rivals the parse cost.
*/
const PROGRESS_INTERVAL = 5e4;
function extendBounds(bounds, geometry) {
	if (!geometry || geometry.type === "GeometryCollection") return;
	const walk = (coords) => {
		if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
			const [x, y] = coords;
			if (x < bounds[0]) bounds[0] = x;
			if (y < bounds[1]) bounds[1] = y;
			if (x > bounds[2]) bounds[2] = x;
			if (y > bounds[3]) bounds[3] = y;
			return;
		}
		if (Array.isArray(coords)) for (const part of coords) walk(part);
	};
	walk(geometry.coordinates);
}
function hasTags(tags) {
	return tags != null && Object.keys(tags).length > 0;
}
/**
* Parse OSM PBF bytes into an in-memory Osm index.
*
* This mirrors osmix's own `fromPbf` block loop (string-table mapping, dense
* nodes, then ways, then relations, then index building) but pulls in only
* `@osmix/core` and `@osmix/pbf` — not the full `osmix` meta-package, which
* re-exports unrelated raster/router/gtfs modules. Spatial indexes are skipped:
* GeoJSON conversion only needs the ID indexes for ref/member lookups.
*/
async function buildOsmFromPbf(bytes) {
	const { header, blocks } = await readOsmPbf(bytes);
	const osm = new Osm({ header });
	for await (const block of blocks) {
		const blockStringIndexMap = osm.stringTable.createBlockIndexMap(block.stringtable);
		for (const group of block.primitivegroup) {
			const { ways, relations, dense } = group;
			if (dense) osm.nodes.addDenseNodes(dense, block, blockStringIndexMap);
			if (ways.length > 0) {
				if (!osm.nodes.isReady()) osm.nodes.buildIndex();
				osm.ways.addWays(ways, blockStringIndexMap);
			}
			if (relations.length > 0) {
				if (!osm.ways.isReady()) osm.ways.buildIndex();
				osm.relations.addRelations(relations, blockStringIndexMap);
			}
		}
	}
	osm.buildIndexes();
	return osm;
}
function geometryBucket(geometry) {
	switch (geometry?.type) {
		case "Point":
		case "MultiPoint": return "points";
		case "LineString":
		case "MultiLineString": return "lines";
		case "Polygon":
		case "MultiPolygon": return "polygons";
		default: return null;
	}
}
/**
* Parse OSM PBF bytes into GeoJSON layers split by geometry type.
*
* Only *tagged* entities become features. The vast majority of OSM nodes and
* ways are untagged geometry: nodes are way vertices, and ways are the member
* rings/segments of multipolygon and other relations. They stay in the index
* (relation geometry assembly still needs them) but are not emitted as
* standalone features — emitting them floods the layers with meaningless
* geometry and, on a whole-country extract, multiplies the number of in-memory
* GeoJSON objects enough to exhaust browser memory. Real features (roads,
* buildings, areas, routes) carry tags, so this keeps them while cutting both
* RAM and the feature count MapLibre has to render. Mirrors osmtogeojson.
*
* The entity-classification loop runs without yielding and can be heavy for
* large extracts (the PBF read above is async, but this part is not), so call
* it from a worker. `onProgress`, when given, is called periodically with the
* count classified so far so that worker can surface progress to the UI.
*/
async function parseOsmPbf(bytes, onProgress) {
	const osm = await buildOsmFromPbf(bytes);
	const points = [];
	const lines = [];
	const polygons = [];
	let skipped = 0;
	const bounds = [
		Infinity,
		Infinity,
		-Infinity,
		-Infinity
	];
	const place = (feature) => {
		const bucket = feature ? geometryBucket(feature.geometry) : null;
		if (!feature || bucket === null) {
			skipped += 1;
			return;
		}
		if (bucket === "points") points.push(feature);
		else if (bucket === "lines") lines.push(feature);
		else polygons.push(feature);
		extendBounds(bounds, feature.geometry);
	};
	const total = osm.nodes.size + osm.ways.size + osm.relations.size;
	let processed = 0;
	const tick = () => {
		processed += 1;
		if (onProgress && processed % PROGRESS_INTERVAL === 0) onProgress({
			processed,
			total
		});
	};
	for (const node of osm.nodes) {
		tick();
		if (!hasTags(node.tags)) continue;
		place(osmEntityToGeoJSONFeature(osm, node));
	}
	for (const way of osm.ways) {
		tick();
		if (!hasTags(way.tags)) continue;
		place(osmEntityToGeoJSONFeature(osm, way));
	}
	for (const relation of osm.relations) {
		tick();
		if (!hasTags(relation.tags)) continue;
		place(osmEntityToGeoJSONFeature(osm, relation));
	}
	if (total > 0 && total % PROGRESS_INTERVAL !== 0) onProgress?.({
		processed,
		total
	});
	return {
		points: {
			type: "FeatureCollection",
			features: points
		},
		lines: {
			type: "FeatureCollection",
			features: lines
		},
		polygons: {
			type: "FeatureCollection",
			features: polygons
		},
		bounds: Number.isFinite(bounds[0]) ? [
			bounds[0],
			bounds[1],
			bounds[2],
			bounds[3]
		] : null,
		counts: {
			nodes: osm.nodes.size,
			ways: osm.ways.size,
			relations: osm.relations.size,
			points: points.length,
			lines: lines.length,
			polygons: polygons.length,
			skipped
		}
	};
}
//#endregion
//#region src/lib/osm-pbf.worker.ts
const worker = self;
worker.addEventListener("message", async (event) => {
	try {
		const result = await parseOsmPbf(new Uint8Array(event.data), (progress) => {
			worker.postMessage({
				type: "progress",
				...progress
			});
		});
		worker.postMessage({
			ok: true,
			result
		});
	} catch (error) {
		worker.postMessage({
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}
});
//#endregion
