// DEFLATE (RFC 1951) and zlib (RFC 1950) decompression.

export const LEN_BASE = new Uint16Array( [ 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 ] );
export const LEN_EXTRA = new Uint8Array( [ 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 ] );
export const DIST_BASE = new Uint16Array( [ 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 ] );
export const DIST_EXTRA = new Uint8Array( [ 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 ] );
export const CL_ORDER = new Uint8Array( [ 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 ] );

const REV8 = new Uint8Array( 256 );

for ( let i = 0; i < 256; i ++ ) {

	let r = 0;
	for ( let b = 0; b < 8; b ++ ) r |= ( ( i >> b ) & 1 ) << ( 7 - b );
	REV8[ i ] = r;

}

// Reverses the low `len` bits of `code` (len <= 16).
export function reverseBits( code, len ) {

	return ( ( REV8[ code & 0xFF ] << 8 ) | REV8[ code >> 8 ] ) >> ( 16 - len );

}

export function adler32( bytes, adler = 1 ) {

	let a = adler & 0xFFFF;
	let b = adler >>> 16;
	const n = bytes.length;
	let i = 0;

	while ( i < n ) {

		// 3800 bytes keeps b below 2^31 so V8 stays on small integers
		const end = Math.min( i + 3800, n );
		for ( ; i < end; i ++ ) {

			a += bytes[ i ];
			b += a;

		}

		a %= 65521;
		b %= 65521;

	}

	return ( ( b << 16 ) | a ) >>> 0;

}

// table entries for unused codes: one bit long, decoding to an out of range symbol so the
// hot loop only needs its usual range check
const BAD_LIT = ( 511 << 4 ) | 1;
const BAD_DIST = ( 31 << 4 ) | 1;

const blCount = new Uint16Array( 16 );
const nextCode = new Uint16Array( 16 );

// Fills `table` so that table[ next maxLen input bits ] = ( symbol << 4 ) | codeLength, 0 for unused codes.
// Returns maxLen.
function buildTable( lengths, offset, count, table, invalid = 0 ) {

	blCount.fill( 0 );
	let maxLen = 0;

	for ( let i = 0; i < count; i ++ ) {

		const l = lengths[ offset + i ];
		blCount[ l ] ++;
		if ( l > maxLen ) maxLen = l;

	}

	if ( maxLen === 0 ) {

		table[ 0 ] = invalid;
		return 0;

	}

	blCount[ 0 ] = 0;
	let left = 1;
	let code = 0;

	for ( let len = 1; len < 16; len ++ ) {

		left = ( left << 1 ) - blCount[ len ];
		if ( left < 0 ) throw new Error( 'usd-gltf: invalid deflate data (over-subscribed code)' );
		code = ( code + blCount[ len - 1 ] ) << 1;
		nextCode[ len ] = code;

	}

	const size = 1 << maxLen;
	table.fill( invalid, 0, size );

	for ( let sym = 0; sym < count; sym ++ ) {

		const len = lengths[ offset + sym ];
		if ( len === 0 ) continue;

		const entry = ( sym << 4 ) | len;
		const step = 1 << len;
		for ( let j = reverseBits( nextCode[ len ] ++, len ); j < size; j += step ) table[ j ] = entry;

	}

	return maxLen;

}

let fixedLit = null;
let fixedDist = null;

function buildFixed() {

	const lengths = new Uint8Array( 288 + 32 );
	lengths.fill( 8, 0, 144 );
	lengths.fill( 9, 144, 256 );
	lengths.fill( 7, 256, 280 );
	lengths.fill( 8, 280, 288 );
	lengths.fill( 5, 288, 320 );

	fixedLit = new Uint16Array( 512 );
	fixedDist = new Uint16Array( 32 );
	buildTable( lengths, 0, 288, fixedLit, BAD_LIT );
	buildTable( lengths, 288, 32, fixedDist, BAD_DIST );

}

function corrupt( what ) {

	return new Error( `usd-gltf: invalid deflate data (${ what })` );

}

