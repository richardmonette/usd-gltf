// Baseline and progressive (Huffman coded, 8 bit) JPEG decoder.
// The IDCT, chroma upsampling and color conversion follow libjpeg's defaults (islow IDCT, "fancy"
// triangle upsampling), so output is close to what libjpeg-turbo based tools produce.
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf

const ZIGZAG = new Uint8Array( [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
] );

function fail( message ) {

	return new Error( `usd-gltf: ${ message }` );

}

function buildHuffman( counts, symbols ) {

	// 9 bit lookahead: ( length << 8 ) | symbol, 0 when the code is longer
	const lookup = new Uint16Array( 512 );
	const maxcode = new Int32Array( 18 ).fill( - 1 );
	const valptr = new Int32Array( 17 );
	const mincode = new Int32Array( 17 );
	let code = 0;
	let k = 0;

	for ( let len = 1; len <= 16; len ++ ) {

		valptr[ len ] = k;
		mincode[ len ] = code;
		const n = counts[ len - 1 ];

		for ( let i = 0; i < n; i ++ ) {

			if ( len <= 9 ) {

				const base = code << ( 9 - len );
				const entry = ( len << 8 ) | symbols[ k ];
				for ( let j = 0; j < 1 << ( 9 - len ); j ++ ) lookup[ base + j ] = entry;

			}

			code ++;
			k ++;

		}

		if ( n ) maxcode[ len ] = code - 1;
		code <<= 1;

	}

	return { lookup, maxcode, valptr, mincode, symbols };

}

/**
 * Decodes a JPEG to 8 bit grayscale (1 channel) or RGB (3 channels, also for CMYK/YCCK input).
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{ width: number, height: number, channels: number, bitDepth: number, data: Uint8Array }}
 */
