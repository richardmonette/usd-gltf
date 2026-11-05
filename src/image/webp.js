// WebP decoder: lossy (VP8), lossless (VP8L) and alpha (ALPH), ported from libwebp
// (BSD license, Copyright Google Inc.) so the output matches libwebp's default decoding,
// including its "fancy" chroma upsampling.

import { AC_TABLE, BMODES_PROBA, COEFFS_PROBA0, COEFFS_UPDATE_PROBA, DC_TABLE } from './webp-tables.js';

function fail( message ) {

	throw new Error( `usd-gltf: webp ${ message }` );

}

// --- container ---

/**
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, channels: 3|4, bitDepth: 8, data: Uint8Array }}
 */
export function decodeWebP( bytes ) {

	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const tag = ( o ) => String.fromCharCode( bytes[ o ], bytes[ o + 1 ], bytes[ o + 2 ], bytes[ o + 3 ] );
	if ( tag( 0 ) !== 'RIFF' || tag( 8 ) !== 'WEBP' ) fail( 'not a WebP file' );

	const end = Math.min( bytes.length, 8 + view.getUint32( 4, true ) );
	let vp8 = null, vp8l = null, alph = null, canvas = null;

	for ( let o = 12; o + 8 <= end; ) {

		const id = tag( o );
		const size = view.getUint32( o + 4, true );
		const data = bytes.subarray( o + 8, Math.min( end, o + 8 + size ) );

		if ( id === 'VP8X' ) canvas = { width: 1 + ( data[ 4 ] | data[ 5 ] << 8 | data[ 6 ] << 16 ), height: 1 + ( data[ 7 ] | data[ 8 ] << 8 | data[ 9 ] << 16 ) };
		else if ( id === 'VP8 ' && ! vp8 && ! vp8l ) vp8 = data;
		else if ( id === 'VP8L' && ! vp8 && ! vp8l ) vp8l = data;
		else if ( id === 'ALPH' && ! alph ) alph = data;
		else if ( id === 'ANMF' && ! vp8 && ! vp8l ) {

			// first animation frame: its own sub-chunks follow a 16 byte header
			const frame = decodeWebP( wrapFrame( data.subarray( 16 ) ) );
			return frame;

		}

		o += 8 + size + ( size & 1 );

	}

	if ( vp8l ) {

		const { width, height, argb } = decodeVP8L( vp8l );
		const hasAlpha = ( vp8l[ 4 ] >> 4 ) & 1;
		return argbToImage( argb, width, height, hasAlpha || argb.some( ( p ) => ( p >>> 24 ) !== 255 ) );

	}

	if ( ! vp8 ) fail( 'no image data' );
	const frame = decodeVP8( vp8 );
	const width = frame.width, height = frame.height;
	const rgb = yuvToRGB( frame, alph ? 4 : 3 );

	if ( alph ) {

		const alpha = decodeAlpha( alph, width, height );
		for ( let i = 0; i < width * height; i ++ ) rgb[ i * 4 + 3 ] = alpha[ i ];

	}

	void canvas;
	return { width, height, channels: alph ? 4 : 3, bitDepth: 8, data: rgb };

}

function wrapFrame( chunks ) {

	const out = new Uint8Array( 12 + chunks.length );
	out.set( [ 0x52, 0x49, 0x46, 0x46 ] );
	new DataView( out.buffer ).setUint32( 4, 4 + chunks.length, true );
	out.set( [ 0x57, 0x45, 0x42, 0x50 ], 8 );
	out.set( chunks, 12 );
	return out;

}

function argbToImage( argb, width, height, alpha ) {

	const channels = alpha ? 4 : 3;
	const data = new Uint8Array( width * height * channels );

	for ( let i = 0; i < width * height; i ++ ) {

		const p = argb[ i ];
		data[ i * channels ] = ( p >>> 16 ) & 255;
		data[ i * channels + 1 ] = ( p >>> 8 ) & 255;
		data[ i * channels + 2 ] = p & 255;
		if ( alpha ) data[ i * channels + 3 ] = p >>> 24;

	}

	return { width, height, channels, bitDepth: 8, data };

}

// --- VP8L lossless ---

class LosslessBitReader {

	constructor( data ) {

		this.data = data;
		this.pos = 0; // bit position

	}

	read( n ) {

		let v = 0;

		for ( let i = 0; i < n; ) {

			const byte = this.pos >> 3;
			const bit = this.pos & 7;
			const take = Math.min( n - i, 8 - bit );
			const b = byte < this.data.length ? this.data[ byte ] : 0;
			v |= ( ( b >> bit ) & ( ( 1 << take ) - 1 ) ) << i;
			i += take;
			this.pos += take;

		}

		return v >>> 0;

	}

	peek( n ) {

		const pos = this.pos;
		const v = this.read( n );
		this.pos = pos;
		return v;

	}

}

const CODE_LENGTH_ORDER = [ 17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 ];
const CODE_TO_PLANE = [
	0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a, 0x26, 0x2a, 0x38, 0x05, 0x37, 0x39, 0x15, 0x1b, 0x36, 0x3a,
	0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b, 0x46, 0x4a, 0x24, 0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03,
	0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d, 0x44, 0x4c, 0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e,
	0x66, 0x6a, 0x22, 0x2e, 0x54, 0x5c, 0x43, 0x4d, 0x65, 0x6b, 0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f,
	0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b, 0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e, 0x00, 0x74, 0x7c, 0x41,
	0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f, 0x40, 0x72, 0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
];

// Canonical prefix code with a lookup table indexed by the next maxLength bits (LSB first).
class PrefixCode {

	constructor( lengths ) {

		let max = 0, nonzero = 0, only = 0;
		for ( let s = 0; s < lengths.length; s ++ ) if ( lengths[ s ] ) { nonzero ++; only = s; if ( lengths[ s ] > max ) max = lengths[ s ]; }

		if ( nonzero === 0 ) fail( 'empty prefix code' );

		if ( nonzero === 1 ) {

			// a single symbol is coded with zero bits
			this.bits = 0;
			this.single = only;
			return;

		}

		const count = new Uint16Array( max + 1 );
		for ( const l of lengths ) if ( l ) count[ l ] ++;
		const next = new Uint32Array( max + 2 );
		let code = 0;
		for ( let l = 1; l <= max; l ++ ) { code = ( code + count[ l - 1 ] ) << 1; next[ l ] = code; }
		count[ 0 ] = 0;
		code = 0;
		for ( let l = 1; l <= max; l ++ ) { next[ l ] = code; code = ( code + count[ l ] ) << 1; }

		this.bits = max;
		this.table = new Uint32Array( 1 << max );

		for ( let s = 0; s < lengths.length; s ++ ) {

			const l = lengths[ s ];
			if ( ! l ) continue;
			const c = next[ l ] ++;
			// reverse the code: the stream is read least significant bit first
			let r = 0;
			for ( let i = 0; i < l; i ++ ) r |= ( ( c >> i ) & 1 ) << ( l - 1 - i );
			for ( let i = r; i < this.table.length; i += 1 << l ) this.table[ i ] = s | ( l << 16 );

		}

	}

	read( br ) {

		if ( this.bits === 0 ) return this.single;
		const e = this.table[ br.peek( this.bits ) ];
		br.pos += e >>> 16;
		return e & 0xffff;

	}

}

function readCodeLengths( br, codeLengthLengths, numSymbols ) {

	const lengthCode = new PrefixCode( codeLengthLengths );
	const lengths = new Uint8Array( numSymbols );
	let maxSymbol = numSymbols;

	if ( br.read( 1 ) ) {

		const n = 2 + 2 * br.read( 3 );
		maxSymbol = 2 + br.read( n );
		if ( maxSymbol > numSymbols ) fail( 'bad code lengths' );

	}

	let prev = 8;

	for ( let symbol = 0; symbol < numSymbols; ) {

		if ( maxSymbol -- === 0 ) break;
		const len = lengthCode.read( br );

		if ( len < 16 ) {

			lengths[ symbol ++ ] = len;
			if ( len ) prev = len;

		} else {

			const slot = len - 16;
			const repeat = br.read( [ 2, 3, 7 ][ slot ] ) + [ 3, 3, 11 ][ slot ];
			if ( symbol + repeat > numSymbols ) fail( 'bad code lengths' );
			const v = len === 16 ? prev : 0;
			for ( let i = 0; i < repeat; i ++ ) lengths[ symbol ++ ] = v;

		}

	}

	return lengths;

}