// Inflates the raw DEFLATE stream starting at src[ pos ]. Returns the output and the byte offset just past the stream.
function inflateStream( src, pos, sizeHint ) {

	const srcLen = src.length;
	const overrun = srcLen + 8;

	let out = new Uint8Array( sizeHint > 0 ? sizeHint : Math.max( 1 << 15, srcLen * 4 ) );
	let op = 0;

	let bitBuf = 0;
	let bitCnt = 0;

	let lengths = null;
	let litDyn = null;
	let distDyn = null;
	let clTable = null;

	let final = 0;
	const state = { src, overrun, pos, bitBuf, bitCnt, out, op };

	do {

		while ( bitCnt < 24 ) {

			bitBuf |= src[ pos ++ ] << bitCnt;
			bitCnt += 8;

		}

		if ( pos > overrun ) throw corrupt( 'unexpected end' );

		final = bitBuf & 1;
		const type = ( bitBuf >>> 1 ) & 3;
		bitBuf >>>= 3;
		bitCnt -= 3;

		if ( type === 0 ) {

			// stored: drop to a byte boundary, then give whole buffered bytes back to the input
			bitBuf >>>= bitCnt & 7;
			bitCnt -= bitCnt & 7;
			pos -= bitCnt >> 3;
			bitBuf = 0;
			bitCnt = 0;

			if ( pos + 4 > srcLen ) throw corrupt( 'unexpected end' );
			const len = src[ pos ] | ( src[ pos + 1 ] << 8 );
			const nlen = src[ pos + 2 ] | ( src[ pos + 3 ] << 8 );
			if ( ( len ^ 0xFFFF ) !== nlen ) throw corrupt( 'stored length mismatch' );
			pos += 4;
			if ( pos + len > srcLen ) throw corrupt( 'unexpected end' );

			if ( op + len > out.length ) out = grow( out, op + len );
			out.set( src.subarray( pos, pos + len ), op );
			op += len;
			pos += len;
			continue;

		}

		let litTable, distTable, litMask, distMask;

		if ( type === 1 ) {

			if ( fixedLit === null ) buildFixed();
			litTable = fixedLit;
			distTable = fixedDist;
			litMask = 511;
			distMask = 31;

		} else if ( type === 2 ) {

			if ( lengths === null ) {

				lengths = new Uint8Array( 320 );
				litDyn = new Uint16Array( 1 << 15 );
				distDyn = new Uint16Array( 1 << 15 );
				clTable = new Uint16Array( 1 << 7 );

			}

			const hlit = ( bitBuf & 31 ) + 257;
			const hdist = ( ( bitBuf >>> 5 ) & 31 ) + 1;
			const hclen = ( ( bitBuf >>> 10 ) & 15 ) + 4;
			bitBuf >>>= 14;
			bitCnt -= 14;
			if ( hlit > 286 || hdist > 30 ) throw corrupt( 'bad code counts' );

			lengths.fill( 0, 0, 19 );
			for ( let i = 0; i < hclen; i ++ ) {

				if ( bitCnt < 3 ) {

					bitBuf |= src[ pos ++ ] << bitCnt;
					bitCnt += 8;

				}

				lengths[ CL_ORDER[ i ] ] = bitBuf & 7;
				bitBuf >>>= 3;
				bitCnt -= 3;

			}

			const clBits = buildTable( lengths, 0, 19, clTable );
			if ( clBits === 0 ) throw corrupt( 'empty code length code' );
			const clMask = ( 1 << clBits ) - 1;

			const total = hlit + hdist;
			let i = 0;

			while ( i < total ) {

				while ( bitCnt < 24 ) {

					bitBuf |= src[ pos ++ ] << bitCnt;
					bitCnt += 8;

				}

				if ( pos > overrun ) throw corrupt( 'unexpected end' );

				const e = clTable[ bitBuf & clMask ];
				const l = e & 15;
				if ( l === 0 ) throw corrupt( 'bad code length code' );
				bitBuf >>>= l;
				bitCnt -= l;
				const sym = e >> 4;

				if ( sym < 16 ) {

					lengths[ i ++ ] = sym;
					continue;

				}

				let rep, val = 0;

				if ( sym === 16 ) {

					if ( i === 0 ) throw corrupt( 'repeat with no previous length' );
					val = lengths[ i - 1 ];
					rep = 3 + ( bitBuf & 3 );
					bitBuf >>>= 2;
					bitCnt -= 2;

				} else if ( sym === 17 ) {

					rep = 3 + ( bitBuf & 7 );
					bitBuf >>>= 3;
					bitCnt -= 3;

				} else {

					rep = 11 + ( bitBuf & 127 );
					bitBuf >>>= 7;
					bitCnt -= 7;

				}

				if ( i + rep > total ) throw corrupt( 'too many code lengths' );
				lengths.fill( val, i, i + rep );
				i += rep;

			}

			if ( lengths[ 256 ] === 0 ) throw corrupt( 'missing end of block code' );

			litMask = ( 1 << buildTable( lengths, 0, hlit, litDyn, BAD_LIT ) ) - 1;
			distMask = ( 1 << buildTable( lengths, hlit, hdist, distDyn, BAD_DIST ) ) - 1;
			litTable = litDyn;
			distTable = distDyn;

		} else {

			throw corrupt( 'bad block type' );

		}

		state.pos = pos;
		state.bitBuf = bitBuf;
		state.bitCnt = bitCnt;
		state.out = out;
		state.op = op;
		decodeSymbols( state, litTable, litMask, distTable, distMask );
		pos = state.pos;
		bitBuf = state.bitBuf;
		bitCnt = state.bitCnt;
		out = state.out;
		op = state.op;

	} while ( final === 0 );

	// unused whole bytes in the bit buffer belong to whatever follows the stream
	pos -= bitCnt >> 3;
	if ( pos > srcLen ) throw corrupt( 'unexpected end' );

	return { data: op === out.length ? out : out.slice( 0, op ), end: pos };

}