export function decodeJPEG( bytes ) {

	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array( bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength );
	if ( data[ 0 ] !== 0xFF || data[ 1 ] !== 0xD8 ) throw fail( 'not a JPEG file' );

	const quantTables = [];
	const dcTables = [];
	const acTables = [];
	let frame = null;
	let resetInterval = 0;
	let adobeTransform = - 1;
	let jfif = false;
	let offset = 2;
	const length = data.length;

	const u16 = ( p ) => ( data[ p ] << 8 ) | data[ p + 1 ];

	while ( offset < length ) {

		if ( data[ offset ] !== 0xFF ) {

			offset ++; // garbage between segments
			continue;

		}

		const marker = data[ offset + 1 ];
		offset += 2;

		if ( marker === 0xFF ) {

			offset --; // fill byte
			continue;

		}

		if ( marker === 0xD9 ) break; // EOI
		if ( marker === 0xD8 || marker === 0x01 || ( marker >= 0xD0 && marker <= 0xD7 ) || marker === 0x00 ) continue;

		const segLength = u16( offset );
		const start = offset + 2;
		const end = offset + segLength;
		if ( end > length ) throw fail( 'truncated JPEG segment' );

		switch ( marker ) {

			case 0xC0: // baseline
			case 0xC1: // extended sequential
			case 0xC2: // progressive
			{

				if ( frame !== null ) throw fail( 'JPEG has more than one frame' );
				const precision = data[ start ];
				if ( precision !== 8 ) throw fail( `${ precision } bit JPEG is not supported` );

				frame = {
					progressive: marker === 0xC2,
					height: u16( start + 1 ),
					width: u16( start + 3 ),
					components: [],
					hmax: 1,
					vmax: 1,
				};

				const n = data[ start + 5 ];
				for ( let i = 0; i < n; i ++ ) {

					const p = start + 6 + i * 3;
					const h = data[ p + 1 ] >> 4;
					const v = data[ p + 1 ] & 15;
					if ( h < 1 || h > 4 || v < 1 || v > 4 ) throw fail( 'invalid JPEG sampling factors' );
					frame.components.push( { id: data[ p ], h, v, tq: data[ p + 2 ] & 3 } );
					frame.hmax = Math.max( frame.hmax, h );
					frame.vmax = Math.max( frame.vmax, v );

				}

				if ( frame.width === 0 ) throw fail( 'JPEG has zero width' );
				if ( frame.height === 0 ) throw fail( 'JPEG with DNL defined height is not supported' );
				prepareComponents( frame );
				break;

			}

			case 0xC3: case 0xC5: case 0xC6: case 0xC7:
				throw fail( 'lossless and hierarchical JPEG are not supported' );

			case 0xC9: case 0xCA: case 0xCB: case 0xCD: case 0xCE: case 0xCF:
				throw fail( 'arithmetic coded JPEG is not supported' );

			case 0xC4: // DHT
			{

				let p = start;
				while ( p + 17 <= end ) {

					const tc = data[ p ] >> 4;
					const th = data[ p ] & 3;
					const counts = data.subarray( p + 1, p + 17 );
					let total = 0;
					for ( let i = 0; i < 16; i ++ ) total += counts[ i ];
					const symbols = data.slice( p + 17, p + 17 + total );
					( tc === 0 ? dcTables : acTables )[ th ] = buildHuffman( counts, symbols );
					p += 17 + total;

				}

				break;

			}

			case 0xDB: // DQT
			{

				let p = start;
				while ( p < end ) {

					const pq = data[ p ] >> 4;
					const tq = data[ p ] & 3;
					const table = new Uint16Array( 64 );
					p ++;

					for ( let k = 0; k < 64; k ++ ) {

						table[ ZIGZAG[ k ] ] = pq ? u16( p + 2 * k ) : data[ p + k ];

					}

					p += pq ? 128 : 64;
					quantTables[ tq ] = table;

				}

				break;

			}

			case 0xDD: // DRI
				resetInterval = u16( start );
				break;

			case 0xDA: // SOS
			{

				if ( frame === null ) throw fail( 'JPEG scan before frame header' );
				const n = data[ start ];
				const scanComponents = [];

				for ( let i = 0; i < n; i ++ ) {

					const id = data[ start + 1 + i * 2 ];
					const tables = data[ start + 2 + i * 2 ];
					const component = frame.components.find( ( c ) => c.id === id );
					if ( ! component ) throw fail( 'JPEG scan references an unknown component' );
					component.dcTable = dcTables[ tables >> 4 ];
					component.acTable = acTables[ tables & 15 ];
					scanComponents.push( component );

				}

				const p = start + 1 + n * 2;
				const ss = data[ p ];
				const se = data[ p + 1 ];
				const ah = data[ p + 2 ] >> 4;
				const al = data[ p + 2 ] & 15;

				offset = decodeScan( data, end, frame, scanComponents, resetInterval, ss, se, ah, al );
				continue;

			}

			case 0xE0: // APP0
				if ( data[ start ] === 0x4A && data[ start + 1 ] === 0x46 && data[ start + 2 ] === 0x49 && data[ start + 3 ] === 0x46 && data[ start + 4 ] === 0 ) jfif = true;
				break;

			case 0xEE: // APP14
				if ( data[ start ] === 0x41 && data[ start + 1 ] === 0x64 && data[ start + 2 ] === 0x6F && data[ start + 3 ] === 0x62 && data[ start + 4 ] === 0x65 ) {

					adobeTransform = data[ start + 11 ];

				}

				break;

			default:
				break;

		}

		offset = end;

	}

	if ( frame === null ) throw fail( 'JPEG has no frame' );

	return buildImage( frame, quantTables, adobeTransform, jfif );

}

function prepareComponents( frame ) {

	const { width, height, hmax, vmax } = frame;
	frame.mcusPerLine = Math.ceil( width / ( 8 * hmax ) );
	frame.mcusPerColumn = Math.ceil( height / ( 8 * vmax ) );

	for ( const c of frame.components ) {

		c.width = Math.ceil( width * c.h / hmax );
		c.height = Math.ceil( height * c.v / vmax );
		c.blocksPerLine = Math.ceil( c.width / 8 );
		c.blocksPerColumn = Math.ceil( c.height / 8 );
		c.blocksPerLineForMcu = frame.mcusPerLine * c.h;
		c.blocksPerColumnForMcu = frame.mcusPerColumn * c.v;
		c.coefs = new Int16Array( c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64 );
		c.pred = 0;

	}

}