function readPrefixCode( br, alphabetSize ) {

	const lengths = new Uint8Array( alphabetSize );

	if ( br.read( 1 ) ) {

		const n = br.read( 1 ) + 1;
		const first = br.read( br.read( 1 ) ? 8 : 1 );
		lengths[ first ] = 1;
		if ( n === 2 ) lengths[ br.read( 8 ) ] = 1;
		return new PrefixCode( lengths );

	}

	const codeLengthLengths = new Uint8Array( 19 );
	const n = br.read( 4 ) + 4;
	for ( let i = 0; i < n; i ++ ) codeLengthLengths[ CODE_LENGTH_ORDER[ i ] ] = br.read( 3 );
	return new PrefixCode( readCodeLengths( br, codeLengthLengths, alphabetSize ) );

}

const subSample = ( size, bits ) => ( size + ( 1 << bits ) - 1 ) >> bits;

function copyValue( symbol, br ) {

	if ( symbol < 4 ) return symbol + 1;
	const extra = ( symbol - 2 ) >> 1;
	const offset = ( 2 + ( symbol & 1 ) ) << extra;
	return offset + br.read( extra ) + 1;

}

function decodeImageStream( br, xsize, ysize, isLevel0, transforms ) {

	let width = xsize;

	if ( isLevel0 ) {

		while ( br.read( 1 ) ) {

			const type = br.read( 2 );
			const t = { type, xsize: width };

			if ( type === 0 || type === 1 ) {

				t.bits = br.read( 3 ) + 2;
				t.data = decodeImageStream( br, subSample( width, t.bits ), subSample( ysize, t.bits ), false );

			} else if ( type === 3 ) {

				const numColors = br.read( 8 ) + 1;
				t.bits = numColors > 16 ? 0 : numColors > 4 ? 1 : numColors > 2 ? 2 : 3;
				const palette = decodeImageStream( br, numColors, 1, false );
				// palette entries are delta coded
				for ( let i = 1; i < numColors; i ++ ) palette[ i ] = addPixels( palette[ i ], palette[ i - 1 ] );
				t.data = new Uint32Array( 1 << ( 8 >> t.bits ) > numColors ? 1 << ( 8 >> t.bits ) : numColors );
				t.data.set( palette );
				width = subSample( width, t.bits );

			}

			transforms.push( t );

		}

	}

	let cacheBits = 0;
	if ( br.read( 1 ) ) {

		cacheBits = br.read( 4 );
		if ( cacheBits < 1 || cacheBits > 11 ) fail( 'bad color cache' );

	}

	// meta prefix codes
	let metaBits = 0, metaImage = null, numGroups = 1;

	if ( isLevel0 && br.read( 1 ) ) {

		metaBits = br.read( 3 ) + 2;
		metaImage = decodeImageStream( br, subSample( width, metaBits ), subSample( ysize, metaBits ), false );
		for ( let i = 0; i < metaImage.length; i ++ ) {

			metaImage[ i ] = ( metaImage[ i ] >> 8 ) & 0xffff;
			if ( metaImage[ i ] + 1 > numGroups ) numGroups = metaImage[ i ] + 1;

		}

	}

	const cacheSize = cacheBits ? 1 << cacheBits : 0;
	const groups = [];

	for ( let g = 0; g < numGroups; g ++ ) {

		groups.push( [ 256 + 24 + cacheSize, 256, 256, 256, 40 ].map( ( size ) => readPrefixCode( br, size ) ) );

	}

	const pixels = new Uint32Array( width * ysize );
	const cache = cacheBits ? new Uint32Array( cacheSize ) : null;
	const cacheShift = 32 - cacheBits;
	const metaWidth = metaImage ? subSample( width, metaBits ) : 0;
	const total = width * ysize;
	let x = 0, y = 0, group = groups[ 0 ];

	const insert = ( p ) => { if ( cache ) cache[ Math.imul( 0x1e35a7bd, p ) >>> cacheShift ] = p; };
	const groupAt = () => ( metaImage ? groups[ metaImage[ ( y >> metaBits ) * metaWidth + ( x >> metaBits ) ] ] : groups[ 0 ] );

	for ( let pos = 0; pos < total; ) {

		if ( metaImage && ( x & ( ( 1 << metaBits ) - 1 ) ) === 0 ) group = groupAt();
		const code = group[ 0 ].read( br );

		if ( code < 256 ) {

			const red = group[ 1 ].read( br );
			const blue = group[ 2 ].read( br );
			const alpha = group[ 3 ].read( br );
			const p = ( ( alpha << 24 ) | ( red << 16 ) | ( code << 8 ) | blue ) >>> 0;
			pixels[ pos ++ ] = p;
			insert( p );
			if ( ++ x >= width ) { x = 0; y ++; }

		} else if ( code < 256 + 24 ) {

			const length = copyValue( code - 256, br );
			const distSymbol = group[ 4 ].read( br );
			const planeCode = copyValue( distSymbol, br );
			let dist;
			if ( planeCode > 120 ) dist = planeCode - 120;
			else {

				const d = CODE_TO_PLANE[ planeCode - 1 ];
				dist = Math.max( 1, ( d >> 4 ) * width + 8 - ( d & 15 ) );

			}

			if ( dist > pos || pos + length > total ) fail( 'bad backward reference' );

			for ( let i = 0; i < length; i ++ ) {

				const p = pixels[ pos - dist ];
				pixels[ pos ++ ] = p;
				insert( p );

			}

			x += length;
			while ( x >= width ) { x -= width; y ++; }
			if ( metaImage && pos < total ) group = groupAt();

		} else {

			if ( ! cache ) fail( 'bad color cache symbol' );
			const p = cache[ code - 280 ];
			pixels[ pos ++ ] = p;
			insert( p );
			if ( ++ x >= width ) { x = 0; y ++; }

		}

	}

	return pixels;

}

function addPixels( a, b ) {

	const ag = ( ( a & 0xff00ff00 ) >>> 0 ) + ( ( b & 0xff00ff00 ) >>> 0 );
	const rb = ( a & 0x00ff00ff ) + ( b & 0x00ff00ff );
	return ( ( ag & 0xff00ff00 ) | ( rb & 0x00ff00ff ) ) >>> 0;

}

function average2( a, b ) {

	return ( ( ( ( ( a ^ b ) & 0xfefefefe ) >>> 1 ) + ( a & b ) ) >>> 0 );

}

function clip255( v ) {

	return v < 0 ? 0 : v > 255 ? 255 : v;

}

function predict( mode, L, T, TL, TR ) {

	switch ( mode ) {

		case 0: return 0xff000000;
		case 1: return L;
		case 2: return T;
		case 3: return TR;
		case 4: return TL;
		case 5: return average2( average2( L, TR ), T );
		case 6: return average2( L, TL );
		case 7: return average2( L, T );
		case 8: return average2( TL, T );
		case 9: return average2( T, TR );
		case 10: return average2( average2( L, TL ), average2( T, TR ) );

		case 11: {

			let d = 0;
			for ( let s = 0; s < 32; s += 8 ) {

				const a = ( T >>> s ) & 255, b = ( L >>> s ) & 255, c = ( TL >>> s ) & 255;
				d += Math.abs( b - c ) - Math.abs( a - c );

			}

			return d <= 0 ? T : L;

		}

		case 12: {

			let out = 0;
			for ( let s = 0; s < 32; s += 8 ) out |= clip255( ( ( L >>> s ) & 255 ) + ( ( T >>> s ) & 255 ) - ( ( TL >>> s ) & 255 ) ) << s;
			return out >>> 0;

		}

		case 13: {

			const avg = average2( L, T );
			let out = 0;
			for ( let s = 0; s < 32; s += 8 ) {

				const a = ( avg >>> s ) & 255;
				out |= clip255( a + Math.trunc( ( a - ( ( TL >>> s ) & 255 ) ) / 2 ) ) << s;

			}

			return out >>> 0;

		}

		default: return 0xff000000;

	}

}

