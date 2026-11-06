import { openStage } from './usd/stage.js';
import { USDToGLTF } from './convert/usd-to-gltf.js';
import { GLTFToUSD } from './convert/gltf-to-usd.js';
import { readGLTF } from './gltf/document.js';
import { writeUSDA } from './usd/usda/writer.js';
import { writeUSDC } from './usd/usdc/writer.js';
import { writeUSDZ } from './usd/usdz.js';
import { Budget } from './limits.js';

export { readGLB, writeGLB } from './gltf/glb.js';
export { detectFormat } from './detect.js';
export { openStage } from './usd/stage.js';
export { readUSDA } from './usd/usda/reader.js';
export { writeUSDA } from './usd/usda/writer.js';
export { readUSDC } from './usd/usdc/reader.js';
export { writeUSDC } from './usd/usdc/writer.js';
export { ConversionLimitError } from './limits.js';
export { DracoMismatchError } from './gltf/draco.js';

function toBytes( data ) {

	return data instanceof Uint8Array ? data : new Uint8Array( data );

}

// Limits shared by both directions; see README "Limits".
function budgetFor( { maxDecodedBytes, maxOutputBytes, signal } ) {

	return new Budget( { maxDecodedBytes, maxOutputBytes, signal } );

}

/**
 * Converts USD (usda, usdc or usdz, detected from the bytes) to GLB.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{ identifier?: string, resolver?: ( path: string ) => Promise<Uint8Array>, variants?: object, log?: ( message: string ) => void, maxDecodedBytes?: number, maxOutputBytes?: number, signal?: AbortSignal }} [options]
 *   resolver loads files referenced by relative paths (not needed for self-contained usdz)
 * @returns {Promise<Uint8Array>}
 */
export async function usdToGLB( data, options = {} ) {

	const budget = budgetFor( options );
	const stage = await openStage( toBytes( data ), { ...options, budget } );
	const builder = await new USDToGLTF( stage, { ...options, budget } ).convert();
	const glb = builder.toGLB();
	budget.check();
	return glb;

}

/**
 * Converts GLB (or glTF JSON with embedded or resolvable buffers) to USD.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{ format?: 'usda'|'usdc'|'usdz', resolver?: ( uri: string ) => Promise<Uint8Array>, dracoDecoder?: object, recoverDracoCounts?: boolean, log?: ( message: string ) => void, maxDecodedBytes?: number, maxOutputBytes?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function glbToUSD( data, { format = 'usdz', resolver = null, log, imageDecoder, dracoDecoder, recoverDracoCounts, ...limits } = {} ) {

	const budget = budgetFor( limits );
	const doc = await readGLTF( toBytes( data ), { resolver, budget, dracoDecoder, recoverDracoCounts, log } );
	const { layer, files } = await new GLTFToUSD( doc, { log, imageDecoder } ).convert();
	let out;

	if ( format === 'usda' ) out = new TextEncoder().encode( writeUSDA( layer, { budget } ) );
	else if ( format === 'usdc' ) out = writeUSDC( layer, { budget } );
	else out = writeUSDZ( [ { name: 'root.usdc', data: writeUSDC( layer, { budget } ) }, ...files ], { budget } ); // the root layer must come first

	budget.check();
	return out;

}

/**
 * For usda / usdc output the textures are separate files; this returns them alongside the layer.
 * @returns {Promise<{ layer: Uint8Array, files: Array<{ name: string, data: Uint8Array }> }>}
 */
export async function glbToUSDFiles( data, { format = 'usda', resolver = null, log, imageDecoder, dracoDecoder, recoverDracoCounts, ...limits } = {} ) {

	const budget = budgetFor( limits );
	const doc = await readGLTF( toBytes( data ), { resolver, budget, dracoDecoder, recoverDracoCounts, log } );
	const { layer, files } = await new GLTFToUSD( doc, { log, imageDecoder } ).convert();
	const bytes = format === 'usdc' ? writeUSDC( layer, { budget } ) : new TextEncoder().encode( writeUSDA( layer, { budget } ) );
	budget.output( files.reduce( ( n, f ) => n + f.data.byteLength, bytes.byteLength ), 'usd files' );
	budget.check();
	return { layer: bytes, files };

}