// Decodes one scan's entropy coded data starting at `offset`; returns the offset of the marker that follows.
function decodeScan( data, offset, frame, components, resetInterval, ss, se, ah, al ) {

	const length = data.length;
	let pos = offset;
	let bitBuf = 0;
	let bitCnt = 0;
	let eobrun = 0;

	function fill() {

		while ( bitCnt <= 24 ) {

			let b = 0;

			if ( pos < length ) {

				b = data[ pos ];

				if ( b === 0xFF ) {

					// stuffed zero, otherwise a marker: feed zeros without moving past it
					if ( data[ pos + 1 ] === 0 ) pos += 2;
					else b = 0;

				} else {

					pos ++;

				}

			}

			bitBuf = ( bitBuf << 8 ) | b;
			bitCnt += 8;

		}

	}

	function bits( n ) {

		if ( bitCnt < n ) fill();
		bitCnt -= n;
		return ( bitBuf >>> bitCnt ) & ( ( 1 << n ) - 1 );

	}

	function bit() {

		if ( bitCnt < 1 ) fill();
		bitCnt --;
		return ( bitBuf >>> bitCnt ) & 1;

	}

	function decodeHuffman( table ) {

		if ( bitCnt < 16 ) fill();
		const e = table.lookup[ ( bitBuf >>> ( bitCnt - 9 ) ) & 511 ];

		if ( e !== 0 ) {

			bitCnt -= e >> 8;
			return e & 255;

		}

		const code = ( bitBuf >>> ( bitCnt - 16 ) ) & 0xFFFF;

		for ( let len = 10; len <= 16; len ++ ) {

			const c = code >>> ( 16 - len );

			if ( c <= table.maxcode[ len ] ) {

				bitCnt -= len;
				return table.symbols[ table.valptr[ len ] + c - table.mincode[ len ] ];

			}

		}

		// corrupt data: skip a bit and carry on, as libjpeg does
		bitCnt --;
		return 0;

	}

	function receiveExtend( s ) {

		if ( s === 0 ) return 0;
		if ( s > 16 ) s = 16;
		const v = bits( s );
		return v < 1 << ( s - 1 ) ? v - ( 1 << s ) + 1 : v;

	}

	function decodeBaseline( c, off ) {

		const coefs = c.coefs;
		const t = decodeHuffman( c.dcTable );
		c.pred += receiveExtend( t );
		coefs[ off ] = c.pred;

		const ac = c.acTable;
		for ( let k = 1; k < 64; ) {

			const rs = decodeHuffman( ac );
			const s = rs & 15;
			const r = rs >> 4;

			if ( s === 0 ) {

				if ( r < 15 ) break;
				k += 16;
				continue;

			}

			k += r;
			if ( k > 63 ) break;
			coefs[ off + ZIGZAG[ k ] ] = receiveExtend( s );
			k ++;

		}

	}

	function decodeDCFirst( c, off ) {

		const t = decodeHuffman( c.dcTable );
		c.pred += receiveExtend( t );
		c.coefs[ off ] = c.pred * ( 1 << al );

	}

	function decodeDCRefine( c, off ) {

		if ( bit() ) c.coefs[ off ] |= 1 << al;

	}

	function decodeACFirst( c, off ) {

		if ( eobrun > 0 ) {

			eobrun --;
			return;

		}

		const coefs = c.coefs;
		const ac = c.acTable;

		for ( let k = ss; k <= se; ) {

			const rs = decodeHuffman( ac );
			const s = rs & 15;
			const r = rs >> 4;

			if ( s === 0 ) {

				if ( r < 15 ) {

					eobrun = ( 1 << r ) - 1;
					if ( r ) eobrun += bits( r );
					break;

				}

				k += 16;
				continue;

			}

			k += r;
			if ( k > 63 ) break;
			coefs[ off + ZIGZAG[ k ] ] = receiveExtend( s ) * ( 1 << al );
			k ++;

		}

	}

	function decodeACRefine( c, off ) {

		const coefs = c.coefs;
		const p1 = 1 << al;
		const m1 = - 1 << al;
		let k = ss;

		if ( eobrun === 0 ) {

			const ac = c.acTable;

			for ( ; k <= se; k ++ ) {

				const rs = decodeHuffman( ac );
				let r = rs >> 4;
				let s = rs & 15;

				if ( s !== 0 ) {

					s = bit() ? p1 : m1;

				} else if ( r !== 15 ) {

					eobrun = 1 << r;
					if ( r ) eobrun += bits( r );
					break;

				}

				// advance over r zero coefficients, refining the nonzero ones passed on the way
				while ( k <= se ) {

					const z = off + ZIGZAG[ k ];

					if ( coefs[ z ] !== 0 ) {

						if ( bit() && ( coefs[ z ] & p1 ) === 0 ) coefs[ z ] += coefs[ z ] >= 0 ? p1 : m1;

					} else {

						if ( r === 0 ) break;
						r --;

					}

					k ++;

				}

				if ( s !== 0 && k <= se ) coefs[ off + ZIGZAG[ k ] ] = s;

			}

		}

		if ( eobrun > 0 ) {

			for ( ; k <= se; k ++ ) {

				const z = off + ZIGZAG[ k ];
				if ( coefs[ z ] !== 0 && bit() && ( coefs[ z ] & p1 ) === 0 ) coefs[ z ] += coefs[ z ] >= 0 ? p1 : m1;

			}

			eobrun --;

		}

	}

	let decode;

	if ( ! frame.progressive ) decode = decodeBaseline;
	else if ( ss === 0 ) decode = ah === 0 ? decodeDCFirst : decodeDCRefine;
	else decode = ah === 0 ? decodeACFirst : decodeACRefine;

	const single = components.length === 1;
	const c0 = components[ 0 ];
	const mcusPerLine = single ? c0.blocksPerLine : frame.mcusPerLine;
	const total = single ? c0.blocksPerLine * c0.blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
	let mcu = 0;

	while ( mcu < total ) {

		for ( const c of components ) c.pred = 0;
		eobrun = 0;
		const stop = resetInterval ? Math.min( mcu + resetInterval, total ) : total;

		for ( ; mcu < stop; mcu ++ ) {

			const row = ( mcu / mcusPerLine ) | 0;
			const col = mcu - row * mcusPerLine;

			if ( single ) {

				decode( c0, ( row * c0.blocksPerLineForMcu + col ) * 64 );

			} else {

				for ( let i = 0; i < components.length; i ++ ) {

					const c = components[ i ];

					for ( let v = 0; v < c.v; v ++ ) {

						for ( let h = 0; h < c.h; h ++ ) {

							decode( c, ( ( row * c.v + v ) * c.blocksPerLineForMcu + col * c.h + h ) * 64 );

						}

					}

				}

			}

		}

		if ( mcu >= total ) break;

		// expect a restart marker; resynchronize on it
		bitCnt = 0;
		bitBuf = 0;
		while ( pos + 1 < length && ! ( data[ pos ] === 0xFF && data[ pos + 1 ] !== 0 && data[ pos + 1 ] !== 0xFF ) ) pos ++;
		if ( pos + 1 >= length ) break;
		const m = data[ pos + 1 ];
		if ( m < 0xD0 || m > 0xD7 ) break; // some other marker: the scan ended early
		pos += 2;

	}

	// find the marker that ends the scan
	while ( pos + 1 < length && ! ( data[ pos ] === 0xFF && data[ pos + 1 ] !== 0 && data[ pos + 1 ] !== 0xFF && ( data[ pos + 1 ] < 0xD0 || data[ pos + 1 ] > 0xD7 ) ) ) pos ++;
	return pos;

}

