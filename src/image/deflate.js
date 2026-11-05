// DEFLATE (RFC 1951) and zlib (RFC 1950) compression: LZ77 over hash chains with lazy matching,
// then each block is written as stored, fixed or dynamic Huffman, whichever is smallest.
// Chains are keyed on 4 bytes: on image data that is both faster and smaller than 3 byte keys,
// at the cost of not finding 3 byte matches.

import { LEN_BASE, LEN_EXTRA, DIST_BASE, DIST_EXTRA, CL_ORDER, adler32, reverseBits } from './inflate.js';

const WSIZE = 1 << 15;
const WMASK = WSIZE - 1;
const HASH_BITS = 16;
const MAX_MATCH = 258;
const BLOCK_SYMBOLS = 1 << 15;

// [ max chain, nice length, lazy threshold (0 = greedy), good length ]
const LEVELS = [
	null,
	[ 4, 8, 0, 4 ],
	[ 8, 16, 0, 4 ],
	[ 32, 32, 0, 4 ],
	[ 16, 16, 4, 4 ],
	[ 32, 32, 16, 8 ],
	[ 128, 128, 16, 8 ],
	[ 256, 128, 32, 8 ],
	[ 1024, 258, 128, 32 ],
	[ 4096, 258, 258, 32 ],
];

// match length 3..258 -> length symbol index 0..28
const LEN_CODE = new Uint8Array( MAX_MATCH + 1 );
// distance - 1 -> distance code, split into < 256 and ( >> 7 ) halves
const DIST_LO = new Uint8Array( 256 );
const DIST_HI = new Uint8Array( 256 );

for ( let c = 0; c < 29; c ++ ) {

	for ( let l = LEN_BASE[ c ]; l < LEN_BASE[ c ] + ( 1 << LEN_EXTRA[ c ] ) && l <= MAX_MATCH; l ++ ) LEN_CODE[ l ] = c;

}

LEN_CODE[ 258 ] = 28;

for ( let c = 0; c < 30; c ++ ) {

	for ( let d = DIST_BASE[ c ] - 1; d < DIST_BASE[ c ] - 1 + ( 1 << DIST_EXTRA[ c ] ); d ++ ) {

		if ( d < 256 ) DIST_LO[ d ] = c;
		else DIST_HI[ d >> 7 ] = c;

	}

}

function distCode( dist ) {

	const d = dist - 1;
	return d < 256 ? DIST_LO[ d ] : DIST_HI[ d >> 7 ];

}

const FIXED_LIT_LENS = new Uint8Array( 288 );
FIXED_LIT_LENS.fill( 8, 0, 144 );
FIXED_LIT_LENS.fill( 9, 144, 256 );
FIXED_LIT_LENS.fill( 7, 256, 280 );
FIXED_LIT_LENS.fill( 8, 280, 288 );
const FIXED_DIST_LENS = new Uint8Array( 30 ).fill( 5 );
const FIXED_LIT_CODES = canonicalCodes( FIXED_LIT_LENS, 288, new Uint16Array( 288 ) );
const FIXED_DIST_CODES = canonicalCodes( FIXED_DIST_LENS, 30, new Uint16Array( 30 ) );

// Bit reversed canonical Huffman codes for the given code lengths.
function canonicalCodes( lens, n, codes ) {

	const count = new Uint16Array( 16 );
	const next = new Uint16Array( 16 );
	for ( let i = 0; i < n; i ++ ) count[ lens[ i ] ] ++;
	count[ 0 ] = 0;

	let code = 0;
	for ( let len = 1; len < 16; len ++ ) {

		code = ( code + count[ len - 1 ] ) << 1;
		next[ len ] = code;

	}

	for ( let i = 0; i < n; i ++ ) {

		const l = lens[ i ];
		codes[ i ] = l ? reverseBits( next[ l ] ++, l ) : 0;

	}

	return codes;

}