function colorDelta( t, c ) {

	return ( ( t << 24 >> 24 ) * ( c << 24 >> 24 ) ) >> 5;

}

function applyInverseTransforms( pixels, transforms, height ) {

	let data = pixels;

	for ( let k = transforms.length - 1; k >= 0; k -- ) {

		const t = transforms[ k ];
		const width = t.xsize;

		if ( t.type === 2 ) {

			for ( let i = 0; i < data.length; i ++ ) {

				const p = data[ i ];
				const g = ( p >>> 8 ) & 255;
				data[ i ] = ( ( p & 0xff00ff00 ) | ( ( ( ( p >>> 16 ) + g ) & 255 ) << 16 ) | ( ( p + g ) & 255 ) ) >>> 0;

			}

		} else if ( t.type === 0 ) {

			const tiles = subSample( width, t.bits );

			for ( let y = 0; y < height; y ++ ) {

				for ( let x = 0; x < width; x ++ ) {

					const i = y * width + x;
					let mode;
					if ( y === 0 ) mode = x === 0 ? 0 : 1;
					else if ( x === 0 ) mode = 2;
					else mode = ( t.data[ ( y >> t.bits ) * tiles + ( x >> t.bits ) ] >>> 8 ) & 15;

					const L = x > 0 ? data[ i - 1 ] : 0;
					const T = y > 0 ? data[ i - width ] : 0;
					const TL = y > 0 && x > 0 ? data[ i - width - 1 ] : 0;
					// top right of the last column is the first pixel of the current row, as in memory
					const TR = y > 0 ? data[ i - width + 1 ] : 0;
					data[ i ] = addPixels( data[ i ], predict( mode, L, T, TL, TR ) );

				}

			}

		} else if ( t.type === 1 ) {

			const tiles = subSample( width, t.bits );

			for ( let y = 0; y < height; y ++ ) {

				for ( let x = 0; x < width; x ++ ) {

					const m = t.data[ ( y >> t.bits ) * tiles + ( x >> t.bits ) ];
					const g2r = m & 255, g2b = ( m >>> 8 ) & 255, r2b = ( m >>> 16 ) & 255;
					const i = y * width + x;
					const p = data[ i ];
					const g = ( p >>> 8 ) & 255;
					const r = ( ( ( p >>> 16 ) & 255 ) + colorDelta( g2r, g ) ) & 255;
					const b = ( ( p & 255 ) + colorDelta( g2b, g ) + colorDelta( r2b, r ) ) & 255;
					data[ i ] = ( ( p & 0xff00ff00 ) | ( r << 16 ) | b ) >>> 0;

				}

			}

		} else if ( t.type === 3 ) {

			const out = new Uint32Array( width * height );
			const packedWidth = subSample( width, t.bits );
			const bpp = 8 >> t.bits;
			const perByte = 1 << t.bits;
			const mask = ( 1 << bpp ) - 1;

			for ( let y = 0; y < height; y ++ ) {

				for ( let x = 0; x < width; x ++ ) {

					const packed = ( data[ y * packedWidth + ( x >> t.bits ) ] >>> 8 ) & 255;
					const index = ( packed >> ( ( x & ( perByte - 1 ) ) * bpp ) ) & mask;
					out[ y * width + x ] = t.data[ index ] ?? 0;

				}

			}

			data = out;

		}

	}

	return data;

}

function decodeVP8L( data ) {

	if ( data[ 0 ] !== 0x2f ) fail( 'bad VP8L signature' );
	const br = new LosslessBitReader( data );
	br.pos = 8;
	const width = br.read( 14 ) + 1;
	const height = br.read( 14 ) + 1;
	br.read( 1 ); // alpha hint
	if ( br.read( 3 ) !== 0 ) fail( 'unsupported VP8L version' );
	return { width, height, argb: decodeLosslessStream( br, width, height ) };

}

function decodeLosslessStream( br, width, height ) {

	const transforms = [];
	const pixels = decodeImageStream( br, width, height, true, transforms );
	return applyInverseTransforms( pixels, transforms, height );

}

// --- alpha ---

function decodeAlpha( chunk, width, height ) {

	const header = chunk[ 0 ];
	const method = header & 3;
	const filter = ( header >> 2 ) & 3;
	let alpha;

	if ( method === 0 ) {

		alpha = chunk.slice( 1, 1 + width * height );

	} else if ( method === 1 ) {

		const br = new LosslessBitReader( chunk.subarray( 1 ) );
		const argb = decodeLosslessStream( br, width, height );
		alpha = new Uint8Array( width * height );
		for ( let i = 0; i < alpha.length; i ++ ) alpha[ i ] = ( argb[ i ] >>> 8 ) & 255;

	} else {

		fail( 'unsupported alpha compression' );

	}

	if ( filter ) {

		for ( let y = 0; y < height; y ++ ) {

			const row = y * width;
			const prev = y > 0 ? row - width : - 1;

			if ( filter === 1 || prev < 0 ) {

				let pred = prev < 0 ? 0 : alpha[ prev ];
				for ( let x = 0; x < width; x ++ ) pred = alpha[ row + x ] = ( pred + alpha[ row + x ] ) & 255;

			} else if ( filter === 2 ) {

				for ( let x = 0; x < width; x ++ ) alpha[ row + x ] = ( alpha[ prev + x ] + alpha[ row + x ] ) & 255;

			} else {

				let top, topLeft = alpha[ prev ], left = topLeft;
				for ( let x = 0; x < width; x ++ ) {

					top = alpha[ prev + x ];
					left = alpha[ row + x ] = ( alpha[ row + x ] + clip255( left + top - topLeft ) ) & 255;
					topLeft = top;

				}

			}

		}

	}

	return alpha;

}

// --- VP8 lossy ---

// Boolean entropy decoder, RFC 6386 section 7.
class BoolDecoder {

	constructor( data, start, end ) {

		this.data = data;
		this.pos = start;
		this.end = end;
		this.value = ( this.next() << 8 ) | this.next();
		this.range = 255;
		this.bitCount = 0;

	}

	next() {

		return this.pos < this.end ? this.data[ this.pos ++ ] : 0;

	}

	bit( prob ) {

		const split = 1 + ( ( ( this.range - 1 ) * prob ) >> 8 );
		const bigSplit = split << 8;
		let bit;

		if ( this.value >= bigSplit ) {

			bit = 1;
			this.range -= split;
			this.value -= bigSplit;

		} else {

			bit = 0;
			this.range = split;

		}

		while ( this.range < 128 ) {

			this.value <<= 1;
			this.range <<= 1;

			if ( ++ this.bitCount === 8 ) {

				this.bitCount = 0;
				this.value |= this.next();

			}

		}

		return bit;

	}

	literal( n ) {

		let v = 0;
		for ( let i = 0; i < n; i ++ ) v = ( v << 1 ) | this.bit( 128 );
		return v;

	}

	signed( n ) {

		const v = this.literal( n );
		return this.bit( 128 ) ? - v : v;

	}

}

const BANDS = [ 0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0 ];
const ZIGZAG = [ 0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15 ];
const CAT_PROBS = [ [ 173, 148, 140 ], [ 176, 155, 140, 135 ], [ 180, 157, 141, 134, 130 ], [ 254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129 ] ];

// work buffer: 1 row and column of context around a 16x16 luma block, plus 4 top right pixels
const BPS = 32;

function largeValue( br, P, p ) {

	if ( ! br.bit( P[ p + 3 ] ) ) {

		if ( ! br.bit( P[ p + 4 ] ) ) return 2;
		return 3 + br.bit( P[ p + 5 ] );

	}

	if ( ! br.bit( P[ p + 6 ] ) ) {

		if ( ! br.bit( P[ p + 7 ] ) ) return 5 + br.bit( 159 );
		return 7 + 2 * br.bit( 165 ) + br.bit( 145 );

	}

	const bit1 = br.bit( P[ p + 8 ] );
	const bit0 = br.bit( P[ p + 9 + bit1 ] );
	const cat = 2 * bit1 + bit0;
	let v = 0;
	for ( const prob of CAT_PROBS[ cat ] ) v += v + br.bit( prob );
	return v + 3 + ( 8 << cat );

}