// libjpeg's jidctint (islow) integer IDCT with dequantization, writing 8x8 samples into out.
function idctBlock( coefs, off, qt, out, outOff, stride, ws ) {

	for ( let c = 0; c < 8; c ++ ) {

		const i = off + c;

		if ( coefs[ i + 8 ] === 0 && coefs[ i + 16 ] === 0 && coefs[ i + 24 ] === 0 && coefs[ i + 32 ] === 0 &&
			coefs[ i + 40 ] === 0 && coefs[ i + 48 ] === 0 && coefs[ i + 56 ] === 0 ) {

			const dc = coefs[ i ] * qt[ c ] * 4;
			ws[ c ] = dc; ws[ c + 8 ] = dc; ws[ c + 16 ] = dc; ws[ c + 24 ] = dc;
			ws[ c + 32 ] = dc; ws[ c + 40 ] = dc; ws[ c + 48 ] = dc; ws[ c + 56 ] = dc;
			continue;

		}

		// even part
		let z2 = coefs[ i + 16 ] * qt[ c + 16 ];
		let z3 = coefs[ i + 48 ] * qt[ c + 48 ];
		let z1 = ( z2 + z3 ) * 4433;
		let tmp2 = z1 - z3 * 15137;
		let tmp3 = z1 + z2 * 6270;
		z2 = coefs[ i ] * qt[ c ];
		z3 = coefs[ i + 32 ] * qt[ c + 32 ];
		let tmp0 = ( z2 + z3 ) * 8192;
		let tmp1 = ( z2 - z3 ) * 8192;
		const tmp10 = tmp0 + tmp3;
		const tmp13 = tmp0 - tmp3;
		const tmp11 = tmp1 + tmp2;
		const tmp12 = tmp1 - tmp2;

		// odd part
		tmp0 = coefs[ i + 56 ] * qt[ c + 56 ];
		tmp1 = coefs[ i + 40 ] * qt[ c + 40 ];
		tmp2 = coefs[ i + 24 ] * qt[ c + 24 ];
		tmp3 = coefs[ i + 8 ] * qt[ c + 8 ];
		z1 = tmp0 + tmp3;
		z2 = tmp1 + tmp2;
		z3 = tmp0 + tmp2;
		let z4 = tmp1 + tmp3;
		const z5 = ( z3 + z4 ) * 9633;
		tmp0 *= 2446;
		tmp1 *= 16819;
		tmp2 *= 25172;
		tmp3 *= 12299;
		z1 *= - 7373;
		z2 *= - 20995;
		z3 = z3 * - 16069 + z5;
		z4 = z4 * - 3196 + z5;
		tmp0 += z1 + z3;
		tmp1 += z2 + z4;
		tmp2 += z2 + z3;
		tmp3 += z1 + z4;

		ws[ c ] = ( tmp10 + tmp3 + 1024 ) >> 11;
		ws[ c + 56 ] = ( tmp10 - tmp3 + 1024 ) >> 11;
		ws[ c + 8 ] = ( tmp11 + tmp2 + 1024 ) >> 11;
		ws[ c + 48 ] = ( tmp11 - tmp2 + 1024 ) >> 11;
		ws[ c + 16 ] = ( tmp12 + tmp1 + 1024 ) >> 11;
		ws[ c + 40 ] = ( tmp12 - tmp1 + 1024 ) >> 11;
		ws[ c + 24 ] = ( tmp13 + tmp0 + 1024 ) >> 11;
		ws[ c + 32 ] = ( tmp13 - tmp0 + 1024 ) >> 11;

	}

	for ( let r = 0; r < 64; r += 8, outOff += stride ) {

		if ( ws[ r + 1 ] === 0 && ws[ r + 2 ] === 0 && ws[ r + 3 ] === 0 && ws[ r + 4 ] === 0 &&
			ws[ r + 5 ] === 0 && ws[ r + 6 ] === 0 && ws[ r + 7 ] === 0 ) {

			const v = ( ( ws[ r ] + 16 ) >> 5 ) + 128;
			out.fill( v < 0 ? 0 : v > 255 ? 255 : v, outOff, outOff + 8 );
			continue;

		}

		let z2 = ws[ r + 2 ];
		let z3 = ws[ r + 6 ];
		let z1 = ( z2 + z3 ) * 4433;
		let tmp2 = z1 - z3 * 15137;
		let tmp3 = z1 + z2 * 6270;
		let tmp0 = ( ws[ r ] + ws[ r + 4 ] ) * 8192;
		let tmp1 = ( ws[ r ] - ws[ r + 4 ] ) * 8192;
		const tmp10 = tmp0 + tmp3;
		const tmp13 = tmp0 - tmp3;
		const tmp11 = tmp1 + tmp2;
		const tmp12 = tmp1 - tmp2;

		tmp0 = ws[ r + 7 ];
		tmp1 = ws[ r + 5 ];
		tmp2 = ws[ r + 3 ];
		tmp3 = ws[ r + 1 ];
		z1 = tmp0 + tmp3;
		z2 = tmp1 + tmp2;
		z3 = tmp0 + tmp2;
		let z4 = tmp1 + tmp3;
		const z5 = ( z3 + z4 ) * 9633;
		tmp0 *= 2446;
		tmp1 *= 16819;
		tmp2 *= 25172;
		tmp3 *= 12299;
		z1 *= - 7373;
		z2 *= - 20995;
		z3 = z3 * - 16069 + z5;
		z4 = z4 * - 3196 + z5;
		tmp0 += z1 + z3;
		tmp1 += z2 + z4;
		tmp2 += z2 + z3;
		tmp3 += z1 + z4;

		// out is a Uint8ClampedArray, so stores saturate to 0..255
		out[ outOff ] = ( ( tmp10 + tmp3 + 131072 ) >> 18 ) + 128;
		out[ outOff + 7 ] = ( ( tmp10 - tmp3 + 131072 ) >> 18 ) + 128;
		out[ outOff + 1 ] = ( ( tmp11 + tmp2 + 131072 ) >> 18 ) + 128;
		out[ outOff + 6 ] = ( ( tmp11 - tmp2 + 131072 ) >> 18 ) + 128;
		out[ outOff + 2 ] = ( ( tmp12 + tmp1 + 131072 ) >> 18 ) + 128;
		out[ outOff + 5 ] = ( ( tmp12 - tmp1 + 131072 ) >> 18 ) + 128;
		out[ outOff + 3 ] = ( ( tmp13 + tmp0 + 131072 ) >> 18 ) + 128;
		out[ outOff + 4 ] = ( ( tmp13 - tmp0 + 131072 ) >> 18 ) + 128;

	}

}