// Length limited Huffman code lengths (Moffat in-place minimum redundancy + miniz style length limiting).
function huffmanLengths( freq, n, maxBits, lens ) {

	lens.fill( 0, 0, n );

	const syms = [];
	for ( let i = 0; i < n; i ++ ) if ( freq[ i ] ) syms.push( i );

	// keep every code complete: a lone symbol gets a partner
	if ( syms.length < 2 ) {

		const s = syms.length ? syms[ 0 ] : 0;
		lens[ s ] = 1;
		lens[ s === 0 ? 1 : 0 ] = 1;
		return;

	}

	syms.sort( ( a, b ) => freq[ a ] - freq[ b ] || a - b );

	const m = syms.length;
	const A = new Int32Array( m );
	for ( let i = 0; i < m; i ++ ) A[ i ] = freq[ syms[ i ] ];

	A[ 0 ] += A[ 1 ];
	let root = 0;
	let leaf = 2;

	for ( let next = 1; next < m - 1; next ++ ) {

		if ( leaf >= m || A[ root ] < A[ leaf ] ) {

			A[ next ] = A[ root ];
			A[ root ++ ] = next;

		} else {

			A[ next ] = A[ leaf ++ ];

		}

		if ( leaf >= m || ( root < next && A[ root ] < A[ leaf ] ) ) {

			A[ next ] += A[ root ];
			A[ root ++ ] = next;

		} else {

			A[ next ] += A[ leaf ++ ];

		}

	}

	A[ m - 2 ] = 0;
	for ( let next = m - 3; next >= 0; next -- ) A[ next ] = A[ A[ next ] ] + 1;

	let avail = 1;
	let used = 0;
	let depth = 0;
	root = m - 2;
	let next = m - 1;

	while ( avail > 0 ) {

		while ( root >= 0 && A[ root ] === depth ) {

			used ++;
			root --;

		}

		while ( avail > used ) {

			A[ next -- ] = depth;
			avail --;

		}

		avail = 2 * used;
		depth ++;
		used = 0;

	}

	// count codes per length, folding anything too long into maxBits, then rebalance the Kraft sum
	const counts = new Int32Array( Math.max( depth, maxBits ) + 2 );
	for ( let i = 0; i < m; i ++ ) counts[ Math.min( A[ i ], maxBits ) ] ++;

	let total = 0;
	for ( let i = maxBits; i > 0; i -- ) total += counts[ i ] << ( maxBits - i );

	while ( total !== ( 1 << maxBits ) ) {

		counts[ maxBits ] --;

		for ( let i = maxBits - 1; i > 0; i -- ) {

			if ( counts[ i ] ) {

				counts[ i ] --;
				counts[ i + 1 ] += 2;
				break;

			}

		}

		total --;

	}

	// shortest codes go to the most frequent symbols
	let j = m;
	for ( let len = 1; len <= maxBits; len ++ ) {

		for ( let c = counts[ len ]; c > 0; c -- ) lens[ syms[ -- j ] ] = len;

	}

}

class BitWriter {

	constructor( size ) {

		this.buf = new Uint8Array( Math.max( size, 1024 ) );
		this.pos = 0;
		this.bits = 0;
		this.cnt = 0;

	}

	ensure( n ) {

		if ( this.pos + n > this.buf.length ) {

			const next = new Uint8Array( Math.max( this.pos + n, this.buf.length * 2 ) );
			next.set( this.buf.subarray( 0, this.pos ) );
			this.buf = next;

		}

	}

	// n <= 16
	put( value, n ) {

		this.bits |= value << this.cnt;
		this.cnt += n;

		while ( this.cnt >= 8 ) {

			this.buf[ this.pos ++ ] = this.bits & 0xFF;
			this.bits >>>= 8;
			this.cnt -= 8;

		}

	}

	align() {

		if ( this.cnt > 0 ) this.buf[ this.pos ++ ] = this.bits & 0xFF;
		this.bits = 0;
		this.cnt = 0;

	}

	bytes( src ) {

		this.ensure( src.length );
		this.buf.set( src, this.pos );
		this.pos += src.length;

	}

	result() {

		return this.buf.slice( 0, this.pos );

	}

}

class Encoder {