function getCoeffs( br, P, type, ctx, dc, ac, n, out, o ) {

	const index = ( band, c ) => ( ( type * 8 + band ) * 3 + c ) * 11;
	let p = index( BANDS[ n ], ctx );

	for ( ; n < 16; n ++ ) {

		if ( ! br.bit( P[ p ] ) ) return n;

		while ( ! br.bit( P[ p + 1 ] ) ) {

			if ( ++ n === 16 ) return 16;
			p = index( BANDS[ n ], 0 );

		}

		let v;

		if ( ! br.bit( P[ p + 2 ] ) ) {

			v = 1;
			p = index( BANDS[ n + 1 ], 1 );

		} else {

			v = largeValue( br, P, p );
			p = index( BANDS[ n + 1 ], 2 );

		}

		out[ o + ZIGZAG[ n ] ] = ( br.bit( 128 ) ? - v : v ) * ( n > 0 ? ac : dc );

	}

	return 16;

}

function transformWHT( input, out ) {

	const tmp = new Int32Array( 16 );

	for ( let i = 0; i < 4; i ++ ) {

		const a0 = input[ i ] + input[ 12 + i ], a1 = input[ 4 + i ] + input[ 8 + i ];
		const a2 = input[ 4 + i ] - input[ 8 + i ], a3 = input[ i ] - input[ 12 + i ];
		tmp[ i ] = a0 + a1; tmp[ 8 + i ] = a0 - a1; tmp[ 4 + i ] = a3 + a2; tmp[ 12 + i ] = a3 - a2;

	}

	for ( let i = 0; i < 4; i ++ ) {

		const dc = tmp[ i * 4 ] + 3;
		const a0 = dc + tmp[ 3 + i * 4 ], a1 = tmp[ 1 + i * 4 ] + tmp[ 2 + i * 4 ];
		const a2 = tmp[ 1 + i * 4 ] - tmp[ 2 + i * 4 ], a3 = dc - tmp[ 3 + i * 4 ];
		out[ i * 64 ] = ( a0 + a1 ) >> 3;
		out[ i * 64 + 16 ] = ( a3 + a2 ) >> 3;
		out[ i * 64 + 32 ] = ( a0 - a1 ) >> 3;
		out[ i * 64 + 48 ] = ( a3 - a2 ) >> 3;

	}

}

const mul1 = ( a ) => ( ( a * 20091 ) >> 16 ) + a;
const mul2 = ( a ) => ( a * 35468 ) >> 16;
const clip8 = ( v ) => ( v < 0 ? 0 : v > 255 ? 255 : v );

// Inverse DCT of one 4x4 block, added to the prediction in buf at o.
function transformAdd( coeffs, c, buf, o ) {

	const tmp = new Int32Array( 16 );

	for ( let i = 0; i < 4; i ++ ) {

		const a = coeffs[ c + i ] + coeffs[ c + 8 + i ];
		const b = coeffs[ c + i ] - coeffs[ c + 8 + i ];
		const cc = mul2( coeffs[ c + 4 + i ] ) - mul1( coeffs[ c + 12 + i ] );
		const d = mul1( coeffs[ c + 4 + i ] ) + mul2( coeffs[ c + 12 + i ] );
		tmp[ i * 4 ] = a + d; tmp[ i * 4 + 1 ] = b + cc; tmp[ i * 4 + 2 ] = b - cc; tmp[ i * 4 + 3 ] = a - d;

	}

	for ( let i = 0; i < 4; i ++ ) {

		const dc = tmp[ i ] + 4;
		const a = dc + tmp[ 8 + i ], b = dc - tmp[ 8 + i ];
		const cc = mul2( tmp[ 4 + i ] ) - mul1( tmp[ 12 + i ] );
		const d = mul1( tmp[ 4 + i ] ) + mul2( tmp[ 12 + i ] );
		const r = o + i * BPS;
		buf[ r ] = clip8( buf[ r ] + ( ( a + d ) >> 3 ) );
		buf[ r + 1 ] = clip8( buf[ r + 1 ] + ( ( b + cc ) >> 3 ) );
		buf[ r + 2 ] = clip8( buf[ r + 2 ] + ( ( b - cc ) >> 3 ) );
		buf[ r + 3 ] = clip8( buf[ r + 3 ] + ( ( a - d ) >> 3 ) );

	}

}

const avg3 = ( a, b, c ) => ( a + 2 * b + c + 2 ) >> 2;
const avg2 = ( a, b ) => ( a + b + 1 ) >> 1;

