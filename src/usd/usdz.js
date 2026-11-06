// USDZ packages: uncompressed zip archives whose file data starts on 64 byte boundaries.
// https://openusd.org/release/spec_usdz.html

import { crc32 } from '../util/crc32.js';
import { inflate } from '../image/inflate.js';
import { Budget } from '../limits.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ALIGN = 64;

/**
 * Lists the files in a zip, in archive order.
 * @param {Uint8Array} bytes
 * @param {{ budget?: import('../limits.js').Budget }} [options]
 * @returns {Map<string, Uint8Array>}
 */
export function readZip( bytes, { budget = new Budget() } = {} ) {

	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const files = new Map();

	let end = bytes.byteLength - 22;
	while ( end >= 0 && view.getUint32( end, true ) !== END ) end --;
	if ( end < 0 ) throw new Error( 'usd-gltf: not a zip archive' );

	const count = view.getUint16( end + 10, true );
	let offset = view.getUint32( end + 16, true );
	const decoder = new TextDecoder();

	for ( let i = 0; i < count; i ++ ) {

		if ( view.getUint32( offset, true ) !== CENTRAL ) throw new Error( 'usd-gltf: bad zip central directory' );

		const method = view.getUint16( offset + 10, true );
		const compressedSize = view.getUint32( offset + 20, true );
		const size = view.getUint32( offset + 24, true );
		const nameLength = view.getUint16( offset + 28, true );
		const extraLength = view.getUint16( offset + 30, true );
		const commentLength = view.getUint16( offset + 32, true );
		const localOffset = view.getUint32( offset + 42, true );
		const name = decoder.decode( bytes.subarray( offset + 46, offset + 46 + nameLength ) );

		const dataStart = localOffset + 30 + view.getUint16( localOffset + 26, true ) + view.getUint16( localOffset + 28, true );
		if ( dataStart + compressedSize > bytes.length ) throw new Error( 'usd-gltf: truncated zip archive' );
		const data = bytes.subarray( dataStart, dataStart + compressedSize );

		if ( ! name.endsWith( '/' ) ) {

			if ( method === 0 ) files.set( name, data );
			else if ( method === 8 ) { budget.decode( size, 'zip' ); files.set( name, inflate( data, size, size ) ); }
			else throw new Error( `usd-gltf: unsupported zip compression ${ method } for ${ name }` );

		}

		offset += 46 + nameLength + extraLength + commentLength;

	}

	return files;

}

/**
 * Writes a USDZ package. The first entry must be the root layer.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @param {{ budget?: import('../limits.js').Budget }} [options]
 * @returns {Uint8Array}
 */
export function writeUSDZ( entries, { budget = new Budget() } = {} ) {

	const encoder = new TextEncoder();
	const locals = [];
	const centrals = [];
	let offset = 0;

	for ( const { name, data } of entries ) {

		const nameBytes = encoder.encode( name );
		const crc = crc32( data );

		// pad with an extra field so the data starts on a 64 byte boundary; extra fields need 4 bytes of header
		let pad = ( ALIGN - ( ( offset + 30 + nameBytes.length ) % ALIGN ) ) % ALIGN;
		if ( pad > 0 && pad < 4 ) pad += ALIGN;

		const local = new Uint8Array( 30 + nameBytes.length + pad );
		const lv = new DataView( local.buffer );
		lv.setUint32( 0, LOCAL, true );
		lv.setUint16( 4, 20, true );
		lv.setUint16( 8, 0, true );
		lv.setUint16( 12, 0x21, true ); // 1980-01-01
		lv.setUint32( 14, crc, true );
		lv.setUint32( 18, data.byteLength, true );
		lv.setUint32( 22, data.byteLength, true );
		lv.setUint16( 26, nameBytes.length, true );
		lv.setUint16( 28, pad, true );
		local.set( nameBytes, 30 );

		if ( pad ) {

			lv.setUint16( 30 + nameBytes.length, 0x1986, true ); // unregistered id, as Pixar's writer uses
			lv.setUint16( 32 + nameBytes.length, pad - 4, true );

		}

		const central = new Uint8Array( 46 + nameBytes.length );
		const cv = new DataView( central.buffer );
		cv.setUint32( 0, CENTRAL, true );
		cv.setUint16( 4, 20, true );
		cv.setUint16( 6, 20, true );
		cv.setUint16( 14, 0x21, true );
		cv.setUint32( 16, crc, true );
		cv.setUint32( 20, data.byteLength, true );
		cv.setUint32( 24, data.byteLength, true );
		cv.setUint16( 28, nameBytes.length, true );
		cv.setUint32( 42, offset, true );
		central.set( nameBytes, 46 );

		locals.push( local, data );
		centrals.push( central );
		offset += local.byteLength + data.byteLength;

	}

	const centralSize = centrals.reduce( ( n, c ) => n + c.byteLength, 0 );
	const end = new Uint8Array( 22 );
	const ev = new DataView( end.buffer );
	ev.setUint32( 0, END, true );
	ev.setUint16( 8, entries.length, true );
	ev.setUint16( 10, entries.length, true );
	ev.setUint32( 12, centralSize, true );
	ev.setUint32( 16, offset, true );

	budget.output( offset + centralSize + 22, 'usdz' );
	const out = new Uint8Array( offset + centralSize + 22 );
	let p = 0;
	for ( const part of [ ...locals, ...centrals, end ] ) {

		out.set( part, p );
		p += part.byteLength;

	}

	return out;

}
