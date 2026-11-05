import { openStage } from './usd/stage.js';
import { USDToGLTF } from './convert/usd-to-gltf.js';
import { GLTFToUSD } from './convert/gltf-to-usd.js';
import { readGLTF } from './gltf/document.js';
import { writeUSDA } from './usd/usda/writer.js';
import { writeUSDC } from './usd/usdc/writer.js';
import { writeUSDZ } from './usd/usdz.js';

export { readGLB, writeGLB } from './gltf/glb.js';
export { detectFormat } from './detect.js';
export { openStage } from './usd/stage.js';
export { readUSDA } from './usd/usda/reader.js';
export { writeUSDA } from './usd/usda/writer.js';
export { readUSDC } from './usd/usdc/reader.js';
export { writeUSDC } from './usd/usdc/writer.js';

function toBytes( data ) {

	return data instanceof Uint8Array ? data : new Uint8Array( data );

}

/**
 * Converts USD (usda, usdc or usdz, detected from the bytes) to GLB.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{ identifier?: string, resolver?: ( path: string ) => Promise<Uint8Array>, variants?: object, log?: ( message: string ) => void }} [options]
 *   resolver loads files referenced by relative paths (not needed for self-contained usdz)
 * @returns {Promise<Uint8Array>}
 */
export async function usdToGLB( data, options = {} ) {

	const stage = await openStage( toBytes( data ), options );
	const builder = await new USDToGLTF( stage, options ).convert();
	return builder.toGLB();

}

/**
 * Converts GLB (or glTF JSON with embedded or resolvable buffers) to USD.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{ format?: 'usda'|'usdc'|'usdz', resolver?: ( uri: string ) => Promise<Uint8Array> }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function glbToUSD( data, { format = 'usdz', resolver = null, log } = {} ) {

	const doc = await readGLTF( toBytes( data ), { resolver } );
	const { layer, files } = await new GLTFToUSD( doc, { log } ).convert();

	if ( format === 'usda' ) return new TextEncoder().encode( writeUSDA( layer ) );
	if ( format === 'usdc' ) return writeUSDC( layer );

	// the root layer must be the first file in the package
	return writeUSDZ( [ { name: 'root.usdc', data: writeUSDC( layer ) }, ...files ] );

}

/**
 * For usda / usdc output the textures are separate files; this returns them alongside the layer.
 * @returns {Promise<{ layer: Uint8Array, files: Array<{ name: string, data: Uint8Array }> }>}
 */
export async function glbToUSDFiles( data, { format = 'usda', resolver = null, log } = {} ) {

	const doc = await readGLTF( toBytes( data ), { resolver } );
	const { layer, files } = await new GLTFToUSD( doc, { log } ).convert();
	return { layer: format === 'usdc' ? writeUSDC( layer ) : new TextEncoder().encode( writeUSDA( layer ) ), files };

}
