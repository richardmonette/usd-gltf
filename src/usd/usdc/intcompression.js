// Sdf_IntegerCompression: delta coded integers with 2 bit size codes, then LZ4.
// The deltas' most common value is stored once, then a 2 bit code per integer
// (0 common, 1 small, 2 medium, 3 large), then the variable length deltas.
// 32 bit ints use int8 / int16 / int32 deltas, 64 bit ints int16 / int32 / int64.

import { compressFast, decompressFast } from './lz4.js';

/**
 * @param {Uint8Array} src encoded (not LZ4 compressed) data
 * @param {number} n number of integers
 * @param {Int32Array} [out]
 * @returns {Int32Array}
 */
export function decodeInts32( src, n, out = new Int32Array( n ) ) {

	if ( n === 0 ) return out;

	const common = src[ 0 ] | ( src[ 1 ] << 8 ) | ( src[ 2 ] << 16 ) | ( src[ 3 ] << 24 );
	let c = 4;
	let v = 4 + ( ( n * 2 + 7 ) >>> 3 );
	let prev = 0;

	for ( let i = 0; i < n; i ++ ) {

		const code = ( src[ c + ( i >>> 2 ) ] >>> ( ( i & 3 ) << 1 ) ) & 3;

		if ( code === 0 ) {

			prev = ( prev + common ) | 0;

		} else if ( code === 1 ) {

			prev = ( prev + ( ( src[ v ] << 24 ) >> 24 ) ) | 0;
			v += 1;

		} else if ( code === 2 ) {

			prev = ( prev + ( ( ( src[ v ] | ( src[ v + 1 ] << 8 ) ) << 16 ) >> 16 ) ) | 0;
			v += 2;

		} else {

			prev = ( prev + ( src[ v ] | ( src[ v + 1 ] << 8 ) | ( src[ v + 2 ] << 16 ) | ( src[ v + 3 ] << 24 ) ) ) | 0;
			v += 4;

		}

		out[ i ] = prev;

	}

	return out;

}

/**
 * 64 bit variant. Values are returned as doubles, exact up to 2^53.
 * @param {Uint8Array} src
 * @param {number} n
 * @returns {Float64Array}
 */
export function decodeInts64( src, n, unsigned = false ) {

	const out = new Float64Array( n );
	if ( n === 0 ) return out;

	const view = new DataView( src.buffer, src.byteOffset, src.byteLength );
	const readI64 = ( o ) => view.getInt32( o + 4, true ) * 4294967296 + view.getUint32( o, true );
	const common = readI64( 0 );
	const c = 8;
	let v = 8 + ( ( n * 2 + 7 ) >>> 3 );
	let prev = 0;

	for ( let i = 0; i < n; i ++ ) {

		const code = ( src[ c + ( i >>> 2 ) ] >>> ( ( i & 3 ) << 1 ) ) & 3;

		if ( code === 0 ) {

			prev += common;

		} else if ( code === 1 ) {

			prev += view.getInt16( v, true );
			v += 2;

		} else if ( code === 2 ) {

			prev += view.getInt32( v, true );
			v += 4;

		} else {

			prev += readI64( v );
			v += 8;

		}

		out[ i ] = unsigned && prev < 0 ? prev + 18446744073709551616 : prev;

	}

	return out;

}

/**
 * @param {ArrayLike<number>} values int32 or uint32 values
 * @returns {Uint8Array} encoded (not LZ4 compressed) data
 */
export function encodeInts32( values ) {

	const n = values.length;
	if ( n === 0 ) return new Uint8Array( 0 );

	// most common delta, the largest on ties
	const deltas = new Int32Array( n );
	const counts = new Map();
	let prev = 0;
	let common = 0;
	let commonCount = 0;

	for ( let i = 0; i < n; i ++ ) {

		const x = values[ i ] | 0;
		const d = ( x - prev ) | 0;
		deltas[ i ] = d;
		prev = x;

		const count = ( counts.get( d ) || 0 ) + 1;
		counts.set( d, count );

		if ( count > commonCount || ( count === commonCount && d > common ) ) {

			common = d;
			commonCount = count;

		}

	}

	const out = new Uint8Array( 4 + ( ( n * 2 + 7 ) >>> 3 ) + n * 4 );
	const view = new DataView( out.buffer );
	view.setInt32( 0, common, true );
	const c = 4;
	let v = 4 + ( ( n * 2 + 7 ) >>> 3 );

	for ( let i = 0; i < n; i ++ ) {

		const d = deltas[ i ];
		let code;

		if ( d === common ) {

			code = 0;

		} else if ( d >= - 128 && d <= 127 ) {

			code = 1;
			out[ v ++ ] = d & 255;

		} else if ( d >= - 32768 && d <= 32767 ) {

			code = 2;
			view.setInt16( v, d, true );
			v += 2;

		} else {

			code = 3;
			view.setInt32( v, d, true );
			v += 4;

		}

		out[ c + ( i >>> 2 ) ] |= code << ( ( i & 3 ) << 1 );

	}

	return out.subarray( 0, v );

}

// Worst case size of the encoded buffer for n ints of the given byte size.
export function encodedBufferSize( n, size = 4 ) {

	return n ? size + ( ( n * 2 + 7 ) >>> 3 ) + n * size : 0;

}

/**
 * Sdf_IntegerCompression::DecompressFromBuffer.
 * @param {Uint8Array} src
 * @param {number} n
 * @returns {Int32Array}
 */
export function decompressInts32( src, n ) {

	if ( n === 0 ) return new Int32Array( 0 );
	return decodeInts32( decompressFast( src, encodedBufferSize( n, 4 ) ), n );

}

export function decompressInts64( src, n, unsigned = false ) {

	if ( n === 0 ) return new Float64Array( 0 );
	return decodeInts64( decompressFast( src, encodedBufferSize( n, 8 ) ), n, unsigned );

}

/**
 * Sdf_IntegerCompression::CompressToBuffer.
 * @param {ArrayLike<number>} values
 * @returns {Uint8Array}
 */
export function compressInts32( values ) {

	return compressFast( encodeInts32( values ) );

}
