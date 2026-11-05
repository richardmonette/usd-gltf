// PNG decoder (all color types, bit depths and Adam7 interlacing) and encoder (8 or 16 bit, adaptive filtering).
// https://www.w3.org/TR/png/

import { crc32 } from '../util/crc32.js';
import { inflateZlib } from './inflate.js';
import { deflateZlib } from './deflate.js';

const SIGNATURE = new Uint8Array( [ 137, 80, 78, 71, 13, 10, 26, 10 ] );

const IHDR = 0x49484452;
const PLTE = 0x504C5445;
const IDAT = 0x49444154;
const IEND = 0x49454E44;
const TRNS = 0x74524E53;

// samples per pixel for each color type
const SAMPLES = [ 1, 0, 3, 1, 2, 0, 4 ];

// x0, y0, dx, dy of the seven Adam7 passes
const ADAM7 = [
	[ 0, 0, 8, 8 ],
	[ 4, 0, 8, 8 ],
	[ 0, 4, 4, 8 ],
	[ 2, 0, 4, 4 ],
	[ 0, 2, 2, 4 ],
	[ 1, 0, 2, 2 ],
	[ 0, 1, 1, 2 ],
];

const NO_INTERLACE = [ [ 0, 0, 1, 1 ] ];

function toBytes( data ) {

	return data instanceof Uint8Array ? data : new Uint8Array( data.buffer || data, data.byteOffset || 0, data.byteLength );

}

function passSize( size, start, step ) {

	return size > start ? Math.ceil( ( size - start ) / step ) : 0;

}

// Reverses the PNG filter of one row in place. prev < 0 means the row above is all zeros.
function unfilterRow( raw, row, prev, rowBytes, bpp ) {

	const filter = raw[ row ];
	const p = row + 1;
	const q = prev + 1;

	switch ( filter ) {

		case 0:
			break;

		case 1:
			for ( let i = bpp; i < rowBytes; i ++ ) raw[ p + i ] += raw[ p + i - bpp ];
			break;

		case 2:
			if ( prev >= 0 ) for ( let i = 0; i < rowBytes; i ++ ) raw[ p + i ] += raw[ q + i ];
			break;

		case 3:
			if ( prev >= 0 ) {

				for ( let i = 0; i < bpp; i ++ ) raw[ p + i ] += raw[ q + i ] >> 1;
				for ( let i = bpp; i < rowBytes; i ++ ) raw[ p + i ] += ( raw[ p + i - bpp ] + raw[ q + i ] ) >> 1;

			} else {

				for ( let i = bpp; i < rowBytes; i ++ ) raw[ p + i ] += raw[ p + i - bpp ] >> 1;

			}

			break;

		case 4:
			if ( prev >= 0 ) {

				for ( let i = 0; i < bpp; i ++ ) raw[ p + i ] += raw[ q + i ];

				for ( let i = bpp; i < rowBytes; i ++ ) {

					const a = raw[ p + i - bpp ];
					const b = raw[ q + i ];
					const c = raw[ q + i - bpp ];
					const pa = b > c ? b - c : c - b;
					const pb = a > c ? a - c : c - a;
					const pc = Math.abs( a + b - c - c );
					raw[ p + i ] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;

				}

			} else {

				for ( let i = bpp; i < rowBytes; i ++ ) raw[ p + i ] += raw[ p + i - bpp ];

			}

			break;

		default:
			throw new Error( `usd-gltf: invalid PNG filter type ${ filter }` );

	}

}

/**
 * Decodes a PNG. Palette images expand to RGB(A), tRNS color keys become an alpha channel,
 * 1, 2 and 4 bit grayscale is scaled to 8 bits, 16 bit images stay 16 bit.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{ width: number, height: number, channels: number, bitDepth: number, data: Uint8Array|Uint16Array }}
 */