// Inverse DCT of every block of a component into a plane of blocksPerLine * 8 samples per row.
function componentPlane( c, qt ) {

	const stride = c.blocksPerLine * 8;
	const plane = new Uint8ClampedArray( stride * c.blocksPerColumn * 8 );
	const ws = new Int32Array( 64 );
	const coefs = c.coefs;

	for ( let by = 0; by < c.blocksPerColumn; by ++ ) {

		for ( let bx = 0; bx < c.blocksPerLine; bx ++ ) {

			idctBlock( coefs, ( by * c.blocksPerLineForMcu + bx ) * 64, qt, plane, by * 8 * stride + bx * 8, stride, ws );

		}

	}

	c.coefs = null; // release coefficient memory early
	return { plane, stride };

}

// Upsamples a component plane by integer factors (hx, vy), using libjpeg's fancy (triangle) filters
// for the common 2x1, 2x2 and 1x2 cases and replication otherwise.
function upsample( plane, stride, cw, ch, hx, vy ) {

	if ( hx === 1 && vy === 1 ) return { data: plane, stride };

	const ow = cw * hx;
	const oh = ch * vy;
	const out = new Uint8Array( ow * oh );

	if ( hx === 2 && vy === 1 && cw > 2 ) {

		for ( let y = 0; y < ch; y ++ ) {

			let i = y * stride;
			let o = y * ow;
			let v = plane[ i ];
			out[ o ++ ] = v;
			out[ o ++ ] = ( v * 3 + plane[ i + 1 ] + 2 ) >> 2;

			for ( let x = 1; x < cw - 1; x ++ ) {

				i ++;
				v = plane[ i ] * 3;
				out[ o ++ ] = ( v + plane[ i - 1 ] + 1 ) >> 2;
				out[ o ++ ] = ( v + plane[ i + 1 ] + 2 ) >> 2;

			}

			i ++;
			v = plane[ i ];
			out[ o ++ ] = ( v * 3 + plane[ i - 1 ] + 1 ) >> 2;
			out[ o ] = v;

		}

		return { data: out, stride: ow };

	}

	if ( hx === 2 && vy === 2 && cw > 2 ) {

		for ( let y = 0; y < ch; y ++ ) {

			const row = y * stride;

			for ( let v = 0; v < 2; v ++ ) {

				const ny = v === 0 ? ( y > 0 ? y - 1 : 0 ) : ( y < ch - 1 ? y + 1 : y );
				const near = ny * stride;
				let o = ( 2 * y + v ) * ow;

				let thisSum = plane[ row ] * 3 + plane[ near ];
				let nextSum = plane[ row + 1 ] * 3 + plane[ near + 1 ];
				out[ o ++ ] = ( thisSum * 4 + 8 ) >> 4;
				out[ o ++ ] = ( thisSum * 3 + nextSum + 7 ) >> 4;
				let lastSum = thisSum;
				thisSum = nextSum;

				for ( let x = 2; x < cw; x ++ ) {

					nextSum = plane[ row + x ] * 3 + plane[ near + x ];
					out[ o ++ ] = ( thisSum * 3 + lastSum + 8 ) >> 4;
					out[ o ++ ] = ( thisSum * 3 + nextSum + 7 ) >> 4;
					lastSum = thisSum;
					thisSum = nextSum;

				}

				out[ o ++ ] = ( thisSum * 3 + lastSum + 8 ) >> 4;
				out[ o ] = ( thisSum * 4 + 7 ) >> 4;

			}

		}

		return { data: out, stride: ow };

	}

	if ( hx === 1 && vy === 2 ) {

		for ( let y = 0; y < ch; y ++ ) {

			const row = y * stride;

			for ( let v = 0; v < 2; v ++ ) {

				const ny = v === 0 ? ( y > 0 ? y - 1 : 0 ) : ( y < ch - 1 ? y + 1 : y );
				const near = ny * stride;
				const bias = v === 0 ? 1 : 2;
				const o = ( 2 * y + v ) * ow;
				for ( let x = 0; x < cw; x ++ ) out[ o + x ] = ( plane[ row + x ] * 3 + plane[ near + x ] + bias ) >> 2;

			}

		}

		return { data: out, stride: ow };

	}

	for ( let y = 0; y < oh; y ++ ) {

		const row = ( ( y / vy ) | 0 ) * stride;
		const o = y * ow;
		for ( let x = 0; x < ow; x ++ ) out[ o + x ] = plane[ row + ( ( x / hx ) | 0 ) ];

	}

	return { data: out, stride: ow };

}

