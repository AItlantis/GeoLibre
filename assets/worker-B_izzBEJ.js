import { n as decode } from "./decode-BPxf1vaZ.js";
//#region ../../node_modules/@developmentseed/geotiff/dist/pool/wrapper.js
/** Collect the transferable ArrayBuffers from a DecodedPixels. */
function collectTransferables(pixels) {
	if (pixels.layout === "pixel-interleaved") return [pixels.data.buffer];
	return pixels.bands.map((b) => b.buffer);
}
//#endregion
//#region ../../node_modules/@developmentseed/geotiff/dist/pool/worker.js
/**
* Default worker entry point for DecoderPool.
*
* In most cases you don't need to reference this file directly — call
* `defaultDecoderPool()` instead, which creates a pool backed by this worker.
*
* To override codecs (e.g. swap in a WASM zstd decoder), create your own
* worker file that mutates `registry` before importing this handler:
*
*   import { registry } from "@developmentseed/geotiff";
*   import { Compression } from "@cogeotiff/core";
*   registry.set(Compression.Zstd, () => import("./my-wasm-zstd.js").then(m => m.decode));
*   import "@developmentseed/geotiff/pool/worker";
*
* Then pass a custom `createWorker` factory to `DecoderPool`:
*
*   new DecoderPool({
*     createWorker: () =>
*       new Worker(new URL("./my-worker.js", import.meta.url), { type: "module" }),
*   });
*/
self.addEventListener("message", async (e) => {
	const { jobId, compression, metadata, buffer } = e.data;
	try {
		const array = await decode(buffer, compression, metadata);
		const transferables = collectTransferables(array);
		const response = {
			jobId,
			pixels: array
		};
		self.postMessage(response, { transfer: transferables });
	} catch (err) {
		const response = {
			jobId,
			error: String(err)
		};
		self.postMessage(response);
	}
});
//#endregion