export function decodePNG( bytes ) {

	bytes = toBytes( bytes );

	for ( let i = 0; i < 8; i ++ ) {

		if ( bytes[ i ] !== SIGNATURE[ i ] ) throw new Error( 'usd-gltf: not a PNG file' );

	}

	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	let width = 0, height = 0, bitDepth = 0, colorType = - 1, interlace = 0;
	let palette = null, trns = null;
	const idat = [];
	let idatLength = 0;
	let offset = 8;

	while ( offset + 8 <= bytes.length ) {

		const length = view.getUint32( offset );
		const type = view.getUint32( offset + 4 );
		const start = offset + 8;
		const end = start + length;
		if ( end > bytes.length ) throw new Error( 'usd-gltf: truncated PNG chunk' );

		if ( type === IHDR ) {

			width = view.getUint32( start );
			height = view.getUint32( start + 4 );
			bitDepth = bytes[ start + 8 ];
			colorType = bytes[ start + 9 ];
			interlace = bytes[ start + 12 ];

		} else if ( type === PLTE ) {

			palette = bytes.subarray( start, end );

		} else if ( type === TRNS ) {

			trns = bytes.subarray( start, end );

		} else if ( type === IDAT ) {

			idat.push( bytes.subarray( start, end ) );
			idatLength += length;

		} else if ( type === IEND ) {

			break;

		}

		offset = end + 4; // skip CRC

	}

	const samples = SAMPLES[ colorType ] || 0;
	const validDepth = colorType === 0 ? [ 1, 2, 4, 8, 16 ].includes( bitDepth )
		: colorType === 3 ? [ 1, 2, 4, 8 ].includes( bitDepth )
			: bitDepth === 8 || bitDepth === 16;

	if ( width === 0 || height === 0 || samples === 0 || ! validDepth ) {

		throw new Error( `usd-gltf: unsupported PNG (color type ${ colorType }, bit depth ${ bitDepth })` );

	}

	if ( colorType === 3 && palette === null ) throw new Error( 'usd-gltf: PNG palette missing' );
	if ( idat.length === 0 ) throw new Error( 'usd-gltf: PNG has no image data' );
	if ( interlace > 1 ) throw new Error( 'usd-gltf: unknown PNG interlace method' );

	// tRNS for gray and RGB is a single color key
	if ( trns !== null && ( colorType === 4 || colorType === 6 || ( colorType === 0 && trns.length < 2 ) || ( colorType === 2 && trns.length < 6 ) ) ) trns = null;

	let zdata;

	if ( idat.length === 1 ) {

		zdata = idat[ 0 ];

	} else {

		zdata = new Uint8Array( idatLength );
		let p = 0;
		for ( const chunk of idat ) {

			zdata.set( chunk, p );
			p += chunk.length;

		}

	}

	const bitsPerPixel = samples * bitDepth;
	const bpp = Math.max( 1, bitsPerPixel >> 3 );
	const passes = interlace ? ADAM7 : NO_INTERLACE;

	let expected = 0;
	for ( const [ x0, y0, dx, dy ] of passes ) {

		const pw = passSize( width, x0, dx );
		const ph = passSize( height, y0, dy );
		if ( pw > 0 ) expected += ( Math.ceil( pw * bitsPerPixel / 8 ) + 1 ) * ph;

	}

	const raw = inflateZlib( zdata, expected );
	if ( raw.length < expected ) throw new Error( 'usd-gltf: PNG image data is truncated' );

	const channels = colorType === 3 ? ( trns !== null ? 4 : 3 ) : samples + ( trns !== null ? 1 : 0 );
	const outDepth = bitDepth === 16 ? 16 : 8;
	const count = width * height * channels;
	const data = outDepth === 16 ? new Uint16Array( count ) : new Uint8Array( count );

	let rowStart = 0;

	for ( const [ x0, y0, dx, dy ] of passes ) {

		const pw = passSize( width, x0, dx );
		const ph = passSize( height, y0, dy );
		if ( pw === 0 || ph === 0 ) continue;

		const rowBytes = Math.ceil( pw * bitsPerPixel / 8 );
		let prev = - 1;

		for ( let y = 0; y < ph; y ++ ) {

			unfilterRow( raw, rowStart, prev, rowBytes, bpp );
			expandRow( raw, rowStart + 1, data, ( ( y0 + y * dy ) * width + x0 ) * channels, dx * channels, pw, colorType, bitDepth, channels, palette, trns );
			prev = rowStart;
			rowStart += rowBytes + 1;

		}

	}

	return { width, height, channels, bitDepth: outDepth, data };

}

