// Identifies a file from its leading bytes, so callers don't have to trust extensions.

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {'glb'|'gltf'|'usda'|'usdc'|'usdz'|null}
 */
export function detectFormat( data ) {

	const bytes = data instanceof Uint8Array ? data : new Uint8Array( data );
	const head = String.fromCharCode( ...bytes.subarray( 0, 8 ) );

	if ( head.startsWith( 'glTF' ) ) return 'glb';
	if ( head === 'PXR-USDC' ) return 'usdc';
	if ( head.startsWith( '#usda' ) ) return 'usda';
	if ( head.startsWith( 'PK\x03\x04' ) ) return 'usdz';

	// glTF JSON may start with whitespace or a UTF-8 BOM
	for ( let i = 0; i < Math.min( bytes.byteLength, 64 ); i ++ ) {

		const c = bytes[ i ];
		if ( c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0xEF || c === 0xBB || c === 0xBF ) continue;
		return c === 0x7B ? 'gltf' : null;

	}

	return null;

}
