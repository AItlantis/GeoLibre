//#region ../../node_modules/@cogeotiff/core/build/const/tiff.endian.js
/**
* Tiff format
*
* The header of a Tiff file contains the endianness of the file
*/
var TiffEndian;
(function(TiffEndian) {
	TiffEndian[TiffEndian["Big"] = 19789] = "Big";
	TiffEndian[TiffEndian["Little"] = 18761] = "Little";
})(TiffEndian || (TiffEndian = {}));
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/const/tiff.tag.id.js
/** Sub file type for tag 254 {@link TiffTag.SubFileType} */
var SubFileType;
(function(SubFileType) {
	/** Reduced resolution version */
	SubFileType[SubFileType["ReducedImage"] = 1] = "ReducedImage";
	/** One page of many */
	SubFileType[SubFileType["Page"] = 2] = "Page";
	/** Transparency mask */
	SubFileType[SubFileType["Mask"] = 4] = "Mask";
})(SubFileType || (SubFileType = {}));
var Orientation;
(function(Orientation) {
	Orientation[Orientation["TopLeft"] = 1] = "TopLeft";
	Orientation[Orientation["TopRight"] = 2] = "TopRight";
	Orientation[Orientation["BottomRight"] = 3] = "BottomRight";
	Orientation[Orientation["BottomLeft"] = 4] = "BottomLeft";
	Orientation[Orientation["LeftTop"] = 5] = "LeftTop";
	Orientation[Orientation["RightTOP"] = 6] = "RightTOP";
	Orientation[Orientation["RightBottom"] = 7] = "RightBottom";
	Orientation[Orientation["LeftBottom"] = 8] = "LeftBottom";
})(Orientation || (Orientation = {}));
var RasterTypeKey;
(function(RasterTypeKey) {
	/**
	* PixelIsArea (default) a pixel is treated as an area,
	* the raster coordinate (0,0) is the top left corner of the top left pixel.
	*/
	RasterTypeKey[RasterTypeKey["PixelIsArea"] = 1] = "PixelIsArea";
	/**
	* PixelIsPoint treats pixels as point samples with empty space between the "pixel" samples.
	* the raster coordinate (0,0) is the location of the top left raster pixel.
	*/
	RasterTypeKey[RasterTypeKey["PixelIsPoint"] = 2] = "PixelIsPoint";
})(RasterTypeKey || (RasterTypeKey = {}));
var ModelTypeCode;
(function(ModelTypeCode) {
	ModelTypeCode[ModelTypeCode["Unknown"] = 0] = "Unknown";
	/** Projection Coordinate System */
	ModelTypeCode[ModelTypeCode["Projected"] = 1] = "Projected";
	/** Geographic latitude-longitude System */
	ModelTypeCode[ModelTypeCode["Geographic"] = 2] = "Geographic";
	/** Geocentric (X,Y,Z) Coordinate System */
	ModelTypeCode[ModelTypeCode["Geocentric"] = 3] = "Geocentric";
	ModelTypeCode[ModelTypeCode["UserDefined"] = 32767] = "UserDefined";
})(ModelTypeCode || (ModelTypeCode = {}));
/** Sub file type for tag 255 {@link TiffTag.OldSubFileType} */
var OldSubFileType;
(function(OldSubFileType) {
	/** Full resolution image data */
	OldSubFileType[OldSubFileType["Image"] = 1] = "Image";
	/** Reduced resolution version */
	OldSubFileType[OldSubFileType["ReducedImage"] = 2] = "ReducedImage";
	/** One page of many */
	OldSubFileType[OldSubFileType["Page"] = 3] = "Page";
})(OldSubFileType || (OldSubFileType = {}));
/** Tiff compression types */
var Compression;
(function(Compression) {
	Compression[Compression["None"] = 1] = "None";
	Compression[Compression["Ccittrle"] = 2] = "Ccittrle";
	Compression[Compression["CcittT4"] = 3] = "CcittT4";
	Compression[Compression["CcittT6"] = 4] = "CcittT6";
	Compression[Compression["Lzw"] = 5] = "Lzw";
	Compression[Compression["Jpeg6"] = 6] = "Jpeg6";
	Compression[Compression["Jpeg"] = 7] = "Jpeg";
	Compression[Compression["DeflateOther"] = 8] = "DeflateOther";
	Compression[Compression["T85"] = 9] = "T85";
	Compression[Compression["T43"] = 10] = "T43";
	Compression[Compression["Next"] = 32766] = "Next";
	Compression[Compression["Ccittrlew"] = 32771] = "Ccittrlew";
	Compression[Compression["PackBits"] = 32773] = "PackBits";
	Compression[Compression["ThunderScan"] = 32809] = "ThunderScan";
	Compression[Compression["It8ctpad"] = 32895] = "It8ctpad";
	Compression[Compression["It8lw"] = 32896] = "It8lw";
	Compression[Compression["It8mp"] = 32897] = "It8mp";
	Compression[Compression["It8bl"] = 32898] = "It8bl";
	Compression[Compression["PixarFilm"] = 32908] = "PixarFilm";
	Compression[Compression["PixarLog"] = 32909] = "PixarLog";
	Compression[Compression["Deflate"] = 32946] = "Deflate";
	Compression[Compression["Dcs"] = 32947] = "Dcs";
	Compression[Compression["Jbig"] = 34661] = "Jbig";
	Compression[Compression["SgiLog"] = 34676] = "SgiLog";
	Compression[Compression["SgiLog24"] = 34677] = "SgiLog24";
	Compression[Compression["Jp2000"] = 34712] = "Jp2000";
	Compression[Compression["Lerc"] = 34887] = "Lerc";
	Compression[Compression["Lzma"] = 34925] = "Lzma";
	Compression[Compression["Zstd"] = 5e4] = "Zstd";
	Compression[Compression["Webp"] = 50001] = "Webp";
	Compression[Compression["JpegXl"] = 50002] = "JpegXl";
	Compression[Compression["JpegXlDng17"] = 52546] = "JpegXlDng17";
})(Compression || (Compression = {}));
var PlanarConfiguration;
(function(PlanarConfiguration) {
	/** single image plane */
	PlanarConfiguration[PlanarConfiguration["Contig"] = 1] = "Contig";
	/** separate planes of data */
	PlanarConfiguration[PlanarConfiguration["Separate"] = 2] = "Separate";
})(PlanarConfiguration || (PlanarConfiguration = {}));
var Predictor;
(function(Predictor) {
	Predictor[Predictor["None"] = 1] = "None";
	/** Horizontal differencing */
	Predictor[Predictor["Horizontal"] = 2] = "Horizontal";
	/** Floating point */
	Predictor[Predictor["FloatingPoint"] = 3] = "FloatingPoint";
})(Predictor || (Predictor = {}));
var SampleFormat;
(function(SampleFormat) {
	/** Unsigned integer data */
	SampleFormat[SampleFormat["Uint"] = 1] = "Uint";
	/** Signed integer data */
	SampleFormat[SampleFormat["Int"] = 2] = "Int";
	/** IEEE floating point data */
	SampleFormat[SampleFormat["Float"] = 3] = "Float";
	/** Untyped data */
	SampleFormat[SampleFormat["Void"] = 4] = "Void";
	/** Complex signed int */
	SampleFormat[SampleFormat["ComplexInt"] = 5] = "ComplexInt";
	/** Complex ieee floating */
	SampleFormat[SampleFormat["ComplexFloat"] = 6] = "ComplexFloat";
})(SampleFormat || (SampleFormat = {}));
var Photometric;
(function(Photometric) {
	/** min value is white */
	Photometric[Photometric["MinIsWhite"] = 0] = "MinIsWhite";
	/** min value is black */
	Photometric[Photometric["MinIsBlack"] = 1] = "MinIsBlack";
	/** RGB color model */
	Photometric[Photometric["Rgb"] = 2] = "Rgb";
	/** color map indexed */
	Photometric[Photometric["Palette"] = 3] = "Palette";
	/** $holdout mask */
	Photometric[Photometric["Mask"] = 4] = "Mask";
	/** !color separations */
	Photometric[Photometric["Separated"] = 5] = "Separated";
	/** !CCIR 601 */
	Photometric[Photometric["Ycbcr"] = 6] = "Ycbcr";
	/** !1976 CIE L*a*b* */
	Photometric[Photometric["Cielab"] = 8] = "Cielab";
	/** ICC L*a*b* [Adobe TIFF Technote 4] */
	Photometric[Photometric["Icclab"] = 9] = "Icclab";
	/** ITU L*a*b* */
	Photometric[Photometric["Itulab"] = 10] = "Itulab";
	/** color filter array */
	Photometric[Photometric["Cfa"] = 32803] = "Cfa";
	/** CIE Log2(L) */
	Photometric[Photometric["Logl"] = 32844] = "Logl";
	Photometric[Photometric["Logluv"] = 32845] = "Logluv";
})(Photometric || (Photometric = {}));
/**
* Tiff tags as defined by libtiff and libgeotiff
*
* - {@link https://gitlab.com/libtiff/libtiff}
* - {@link https://github.com/OSGeo/libgeotiff/}
*/
var TiffTag;
(function(TiffTag) {
	/**
	* Type of the sub file
	*
	* @see {@link SubFileType}
	*/
	TiffTag[TiffTag["SubFileType"] = 254] = "SubFileType";
	/**
	* Type of sub file
	*
	* @see {@link OldSubFileType}
	*/
	TiffTag[TiffTag["OldSubFileType"] = 255] = "OldSubFileType";
	/** Width of image in pixels */
	TiffTag[TiffTag["ImageWidth"] = 256] = "ImageWidth";
	/** Height of image in pixels */
	TiffTag[TiffTag["ImageHeight"] = 257] = "ImageHeight";
	/**
	* Number of bits per channel
	*
	* @example
	* ```typescript
	* [8,8,8] // 8 bit RGB
	* [16] // 16bit
	* ```
	*/
	TiffTag[TiffTag["BitsPerSample"] = 258] = "BitsPerSample";
	/**
	*
	* Data type of the image
	*
	* See {@link SampleFormat}
	*
	* @example
	* ```typescript
	* [1] // SampleFormat.Uint
	* [1,1,1,1] // 4 band Uint
	* ```
	*/
	TiffTag[TiffTag["SampleFormat"] = 339] = "SampleFormat";
	/**
	* Compression Type
	*
	* @see {@link Compression}
	*
	* @example
	* ```typescript
	* 5 // Compression.Lzw
	* ```
	*/
	TiffTag[TiffTag["Compression"] = 259] = "Compression";
	/**
	* Photometric interpretation
	*
	* @see {@link Photometric}
	*
	* @example
	* ```typescript
	* 2 // Photometric.Rgb
	* ```
	*/
	TiffTag[TiffTag["Photometric"] = 262] = "Photometric";
	/** Tile width in pixels */
	TiffTag[TiffTag["TileWidth"] = 322] = "TileWidth";
	/** Tile height in pixels */
	TiffTag[TiffTag["TileHeight"] = 323] = "TileHeight";
	/**
	* Offsets to data tiles
	* `0` means the tile has no data (sparse tiff)
	*
	* @example
	* ```typescript
	* [0, 3200, 1406] // three tiles, first tile does not exist
	* ```
	*/
	TiffTag[TiffTag["TileOffsets"] = 324] = "TileOffsets";
	/**
	*  Byte counts for tiles
	*  `0 means the tile does not exist (sparse tiff)
	*
	* @example
	* ```typescript
	* [0, 3200, 1406] // three tiles, first tile does not exist
	* ```
	**/
	TiffTag[TiffTag["TileByteCounts"] = 325] = "TileByteCounts";
	/** JPEG table stream */
	TiffTag[TiffTag["JpegTables"] = 347] = "JpegTables";
	TiffTag[TiffTag["StripOffsets"] = 273] = "StripOffsets";
	TiffTag[TiffTag["StripByteCounts"] = 279] = "StripByteCounts";
	/**
	* GDAL metadata
	* Generally a xml document with lots of information about the tiff and how it was created
	*/
	TiffTag[TiffTag["GdalMetadata"] = 42112] = "GdalMetadata";
	/**
	* No data value encoded as a string
	*
	* @example "-9999"
	*/
	TiffTag[TiffTag["GdalNoData"] = 42113] = "GdalNoData";
	/**  GeoTiff Tags */
	/**
	* Pixel scale in meters
	* in the format [scaleX, scaleY, scaleZ]
	*
	* Requires {@link ModelTiePoint} to be set and {@link ModelTransformation} not to be set
	*
	* @example
	* ```typescript
	* [100.0, 100.0, 0.0]
	* ```
	*/
	TiffTag[TiffTag["ModelPixelScale"] = 33550] = "ModelPixelScale";
	/**
	* Position of the tiff
	*
	* contains a list of tie points that contain
	* [x,y,z] of position in the in the tiff, generally [0,0,0]
	* [x,y,z] of the position in the projected
	*
	* @example
	* Mapping tiff point `[0,0,0]` to projected coordinates `[350807.4, 5316081.3, 0.0]`
	* ```
	* [0, 0, 0, 350807.4, 5316081.3, 0.0]
	* ```
	*/
	TiffTag[TiffTag["ModelTiePoint"] = 33922] = "ModelTiePoint";
	/**
	* Exact affine transformation between the tiff and the projected location
	*
	* this tag should not be defined when {@link ModelTiePoint} or {@link ModelPixelScale} are used
	*
	* @example
	*```typescript
	*   [ 0, 100.0, 0, 400000.0,
	* 100.0,     0, 0, 500000.0,
	*     0,     0, 0,        0,
	*     0,     0, 0,        1]
	* ```
	*/
	TiffTag[TiffTag["ModelTransformation"] = 34264] = "ModelTransformation";
	/**
	* List of GeoTiff tags
	* {@link TiffTagGeo}
	*
	* {@link https://docs.ogc.org/is/19-008r4/19-008r4.html#_requirements_class_geokeydirectorytag}
	*/
	TiffTag[TiffTag["GeoKeyDirectory"] = 34735] = "GeoKeyDirectory";
	/**
	* Double Parameters for GeoTiff Tags
	*
	* {@link TiffTagGeo}
	*/
	TiffTag[TiffTag["GeoDoubleParams"] = 34736] = "GeoDoubleParams";
	/**
	* Ascii Parameters for GeoTiff Tags
	*
	* {@link TiffTagGeo}
	*/
	TiffTag[TiffTag["GeoAsciiParams"] = 34737] = "GeoAsciiParams";
	/**
	* Stores the LERC version and additional compression
	*
	* @example
	* ```typescript
	* [4, 0] // version 4, no extra compression
	* ```
	*/
	TiffTag[TiffTag["LercParameters"] = 50674] = "LercParameters";
	TiffTag[TiffTag["PlanarConfiguration"] = 284] = "PlanarConfiguration";
	/** Untyped values */
	TiffTag[TiffTag["CellLength"] = 265] = "CellLength";
	TiffTag[TiffTag["CellWidth"] = 264] = "CellWidth";
	TiffTag[TiffTag["ColorMap"] = 320] = "ColorMap";
	TiffTag[TiffTag["Copyright"] = 33432] = "Copyright";
	TiffTag[TiffTag["DateTime"] = 306] = "DateTime";
	TiffTag[TiffTag["ExtraSamples"] = 338] = "ExtraSamples";
	TiffTag[TiffTag["FillOrder"] = 266] = "FillOrder";
	TiffTag[TiffTag["FreeByteCounts"] = 289] = "FreeByteCounts";
	TiffTag[TiffTag["FreeOffsets"] = 288] = "FreeOffsets";
	TiffTag[TiffTag["GrayResponseCurve"] = 291] = "GrayResponseCurve";
	TiffTag[TiffTag["GrayResponseUnit"] = 290] = "GrayResponseUnit";
	TiffTag[TiffTag["HostComputer"] = 316] = "HostComputer";
	TiffTag[TiffTag["ImageDescription"] = 270] = "ImageDescription";
	TiffTag[TiffTag["Make"] = 271] = "Make";
	TiffTag[TiffTag["MaxSampleValue"] = 281] = "MaxSampleValue";
	TiffTag[TiffTag["MinSampleValue"] = 280] = "MinSampleValue";
	TiffTag[TiffTag["Model"] = 272] = "Model";
	TiffTag[TiffTag["Orientation"] = 274] = "Orientation";
	TiffTag[TiffTag["ResolutionUnit"] = 296] = "ResolutionUnit";
	TiffTag[TiffTag["RowsPerStrip"] = 278] = "RowsPerStrip";
	TiffTag[TiffTag["SamplesPerPixel"] = 277] = "SamplesPerPixel";
	TiffTag[TiffTag["Software"] = 305] = "Software";
	TiffTag[TiffTag["Threshholding"] = 263] = "Threshholding";
	TiffTag[TiffTag["XResolution"] = 282] = "XResolution";
	TiffTag[TiffTag["YResolution"] = 283] = "YResolution";
	TiffTag[TiffTag["BadFaxLines"] = 326] = "BadFaxLines";
	TiffTag[TiffTag["CleanFaxData"] = 327] = "CleanFaxData";
	TiffTag[TiffTag["ClipPath"] = 343] = "ClipPath";
	TiffTag[TiffTag["ConsecutiveBadFaxLines"] = 328] = "ConsecutiveBadFaxLines";
	TiffTag[TiffTag["Decode"] = 433] = "Decode";
	TiffTag[TiffTag["DefaultImageColor"] = 434] = "DefaultImageColor";
	TiffTag[TiffTag["DocumentName"] = 269] = "DocumentName";
	TiffTag[TiffTag["DotRange"] = 336] = "DotRange";
	TiffTag[TiffTag["HalftoneHints"] = 321] = "HalftoneHints";
	TiffTag[TiffTag["Indexed"] = 346] = "Indexed";
	TiffTag[TiffTag["PageName"] = 285] = "PageName";
	TiffTag[TiffTag["PageNumber"] = 297] = "PageNumber";
	TiffTag[TiffTag["Predictor"] = 317] = "Predictor";
	TiffTag[TiffTag["PrimaryChromaticities"] = 319] = "PrimaryChromaticities";
	TiffTag[TiffTag["ReferenceBlackWhite"] = 532] = "ReferenceBlackWhite";
	TiffTag[TiffTag["SMinSampleValue"] = 340] = "SMinSampleValue";
	TiffTag[TiffTag["SMaxSampleValue"] = 341] = "SMaxSampleValue";
	TiffTag[TiffTag["StripRowCounts"] = 559] = "StripRowCounts";
	TiffTag[TiffTag["SubIFDs"] = 330] = "SubIFDs";
	TiffTag[TiffTag["T4Options"] = 292] = "T4Options";
	TiffTag[TiffTag["T6Options"] = 293] = "T6Options";
	TiffTag[TiffTag["TransferFunction"] = 301] = "TransferFunction";
	TiffTag[TiffTag["WhitePoint"] = 318] = "WhitePoint";
	TiffTag[TiffTag["XClipPathUnits"] = 344] = "XClipPathUnits";
	TiffTag[TiffTag["XPosition"] = 286] = "XPosition";
	TiffTag[TiffTag["YCbCrCoefficients"] = 529] = "YCbCrCoefficients";
	TiffTag[TiffTag["YCbCrPositioning"] = 531] = "YCbCrPositioning";
	TiffTag[TiffTag["YCbCrSubSampling"] = 530] = "YCbCrSubSampling";
	TiffTag[TiffTag["YClipPathUnits"] = 345] = "YClipPathUnits";
	TiffTag[TiffTag["YPosition"] = 287] = "YPosition";
	TiffTag[TiffTag["ApertureValue"] = 37378] = "ApertureValue";
	TiffTag[TiffTag["ColorSpace"] = 40961] = "ColorSpace";
	TiffTag[TiffTag["DateTimeDigitized"] = 36868] = "DateTimeDigitized";
	TiffTag[TiffTag["DateTimeOriginal"] = 36867] = "DateTimeOriginal";
	TiffTag[TiffTag["ExifIFD"] = 34665] = "ExifIFD";
	TiffTag[TiffTag["ExifVersion"] = 36864] = "ExifVersion";
	TiffTag[TiffTag["ExposureTime"] = 33434] = "ExposureTime";
	TiffTag[TiffTag["FileSource"] = 41728] = "FileSource";
	TiffTag[TiffTag["Flash"] = 37385] = "Flash";
	TiffTag[TiffTag["FlashpixVersion"] = 40960] = "FlashpixVersion";
	TiffTag[TiffTag["FNumber"] = 33437] = "FNumber";
	TiffTag[TiffTag["ImageUniqueID"] = 42016] = "ImageUniqueID";
	TiffTag[TiffTag["LightSource"] = 37384] = "LightSource";
	TiffTag[TiffTag["MakerNote"] = 37500] = "MakerNote";
	TiffTag[TiffTag["ShutterSpeedValue"] = 37377] = "ShutterSpeedValue";
	TiffTag[TiffTag["UserComment"] = 37510] = "UserComment";
	TiffTag[TiffTag["IPTC"] = 33723] = "IPTC";
	TiffTag[TiffTag["ICCProfile"] = 34675] = "ICCProfile";
	TiffTag[TiffTag["XMP"] = 700] = "XMP";
})(TiffTag || (TiffTag = {}));
/**
* Geotiff tags as defined by OGC GeoTiff 1.1
*
* {@link https://docs.ogc.org/is/19-008r4/19-008r4.html#_summary_of_geokey_ids_and_names}
*/
var TiffTagGeo;
(function(TiffTagGeo) {
	/**
	* This GeoKey defines the type of Model coordinate reference system used, to which the transformation from the raster space is made:
	*
	* {@link https://docs.ogc.org/is/19-008r4/19-008r4.html#_requirements_class_gtmodeltypegeokey}
	*
	* {@link ModelTypeCode}
	*/
	TiffTagGeo[TiffTagGeo["GTModelTypeGeoKey"] = 1024] = "GTModelTypeGeoKey";
	/**
	* There are currently only two options: `RasterPixelIsPoint` and `RasterPixelIsArea`
	*
	* {@link https://docs.ogc.org/is/19-008r4/19-008r4.html#_requirements_class_gtrastertypegeokey}
	*
	* {@link RasterTypeKey}
	*/
	TiffTagGeo[TiffTagGeo["GTRasterTypeGeoKey"] = 1025] = "GTRasterTypeGeoKey";
	/**
	* ASCII reference to published documentation on the overall configuration of the GeoTIFF file.
	*
	* @example "NZGD2000 / New Zealand Transverse Mercator 2000"
	*/
	TiffTagGeo[TiffTagGeo["GTCitationGeoKey"] = 1026] = "GTCitationGeoKey";
	/**
	* Renamed from GeographicTypeGeoKey in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["GeodeticCRSGeoKey"] = 2048] = "GeodeticCRSGeoKey";
	/**
	* Renamed from GeogCitationGeoKey in OGC GeoTiff
	*
	* @example "NZTM"
	*/
	TiffTagGeo[TiffTagGeo["GeodeticCitationGeoKey"] = 2049] = "GeodeticCitationGeoKey";
	/**
	* Renamed from GeogGeodeticDatumGeoKey in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["GeodeticDatumGeoKey"] = 2050] = "GeodeticDatumGeoKey";
	/**
	* Renamed from "GeogPrimeMeridianGeoKey" in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["PrimeMeridianGeoKey"] = 2051] = "PrimeMeridianGeoKey";
	/**
	* Linear unit of measure
	* @example 9001 // Metre
	*/
	TiffTagGeo[TiffTagGeo["GeogLinearUnitsGeoKey"] = 2052] = "GeogLinearUnitsGeoKey";
	TiffTagGeo[TiffTagGeo["GeogLinearUnitSizeGeoKey"] = 2053] = "GeogLinearUnitSizeGeoKey";
	/**
	* Angular unit of measure
	*
	* @example 9102 // Degree
	*/
	TiffTagGeo[TiffTagGeo["GeogAngularUnitsGeoKey"] = 2054] = "GeogAngularUnitsGeoKey";
	TiffTagGeo[TiffTagGeo["GeogAngularUnitSizeGeoKey"] = 2055] = "GeogAngularUnitSizeGeoKey";
	/**
	* Renamed from "GeogEllipsoidGeoKey" in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["EllipsoidGeoKey"] = 2056] = "EllipsoidGeoKey";
	/**
	* Renamed from "GeogSemiMajorAxisGeoKey" in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["EllipsoidSemiMajorAxisGeoKey"] = 2057] = "EllipsoidSemiMajorAxisGeoKey";
	/**
	* Renamed from "GeogSemiMinorAxisGeoKey" in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["EllipsoidSemiMinorAxisGeoKey"] = 2058] = "EllipsoidSemiMinorAxisGeoKey";
	/**
	* Renamed from "GeogInvFlatteningGeoKey" in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["EllipsoidInvFlatteningGeoKey"] = 2059] = "EllipsoidInvFlatteningGeoKey";
	/**
	*  Renamed from "GeogPrimeMeridianLongGeoKey" in OGC GeoTiff
	*/
	TiffTagGeo[TiffTagGeo["PrimeMeridianLongitudeGeoKey"] = 2061] = "PrimeMeridianLongitudeGeoKey";
	TiffTagGeo[TiffTagGeo["GeogTOWGS84GeoKey"] = 2062] = "GeogTOWGS84GeoKey";
	TiffTagGeo[TiffTagGeo["GeogAzimuthUnitsGeoKey"] = 2060] = "GeogAzimuthUnitsGeoKey";
	/**
	* EPSG code of the tiff
	*
	* Renamed from "ProjectedCSTypeGeoKey" in OGC GeoTiff
	*
	* @example
	* ```typescript
	* 2193 // NZTM
	* 3857 // WebMercatorQuad
	* ```
	*/
	TiffTagGeo[TiffTagGeo["ProjectedCRSGeoKey"] = 3072] = "ProjectedCRSGeoKey";
	/**
	* ASCII reference to published documentation on the Projected  Coordinate System
	*
	* Renamed from "PCSCitationGeoKey" in OGC GeoTiff
	*
	* @example "UTM Zone 60 N with WGS 84"
	*/
	TiffTagGeo[TiffTagGeo["ProjectedCitationGeoKey"] = 3073] = "ProjectedCitationGeoKey";
	/**
	* Specifies a map projection from the GeoTIFF CRS register or to indicate that the map projection is user-defined.
	*
	* {@link https://docs.ogc.org/is/19-008r4/19-008r4.html#_map_projection_geokeys}
	*
	* @example 2193
	*/
	TiffTagGeo[TiffTagGeo["ProjectionGeoKey"] = 3074] = "ProjectionGeoKey";
	TiffTagGeo[TiffTagGeo["ProjMethodGeoKey"] = 3075] = "ProjMethodGeoKey";
	TiffTagGeo[TiffTagGeo["ProjLinearUnitsGeoKey"] = 3076] = "ProjLinearUnitsGeoKey";
	TiffTagGeo[TiffTagGeo["ProjLinearUnitSizeGeoKey"] = 3077] = "ProjLinearUnitSizeGeoKey";
	TiffTagGeo[TiffTagGeo["ProjStdParallel1GeoKey"] = 3078] = "ProjStdParallel1GeoKey";
	TiffTagGeo[TiffTagGeo["ProjStdParallel2GeoKey"] = 3079] = "ProjStdParallel2GeoKey";
	TiffTagGeo[TiffTagGeo["ProjNatOriginLongGeoKey"] = 3080] = "ProjNatOriginLongGeoKey";
	TiffTagGeo[TiffTagGeo["ProjNatOriginLatGeoKey"] = 3081] = "ProjNatOriginLatGeoKey";
	TiffTagGeo[TiffTagGeo["ProjFalseEastingGeoKey"] = 3082] = "ProjFalseEastingGeoKey";
	TiffTagGeo[TiffTagGeo["ProjFalseNorthingGeoKey"] = 3083] = "ProjFalseNorthingGeoKey";
	TiffTagGeo[TiffTagGeo["ProjFalseOriginLongGeoKey"] = 3084] = "ProjFalseOriginLongGeoKey";
	TiffTagGeo[TiffTagGeo["ProjFalseOriginLatGeoKey"] = 3085] = "ProjFalseOriginLatGeoKey";
	TiffTagGeo[TiffTagGeo["ProjFalseOriginEastingGeoKey"] = 3086] = "ProjFalseOriginEastingGeoKey";
	TiffTagGeo[TiffTagGeo["ProjFalseOriginNorthingGeoKey"] = 3087] = "ProjFalseOriginNorthingGeoKey";
	TiffTagGeo[TiffTagGeo["ProjCenterLongGeoKey"] = 3088] = "ProjCenterLongGeoKey";
	TiffTagGeo[TiffTagGeo["ProjCenterLatGeoKey"] = 3089] = "ProjCenterLatGeoKey";
	TiffTagGeo[TiffTagGeo["ProjCenterEastingGeoKey"] = 3090] = "ProjCenterEastingGeoKey";
	TiffTagGeo[TiffTagGeo["ProjCenterNorthingGeoKey"] = 3091] = "ProjCenterNorthingGeoKey";
	TiffTagGeo[TiffTagGeo["ProjScaleAtNatOriginGeoKey"] = 3092] = "ProjScaleAtNatOriginGeoKey";
	TiffTagGeo[TiffTagGeo["ProjScaleAtCenterGeoKey"] = 3093] = "ProjScaleAtCenterGeoKey";
	TiffTagGeo[TiffTagGeo["ProjAzimuthAngleGeoKey"] = 3094] = "ProjAzimuthAngleGeoKey";
	TiffTagGeo[TiffTagGeo["ProjStraightVertPoleLongGeoKey"] = 3095] = "ProjStraightVertPoleLongGeoKey";
	TiffTagGeo[TiffTagGeo["ProjRectifiedGridAngleGeoKey"] = 3096] = "ProjRectifiedGridAngleGeoKey";
	/**
	* This key is provided to specify the vertical coordinate reference system from the GeoTIFF CRS register or to indicate that the CRS is a user-defined vertical coordinate reference system. The value for VerticalGeoKey should follow the
	*
	* {@link https://docs.ogc.org/is/19-008r4/19-008r4.html#_requirements_class_verticalgeokey}
	*
	* @example 4979
	*/
	TiffTagGeo[TiffTagGeo["VerticalGeoKey"] = 4096] = "VerticalGeoKey";
	/**
	*
	* @example "Geographic 3D WGS 84, Ellipsoidal height"
	*/
	TiffTagGeo[TiffTagGeo["VerticalCitationGeoKey"] = 4097] = "VerticalCitationGeoKey";
	/**
	* vertical datum for a user-defined vertical coordinate reference system.
	*/
	TiffTagGeo[TiffTagGeo["VerticalDatumGeoKey"] = 4098] = "VerticalDatumGeoKey";
	/**
	* Linear Unit for vertical CRS
	*
	* @example 9001
	*/
	TiffTagGeo[TiffTagGeo["VerticalUnitsGeoKey"] = 4099] = "VerticalUnitsGeoKey";
})(TiffTagGeo || (TiffTagGeo = {}));
/**
* EPSG Angular Units. exist between [9100,  9199]
*
* Taken from libgeotiff
*/
var AngularUnit;
(function(AngularUnit) {
	AngularUnit[AngularUnit["Radian"] = 9101] = "Radian";
	AngularUnit[AngularUnit["Degree"] = 9102] = "Degree";
	AngularUnit[AngularUnit["ArcMinute"] = 9103] = "ArcMinute";
	AngularUnit[AngularUnit["ArcDegree"] = 9104] = "ArcDegree";
	AngularUnit[AngularUnit["Grad"] = 9105] = "Grad";
	AngularUnit[AngularUnit["Gon"] = 9106] = "Gon";
	AngularUnit[AngularUnit["Dms"] = 9107] = "Dms";
})(AngularUnit || (AngularUnit = {}));
/**
* ESPG Liner units exist between [9000,  9099]
*
* Taken from libgeotiff
*/
var LinearUnit;
(function(LinearUnit) {
	LinearUnit[LinearUnit["Metre"] = 9001] = "Metre";
	LinearUnit[LinearUnit["Foot"] = 9002] = "Foot";
	LinearUnit[LinearUnit["FootUsSurvey"] = 9003] = "FootUsSurvey";
	LinearUnit[LinearUnit["FootModifiedAmerican"] = 9004] = "FootModifiedAmerican";
	LinearUnit[LinearUnit["FootClarke"] = 9005] = "FootClarke";
	LinearUnit[LinearUnit["FootIndian"] = 9006] = "FootIndian";
	LinearUnit[LinearUnit["Link"] = 9007] = "Link";
	LinearUnit[LinearUnit["LinkBenoit"] = 9008] = "LinkBenoit";
	LinearUnit[LinearUnit["LinkSears"] = 9009] = "LinkSears";
	LinearUnit[LinearUnit["ChainBenoit"] = 9010] = "ChainBenoit";
	LinearUnit[LinearUnit["ChainSears"] = 9011] = "ChainSears";
	LinearUnit[LinearUnit["YardSears"] = 9012] = "YardSears";
	LinearUnit[LinearUnit["YardIndian"] = 9013] = "YardIndian";
	LinearUnit[LinearUnit["Fathom"] = 9014] = "Fathom";
	LinearUnit[LinearUnit["MileInternationalNautical"] = 9015] = "MileInternationalNautical";
})(LinearUnit || (LinearUnit = {}));
TiffTag.TileByteCounts, TiffTag.TileOffsets, TiffTag.StripOffsets, TiffTag.StripByteCounts, TiffTag.BitsPerSample, TiffTag.SampleFormat, TiffTag.GeoKeyDirectory, TiffTag.GeoDoubleParams;
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/const/tiff.mime.js
/**
* MimeType conversion for common tif image compresson types
*/
var TiffMimeType;
(function(TiffMimeType) {
	TiffMimeType["None"] = "application/octet-stream";
	TiffMimeType["Jbig"] = "image/jbig";
	TiffMimeType["Dcs"] = "image/x-kodak-dcs";
	TiffMimeType["PackBits"] = "application/packbits";
	TiffMimeType["Jpeg"] = "image/jpeg";
	TiffMimeType["Jp2000"] = "image/jp2";
	TiffMimeType["JpegXl"] = "image/jpegxl";
	TiffMimeType["Webp"] = "image/webp";
	TiffMimeType["Zstd"] = "application/zstd";
	TiffMimeType["Lzw"] = "application/lzw";
	TiffMimeType["Deflate"] = "application/deflate";
	TiffMimeType["Lerc"] = "application/lerc";
	TiffMimeType["Lzma"] = "application/x-lzma";
})(TiffMimeType || (TiffMimeType = {}));
Compression.None, TiffMimeType.None, Compression.Lzw, TiffMimeType.Lzw, Compression.Jpeg6, TiffMimeType.Jpeg, Compression.Jpeg, TiffMimeType.Jpeg, Compression.DeflateOther, TiffMimeType.Deflate, Compression.Deflate, TiffMimeType.Deflate, Compression.Lerc, TiffMimeType.Lerc, Compression.Lzma, TiffMimeType.Lzma, Compression.Jp2000, TiffMimeType.Jp2000, Compression.Zstd, TiffMimeType.Zstd, Compression.Webp, TiffMimeType.Webp, Compression.JpegXl, TiffMimeType.JpegXl, Compression.Ccittrle, TiffMimeType.None, Compression.CcittT4, TiffMimeType.None, Compression.CcittT6, TiffMimeType.None, Compression.T85, TiffMimeType.Jbig, Compression.T43, TiffMimeType.Jbig, Compression.Next, TiffMimeType.None, Compression.Ccittrlew, TiffMimeType.None, Compression.PackBits, TiffMimeType.PackBits, Compression.ThunderScan, TiffMimeType.None, Compression.It8ctpad, TiffMimeType.None, Compression.It8lw, TiffMimeType.None, Compression.It8mp, TiffMimeType.None, Compression.It8bl, TiffMimeType.None, Compression.PixarFilm, TiffMimeType.None, Compression.PixarLog, TiffMimeType.None, Compression.Dcs, TiffMimeType.Dcs, Compression.Jbig, TiffMimeType.Jbig, Compression.SgiLog, TiffMimeType.None, Compression.SgiLog24, TiffMimeType.None, Compression.JpegXlDng17, TiffMimeType.JpegXl;
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/const/tiff.tag.value.js
var TiffTagValueType;
(function(TiffTagValueType) {
	TiffTagValueType[TiffTagValueType["Uint8"] = 1] = "Uint8";
	TiffTagValueType[TiffTagValueType["Ascii"] = 2] = "Ascii";
	TiffTagValueType[TiffTagValueType["Uint16"] = 3] = "Uint16";
	TiffTagValueType[TiffTagValueType["Uint32"] = 4] = "Uint32";
	TiffTagValueType[TiffTagValueType["Rational"] = 5] = "Rational";
	TiffTagValueType[TiffTagValueType["Int8"] = 6] = "Int8";
	TiffTagValueType[TiffTagValueType["Undefined"] = 7] = "Undefined";
	TiffTagValueType[TiffTagValueType["Int16"] = 8] = "Int16";
	TiffTagValueType[TiffTagValueType["Int32"] = 9] = "Int32";
	TiffTagValueType[TiffTagValueType["SignedRational"] = 10] = "SignedRational";
	TiffTagValueType[TiffTagValueType["Float32"] = 11] = "Float32";
	TiffTagValueType[TiffTagValueType["Float64"] = 12] = "Float64";
	TiffTagValueType[TiffTagValueType["Ifd"] = 13] = "Ifd";
	TiffTagValueType[TiffTagValueType["Uint64"] = 16] = "Uint64";
	TiffTagValueType[TiffTagValueType["Int64"] = 17] = "Int64";
	TiffTagValueType[TiffTagValueType["Ifd8"] = 18] = "Ifd8";
})(TiffTagValueType || (TiffTagValueType = {}));
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/const/tiff.version.js
/**
* Tif version number that is stored at the start of a tif file
*/
var TiffVersion;
(function(TiffVersion) {
	/**
	* Big tif's,
	* generally uses 64bit numbers for offsets
	* @see http://bigtiff.org/
	**/
	TiffVersion[TiffVersion["BigTiff"] = 43] = "BigTiff";
	/**
	* Original tif
	* Uses 32 bit or smaller numbers for offsets and counters
	*/
	TiffVersion[TiffVersion["Tiff"] = 42] = "Tiff";
})(TiffVersion || (TiffVersion = {}));
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/util/bytes.js
var ByteSizeFloat;
(function(ByteSizeFloat) {
	ByteSizeFloat[ByteSizeFloat["Double"] = 8] = "Double";
	ByteSizeFloat[ByteSizeFloat["Float32"] = 4] = "Float32";
})(ByteSizeFloat || (ByteSizeFloat = {}));
var ByteSize;
(function(ByteSize) {
	ByteSize[ByteSize["UInt64"] = 8] = "UInt64";
	ByteSize[ByteSize["UInt32"] = 4] = "UInt32";
	ByteSize[ByteSize["UInt16"] = 2] = "UInt16";
	ByteSize[ByteSize["UInt8"] = 1] = "UInt8";
})(ByteSize || (ByteSize = {}));
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/read/endian.js
const buffer = /* @__PURE__ */ new ArrayBuffer(4);
const uint32 = new Uint32Array(buffer);
const uint8 = new Uint8Array(buffer);
uint32[0] = 1;
uint8[0];
TiffTag.Compression, TiffTag.ImageHeight, TiffTag.ImageWidth, TiffTag.ModelPixelScale, TiffTag.ModelTiePoint, TiffTag.ModelTransformation, TiffTag.TileHeight, TiffTag.TileWidth;
TiffTag.GeoKeyDirectory, TiffTag.GeoAsciiParams, TiffTag.GeoDoubleParams;
//#endregion
//#region ../../node_modules/@cogeotiff/core/build/read/tiff.gdal.js
var GhostOption;
(function(GhostOption) {
	GhostOption["GdalStructuralMetadataSize"] = "GDAL_STRUCTURAL_METADATA_SIZE";
	GhostOption["Layout"] = "LAYOUT";
	GhostOption["BlockOrder"] = "BLOCK_ORDER";
	GhostOption["BlockLeader"] = "BLOCK_LEADER";
	GhostOption["BlockTrailer"] = "BLOCK_TRAILER";
	GhostOption["KnownIncompatibleEdition"] = "KNOWN_INCOMPATIBLE_EDITION";
	GhostOption["MaskInterleavedWithImagery"] = "MASK_INTERLEAVED_WITH_IMAGERY";
})(GhostOption || (GhostOption = {}));
var GhostOptionTileOrder;
(function(GhostOptionTileOrder) {
	GhostOptionTileOrder["RowMajor"] = "ROW_MAJOR";
})(GhostOptionTileOrder || (GhostOptionTileOrder = {}));
var GhostOptionTileLeader;
(function(GhostOptionTileLeader) {
	GhostOptionTileLeader["uint32"] = "SIZE_AS_UINT4";
})(GhostOptionTileLeader || (GhostOptionTileLeader = {}));
TiffVersion.Tiff, ByteSize.UInt32, ByteSize.UInt16, ByteSize.UInt16 + ByteSize.UInt16 + 2 * ByteSize.UInt32;
TiffVersion.BigTiff, ByteSize.UInt64, ByteSize.UInt64, ByteSize.UInt16 + ByteSize.UInt16 + 2 * ByteSize.UInt64;
TiffVersion.BigTiff, TiffVersion.Tiff;
//#endregion
//#region ../../node_modules/@developmentseed/geotiff/dist/codecs/canvas.js
async function decode$2(bytes, metadata) {
	const blob = new Blob([bytes]);
	const imageBitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(imageBitmap, 0, 0);
	imageBitmap.close();
	const { width, height } = canvas;
	const rgba = ctx.getImageData(0, 0, width, height).data;
	const samplesPerPixel = metadata.samplesPerPixel;
	if (samplesPerPixel === 4) return {
		layout: "pixel-interleaved",
		data: rgba
	};
	if (samplesPerPixel === 3) {
		const pixelCount = width * height;
		const rgb = new Uint8ClampedArray(pixelCount * 3);
		for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
			rgb[i] = rgba[j];
			rgb[i + 1] = rgba[j + 1];
			rgb[i + 2] = rgba[j + 2];
		}
		return {
			layout: "pixel-interleaved",
			data: rgb
		};
	}
	if (samplesPerPixel === 1) {
		const pixelCount = width * height;
		const gray = new Uint8ClampedArray(pixelCount);
		for (let i = 0, j = 0; i < pixelCount; i++, j += 4) gray[i] = rgba[j];
		return {
			layout: "pixel-interleaved",
			data: gray
		};
	}
	throw new Error(`Unsupported SamplesPerPixel for JPEG: ${samplesPerPixel}`);
}
//#endregion
//#region ../../node_modules/@developmentseed/geotiff/dist/codecs/decompression-stream.js
function assert(expression, msg = "") {
	if (!expression) throw new Error(msg);
}
async function decompressWithDecompressionStream(data, { format, signal }) {
	const response = data instanceof Response ? data : new Response(data);
	assert(response.body, "Response does not contain body.");
	try {
		return await new Response(response.body.pipeThrough(new DecompressionStream(format), { signal })).arrayBuffer();
	} catch {
		signal?.throwIfAborted();
		throw new Error(`Failed to decode ${format}`);
	}
}
//#endregion
//#region ../../node_modules/@developmentseed/geotiff/dist/codecs/deflate.js
async function decode$1(bytes) {
	return decompressWithDecompressionStream(bytes, { format: "deflate" });
}
//#endregion
//#region ../../node_modules/@developmentseed/geotiff/dist/codecs/predictor.js
/**
* Undo TIFF horizontal differencing (predictor 2) or floating-point
* prediction (predictor 3) in-place on a decoded tile buffer.
*
* Mirrors the applyPredictor logic in geotiff.js.
*/
/** Undo horizontal differencing for integer samples (predictor 2). */
function decodeRowAcc(row, stride) {
	const r = row;
	let offset = 0;
	let length = row.length - stride;
	do {
		for (let i = stride; i > 0; i--) {
			r[offset + stride] = (r[offset + stride] ?? 0) + (r[offset] ?? 0);
			offset++;
		}
		length -= stride;
	} while (length > 0);
}
/** Undo floating-point horizontal differencing (predictor 3). */
function decodeRowFloatingPoint(row, stride, bytesPerSample) {
	let index = 0;
	let count = row.length;
	const wc = count / bytesPerSample;
	while (count > stride) {
		for (let i = stride; i > 0; i--) {
			row[index + stride] += row[index];
			index++;
		}
		count -= stride;
	}
	const copy = row.slice();
	for (let i = 0; i < wc; i++) for (let b = 0; b < bytesPerSample; b++) row[bytesPerSample * i + b] = copy[(bytesPerSample - b - 1) * wc + i];
}
/**
* Apply TIFF predictor decoding to a raw decoded tile buffer in-place.
*
* @param block              Decoded tile bytes.
* @param predictor          Predictor enum value.
* @param width              Tile width in pixels.
* @param height             Tile height in pixels.
* @param bitsPerSample      Bits per sample (all samples must be equal).
* @param samplesPerPixel    Number of bands.
* @param planarConfiguration  PlanarConfiguration enum value.
*/
function applyPredictor(block, predictor, width, height, bitsPerSample, samplesPerPixel, planarConfiguration) {
	if (predictor === Predictor.None) return block;
	const bytesPerSample = bitsPerSample / 8;
	const stride = planarConfiguration === PlanarConfiguration.Separate ? 1 : samplesPerPixel;
	for (let i = 0; i < height; i++) {
		const byteOffset = i * stride * width * bytesPerSample;
		if (byteOffset >= block.byteLength) break;
		if (predictor === Predictor.Horizontal) {
			let row;
			const length = stride * width;
			switch (bitsPerSample) {
				case 8:
					row = new Uint8Array(block, byteOffset, length);
					break;
				case 16:
					row = new Uint16Array(block, byteOffset, length);
					break;
				case 32:
					row = new Uint32Array(block, byteOffset, length);
					break;
				default: throw new Error(`Predictor 2 not supported for ${bitsPerSample} bits per sample.`);
			}
			decodeRowAcc(row, stride);
		} else if (predictor === Predictor.FloatingPoint) decodeRowFloatingPoint(new Uint8Array(block, byteOffset, stride * width * bytesPerSample), stride, bytesPerSample);
	}
	return block;
}
//#endregion
//#region ../../node_modules/@developmentseed/geotiff/dist/decode.js
async function decodeUncompressed(bytes) {
	return bytes;
}
/**
* The global registry of decoders for each compression type.
*
* This maps a {@link Compression} value to a function that returns a promise of
* a {@link Decoder}.
*/
const DECODER_REGISTRY = /* @__PURE__ */ new Map();
DECODER_REGISTRY.set(Compression.None, () => Promise.resolve(decodeUncompressed));
DECODER_REGISTRY.set(Compression.Deflate, () => Promise.resolve(decode$1));
DECODER_REGISTRY.set(Compression.DeflateOther, () => Promise.resolve(decode$1));
DECODER_REGISTRY.set(Compression.Lzw, () => import("./lzw-CwsKOR85.js").then((m) => m.decode));
DECODER_REGISTRY.set(Compression.Zstd, () => import("./zstd-DmHB3Top.js").then((m) => m.decode));
DECODER_REGISTRY.set(Compression.Jpeg, () => Promise.resolve(decode$2));
DECODER_REGISTRY.set(Compression.Jpeg6, () => Promise.resolve(decode$2));
DECODER_REGISTRY.set(Compression.Webp, () => Promise.resolve(decode$2));
DECODER_REGISTRY.set(Compression.Lerc, () => import("./lerc-BxamPwV0.js").then((m) => m.decode));
/**
* Decode a tile's bytes according to its compression and image metadata.
*/
async function decode(bytes, compression, metadata) {
	const loader = DECODER_REGISTRY.get(compression);
	if (!loader) throw new Error(`Unsupported compression: ${compression}`);
	const result = await (await loader())(bytes, metadata);
	if (result instanceof ArrayBuffer) {
		const { predictor, width, height, bitsPerSample, samplesPerPixel, planarConfiguration } = metadata;
		return {
			layout: "pixel-interleaved",
			data: toTypedArray(applyPredictor(result, predictor, width, height, bitsPerSample, samplesPerPixel, planarConfiguration), metadata)
		};
	}
	return result;
}
/**
* Unpack a 1-bit packed mask buffer (MSB-first) into a Uint8Array of 0/255.
* Each input byte holds 8 pixels; bit 7 is the first pixel in that byte.
*/
function unpackBitPacked(buffer, pixelCount) {
	const packed = new Uint8Array(buffer);
	const out = new Uint8Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) out[i] = packed[i >> 3] >> 7 - (i & 7) & 1 ? 255 : 0;
	return out;
}
/**
* Convert a raw ArrayBuffer of pixel data into a typed array based on the
* sample format and bits per sample. This is used for codecs that return raw
* bytes.
*/
function toTypedArray(buffer, metadata) {
	const { sampleFormat, bitsPerSample } = metadata;
	switch (sampleFormat) {
		case SampleFormat.Uint:
			switch (bitsPerSample) {
				case 1: return unpackBitPacked(buffer, metadata.width * metadata.height * metadata.samplesPerPixel);
				case 8: return new Uint8Array(buffer);
				case 16: return new Uint16Array(buffer);
				case 32: return new Uint32Array(buffer);
			}
			break;
		case SampleFormat.Int:
			switch (bitsPerSample) {
				case 8: return new Int8Array(buffer);
				case 16: return new Int16Array(buffer);
				case 32: return new Int32Array(buffer);
			}
			break;
		case SampleFormat.Float: switch (bitsPerSample) {
			case 32: return new Float32Array(buffer);
			case 64: return new Float64Array(buffer);
		}
	}
	throw new Error(`Unsupported sample format/depth: SampleFormat=${sampleFormat}, BitsPerSample=${bitsPerSample}`);
}
//#endregion
export { decode as n, Compression as r, DECODER_REGISTRY as t };
