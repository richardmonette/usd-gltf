// LZ4 block format and the TfFastCompression framing used by usdc files.
// https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md

const MIN_MATCH = 4;
const LAST_LITERALS = 5; // the last 5 bytes of a block are always literals
const MF_LIMIT = 12; // a match can't start within the last 12 bytes
const MAX_OFFSET = 65535;
const HASH_LOG = 16;
const MAX_INPUT_SIZE = 0x7E000000; // LZ4_MAX_INPUT_SIZE, the TfFastCompression chunk size

/**
 * Decodes one LZ4 block from src[ srcStart, srcEnd ) into dst at dstStart.
 * @returns {number} the number of bytes written
 */
export function decompressBlock( src, srcStart, srcEnd, dst, dstStart = 0 ) {

	let s = srcStart;
	let d = dstStart;
	const dstEnd = dst.length;

	while ( s < srcEnd ) {

		const token = src[ s ++ ];

		// literals
		let len = token >>> 4;

		if ( len === 15 ) {

			let b;
			do { b = src[ s ++ ]; len += b; } while ( b === 255 );

		}

		if ( s + len > srcEnd || d + len > dstEnd ) throw new Error( 'usd-gltf: corrupt LZ4 data' );

		if ( len < 32 ) {

			for ( let i = 0; i < len; i ++ ) dst[ d ++ ] = src[ s ++ ];

		} else {

			dst.set( src.subarray( s, s + len ), d );
			s += len;
			d += len;

		}

		if ( s >= srcEnd ) break; // the last sequence has no match

		// match
		const offset = src[ s ] | ( src[ s + 1 ] << 8 );
		s += 2;
		if ( offset === 0 || offset > d - dstStart ) throw new Error( 'usd-gltf: corrupt LZ4 data' );

		len = token & 15;

		if ( len === 15 ) {

			let b;
			do { b = src[ s ++ ]; len += b; } while ( b === 255 );

		}

		len += MIN_MATCH;
		if ( d + len > dstEnd ) throw new Error( 'usd-gltf: corrupt LZ4 data' );

		let m = d - offset;

		if ( offset >= len && len >= 32 ) {

			dst.copyWithin( d, m, m + len );
			d += len;

		} else {

			for ( let i = 0; i < len; i ++ ) dst[ d ++ ] = dst[ m ++ ];

		}

	}

	return d - dstStart;

}

let hashTable = null;

function writeLength( out, o, len ) {

	while ( len >= 255 ) {

		out[ o ++ ] = 255;
		len -= 255;

	}

	out[ o ++ ] = len;
	return o;

}

function writeSequence( out, o, src, litStart, litLen, offset, matchLen ) {

	const tokenPos = o ++;
	let token = 0;

	if ( litLen >= 15 ) {

		token = 15 << 4;
		o = writeLength( out, o, litLen - 15 );

	} else {

		token = litLen << 4;

	}

	if ( litLen < 32 ) {

		for ( let i = 0; i < litLen; i ++ ) out[ o ++ ] = src[ litStart + i ];

	} else {

		out.set( src.subarray( litStart, litStart + litLen ), o );
		o += litLen;

	}

	if ( matchLen > 0 ) {

		out[ o ++ ] = offset & 255;
		out[ o ++ ] = offset >>> 8;
		const ml = matchLen - MIN_MATCH;

		if ( ml >= 15 ) {

			token |= 15;
			o = writeLength( out, o, ml - 15 );

		} else {

			token |= ml;

		}

	}

	out[ tokenPos ] = token;
	return o;

}

/**
 * Compresses src into a single LZ4 block with a greedy hash matcher.
 * @param {Uint8Array} src
 * @returns {Uint8Array}
 */
export function compressBlock( src ) {

	const n = src.length;
	const out = new Uint8Array( n + ( n / 255 | 0 ) + 16 );
	let o = 0;
	let anchor = 0;

	if ( n >= MF_LIMIT + 1 ) {

		if ( hashTable === null ) hashTable = new Int32Array( 1 << HASH_LOG );
		const table = hashTable;
		table.fill( - 1 );

		const matchLimit = n - LAST_LITERALS;
		const searchLimit = n - MF_LIMIT;
		let i = 0;

		while ( i < searchLimit ) {

			const seq = src[ i ] | ( src[ i + 1 ] << 8 ) | ( src[ i + 2 ] << 16 ) | ( src[ i + 3 ] << 24 );
			const h = Math.imul( seq, 2654435761 ) >>> ( 32 - HASH_LOG );
			const ref = table[ h ];
			table[ h ] = i;

			if ( ref >= 0 && i - ref <= MAX_OFFSET &&
				src[ ref ] === src[ i ] && src[ ref + 1 ] === src[ i + 1 ] && src[ ref + 2 ] === src[ i + 2 ] && src[ ref + 3 ] === src[ i + 3 ] ) {

				let len = MIN_MATCH;
				while ( i + len < matchLimit && src[ ref + len ] === src[ i + len ] ) len ++;

				o = writeSequence( out, o, src, anchor, i - anchor, i - ref, len );
				i += len;
				anchor = i;

				// seed the table with the position just before the next search start
				if ( i - 2 < searchLimit ) {

					const p = i - 2;
					const s2 = src[ p ] | ( src[ p + 1 ] << 8 ) | ( src[ p + 2 ] << 16 ) | ( src[ p + 3 ] << 24 );
					table[ Math.imul( s2, 2654435761 ) >>> ( 32 - HASH_LOG ) ] = p;

				}

			} else {

				i ++;

			}

		}

	}

	o = writeSequence( out, o, src, anchor, n - anchor, 0, 0 );
	return out.subarray( 0, o );

}

/**
 * TfFastCompression::DecompressFromBuffer: a chunk count byte, then one LZ4 block
 * (count 0) or count blocks each prefixed by an int32 size.
 * @param {Uint8Array} src compressed bytes
 * @param {number} outputSize expected decompressed size
 * @returns {Uint8Array}
 */
export function decompressFast( src, outputSize ) {

	const out = new Uint8Array( outputSize );
	const nChunks = src[ 0 ];

	if ( nChunks === 0 ) {

		decompressBlock( src, 1, src.length, out, 0 );
		return out;

	}

	const view = new DataView( src.buffer, src.byteOffset, src.byteLength );
	let s = 1;
	let d = 0;

	for ( let i = 0; i < nChunks; i ++ ) {

		const size = view.getInt32( s, true );
		s += 4;
		d += decompressBlock( src, s, s + size, out, d );
		s += size;

	}

	return out;

}

/**
 * TfFastCompression::CompressToBuffer.
 * @param {Uint8Array} src
 * @returns {Uint8Array}
 */
export function compressFast( src ) {

	if ( src.length <= MAX_INPUT_SIZE ) {

		const block = compressBlock( src );
		const out = new Uint8Array( block.length + 1 );
		out.set( block, 1 );
		return out;

	}

	const parts = [ null ];
	let total = 1;

	for ( let start = 0; start < src.length; start += MAX_INPUT_SIZE ) {

		const block = compressBlock( src.subarray( start, Math.min( src.length, start + MAX_INPUT_SIZE ) ) );
		parts.push( block );
		total += 4 + block.length;

	}

	const out = new Uint8Array( total );
	const view = new DataView( out.buffer );
	out[ 0 ] = parts.length - 1;
	let o = 1;

	for ( let i = 1; i < parts.length; i ++ ) {

		view.setInt32( o, parts[ i ].length, true );
		out.set( parts[ i ], o + 4 );
		o += 4 + parts[ i ].length;

	}

	return out;

}
