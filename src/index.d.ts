/** Loads a file referenced by a relative path or URI (glTF buffers and images, USD sublayers and references). */
export type Resolver = ( path: string ) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;

/** A decoded image: 8 or 16 bit samples, interleaved, top row first. */
export interface DecodedImage {
	width: number;
	height: number;
	channels: 1 | 2 | 3 | 4;
	bitDepth: 8 | 16;
	data: Uint8Array | Uint16Array;
}

/** Replaces the built in image decoding (the platform decoder in browsers, JavaScript decoders in Node). */
export type ImageDecoder = ( bytes: Uint8Array, mimeType?: string ) => DecodedImage | Promise<DecodedImage>;

/** Opt-in resource limits, for both directions. See README "Limits". */
export interface ConversionLimits {
	/** Decoded data held during the conversion: accessors, USD arrays, decompressed data, images, arrays written to the output layer. */
	maxDecodedBytes?: number;
	/** Largest output buffer: checked as writers grow and before the final usdz or glb is allocated. */
	maxOutputBytes?: number;
	/** Cancels the conversion, which then rejects with the signal's reason. */
	signal?: AbortSignal;
}

/** Thrown when a conversion would go over one of its limits. Carries sizes only, never input data or file names. */
export class ConversionLimitError extends Error {
	name: 'ConversionLimitError';
	code: 'USD_GLTF_LIMIT';
	/** Where the limit was reached, e.g. 'accessor 3', 'usdc', 'image', 'glb'. */
	stage: string;
	resource: 'decoded' | 'output';
	limit: number;
	attempted: number;
}

export interface USDToGLBOptions extends ConversionLimits {
	/** Name of the input file, used to resolve relative paths. */
	identifier?: string;
	/** Needed when the USD references files outside a usdz package. */
	resolver?: Resolver;
	/** Variant selections, by prim path: { '/Root': { shadingVariant: 'red' } }, or by set name for every prim. */
	variants?: Record<string, string | Record<string, string>>;
	/** Write material variant sets as KHR_materials_variants (default true). */
	materialVariants?: boolean;
	imageDecoder?: ImageDecoder;
	/** Receives non fatal problems, such as textures that could not be read. */
	log?: ( message: string ) => void;
}

export interface GLBToUSDOptions extends ConversionLimits {
	/** Output encoding: a usdz package (default), or a single usda / usdc layer without its textures. */
	format?: 'usdz' | 'usda' | 'usdc';
	/** Needed for .gltf files with external buffers or images. */
	resolver?: Resolver;
	/**
	 * A Draco decoder module (from draco3d's createDecoderModule, or Google's decoder build), or a
	 * promise of one. Without it, Draco files load draco3d in Node and Google's CDN build in browsers.
	 */
	dracoDecoder?: object | Promise<object>;
	imageDecoder?: ImageDecoder;
	log?: ( message: string ) => void;
}

/** Converts USD (usda, usdc or usdz, detected from the bytes) to GLB. */
export function usdToGLB( data: Uint8Array | ArrayBuffer, options?: USDToGLBOptions ): Promise<Uint8Array>;

/** Converts glTF (GLB, or .gltf JSON with a resolver for its files) to USD. */
export function glbToUSD( data: Uint8Array | ArrayBuffer, options?: GLBToUSDOptions ): Promise<Uint8Array>;

/** Like glbToUSD for usda / usdc output, also returning the texture files the layer references. */
export function glbToUSDFiles( data: Uint8Array | ArrayBuffer, options?: Omit<GLBToUSDOptions, 'format'> & { format?: 'usda' | 'usdc' } ): Promise<{ layer: Uint8Array, files: Array<{ name: string, data: Uint8Array }> }>;

/** Identifies a file from its leading bytes. */
export function detectFormat( data: Uint8Array | ArrayBuffer ): 'glb' | 'gltf' | 'usda' | 'usdc' | 'usdz' | null;

/** Splits a GLB into its JSON and binary chunk. */
export function readGLB( data: Uint8Array | ArrayBuffer ): { json: any, bin: Uint8Array | null };

/** Packs glTF JSON (an object, or already UTF-8 encoded) and a binary buffer into a GLB. */
export function writeGLB( json: object | Uint8Array, bin?: Uint8Array | null ): Uint8Array;

/** The uncomposed contents of one USD layer; see src/usd/model.js for the value representation. */
export interface Layer {
	identifier: string;
	metadata: Record<string, any>;
	root: any;
	getPrimAtPath( path: string ): any;
}

export function readUSDA( source: string | Uint8Array, identifier?: string ): Layer;
export function writeUSDA( layer: Layer ): string;
export function readUSDC( data: Uint8Array | ArrayBuffer, identifier?: string ): Layer;
export function writeUSDC( layer: Layer ): Uint8Array;

/** Opens and composes a USD stage (references, payloads, sublayers, inherits, variants). */
export function openStage( data: Uint8Array, options?: { identifier?: string, resolver?: Resolver, variants?: USDToGLBOptions[ 'variants' ] } ): Promise<any>;