// libjpeg's fixed point YCbCr -> RGB tables
const CR_R = new Int32Array( 256 );
const CB_B = new Int32Array( 256 );
const CR_G = new Int32Array( 256 );
const CB_G = new Int32Array( 256 );

for ( let i = 0; i < 256; i ++ ) {

	const x = i - 128;
	CR_R[ i ] = ( 91881 * x + 32768 ) >> 16;
	CB_B[ i ] = ( 116130 * x + 32768 ) >> 16;
	CR_G[ i ] = - 46802 * x;
	CB_G[ i ] = - 22554 * x + 32768;

}

function buildImage( frame, quantTables, adobeTransform, jfif ) {

	const { width, height, hmax, vmax, components } = frame;
	const n = components.length;

	if ( n !== 1 && n !== 3 && n !== 4 ) throw fail( `${ n } component JPEG is not supported` );

	const planes = components.map( ( c ) => {

		const qt = quantTables[ c.tq ];
		if ( ! qt ) throw fail( 'JPEG quantization table missing' );
		if ( hmax % c.h !== 0 || vmax % c.v !== 0 ) throw fail( 'JPEG fractional sampling factors are not supported' );
		const { plane, stride } = componentPlane( c, qt );
		return upsample( plane, stride, c.width, c.height, hmax / c.h, vmax / c.v );

	} );

	if ( n === 1 ) {

		const out = new Uint8Array( width * height );
		const { data, stride } = planes[ 0 ];
		for ( let y = 0; y < height; y ++ ) out.set( data.subarray( y * stride, y * stride + width ), y * width );
		return { width, height, channels: 1, bitDepth: 8, data: out };

	}

	// written through a clamped view so color conversion saturates
	const out = new Uint8ClampedArray( width * height * 3 );
	const result = { width, height, channels: 3, bitDepth: 8, data: new Uint8Array( out.buffer ) };
	const [ p0, p1, p2 ] = planes;

	let transform;
	if ( n === 3 ) {

		if ( adobeTransform >= 0 ) transform = adobeTransform !== 0;
		else if ( jfif ) transform = true;
		else transform = ! ( components[ 0 ].id === 0x52 && components[ 1 ].id === 0x47 && components[ 2 ].id === 0x42 ); // 'R', 'G', 'B'

	} else {

		transform = adobeTransform === 2; // YCCK

	}

	if ( n === 3 ) {

		for ( let y = 0, o = 0; y < height; y ++ ) {

			const r0 = y * p0.stride, r1 = y * p1.stride, r2 = y * p2.stride;

			if ( transform ) {

				for ( let x = 0; x < width; x ++, o += 3 ) {

					const Y = p0.data[ r0 + x ];
					const cb = p1.data[ r1 + x ];
					const cr = p2.data[ r2 + x ];
					out[ o ] = Y + CR_R[ cr ];
					out[ o + 1 ] = Y + ( ( CB_G[ cb ] + CR_G[ cr ] ) >> 16 );
					out[ o + 2 ] = Y + CB_B[ cb ];

				}

			} else {

				for ( let x = 0; x < width; x ++, o += 3 ) {

					out[ o ] = p0.data[ r0 + x ];
					out[ o + 1 ] = p1.data[ r1 + x ];
					out[ o + 2 ] = p2.data[ r2 + x ];

				}

			}

		}

		return result;

	}

	// CMYK / YCCK. Adobe files store inverted CMYK; convert like Pillow: R = ( 255 - C ) * ( 255 - K ) / 255
	const p3 = planes[ 3 ];
	const inverted = adobeTransform >= 0;

	for ( let y = 0, o = 0; y < height; y ++ ) {

		const r0 = y * p0.stride, r1 = y * p1.stride, r2 = y * p2.stride, r3 = y * p3.stride;

		for ( let x = 0; x < width; x ++, o += 3 ) {

			let c = p0.data[ r0 + x ];
			let m = p1.data[ r1 + x ];
			let ye = p2.data[ r2 + x ];
			let k = p3.data[ r3 + x ];

			if ( transform ) {

				const Y = c;
				const cb = m;
				const cr = ye;
				c = 255 - clamp( Y + CR_R[ cr ] );
				m = 255 - clamp( Y + ( ( CB_G[ cb ] + CR_G[ cr ] ) >> 16 ) );
				ye = 255 - clamp( Y + CB_B[ cb ] );

			}

			if ( inverted ) {

				c = 255 - c;
				m = 255 - m;
				ye = 255 - ye;
				k = 255 - k;

			}

			const nk = 255 - k;
			out[ o ] = nk - muldiv255( c, nk );
			out[ o + 1 ] = nk - muldiv255( m, nk );
			out[ o + 2 ] = nk - muldiv255( ye, nk );

		}

	}

	return result;

}

function clamp( v ) {

	return v < 0 ? 0 : v > 255 ? 255 : v;

}

function muldiv255( a, b ) {

	const t = a * b + 128;
	return ( ( t >> 8 ) + t ) >> 8;

}