// 4x4 intra predictors; mode numbers follow libwebp: DC TM VE HE RD VR LD VL HD HU
function predict4( mode, d, o ) {

	const top = o - BPS;
	const A = d[ top ], B = d[ top + 1 ], C = d[ top + 2 ], D = d[ top + 3 ], E = d[ top + 4 ], F = d[ top + 5 ], G = d[ top + 6 ], H = d[ top + 7 ];
	const X = d[ top - 1 ], I = d[ o - 1 ], J = d[ o - 1 + BPS ], K = d[ o - 1 + 2 * BPS ], L = d[ o - 1 + 3 * BPS ];
	const put = ( x, y, v ) => { d[ o + x + y * BPS ] = v; };

	switch ( mode ) {

		case 0: {

			let dc = 4;
			for ( let i = 0; i < 4; i ++ ) dc += d[ top + i ] + d[ o - 1 + i * BPS ];
			dc >>= 3;
			for ( let y = 0; y < 4; y ++ ) for ( let x = 0; x < 4; x ++ ) put( x, y, dc );
			break;

		}

		case 1:
			for ( let y = 0; y < 4; y ++ ) for ( let x = 0; x < 4; x ++ ) put( x, y, clip8( d[ top + x ] + d[ o - 1 + y * BPS ] - X ) );
			break;

		case 2: {

			const v = [ avg3( X, A, B ), avg3( A, B, C ), avg3( B, C, D ), avg3( C, D, E ) ];
			for ( let y = 0; y < 4; y ++ ) for ( let x = 0; x < 4; x ++ ) put( x, y, v[ x ] );
			break;

		}

		case 3: {

			const v = [ avg3( X, I, J ), avg3( I, J, K ), avg3( J, K, L ), avg3( K, L, L ) ];
			for ( let y = 0; y < 4; y ++ ) for ( let x = 0; x < 4; x ++ ) put( x, y, v[ y ] );
			break;

		}

		case 4:
			put( 0, 3, avg3( J, K, L ) );
			put( 1, 3, avg3( I, J, K ) ); put( 0, 2, avg3( I, J, K ) );
			put( 2, 3, avg3( X, I, J ) ); put( 1, 2, avg3( X, I, J ) ); put( 0, 1, avg3( X, I, J ) );
			put( 3, 3, avg3( A, X, I ) ); put( 2, 2, avg3( A, X, I ) ); put( 1, 1, avg3( A, X, I ) ); put( 0, 0, avg3( A, X, I ) );
			put( 3, 2, avg3( B, A, X ) ); put( 2, 1, avg3( B, A, X ) ); put( 1, 0, avg3( B, A, X ) );
			put( 3, 1, avg3( C, B, A ) ); put( 2, 0, avg3( C, B, A ) );
			put( 3, 0, avg3( D, C, B ) );
			break;

		case 5:
			put( 0, 0, avg2( X, A ) ); put( 1, 2, avg2( X, A ) );
			put( 1, 0, avg2( A, B ) ); put( 2, 2, avg2( A, B ) );
			put( 2, 0, avg2( B, C ) ); put( 3, 2, avg2( B, C ) );
			put( 3, 0, avg2( C, D ) );
			put( 0, 3, avg3( K, J, I ) );
			put( 0, 2, avg3( J, I, X ) );
			put( 0, 1, avg3( I, X, A ) ); put( 1, 3, avg3( I, X, A ) );
			put( 1, 1, avg3( X, A, B ) ); put( 2, 3, avg3( X, A, B ) );
			put( 2, 1, avg3( A, B, C ) ); put( 3, 3, avg3( A, B, C ) );
			put( 3, 1, avg3( B, C, D ) );
			break;

		case 6:
			put( 0, 0, avg3( A, B, C ) );
			put( 1, 0, avg3( B, C, D ) ); put( 0, 1, avg3( B, C, D ) );
			put( 2, 0, avg3( C, D, E ) ); put( 1, 1, avg3( C, D, E ) ); put( 0, 2, avg3( C, D, E ) );
			put( 3, 0, avg3( D, E, F ) ); put( 2, 1, avg3( D, E, F ) ); put( 1, 2, avg3( D, E, F ) ); put( 0, 3, avg3( D, E, F ) );
			put( 3, 1, avg3( E, F, G ) ); put( 2, 2, avg3( E, F, G ) ); put( 1, 3, avg3( E, F, G ) );
			put( 3, 2, avg3( F, G, H ) ); put( 2, 3, avg3( F, G, H ) );
			put( 3, 3, avg3( G, H, H ) );
			break;

		case 7:
			put( 0, 0, avg2( A, B ) );
			put( 1, 0, avg2( B, C ) ); put( 0, 2, avg2( B, C ) );
			put( 2, 0, avg2( C, D ) ); put( 1, 2, avg2( C, D ) );
			put( 3, 0, avg2( D, E ) ); put( 2, 2, avg2( D, E ) );
			put( 0, 1, avg3( A, B, C ) );
			put( 1, 1, avg3( B, C, D ) ); put( 0, 3, avg3( B, C, D ) );
			put( 2, 1, avg3( C, D, E ) ); put( 1, 3, avg3( C, D, E ) );
			put( 3, 1, avg3( D, E, F ) ); put( 2, 3, avg3( D, E, F ) );
			put( 3, 2, avg3( E, F, G ) );
			put( 3, 3, avg3( F, G, H ) );
			break;

		case 8:
			put( 0, 0, avg2( I, X ) ); put( 2, 1, avg2( I, X ) );
			put( 0, 1, avg2( J, I ) ); put( 2, 2, avg2( J, I ) );
			put( 0, 2, avg2( K, J ) ); put( 2, 3, avg2( K, J ) );
			put( 0, 3, avg2( L, K ) );
			put( 3, 0, avg3( A, B, C ) );
			put( 2, 0, avg3( X, A, B ) );
			put( 1, 0, avg3( I, X, A ) ); put( 3, 1, avg3( I, X, A ) );
			put( 1, 1, avg3( J, I, X ) ); put( 3, 2, avg3( J, I, X ) );
			put( 1, 2, avg3( K, J, I ) ); put( 3, 3, avg3( K, J, I ) );
			put( 1, 3, avg3( L, K, J ) );
			break;

		case 9:
			put( 0, 0, avg2( I, J ) );
			put( 2, 0, avg2( J, K ) ); put( 0, 1, avg2( J, K ) );
			put( 2, 1, avg2( K, L ) ); put( 0, 2, avg2( K, L ) );
			put( 1, 0, avg3( I, J, K ) );
			put( 3, 0, avg3( J, K, L ) ); put( 1, 1, avg3( J, K, L ) );
			put( 3, 1, avg3( K, L, L ) ); put( 1, 2, avg3( K, L, L ) );
			put( 3, 2, L ); put( 2, 2, L ); put( 0, 3, L ); put( 1, 3, L ); put( 2, 3, L ); put( 3, 3, L );
			break;

	}

}

// 16x16 luma and 8x8 chroma predictors with libwebp's handling of missing edges
function predictBlock( mode, d, o, size, hasTop, hasLeft ) {

	const top = o - BPS;

	if ( mode === 0 ) {

		let dc;
		const shift = size === 16 ? 4 : 3;

		if ( hasTop && hasLeft ) {

			dc = size;
			for ( let i = 0; i < size; i ++ ) dc += d[ top + i ] + d[ o - 1 + i * BPS ];
			dc >>= shift + 1;

		} else if ( hasTop || hasLeft ) {

			dc = size >> 1;
			for ( let i = 0; i < size; i ++ ) dc += hasTop ? d[ top + i ] : d[ o - 1 + i * BPS ];
			dc >>= shift;

		} else {

			dc = 128;

		}

		for ( let y = 0; y < size; y ++ ) d.fill( dc, o + y * BPS, o + y * BPS + size );

	} else if ( mode === 1 ) {

		const X = d[ top - 1 ];
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) d[ o + y * BPS + x ] = clip8( d[ top + x ] + d[ o - 1 + y * BPS ] - X );

	} else if ( mode === 2 ) {

		for ( let y = 0; y < size; y ++ ) d.copyWithin( o + y * BPS, top, top + size );

	} else {

		for ( let y = 0; y < size; y ++ ) d.fill( d[ o - 1 + y * BPS ], o + y * BPS, o + y * BPS + size );

	}

}

// libwebp's CheckMode: DC prediction depends on which edges exist, TM on the first row and column
function checkMode( mbx, mby, mode ) {

	if ( mode === 0 ) return { mode: 0, hasTop: mby > 0, hasLeft: mbx > 0 };
	return { mode, hasTop: true, hasLeft: true };

}

const SCAN = Array.from( { length: 16 }, ( _, n ) => ( n & 3 ) * 4 + ( n >> 2 ) * 4 * BPS );