// Decodes literal/length + distance symbols up to the end of block code. Kept separate from the
// block header parsing so V8 optimizes it as a whole function rather than via on-stack replacement.
function decodeSymbols( state, litTable, litMask, distTable, distMask ) {

	const src = state.src;
	const overrun = state.overrun;
	let pos = state.pos;
	let bitBuf = state.bitBuf;
	let bitCnt = state.bitCnt;
	let out = state.out;
	let op = state.op;
	let outLen = out.length;

	for ( ;; ) {

		if ( bitCnt < 15 ) {

			bitBuf |= ( src[ pos ] | ( src[ pos + 1 ] << 8 ) ) << bitCnt;
			pos += 2;
			bitCnt += 16;
			if ( pos > overrun ) throw corrupt( 'unexpected end' );

		}

		let e = litTable[ bitBuf & litMask ];
		let l = e & 15;
		bitBuf >>>= l;
		bitCnt -= l;
		let sym = e >> 4;

		if ( sym < 256 ) {

			if ( op === outLen ) {

				out = grow( out, op + 1 );
				outLen = out.length;

			}

			out[ op ++ ] = sym;
			continue;

		}

		if ( sym === 256 ) break;

		sym -= 257;
		if ( sym >= 29 ) throw corrupt( 'bad literal/length code' );

		// worst case: 5 length extra + 15 distance code bits, then up to 13 distance extra bits
		while ( bitCnt < 20 ) {

			bitBuf |= src[ pos ++ ] << bitCnt;
			bitCnt += 8;

		}

		let len = LEN_BASE[ sym ];
		const le = LEN_EXTRA[ sym ];

		if ( le !== 0 ) {

			len += bitBuf & ( ( 1 << le ) - 1 );
			bitBuf >>>= le;
			bitCnt -= le;

		}

		e = distTable[ bitBuf & distMask ];
		l = e & 15;
		bitBuf >>>= l;
		bitCnt -= l;
		sym = e >> 4;
		if ( sym >= 30 ) throw corrupt( 'bad distance code' );

		let dist = DIST_BASE[ sym ];
		const de = DIST_EXTRA[ sym ];

		if ( de !== 0 ) {

			if ( bitCnt < de ) {

				bitBuf |= ( src[ pos ] | ( src[ pos + 1 ] << 8 ) ) << bitCnt;
				pos += 2;
				bitCnt += 16;

			}

			dist += bitBuf & ( ( 1 << de ) - 1 );
			bitBuf >>>= de;
			bitCnt -= de;

		}

		if ( dist > op ) throw corrupt( 'distance too far back' );

		if ( op + len > outLen ) {

			out = grow( out, op + len );
			outLen = out.length;

		}

		let from = op - dist;
		const end = op + len;

		if ( dist >= len && len > 16 ) {

			out.copyWithin( op, from, from + len );
			op = end;

		} else {

			while ( op < end ) out[ op ++ ] = out[ from ++ ];

		}

	}

	state.pos = pos;
	state.bitBuf = bitBuf;
	state.bitCnt = bitCnt;
	state.out = out;
	state.op = op;

}

function grow( out, need ) {

	const next = new Uint8Array( Math.max( need, out.length * 2 ) );
	next.set( out );
	return next;

}

function toBytes( data ) {

	return data instanceof Uint8Array ? data : new Uint8Array( data.buffer || data, data.byteOffset || 0, data.byteLength );

}

/**
 * Decompresses raw DEFLATE data.
 * @param {Uint8Array} bytes
 * @param {number} [sizeHint] expected output size, avoids reallocation when known
 * @returns {Uint8Array}
 */
export function inflate( bytes, sizeHint = 0 ) {

	return inflateStream( toBytes( bytes ), 0, sizeHint ).data;

}

/**
 * Decompresses zlib wrapped DEFLATE data and verifies its Adler-32 checksum.
 * @param {Uint8Array} bytes
 * @param {number} [sizeHint]
 * @returns {Uint8Array}
 */
export function inflateZlib( bytes, sizeHint = 0 ) {

	bytes = toBytes( bytes );
	if ( bytes.length < 2 ) throw corrupt( 'missing zlib header' );

	const cmf = bytes[ 0 ];
	const flg = bytes[ 1 ];
	if ( ( cmf & 15 ) !== 8 || ( cmf >> 4 ) > 7 || ( ( cmf << 8 ) | flg ) % 31 !== 0 ) throw corrupt( 'bad zlib header' );
	if ( flg & 32 ) throw corrupt( 'zlib preset dictionary not supported' );

	const { data, end } = inflateStream( bytes, 2, sizeHint );

	if ( end + 4 <= bytes.length ) {

		const expected = ( ( bytes[ end ] << 24 ) | ( bytes[ end + 1 ] << 16 ) | ( bytes[ end + 2 ] << 8 ) | bytes[ end + 3 ] ) >>> 0;
		if ( adler32( data ) !== expected ) throw corrupt( 'adler32 mismatch' );

	}

	return data;

}