// Converts one unfiltered row of pw pixels starting at raw[ src ] into output samples at data[ dst ], dst advancing by step.
function expandRow( raw, src, data, dst, step, pw, colorType, bitDepth, channels, palette, trns ) {

	if ( colorType === 3 ) {

		const mask = ( 1 << bitDepth ) - 1;
		const ppb = 8 / bitDepth; // pixels per byte
		const entries = palette.length / 3;

		for ( let x = 0; x < pw; x ++, dst += step ) {

			const shift = 8 - bitDepth - ( x % ppb ) * bitDepth;
			const index = ( raw[ src + ( ( x * bitDepth ) >> 3 ) ] >> shift ) & mask;
			const p = index < entries ? index * 3 : 0; // out of range indices read as entry 0
			data[ dst ] = palette[ p ];
			data[ dst + 1 ] = palette[ p + 1 ];
			data[ dst + 2 ] = palette[ p + 2 ];
			if ( channels === 4 ) data[ dst + 3 ] = index < trns.length ? trns[ index ] : 255;

		}

		return;

	}

	if ( bitDepth < 8 ) {

		const mask = ( 1 << bitDepth ) - 1;
		const scale = 255 / mask;
		const ppb = 8 / bitDepth;
		const key = trns !== null ? ( ( trns[ 0 ] << 8 ) | trns[ 1 ] ) & mask : - 1;

		for ( let x = 0; x < pw; x ++, dst += step ) {

			const shift = 8 - bitDepth - ( x % ppb ) * bitDepth;
			const v = ( raw[ src + ( ( x * bitDepth ) >> 3 ) ] >> shift ) & mask;
			data[ dst ] = v * scale;
			if ( channels === 2 ) data[ dst + 1 ] = v === key ? 0 : 255;

		}

		return;

	}

	const samples = SAMPLES[ colorType ];

	if ( bitDepth === 8 ) {

		if ( trns === null ) {

			if ( step === channels ) {

				data.set( raw.subarray( src, src + pw * channels ), dst );
				return;

			}

			for ( let x = 0; x < pw; x ++, dst += step, src += samples ) {

				for ( let c = 0; c < samples; c ++ ) data[ dst + c ] = raw[ src + c ];

			}

			return;

		}

		if ( samples === 1 ) {

			const key = trns[ 1 ];

			for ( let x = 0; x < pw; x ++, dst += step, src ++ ) {

				const v = raw[ src ];
				data[ dst ] = v;
				data[ dst + 1 ] = v === key ? 0 : 255;

			}

		} else {

			const kr = trns[ 1 ], kg = trns[ 3 ], kb = trns[ 5 ];

			for ( let x = 0; x < pw; x ++, dst += step, src += 3 ) {

				const r = raw[ src ], g = raw[ src + 1 ], b = raw[ src + 2 ];
				data[ dst ] = r;
				data[ dst + 1 ] = g;
				data[ dst + 2 ] = b;
				data[ dst + 3 ] = r === kr && g === kg && b === kb ? 0 : 255;

			}

		}

		return;

	}

	// 16 bit, big endian samples
	if ( trns === null ) {

		for ( let x = 0; x < pw; x ++, dst += step ) {

			for ( let c = 0; c < samples; c ++, src += 2 ) data[ dst + c ] = ( raw[ src ] << 8 ) | raw[ src + 1 ];

		}

		return;

	}

	const k0 = ( trns[ 0 ] << 8 ) | trns[ 1 ];
	const k1 = samples === 3 ? ( trns[ 2 ] << 8 ) | trns[ 3 ] : 0;
	const k2 = samples === 3 ? ( trns[ 4 ] << 8 ) | trns[ 5 ] : 0;

	for ( let x = 0; x < pw; x ++, dst += step ) {

		let opaque = false;

		for ( let c = 0; c < samples; c ++, src += 2 ) {

			const v = ( raw[ src ] << 8 ) | raw[ src + 1 ];
			data[ dst + c ] = v;
			if ( v !== ( c === 0 ? k0 : c === 1 ? k1 : k2 ) ) opaque = true;

		}

		data[ dst + samples ] = opaque ? 65535 : 0;

	}

}

const ABS = new Uint8Array( 256 );
for ( let i = 0; i < 256; i ++ ) ABS[ i ] = i < 128 ? i : 256 - i;

function paeth( a, b, c ) {

	const pa = b > c ? b - c : c - b;
	const pb = a > c ? a - c : c - a;
	const pc = Math.abs( a + b - c - c );
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;

}

// Picks the filter whose residuals have the smallest sum of absolute (signed) values.
// The row is src[ p .. ), the row above is above[ q .. ) (zeros for the first row).
function chooseFilter( src, p, above, q, rowBytes, bpp ) {

	let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;

	for ( let i = 0; i < bpp; i ++ ) {

		const x = src[ p + i ];
		const b = above[ q + i ];
		s0 += ABS[ x ];
		s2 += ABS[ ( x - b ) & 0xFF ];
		s3 += ABS[ ( x - ( b >> 1 ) ) & 0xFF ];

	}

	s1 = s0;
	s4 = s2;

	for ( let i = bpp; i < rowBytes; i ++ ) {

		const x = src[ p + i ];
		const a = src[ p + i - bpp ];
		const b = above[ q + i ];
		const c = above[ q + i - bpp ];
		s0 += ABS[ x ];
		s1 += ABS[ ( x - a ) & 0xFF ];
		s2 += ABS[ ( x - b ) & 0xFF ];
		s3 += ABS[ ( x - ( ( a + b ) >> 1 ) ) & 0xFF ];

		// paeth, inlined
		let pa = b - c;
		let pb = a - c;
		let pc = pa + pb;
		if ( pa < 0 ) pa = - pa;
		if ( pb < 0 ) pb = - pb;
		if ( pc < 0 ) pc = - pc;
		s4 += ABS[ ( x - ( pa <= pb && pa <= pc ? a : pb <= pc ? b : c ) ) & 0xFF ];

	}

	let filter = 0, best = s0;
	if ( s1 < best ) { filter = 1; best = s1; }
	if ( s2 < best ) { filter = 2; best = s2; }
	if ( s3 < best ) { filter = 3; best = s3; }
	if ( s4 < best ) filter = 4;
	return filter;

}