function decodeVP8( data ) {

	const bits = data[ 0 ] | ( data[ 1 ] << 8 ) | ( data[ 2 ] << 16 );
	if ( bits & 1 ) fail( 'not a key frame' );
	const partitionLength = bits >> 5;
	if ( data[ 3 ] !== 0x9d || data[ 4 ] !== 0x01 || data[ 5 ] !== 0x2a ) fail( 'bad VP8 start code' );

	const width = ( data[ 6 ] | ( data[ 7 ] << 8 ) ) & 0x3fff;
	const height = ( data[ 8 ] | ( data[ 9 ] << 8 ) ) & 0x3fff;
	const mbw = ( width + 15 ) >> 4, mbh = ( height + 15 ) >> 4;

	let pos = 10;
	const br = new BoolDecoder( data, pos, pos + partitionLength );
	pos += partitionLength;

	br.bit( 128 ); // color space
	br.bit( 128 ); // clamping type

	// segments
	const segment = { use: false, updateMap: false, absolute: true, quant: [ 0, 0, 0, 0 ], filter: [ 0, 0, 0, 0 ], probs: [ 255, 255, 255 ] };

	if ( ( segment.use = !! br.bit( 128 ) ) ) {

		segment.updateMap = !! br.bit( 128 );

		if ( br.bit( 128 ) ) {

			segment.absolute = !! br.bit( 128 );
			for ( let s = 0; s < 4; s ++ ) segment.quant[ s ] = br.bit( 128 ) ? br.signed( 7 ) : 0;
			for ( let s = 0; s < 4; s ++ ) segment.filter[ s ] = br.bit( 128 ) ? br.signed( 6 ) : 0;

		}

		if ( segment.updateMap ) for ( let s = 0; s < 3; s ++ ) segment.probs[ s ] = br.bit( 128 ) ? br.literal( 8 ) : 255;

	}

	// loop filter
	const simple = br.bit( 128 );
	const level = br.literal( 6 );
	const sharpness = br.literal( 3 );
	const refDelta = [ 0, 0, 0, 0 ], modeDelta = [ 0, 0, 0, 0 ];
	const useDelta = br.bit( 128 );

	if ( useDelta && br.bit( 128 ) ) {

		for ( let i = 0; i < 4; i ++ ) if ( br.bit( 128 ) ) refDelta[ i ] = br.signed( 6 );
		for ( let i = 0; i < 4; i ++ ) if ( br.bit( 128 ) ) modeDelta[ i ] = br.signed( 6 );

	}

	const filterType = level === 0 ? 0 : simple ? 1 : 2;

	// partitions
	const numParts = 1 << br.literal( 2 );
	const sizesStart = pos;
	let partStart = pos + 3 * ( numParts - 1 );
	const parts = [];

	for ( let p = 0; p < numParts; p ++ ) {

		let size = p < numParts - 1 ? data[ sizesStart + p * 3 ] | ( data[ sizesStart + p * 3 + 1 ] << 8 ) | ( data[ sizesStart + p * 3 + 2 ] << 16 ) : data.length - partStart;
		size = Math.min( size, data.length - partStart );
		parts.push( new BoolDecoder( data, partStart, partStart + size ) );
		partStart += size;

	}

	// quantizers
	const baseQ = br.literal( 7 );
	const dq = [ 0, 0, 0, 0, 0 ].map( () => ( br.bit( 128 ) ? br.signed( 4 ) : 0 ) );
	const [ dqy1dc, dqy2dc, dqy2ac, dquvdc, dquvac ] = dq;
	const clipQ = ( v, max ) => ( v < 0 ? 0 : v > max ? max : v );
	const quant = [];

	for ( let s = 0; s < 4; s ++ ) {

		let q = baseQ;
		if ( segment.use ) q = segment.quant[ s ] + ( segment.absolute ? 0 : baseQ );
		const y2ac = ( AC_TABLE[ clipQ( q + dqy2ac, 127 ) ] * 101581 ) >> 16;
		quant.push( {
			y1: [ DC_TABLE[ clipQ( q + dqy1dc, 127 ) ], AC_TABLE[ clipQ( q, 127 ) ] ],
			y2: [ DC_TABLE[ clipQ( q + dqy2dc, 127 ) ] * 2, y2ac < 8 ? 8 : y2ac ],
			uv: [ DC_TABLE[ clipQ( q + dquvdc, 117 ) ], AC_TABLE[ clipQ( q + dquvac, 127 ) ] ],
		} );

	}

	br.bit( 128 ); // refresh entropy probs, ignored for a single key frame

	const P = new Uint8Array( 1056 );
	for ( let i = 0; i < 1056; i ++ ) P[ i ] = br.bit( COEFFS_UPDATE_PROBA[ i ] ) ? br.literal( 8 ) : COEFFS_PROBA0[ i ];

	const useSkip = br.bit( 128 );
	const skipProb = useSkip ? br.literal( 8 ) : 0;

	// filter strengths per segment and per i4x4
	const strengths = [];

	for ( let s = 0; s < 4; s ++ ) {

		let base = level;
		if ( segment.use ) base = segment.filter[ s ] + ( segment.absolute ? 0 : level );
		strengths.push( [ 0, 1 ].map( ( i4 ) => {

			let l = base;
			if ( useDelta ) { l += refDelta[ 0 ]; if ( i4 ) l += modeDelta[ 0 ]; }
			l = l < 0 ? 0 : l > 63 ? 63 : l;
			if ( l === 0 ) return { limit: 0 };
			let ilevel = l;
			if ( sharpness > 0 ) {

				ilevel >>= sharpness > 4 ? 2 : 1;
				if ( ilevel > 9 - sharpness ) ilevel = 9 - sharpness;

			}

			if ( ilevel < 1 ) ilevel = 1;
			return { limit: 2 * l + ilevel, ilevel, hev: l >= 40 ? 2 : l >= 15 ? 1 : 0 };

		} ) );

	}

	// frame planes, macroblock aligned
	const yStride = mbw * 16, uvStride = mbw * 8;
	const Y = new Uint8Array( yStride * mbh * 16 );
	const U = new Uint8Array( uvStride * mbh * 8 );
	const V = new Uint8Array( uvStride * mbh * 8 );
	const mbInfo = new Array( mbw * mbh );

	// non zero contexts: 4 luma, 2 + 2 chroma, 1 dc per column / row
	const topNz = new Uint8Array( mbw * 9 );
	const leftNz = new Uint8Array( 9 );
	const intraTop = new Uint8Array( mbw * 4 );
	const intraLeft = new Uint8Array( 4 );

	const ybuf = new Uint8Array( BPS * 17 + 1 );
	const ubuf = new Uint8Array( BPS * 9 + 1 );
	const vbuf = new Uint8Array( BPS * 9 + 1 );
	const YO = BPS + 1, UVO = BPS + 1; // offset of the block's first pixel
	const coeffs = new Int16Array( 384 );
	const dc = new Int16Array( 16 );
	const imodes = new Uint8Array( 16 );

	for ( let mby = 0; mby < mbh; mby ++ ) {

		leftNz.fill( 0 );
		intraLeft.fill( 0 );
		const tokens = parts[ mby & ( numParts - 1 ) ];

		for ( let mbx = 0; mbx < mbw; mbx ++ ) {

			// modes
			const seg = segment.updateMap ? ( ! br.bit( segment.probs[ 0 ] ) ? br.bit( segment.probs[ 1 ] ) : br.bit( segment.probs[ 2 ] ) + 2 ) : 0;
			const skip = useSkip ? br.bit( skipProb ) : 0;
			const isI4 = ! br.bit( 145 );
			let ymode = 0;

			if ( ! isI4 ) {

				ymode = br.bit( 156 ) ? ( br.bit( 128 ) ? 1 : 3 ) : ( br.bit( 163 ) ? 2 : 0 );
				intraTop.fill( ymode, mbx * 4, mbx * 4 + 4 );
				intraLeft.fill( ymode );

			} else {

				for ( let y = 0; y < 4; y ++ ) {

					let m = intraLeft[ y ];

					for ( let x = 0; x < 4; x ++ ) {

						const pr = ( intraTop[ mbx * 4 + x ] * 10 + m ) * 9;
						const b = ( i ) => br.bit( BMODES_PROBA[ pr + i ] );
						m = ! b( 0 ) ? 0 : ! b( 1 ) ? 1 : ! b( 2 ) ? 2 : ! b( 3 ) ? ( ! b( 4 ) ? 3 : ! b( 5 ) ? 4 : 5 ) : ( ! b( 6 ) ? 6 : ! b( 7 ) ? 7 : ! b( 8 ) ? 8 : 9 );
						intraTop[ mbx * 4 + x ] = m;
						imodes[ y * 4 + x ] = m;

					}

					intraLeft[ y ] = m;

				}

			}

			const uvmode = ! br.bit( 142 ) ? 0 : ! br.bit( 114 ) ? 2 : br.bit( 183 ) ? 1 : 3;

			// residuals
			coeffs.fill( 0 );
			const q = quant[ seg ];
			const tnz = mbx * 9;
			let anyNonZero = false;

			if ( ! skip ) {

				let first = 0, type = 3;

				if ( ! isI4 ) {

					dc.fill( 0 );
					const ctx = topNz[ tnz + 8 ] + leftNz[ 8 ];
					const nz = getCoeffs( tokens, P, 1, ctx, q.y2[ 0 ], q.y2[ 1 ], 0, dc, 0 );
					topNz[ tnz + 8 ] = leftNz[ 8 ] = nz > 0 ? 1 : 0;
					transformWHT( dc, coeffs );
					first = 1;
					type = 0;

				}

				for ( let y = 0; y < 4; y ++ ) {

					for ( let x = 0; x < 4; x ++ ) {

						const ctx = topNz[ tnz + x ] + leftNz[ y ];
						const nz = getCoeffs( tokens, P, type, ctx, q.y1[ 0 ], q.y1[ 1 ], first, coeffs, ( y * 4 + x ) * 16 );
						topNz[ tnz + x ] = leftNz[ y ] = nz > first ? 1 : 0;

					}

				}

				for ( let ch = 0; ch < 2; ch ++ ) {

					for ( let y = 0; y < 2; y ++ ) {

						for ( let x = 0; x < 2; x ++ ) {

							const ctx = topNz[ tnz + 4 + ch * 2 + x ] + leftNz[ 4 + ch * 2 + y ];
							const nz = getCoeffs( tokens, P, 2, ctx, q.uv[ 0 ], q.uv[ 1 ], 0, coeffs, 256 + ch * 64 + ( y * 2 + x ) * 16 );
							topNz[ tnz + 4 + ch * 2 + x ] = leftNz[ 4 + ch * 2 + y ] = nz > 0 ? 1 : 0;

						}

					}

				}

				for ( let i = 0; i < 384; i ++ ) if ( coeffs[ i ] ) { anyNonZero = true; break; }

			} else {

				topNz.fill( 0, tnz, tnz + 8 );
				leftNz.fill( 0, 0, 8 );
				if ( ! isI4 ) topNz[ tnz + 8 ] = leftNz[ 8 ] = 0;

			}

			mbInfo[ mby * mbw + mbx ] = { seg, inner: isI4 || anyNonZero, isI4 };

			// reconstruction in the work buffers, with libwebp's edge values
			const yx = mbx * 16, yy = mby * 16;

			for ( let j = 0; j < 16; j ++ ) ybuf[ YO - 1 + j * BPS ] = mbx > 0 ? Y[ ( yy + j ) * yStride + yx - 1 ] : 129;
			for ( let j = 0; j < 8; j ++ ) {

				ubuf[ UVO - 1 + j * BPS ] = mbx > 0 ? U[ ( mby * 8 + j ) * uvStride + mbx * 8 - 1 ] : 129;
				vbuf[ UVO - 1 + j * BPS ] = mbx > 0 ? V[ ( mby * 8 + j ) * uvStride + mbx * 8 - 1 ] : 129;

			}

			if ( mby > 0 ) {

				ybuf.set( Y.subarray( ( yy - 1 ) * yStride + yx, ( yy - 1 ) * yStride + yx + 16 ), YO - BPS );
				ubuf.set( U.subarray( ( mby * 8 - 1 ) * uvStride + mbx * 8, ( mby * 8 - 1 ) * uvStride + mbx * 8 + 8 ), UVO - BPS );
				vbuf.set( V.subarray( ( mby * 8 - 1 ) * uvStride + mbx * 8, ( mby * 8 - 1 ) * uvStride + mbx * 8 + 8 ), UVO - BPS );
				ybuf[ YO - BPS - 1 ] = mbx > 0 ? Y[ ( yy - 1 ) * yStride + yx - 1 ] : 129;
				ubuf[ UVO - BPS - 1 ] = mbx > 0 ? U[ ( mby * 8 - 1 ) * uvStride + mbx * 8 - 1 ] : 129;
				vbuf[ UVO - BPS - 1 ] = mbx > 0 ? V[ ( mby * 8 - 1 ) * uvStride + mbx * 8 - 1 ] : 129;

				// top right: the next macroblock's top row, or a copy of the last top pixel at the right edge
				for ( let i = 0; i < 4; i ++ ) ybuf[ YO - BPS + 16 + i ] = mbx < mbw - 1 ? Y[ ( yy - 1 ) * yStride + yx + 16 + i ] : Y[ ( yy - 1 ) * yStride + yx + 15 ];

			} else {

				ybuf.fill( 127, YO - BPS - 1, YO - BPS + 20 );
				ubuf.fill( 127, UVO - BPS - 1, UVO - BPS + 8 );
				vbuf.fill( 127, UVO - BPS - 1, UVO - BPS + 8 );

			}

			if ( isI4 ) {

				// sub-blocks in the right column use the macroblock's top right pixels
				for ( let r = 1; r < 4; r ++ ) for ( let i = 0; i < 4; i ++ ) ybuf[ YO + ( r * 4 - 1 ) * BPS + 16 + i ] = ybuf[ YO - BPS + 16 + i ];

				for ( let n = 0; n < 16; n ++ ) {

					predict4( imodes[ n ], ybuf, YO + SCAN[ n ] );
					if ( ! skip ) transformAdd( coeffs, n * 16, ybuf, YO + SCAN[ n ] );

				}

			} else {

				const m = checkMode( mbx, mby, ymode );
				predictBlock( m.mode, ybuf, YO, 16, m.hasTop, m.hasLeft );
				if ( ! skip ) for ( let n = 0; n < 16; n ++ ) transformAdd( coeffs, n * 16, ybuf, YO + SCAN[ n ] );

			}

			const um = checkMode( mbx, mby, uvmode );
			predictBlock( um.mode, ubuf, UVO, 8, um.hasTop, um.hasLeft );
			predictBlock( um.mode, vbuf, UVO, 8, um.hasTop, um.hasLeft );

			if ( ! skip ) {

				for ( let n = 0; n < 4; n ++ ) {

					const off = UVO + ( n & 1 ) * 4 + ( n >> 1 ) * 4 * BPS;
					transformAdd( coeffs, 256 + n * 16, ubuf, off );
					transformAdd( coeffs, 320 + n * 16, vbuf, off );

				}

			}

			for ( let j = 0; j < 16; j ++ ) Y.set( ybuf.subarray( YO + j * BPS, YO + j * BPS + 16 ), ( yy + j ) * yStride + yx );
			for ( let j = 0; j < 8; j ++ ) {

				U.set( ubuf.subarray( UVO + j * BPS, UVO + j * BPS + 8 ), ( mby * 8 + j ) * uvStride + mbx * 8 );
				V.set( vbuf.subarray( UVO + j * BPS, UVO + j * BPS + 8 ), ( mby * 8 + j ) * uvStride + mbx * 8 );

			}

		}

	}

	if ( filterType ) {

		for ( let mby = 0; mby < mbh; mby ++ ) {

			for ( let mbx = 0; mbx < mbw; mbx ++ ) {

				const info = mbInfo[ mby * mbw + mbx ];
				const f = strengths[ info.seg ][ info.isI4 ? 1 : 0 ];
				if ( ! f.limit ) continue;
				filterMacroblock( filterType, f, info.inner, mbx, mby, Y, U, V, yStride, uvStride );

			}

		}

	}

	return { width, height, Y, U, V, yStride, uvStride };

}

