// GLB container: a 12 byte header followed by a JSON chunk and an optional BIN chunk.
// https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout

const MAGIC = 0x46546C67; // 'glTF'
const CHUNK_JSON = 0x4E4F534A; // 'JSON'
const CHUNK_BIN = 0x004E4942; // 'BIN\0'

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pad4( n ) {

	return ( n + 3 ) & ~ 3;

}

/**
 * Splits a GLB into its glTF JSON and binary buffer.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ json: object, bin: Uint8Array|null }}
 */
export function readGLB( data ) {

	const bytes = data instanceof Uint8Array ? data : new Uint8Array( data );
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );

	if ( bytes.byteLength < 12 || view.getUint32( 0, true ) !== MAGIC ) throw new Error( 'usd-gltf: not a GLB file' );

	const version = view.getUint32( 4, true );
	if ( version !== 2 ) throw new Error( `usd-gltf: unsupported GLB version ${ version }` );

	const length = Math.min( view.getUint32( 8, true ), bytes.byteLength );

	let json = null;
	let bin = null;
	let offset = 12;

	while ( offset + 8 <= length ) {

		const chunkLength = view.getUint32( offset, true );
		const chunkType = view.getUint32( offset + 4, true );
		const start = offset + 8;
		const end = start + chunkLength;

		if ( end > length ) throw new Error( 'usd-gltf: truncated GLB chunk' );

		if ( chunkType === CHUNK_JSON && json === null ) {

			json = JSON.parse( decoder.decode( bytes.subarray( start, end ) ) );

		} else if ( chunkType === CHUNK_BIN && bin === null ) {

			bin = bytes.subarray( start, end );

		}

		// unknown chunk types are skipped, as the spec requires

		offset = end;

	}

	if ( json === null ) throw new Error( 'usd-gltf: GLB has no JSON chunk' );

	return { json, bin };

}

/**
 * Packs glTF JSON and an optional binary buffer into a GLB.
 * @param {object|Uint8Array} json the glTF JSON, or it already encoded as UTF-8
 * @param {Uint8Array|null} [bin]
 * @returns {Uint8Array}
 */
export function writeGLB( json, bin = null ) {

	const jsonBytes = json instanceof Uint8Array ? json : encoder.encode( JSON.stringify( json ) );
	const jsonLength = pad4( jsonBytes.byteLength );
	const binLength = bin ? pad4( bin.byteLength ) : 0;

	const total = 12 + 8 + jsonLength + ( bin ? 8 + binLength : 0 );
	const out = new Uint8Array( total );
	const view = new DataView( out.buffer );

	view.setUint32( 0, MAGIC, true );
	view.setUint32( 4, 2, true );
	view.setUint32( 8, total, true );

	view.setUint32( 12, jsonLength, true );
	view.setUint32( 16, CHUNK_JSON, true );
	out.set( jsonBytes, 20 );
	out.fill( 0x20, 20 + jsonBytes.byteLength, 20 + jsonLength ); // JSON is padded with spaces

	if ( bin ) {

		const offset = 20 + jsonLength;
		view.setUint32( offset, binLength, true );
		view.setUint32( offset + 4, CHUNK_BIN, true );
		out.set( bin, offset + 8 ); // BIN padding stays zero

	}

	return out;

}
