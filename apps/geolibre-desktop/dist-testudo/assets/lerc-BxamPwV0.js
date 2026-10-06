import { r as Compression, t as DECODER_REGISTRY } from "./decode-BPxf1vaZ.js";
//#region ../../node_modules/@developmentseed/geotiff/dist/codecs/lerc.js
/** Inner compression type encoded in LercParameters[1]. */
var LercCompression;
(function(LercCompression) {
	LercCompression[LercCompression["None"] = 0] = "None";
	LercCompression[LercCompression["Deflate"] = 1] = "Deflate";
	LercCompression[LercCompression["Zstd"] = 2] = "Zstd";
})(LercCompression || (LercCompression = {}));
let wasmInitialized = false;
async function getLerc() {
	const lerc = await import("./LercDecode.es-CO79vzEm.js");
	if (!wasmInitialized) {
		await lerc.load();
		wasmInitialized = true;
	}
	return lerc;
}
async function decode(bytes, metadata) {
	const lercCompressionType = metadata.lercParameters?.[1] ?? LercCompression.None;
	let lercInput = bytes;
	if (lercCompressionType === LercCompression.Deflate || lercCompressionType === LercCompression.Zstd) {
		const innerCompression = lercCompressionType === LercCompression.Deflate ? Compression.Deflate : Compression.Zstd;
		lercInput = await (await DECODER_REGISTRY.get(innerCompression)())(bytes, metadata);
	}
	return {
		layout: "band-separate",
		bands: (await getLerc()).decode(lercInput).pixels
	};
}
//#endregion
export { decode };