// --- loop filter ---

const abs = Math.abs;
const sclip1 = ( v ) => ( v < - 128 ? - 128 : v > 127 ? 127 : v ); // [-1020, 1020] -> [-128, 127]
const sclip2 = ( v ) => ( v < - 16 ? - 16 : v > 15 ? 15 : v ); // [-112, 112] -> [-16, 15]

function doFilter2( p, i, step ) {

	const p1 = p[ i - 2 * step ], p0 = p[ i - step ], q0 = p[ i ], q1 = p[ i + step ];
	const a = 3 * ( q0 - p0 ) + sclip1( p1 - q1 );
	const a1 = sclip2( ( a + 4 ) >> 3 );
	const a2 = sclip2( ( a + 3 ) >> 3 );
	p[ i - step ] = clip8( p0 + a2 );
	p[ i ] = clip8( q0 - a1 );

}

function doFilter4( p, i, step ) {

	const p1 = p[ i - 2 * step ], p0 = p[ i - step ], q0 = p[ i ], q1 = p[ i + step ];
	const a = 3 * ( q0 - p0 );
	const a1 = sclip2( ( a + 4 ) >> 3 );
	const a2 = sclip2( ( a + 3 ) >> 3 );
	const a3 = ( a1 + 1 ) >> 1;
	p[ i - 2 * step ] = clip8( p1 + a3 );
	p[ i - step ] = clip8( p0 + a2 );
	p[ i ] = clip8( q0 - a1 );
	p[ i + step ] = clip8( q1 - a3 );

}

function doFilter6( p, i, step ) {

	const p2 = p[ i - 3 * step ], p1 = p[ i - 2 * step ], p0 = p[ i - step ];
	const q0 = p[ i ], q1 = p[ i + step ], q2 = p[ i + 2 * step ];
	const a = sclip1( 3 * ( q0 - p0 ) + sclip1( p1 - q1 ) );
	const a1 = ( 27 * a + 63 ) >> 7;
	const a2 = ( 18 * a + 63 ) >> 7;
	const a3 = ( 9 * a + 63 ) >> 7;
	p[ i - 3 * step ] = clip8( p2 + a3 );
	p[ i - 2 * step ] = clip8( p1 + a2 );
	p[ i - step ] = clip8( p0 + a1 );
	p[ i ] = clip8( q0 - a1 );
	p[ i + step ] = clip8( q1 - a2 );
	p[ i + 2 * step ] = clip8( q2 - a3 );

}

function needsFilter( p, i, step, t ) {

	return 4 * abs( p[ i - step ] - p[ i ] ) + abs( p[ i - 2 * step ] - p[ i + step ] ) <= t;

}