	constructor( writer ) {

		this.w = writer;
		this.syms = new Uint16Array( BLOCK_SYMBOLS ); // literal byte, or 256 + match length - 3
		this.dists = new Uint16Array( BLOCK_SYMBOLS );
		this.count = 0;
		this.litFreq = new Uint32Array( 286 );
		this.distFreq = new Uint32Array( 30 );
		this.litLens = new Uint8Array( 288 );
		this.distLens = new Uint8Array( 30 );
		this.litCodes = new Uint16Array( 288 );
		this.distCodes = new Uint16Array( 30 );
		this.clLens = new Uint8Array( 19 );
		this.clCodes = new Uint16Array( 19 );
		this.clFreq = new Uint32Array( 19 );
		this.clSyms = new Uint8Array( 320 );
		this.clExtra = new Uint8Array( 320 );
		this.all = new Uint8Array( 320 );

	}

	// Writes the pending symbols for src[ start, end ) as one block (or several stored blocks).
	flush( src, start, end, final, stored = false ) {

		const { w, litFreq, distFreq, litLens, distLens } = this;
		litFreq[ 256 ] = 1;

		huffmanLengths( litFreq, 286, 15, litLens );
		huffmanLengths( distFreq, 30, 15, distLens );

		let hlit = 286;
		while ( hlit > 257 && litLens[ hlit - 1 ] === 0 ) hlit --;
		let hdist = 30;
		while ( hdist > 1 && distLens[ hdist - 1 ] === 0 ) hdist --;

		// run length encode the code lengths
		const { all, clSyms, clExtra, clFreq, clLens } = this;
		all.set( litLens.subarray( 0, hlit ), 0 );
		all.set( distLens.subarray( 0, hdist ), hlit );
		const total = hlit + hdist;
		clFreq.fill( 0 );
		let nc = 0;

		for ( let i = 0; i < total; ) {

			const cur = all[ i ];
			let run = 1;
			while ( i + run < total && all[ i + run ] === cur ) run ++;
			i += run;

			if ( cur === 0 ) {

				while ( run >= 11 ) {

					const r = Math.min( run, 138 );
					clSyms[ nc ] = 18;
					clExtra[ nc ++ ] = r - 11;
					run -= r;

				}

				if ( run >= 3 ) {

					clSyms[ nc ] = 17;
					clExtra[ nc ++ ] = run - 3;
					run = 0;

				}

			} else {

				clSyms[ nc ++ ] = cur;
				run --;

				while ( run >= 3 ) {

					const r = Math.min( run, 6 );
					clSyms[ nc ] = 16;
					clExtra[ nc ++ ] = r - 3;
					run -= r;

				}

			}

			while ( run > 0 ) {

				clSyms[ nc ++ ] = cur;
				run --;

			}

		}

		for ( let i = 0; i < nc; i ++ ) clFreq[ clSyms[ i ] ] ++;
		huffmanLengths( clFreq, 19, 7, clLens );

		let hclen = 19;
		while ( hclen > 4 && clLens[ CL_ORDER[ hclen - 1 ] ] === 0 ) hclen --;

		// block costs in bits
		let extraBits = 0;
		let dynBits = 14 + 3 * hclen;
		let fixBits = 0;

		for ( let i = 0; i < 19; i ++ ) dynBits += clFreq[ i ] * clLens[ i ];
		dynBits += clFreq[ 16 ] * 2 + clFreq[ 17 ] * 3 + clFreq[ 18 ] * 7;

		for ( let i = 0; i < 286; i ++ ) {

			const f = litFreq[ i ];
			if ( f === 0 ) continue;
			dynBits += f * litLens[ i ];
			fixBits += f * FIXED_LIT_LENS[ i ];
			if ( i > 256 ) extraBits += f * LEN_EXTRA[ i - 257 ];

		}

		for ( let i = 0; i < 30; i ++ ) {

			const f = distFreq[ i ];
			if ( f === 0 ) continue;
			dynBits += f * distLens[ i ];
			fixBits += f * 5;
			extraBits += f * DIST_EXTRA[ i ];

		}

		dynBits += extraBits;
		fixBits += extraBits;
		const length = end - start;
		const storedBits = ( length + 5 * Math.ceil( Math.max( length, 1 ) / 65535 ) ) * 8 + 7;

		w.ensure( Math.ceil( Math.max( length * 1.2, dynBits / 8 ) ) + 1024 );

		if ( stored || ( storedBits <= dynBits && storedBits <= fixBits ) ) {

			let p = start;

			do {

				const n = Math.min( 65535, end - p );
				const last = final && p + n === end;
				w.put( last ? 1 : 0, 3 );
				w.align();
				w.put( n, 16 );
				w.put( n ^ 0xFFFF, 16 );
				w.bytes( src.subarray( p, p + n ) );
				p += n;

			} while ( p < end );

		} else if ( fixBits <= dynBits ) {

			w.put( final ? 3 : 2, 3 );
			this.writeSymbols( FIXED_LIT_CODES, FIXED_LIT_LENS, FIXED_DIST_CODES, FIXED_DIST_LENS );

		} else {

			w.put( final ? 5 : 4, 3 );
			w.put( hlit - 257, 5 );
			w.put( hdist - 1, 5 );
			w.put( hclen - 4, 4 );
			for ( let i = 0; i < hclen; i ++ ) w.put( clLens[ CL_ORDER[ i ] ], 3 );

			const clCodes = canonicalCodes( clLens, 19, this.clCodes );

			for ( let i = 0; i < nc; i ++ ) {

				const s = clSyms[ i ];
				w.put( clCodes[ s ], clLens[ s ] );
				if ( s === 16 ) w.put( clExtra[ i ], 2 );
				else if ( s === 17 ) w.put( clExtra[ i ], 3 );
				else if ( s === 18 ) w.put( clExtra[ i ], 7 );

			}

			this.writeSymbols( canonicalCodes( litLens, 286, this.litCodes ), litLens, canonicalCodes( distLens, 30, this.distCodes ), distLens );

		}

		this.count = 0;
		litFreq.fill( 0 );
		distFreq.fill( 0 );

	}