function applyFilter( filter, src, p, above, q, out, o, rowBytes, bpp ) {

	switch ( filter ) {

		case 0:
			out.set( src.subarray( p, p + rowBytes ), o );
			break;

		case 1:
			for ( let i = 0; i < bpp; i ++ ) out[ o + i ] = src[ p + i ];
			for ( let i = bpp; i < rowBytes; i ++ ) out[ o + i ] = src[ p + i ] - src[ p + i - bpp ];
			break;

		case 2:
			for ( let i = 0; i < rowBytes; i ++ ) out[ o + i ] = src[ p + i ] - above[ q + i ];
			break;

		case 3:
			for ( let i = 0; i < bpp; i ++ ) out[ o + i ] = src[ p + i ] - ( above[ q + i ] >> 1 );
			for ( let i = bpp; i < rowBytes; i ++ ) out[ o + i ] = src[ p + i ] - ( ( src[ p + i - bpp ] + above[ q + i ] ) >> 1 );
			break;

		case 4:
			for ( let i = 0; i < bpp; i ++ ) out[ o + i ] = src[ p + i ] - above[ q + i ];
			for ( let i = bpp; i < rowBytes; i ++ ) out[ o + i ] = src[ p + i ] - paeth( src[ p + i - bpp ], above[ q + i ], above[ q + i - bpp ] );
			break;

	}

}

function chunk( out, offset, type, payload ) {

	const view = new DataView( out.buffer, out.byteOffset );
	view.setUint32( offset, payload.length );
	view.setUint32( offset + 4, type );
	out.set( payload, offset + 8 );
	const crc = crc32( payload, crc32( out.subarray( offset + 4, offset + 8 ) ) );
	view.setUint32( offset + 8 + payload.length, crc );
	return offset + 12 + payload.length;

}

/**
 * Encodes pixels as a PNG. channels 1-4 map to gray, gray+alpha, RGB and RGBA.
 * @param {{ width: number, height: number, channels: number, data: Uint8Array|Uint16Array|Uint8ClampedArray, bitDepth?: number }} image
 * @param {{ level?: number }} [options] deflate level 0-9; the default 4 balances speed and size for large textures
 * @returns {Uint8Array}
 */
export function encodePNG( { width, height, channels, data, bitDepth = 8 }, { level = 4 } = {} ) {

	if ( ! ( channels >= 1 && channels <= 4 ) ) throw new Error( `usd-gltf: encodePNG cannot write ${ channels } channels` );
	if ( bitDepth !== 8 && bitDepth !== 16 ) throw new Error( `usd-gltf: encodePNG cannot write bit depth ${ bitDepth }` );
	if ( data.length < width * height * channels ) throw new Error( 'usd-gltf: encodePNG data is too short' );

	const bpp = channels * ( bitDepth >> 3 );
	const rowBytes = width * bpp;
	let src;

	if ( bitDepth === 16 ) {

		src = new Uint8Array( rowBytes * height );
		for ( let i = 0, n = width * height * channels; i < n; i ++ ) {

			const v = data[ i ];
			src[ 2 * i ] = v >> 8;
			src[ 2 * i + 1 ] = v & 0xFF;

		}

	} else {

		src = data instanceof Uint8Array ? data : new Uint8Array( data.buffer, data.byteOffset, width * height * channels );

	}

	const filtered = new Uint8Array( ( rowBytes + 1 ) * height );
	const zero = new Uint8Array( rowBytes );

	for ( let y = 0; y < height; y ++ ) {

		const p = y * rowBytes;
		const above = y > 0 ? src : zero;
		const q = y > 0 ? p - rowBytes : 0;
		const o = y * ( rowBytes + 1 );
		filtered[ o ] = chooseFilter( src, p, above, q, rowBytes, bpp );
		applyFilter( filtered[ o ], src, p, above, q, filtered, o + 1, rowBytes, bpp );

	}

	const idat = deflateZlib( filtered, level );

	const ihdr = new Uint8Array( 13 );
	const hv = new DataView( ihdr.buffer );
	hv.setUint32( 0, width );
	hv.setUint32( 4, height );
	ihdr[ 8 ] = bitDepth;
	ihdr[ 9 ] = [ 0, 0, 4, 2, 6 ][ channels ];

	const out = new Uint8Array( 8 + 25 + 12 + idat.length + 12 );
	out.set( SIGNATURE, 0 );
	let offset = chunk( out, 8, IHDR, ihdr );
	offset = chunk( out, offset, IDAT, idat );
	chunk( out, offset, IEND, new Uint8Array( 0 ) );

	return out;

}