function needsFilter2( p, i, step, t, it ) {

	const p3 = p[ i - 4 * step ], p2 = p[ i - 3 * step ], p1 = p[ i - 2 * step ], p0 = p[ i - step ];
	const q0 = p[ i ], q1 = p[ i + step ], q2 = p[ i + 2 * step ], q3 = p[ i + 3 * step ];
	if ( 4 * abs( p0 - q0 ) + abs( p1 - q1 ) > t ) return false;
	return abs( p3 - p2 ) <= it && abs( p2 - p1 ) <= it && abs( p1 - p0 ) <= it && abs( q3 - q2 ) <= it && abs( q2 - q1 ) <= it && abs( q1 - q0 ) <= it;

}

function hev( p, i, step, t ) {

	return abs( p[ i - 2 * step ] - p[ i - step ] ) > t || abs( p[ i + step ] - p[ i ] ) > t;

}

// hstride: step across the edge; vstride: step along it
function simpleFilter( p, start, hstride, vstride, size, thresh ) {

	const t = 2 * thresh + 1;
	for ( let k = 0, i = start; k < size; k ++, i += vstride ) if ( needsFilter( p, i, hstride, t ) ) doFilter2( p, i, hstride );

}

function filterLoop( p, start, hstride, vstride, size, thresh, ithresh, hevThresh, wide ) {

	const t = 2 * thresh + 1;

	for ( let k = 0, i = start; k < size; k ++, i += vstride ) {

		if ( ! needsFilter2( p, i, hstride, t, ithresh ) ) continue;
		if ( hev( p, i, hstride, hevThresh ) ) doFilter2( p, i, hstride );
		else if ( wide ) doFilter6( p, i, hstride );
		else doFilter4( p, i, hstride );

	}

}

function filterMacroblock( type, f, inner, mbx, mby, Y, U, V, ys, uvs ) {

	const y0 = mby * 16 * ys + mbx * 16;
	const limit = f.limit;

	if ( type === 1 ) {

		if ( mbx > 0 ) simpleFilter( Y, y0, 1, ys, 16, limit + 4 );
		if ( inner ) for ( let k = 4; k < 16; k += 4 ) simpleFilter( Y, y0 + k, 1, ys, 16, limit );
		if ( mby > 0 ) simpleFilter( Y, y0, ys, 1, 16, limit + 4 );
		if ( inner ) for ( let k = 4; k < 16; k += 4 ) simpleFilter( Y, y0 + k * ys, ys, 1, 16, limit );
		return;

	}

	const uv0 = mby * 8 * uvs + mbx * 8;
	const { ilevel, hev: h } = f;

	if ( mbx > 0 ) {

		filterLoop( Y, y0, 1, ys, 16, limit + 4, ilevel, h, true );
		filterLoop( U, uv0, 1, uvs, 8, limit + 4, ilevel, h, true );
		filterLoop( V, uv0, 1, uvs, 8, limit + 4, ilevel, h, true );

	}

	if ( inner ) {

		for ( let k = 4; k < 16; k += 4 ) filterLoop( Y, y0 + k, 1, ys, 16, limit, ilevel, h, false );
		filterLoop( U, uv0 + 4, 1, uvs, 8, limit, ilevel, h, false );
		filterLoop( V, uv0 + 4, 1, uvs, 8, limit, ilevel, h, false );

	}

	if ( mby > 0 ) {

		filterLoop( Y, y0, ys, 1, 16, limit + 4, ilevel, h, true );
		filterLoop( U, uv0, uvs, 1, 8, limit + 4, ilevel, h, true );
		filterLoop( V, uv0, uvs, 1, 8, limit + 4, ilevel, h, true );

	}

	if ( inner ) {

		for ( let k = 4; k < 16; k += 4 ) filterLoop( Y, y0 + k * ys, ys, 1, 16, limit, ilevel, h, false );
		filterLoop( U, uv0 + 4 * uvs, uvs, 1, 8, limit, ilevel, h, false );
		filterLoop( V, uv0 + 4 * uvs, uvs, 1, 8, limit, ilevel, h, false );

	}

}

// --- colour conversion with libwebp's fancy upsampling ---

const multHi = ( v, c ) => ( v * c ) >> 8;
const clipRGB = ( v ) => ( ( v & ~16383 ) === 0 ? v >> 6 : v < 0 ? 0 : 255 );

function yuvToRGB( { width, height, Y, U, V, yStride, uvStride }, channels ) {

	const out = new Uint8Array( width * height * channels );
	if ( channels === 4 ) for ( let i = 3; i < out.length; i += 4 ) out[ i ] = 255;

	const put = ( row, x, y, u, v ) => {

		const o = ( row * width + x ) * channels;
		const yy = multHi( y, 19077 );
		out[ o ] = clipRGB( yy + multHi( v, 26149 ) - 14234 );
		out[ o + 1 ] = clipRGB( yy - multHi( u, 6419 ) - multHi( v, 13320 ) + 8708 );
		out[ o + 2 ] = clipRGB( yy + multHi( u, 33050 ) - 17685 );

	};

	// one pair of output rows: top uses chroma rows (tu, cu) weighted toward tu, bottom toward cu
	const pair = ( topRow, bottomRow, tu, cu ) => {

		const tyo = topRow * yStride, byo = bottomRow * yStride;
		const tuo = tu * uvStride, cuo = cu * uvStride;
		const last = ( width - 1 ) >> 1;
		let tlU = U[ tuo ], tlV = V[ tuo ], lU = U[ cuo ], lV = V[ cuo ];

		put( topRow, 0, Y[ tyo ], ( 3 * tlU + lU + 2 ) >> 2, ( 3 * tlV + lV + 2 ) >> 2 );
		if ( bottomRow >= 0 ) put( bottomRow, 0, Y[ byo ], ( 3 * lU + tlU + 2 ) >> 2, ( 3 * lV + tlV + 2 ) >> 2 );

		for ( let x = 1; x <= last; x ++ ) {

			const tU = U[ tuo + x ], tV = V[ tuo + x ], cU = U[ cuo + x ], cV = V[ cuo + x ];
			const avgU = tlU + tU + lU + cU + 8, avgV = tlV + tV + lV + cV + 8;
			const d12U = ( avgU + 2 * ( tU + lU ) ) >> 3, d12V = ( avgV + 2 * ( tV + lV ) ) >> 3;
			const d03U = ( avgU + 2 * ( tlU + cU ) ) >> 3, d03V = ( avgV + 2 * ( tlV + cV ) ) >> 3;

			put( topRow, 2 * x - 1, Y[ tyo + 2 * x - 1 ], ( d12U + tlU ) >> 1, ( d12V + tlV ) >> 1 );
			put( topRow, 2 * x, Y[ tyo + 2 * x ], ( d03U + tU ) >> 1, ( d03V + tV ) >> 1 );

			if ( bottomRow >= 0 ) {

				put( bottomRow, 2 * x - 1, Y[ byo + 2 * x - 1 ], ( d03U + lU ) >> 1, ( d03V + lV ) >> 1 );
				put( bottomRow, 2 * x, Y[ byo + 2 * x ], ( d12U + cU ) >> 1, ( d12V + cV ) >> 1 );

			}

			tlU = tU; tlV = tV; lU = cU; lV = cV;

		}

		if ( ! ( width & 1 ) ) {

			put( topRow, width - 1, Y[ tyo + width - 1 ], ( 3 * tlU + lU + 2 ) >> 2, ( 3 * tlV + lV + 2 ) >> 2 );
			if ( bottomRow >= 0 ) put( bottomRow, width - 1, Y[ byo + width - 1 ], ( 3 * lU + tlU + 2 ) >> 2, ( 3 * lV + tlV + 2 ) >> 2 );

		}

	};

	pair( 0, - 1, 0, 0 );
	for ( let k = 1; 2 * k - 1 < height; k ++ ) {

		if ( 2 * k < height ) pair( 2 * k - 1, 2 * k, k - 1, k );
		else pair( 2 * k - 1, - 1, k - 1, k - 1 );

	}

	return out;

}