	writeSymbols( litCodes, litLens, distCodes, distLens ) {

		const { w, syms, dists, count } = this;

		for ( let i = 0; i < count; i ++ ) {

			const s = syms[ i ];

			if ( s < 256 ) {

				w.put( litCodes[ s ], litLens[ s ] );

			} else {

				const len = s - 253;
				const lc = LEN_CODE[ len ];
				w.put( litCodes[ 257 + lc ], litLens[ 257 + lc ] );
				if ( LEN_EXTRA[ lc ] ) w.put( len - LEN_BASE[ lc ], LEN_EXTRA[ lc ] );

				const dist = dists[ i ];
				const dc = distCode( dist );
				w.put( distCodes[ dc ], distLens[ dc ] );
				if ( DIST_EXTRA[ dc ] ) w.put( dist - DIST_BASE[ dc ], DIST_EXTRA[ dc ] );

			}

		}

		w.put( litCodes[ 256 ], litLens[ 256 ] );

	}

}

// Adds positions [ from, to ) to the hash chains; each needs 4 bytes of lookahead.
function insertHash( src, head, prev, from, to ) {

	if ( to > src.length - 3 ) to = src.length - 3;

	for ( let i = from; i < to; i ++ ) {

		const h = Math.imul( src[ i ] | ( src[ i + 1 ] << 8 ) | ( src[ i + 2 ] << 16 ) | ( src[ i + 3 ] << 24 ), 0x1E35A7BD ) >>> ( 32 - HASH_BITS );
		prev[ i & WMASK ] = head[ h ];
		head[ h ] = i;

	}

	return to > from ? to : from;

}

// Longest match for position i (already in the chains) that beats `best`.
// Returns ( length << 16 ) | distance, or 0 when there is none.
function findMatch( src, prev, i, chain, best, nice ) {

	const maxLen = Math.min( MAX_MATCH, src.length - i );
	if ( best >= maxLen ) return 0;

	const minPos = i - WSIZE;
	const b0 = src[ i ];
	const b1 = src[ i + 1 ];
	let cand = prev[ i & WMASK ];
	let found = 0;

	while ( cand >= minPos && cand >= 0 && chain -- > 0 ) {

		if ( src[ cand + best ] === src[ i + best ] && src[ cand ] === b0 && src[ cand + 1 ] === b1 ) {

			let l = 2;
			while ( l < maxLen && src[ cand + l ] === src[ i + l ] ) l ++;

			if ( l > best ) {

				best = l;
				found = i - cand;
				if ( l >= nice || l >= maxLen ) break;

			}

		}

		const next = prev[ cand & WMASK ];
		if ( next >= cand ) break;
		cand = next;

	}

	// a distant 3 byte match costs more than three literals
	if ( found === 0 || ( best === 3 && found > 4096 ) ) return 0;
	return ( best << 16 ) | found;

}

function compress( src, level, w ) {

	const n = src.length;
	const enc = new Encoder( w );

	if ( level <= 0 || n === 0 ) {

		enc.flush( src, 0, n, true, true );
		return;

	}

	const [ maxChain, nice, lazy, good ] = LEVELS[ Math.min( level, 9 ) ];
	const head = new Int32Array( 1 << HASH_BITS ).fill( - 1 );
	const prev = new Int32Array( WSIZE );
	const { syms, dists, litFreq, distFreq } = enc;

	let inserted = 0; // positions below this are in the hash chains
	let blockStart = 0;
	let count = 0;
	let i = 0;
	let match = - 1; // ( length << 16 ) | distance for position i, -1 when not searched yet

	while ( i < n ) {

		if ( match < 0 ) {

			match = 0;

			if ( n - i >= 4 ) {

				inserted = insertHash( src, head, prev, inserted, i + 1 );
				match = findMatch( src, prev, i, maxChain, 2, nice );

			}

		}

		let len = match >>> 16;

		if ( len >= 3 && len < lazy && n - i - 1 >= 4 ) {

			inserted = insertHash( src, head, prev, inserted, i + 2 );
			const next = findMatch( src, prev, i + 1, len >= good ? maxChain >> 2 : maxChain, len, nice );

			if ( next !== 0 ) {

				// defer: emit a literal and keep the better match found at i + 1
				match = next;
				len = 0;

			}

		}

		if ( len < 3 ) {

			syms[ count ++ ] = src[ i ];
			litFreq[ src[ i ] ] ++;
			i ++;
			if ( match === 0 ) match = - 1;

		} else {

			const dist = match & 0xFFFF;
			syms[ count ] = len + 253;
			dists[ count ++ ] = dist;
			litFreq[ 257 + LEN_CODE[ len ] ] ++;
			distFreq[ distCode( dist ) ] ++;
			i += len;
			inserted = insertHash( src, head, prev, inserted, i );
			match = - 1;

		}

		if ( count === BLOCK_SYMBOLS ) {

			enc.count = count;
			enc.flush( src, blockStart, i, false );
			blockStart = i;
			count = 0;

		}

	}

	enc.count = count;
	enc.flush( src, blockStart, n, true );

}

function toBytes( data ) {

	return data instanceof Uint8Array ? data : new Uint8Array( data.buffer || data, data.byteOffset || 0, data.byteLength );

}

/**
 * Compresses bytes into a raw DEFLATE stream.
 * @param {Uint8Array} bytes
 * @param {number} [level] 0 (stored) to 9 (smallest), default 6
 * @returns {Uint8Array}
 */
export function deflate( bytes, level = 6 ) {

	bytes = toBytes( bytes );
	const w = new BitWriter( ( bytes.length >> 1 ) + 1024 );
	compress( bytes, level, w );
	w.align();
	return w.result();

}

/**
 * Compresses bytes into a zlib stream (header, DEFLATE data, Adler-32).
 * @param {Uint8Array} bytes
 * @param {number} [level]
 * @returns {Uint8Array}
 */
export function deflateZlib( bytes, level = 6 ) {

	bytes = toBytes( bytes );
	const w = new BitWriter( ( bytes.length >> 1 ) + 1024 );
	const flevel = level <= 1 ? 0 : level < 6 ? 1 : level === 6 ? 2 : 3;
	const cmf = 0x78;
	let flg = flevel << 6;
	flg += 31 - ( ( cmf << 8 ) | flg ) % 31;
	w.put( cmf, 8 );
	w.put( flg, 8 );

	compress( bytes, level, w );
	w.align();

	const a = adler32( bytes );
	w.ensure( 4 );
	w.put( a >>> 24, 8 );
	w.put( ( a >>> 16 ) & 0xFF, 8 );
	w.put( ( a >>> 8 ) & 0xFF, 8 );
	w.put( a & 0xFF, 8 );

	return w.result();

}
