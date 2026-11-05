// Decoders for meshoptimizer compressed buffer views (KHR_meshopt_compression, EXT_meshopt_compression),
// ported from meshoptimizer's scalar reference implementation (src/vertexcodec.cpp, indexcodec.cpp,
// vertexfilter.cpp, MIT license, Copyright Arseny Kapoulkine).

const VERTEX_HEADER = 0xa0;
const INDEX_HEADER = 0xe0;
const SEQUENCE_HEADER = 0xd0;
const BLOCK_SIZE_BYTES = 8192;
const BLOCK_MAX_SIZE = 256;
const GROUP_SIZE = 16;
const GROUP_DECODE_LIMIT = 24;
const BITS_V0 = [ 0, 2, 4, 8 ];
const BITS_V1 = [ 0, 1, 2, 4, 8 ];

const fround = Math.fround;

function fail( message ) {

	throw new Error( `usd-gltf: meshopt ${ message }` );

}

// --- vertex codec ---

function decodeBytesGroup( data, pos, out, o, bits ) {

	if ( bits === 0 ) {

		out.fill( 0, o, o + GROUP_SIZE );
		return pos;

	}

	if ( bits === 8 ) {

		out.set( data.subarray( pos, pos + GROUP_SIZE ), o );
		return pos + GROUP_SIZE;

	}

	// packed values, with the maximum value meaning "read a literal byte"
	const perByte = 8 / bits;
	const mask = ( 1 << bits ) - 1;
	let varPos = pos + GROUP_SIZE / perByte;

	for ( let b = 0; b < GROUP_SIZE / perByte; b ++ ) {

		let byte = data[ pos + b ];

		// 1 bit groups store their bits reversed relative to the other widths
		if ( bits === 1 ) byte = ( ( byte * 0x0202020202 & 0x010884422010 ) % 1023 ) & 0xff;

		for ( let k = 0; k < perByte; k ++ ) {

			const enc = ( byte >> ( 8 - bits ) ) & mask;
			byte = ( byte << bits ) & 0xff;

			if ( enc === mask ) out[ o ++ ] = data[ varPos ++ ];
			else out[ o ++ ] = enc;

		}

	}

	return varPos;

}

function decodeBytes( data, pos, end, out, o, size, bits ) {

	const headerSize = ( ( size / GROUP_SIZE ) + 3 ) >> 2;
	if ( end - pos < headerSize ) fail( 'truncated vertex data' );
	const header = pos;
	pos += headerSize;

	for ( let i = 0; i < size; i += GROUP_SIZE ) {

		if ( end - pos < GROUP_DECODE_LIMIT ) fail( 'truncated vertex data' );
		const g = i / GROUP_SIZE;
		const k = ( data[ header + ( g >> 2 ) ] >> ( ( g & 3 ) * 2 ) ) & 3;
		pos = decodeBytesGroup( data, pos, out, o + i, bits[ k ] );

	}

	return pos;

}

function decodeVertexBlock( data, pos, end, target, targetOffset, count, size, last, channels, version, buffer ) {

	const aligned = ( count + GROUP_SIZE - 1 ) & ~ ( GROUP_SIZE - 1 );
	const controlSize = version === 0 ? 0 : size / 4;
	if ( end - pos < controlSize ) fail( 'truncated vertex data' );
	const control = pos;
	pos += controlSize;

	for ( let k = 0; k < size; k += 4 ) {

		const ctrlByte = version === 0 ? 0 : data[ control + k / 4 ];

		for ( let j = 0; j < 4; j ++ ) {

			const ctrl = ( ctrlByte >> ( j * 2 ) ) & 3;

			if ( ctrl === 3 ) {

				if ( end - pos < count ) fail( 'truncated vertex data' );
				buffer.set( data.subarray( pos, pos + count ), j * count );
				pos += count;

			} else if ( ctrl === 2 ) {

				buffer.fill( 0, j * count, j * count + count );

			} else {

				// decodes aligned bytes into a scratch area; only the first count are used
				pos = decodeBytes( data, pos, end, buffer, BLOCK_MAX_SIZE * 4 + j * BLOCK_MAX_SIZE, aligned, version === 0 ? BITS_V0 : BITS_V1.slice( ctrl ) );
				buffer.copyWithin( j * count, BLOCK_MAX_SIZE * 4 + j * BLOCK_MAX_SIZE, BLOCK_MAX_SIZE * 4 + j * BLOCK_MAX_SIZE + count );

			}

		}

		const channel = version === 0 ? 0 : channels[ k / 4 ];
		const type = channel & 3;

		if ( type === 0 ) {

			// bytes: zigzag deltas
			for ( let b = 0; b < 4; b ++ ) {

				let p = last[ k + b ];
				for ( let i = 0; i < count; i ++ ) {

					const v = buffer[ b * count + i ];
					p = ( p + ( ( v >> 1 ) ^ - ( v & 1 ) ) ) & 0xff;
					target[ targetOffset + i * size + k + b ] = p;

				}

			}

		} else if ( type === 1 ) {

			// 16 bit zigzag deltas
			for ( let h = 0; h < 2; h ++ ) {

				let p = last[ k + h * 2 ] | ( last[ k + h * 2 + 1 ] << 8 );
				for ( let i = 0; i < count; i ++ ) {

					const v = buffer[ h * 2 * count + i ] | ( buffer[ ( h * 2 + 1 ) * count + i ] << 8 );
					p = ( p + ( ( v >> 1 ) ^ - ( v & 1 ) ) ) & 0xffff;
					target[ targetOffset + i * size + k + h * 2 ] = p & 0xff;
					target[ targetOffset + i * size + k + h * 2 + 1 ] = p >> 8;

				}

			}

		} else if ( type === 2 ) {

			// 32 bit xor deltas with rotation
			const rot = ( 32 - ( channel >> 4 ) ) & 31;
			let p = ( last[ k ] | ( last[ k + 1 ] << 8 ) | ( last[ k + 2 ] << 16 ) | ( last[ k + 3 ] << 24 ) ) >>> 0;

			for ( let i = 0; i < count; i ++ ) {

				let v = ( buffer[ i ] | ( buffer[ count + i ] << 8 ) | ( buffer[ 2 * count + i ] << 16 ) | ( buffer[ 3 * count + i ] << 24 ) ) >>> 0;
				v = ( ( ( v << rot ) | ( v >>> ( ( 32 - rot ) & 31 ) ) ) ^ p ) >>> 0;
				const t = targetOffset + i * size + k;
				target[ t ] = v & 0xff; target[ t + 1 ] = ( v >>> 8 ) & 0xff; target[ t + 2 ] = ( v >>> 16 ) & 0xff; target[ t + 3 ] = v >>> 24;
				p = v;

			}

		} else {

			fail( 'invalid channel type' );

		}

	}

	for ( let b = 0; b < size; b ++ ) last[ b ] = target[ targetOffset + ( count - 1 ) * size + b ];
	return pos;

}

/**
 * meshopt_decodeVertexBuffer: count vertices of size bytes into target.
 */
export function decodeVertexBuffer( target, count, size, source ) {

	if ( size <= 0 || size > 256 || size % 4 ) fail( 'invalid vertex size' );
	if ( source[ 0 ] >> 4 !== VERTEX_HEADER >> 4 ) fail( 'invalid vertex header' );
	const version = source[ 0 ] & 15;
	if ( version > 1 ) fail( `unsupported vertex codec version ${ version }` );

	const tailSize = size + ( version === 0 ? 0 : size / 4 );
	const tailPad = Math.max( tailSize, version === 0 ? 32 : 24 );
	const end = source.length;
	if ( end - 1 < tailPad ) fail( 'truncated vertex data' );

	const last = source.slice( end - tailSize, end - tailSize + size );
	const channels = version === 0 ? null : source.subarray( end - tailSize + size, end );
	const blockSize = Math.min( ( BLOCK_SIZE_BYTES / size ) & ~ ( GROUP_SIZE - 1 ), BLOCK_MAX_SIZE );
	const buffer = new Uint8Array( BLOCK_MAX_SIZE * 8 );
	let pos = 1;

	for ( let offset = 0; offset < count; offset += blockSize ) {

		const n = Math.min( blockSize, count - offset );
		pos = decodeVertexBlock( source, pos, end, target, offset * size, n, size, last, channels, version, buffer );

	}

	if ( end - pos !== tailPad ) fail( 'malformed vertex data' );
	return target;

}

// --- index codecs ---

function decodeVByte( data, state ) {

	const lead = data[ state.pos ++ ];
	if ( lead < 128 ) return lead;
	let result = lead & 127;
	let shift = 7;

	for ( let i = 0; i < 4; i ++ ) {

		const group = data[ state.pos ++ ];
		result = ( result | ( ( group & 127 ) << shift ) ) >>> 0;
		shift += 7;
		if ( group < 128 ) break;

	}

	return result;

}

function decodeIndex( data, state, last ) {

	const v = decodeVByte( data, state );
	return ( last + ( ( v >>> 1 ) ^ - ( v & 1 ) ) ) >>> 0;

}

/**
 * meshopt_decodeIndexBuffer: triangle list compressed with the index codec.
 */
export function decodeIndexBuffer( target, count, source ) {

	if ( count % 3 ) fail( 'index count must be a multiple of 3' );
	if ( source.length < 1 + count / 3 + 16 ) fail( 'truncated index data' );
	if ( source[ 0 ] >> 4 !== INDEX_HEADER >> 4 ) fail( 'invalid index header' );
	const version = source[ 0 ] & 15;
	if ( version > 1 ) fail( `unsupported index codec version ${ version }` );

	const edge = new Uint32Array( 32 ).fill( 0xffffffff );
	const vfifo = new Uint32Array( 16 ).fill( 0xffffffff );
	let eo = 0, vo = 0, next = 0, last = 0, out = 0;
	const fecmax = version >= 1 ? 13 : 15;

	let code = 1;
	const codeEnd = 1 + count / 3;
	const state = { pos: codeEnd };
	const safeEnd = source.length - 16;
	const table = safeEnd;

	const pushV = ( v, cond = 1 ) => { vfifo[ vo ] = v; vo = ( vo + cond ) & 15; };
	const pushE = ( a, b ) => { edge[ eo * 2 ] = a; edge[ eo * 2 + 1 ] = b; eo = ( eo + 1 ) & 15; };
	const write = ( a, b, c ) => { target[ out ++ ] = a; target[ out ++ ] = b; target[ out ++ ] = c; };

	while ( code < codeEnd ) {

		const codetri = source[ code ++ ];

		if ( codetri < 0xf0 ) {

			const fe = codetri >> 4;
			const ei = ( eo - 1 - fe ) & 15;
			const a = edge[ ei * 2 ], b = edge[ ei * 2 + 1 ];
			const fec = codetri & 15;
			let c;

			if ( fec < fecmax ) {

				const cf = vfifo[ ( vo - 1 - fec ) & 15 ];
				c = fec === 0 ? next : cf;
				const fec0 = fec === 0 ? 1 : 0;
				next += fec0;
				pushV( c, fec0 );

			} else {

				if ( state.pos > safeEnd ) fail( 'truncated index data' );
				last = c = fec !== 15 ? ( last + ( fec * 2 - 27 ) ) >>> 0 : decodeIndex( source, state, last );
				pushV( c );

			}

			pushE( c, b );
			pushE( a, c );
			write( a, b, c );

		} else if ( codetri < 0xfe ) {

			const codeaux = source[ table + ( codetri & 15 ) ];
			const feb = codeaux >> 4, fec = codeaux & 15;
			const a = next ++;
			const bf = vfifo[ ( vo - feb ) & 15 ];
			const b = feb === 0 ? next : bf;
			const feb0 = feb === 0 ? 1 : 0;
			next += feb0;
			const cf = vfifo[ ( vo - fec ) & 15 ];
			const c = fec === 0 ? next : cf;
			const fec0 = fec === 0 ? 1 : 0;
			next += fec0;
			write( a, b, c );
			pushV( a ); pushV( b, feb0 ); pushV( c, fec0 );
			pushE( b, a ); pushE( c, b ); pushE( a, c );

		} else {

			if ( state.pos > safeEnd ) fail( 'truncated index data' );
			const codeaux = source[ state.pos ++ ];
			const fea = codetri === 0xfe ? 0 : 15;
			const feb = codeaux >> 4, fec = codeaux & 15;
			if ( codeaux === 0 ) next = 0;

			let a = fea === 0 ? next ++ : 0;
			let b = feb === 0 ? next ++ : vfifo[ ( vo - feb ) & 15 ];
			let c = fec === 0 ? next ++ : vfifo[ ( vo - fec ) & 15 ];
			if ( fea === 15 ) last = a = decodeIndex( source, state, last );
			if ( feb === 15 ) last = b = decodeIndex( source, state, last );
			if ( fec === 15 ) last = c = decodeIndex( source, state, last );

			write( a, b, c );
			pushV( a ); pushV( b, ( feb === 0 ) | ( feb === 15 ) ); pushV( c, ( fec === 0 ) | ( fec === 15 ) );
			pushE( b, a ); pushE( c, b ); pushE( a, c );

		}

	}

	if ( state.pos !== safeEnd ) fail( 'malformed index data' );
	return target;

}

/**
 * meshopt_decodeIndexSequence: arbitrary index lists (strips, lines, points).
 */
export function decodeIndexSequence( target, count, source ) {

	if ( source.length < 1 + count + 4 ) fail( 'truncated index data' );
	if ( source[ 0 ] >> 4 !== SEQUENCE_HEADER >> 4 ) fail( 'invalid index sequence header' );
	if ( ( source[ 0 ] & 15 ) > 1 ) fail( 'unsupported index sequence version' );

	const state = { pos: 1 };
	const safeEnd = source.length - 4;
	const last = [ 0, 0 ];

	for ( let i = 0; i < count; i ++ ) {

		if ( state.pos >= safeEnd ) fail( 'truncated index data' );
		let v = decodeVByte( source, state );
		const current = v & 1;
		v >>>= 1;
		const index = ( last[ current ] + ( ( v >>> 1 ) ^ - ( v & 1 ) ) ) >>> 0;
		last[ current ] = index;
		target[ i ] = index;

	}

	if ( state.pos !== safeEnd ) fail( 'malformed index data' );
	return target;

}

// --- filters ---

function round( v ) {

	return Math.trunc( v + ( v >= 0 ? 0.5 : - 0.5 ) );

}

function filterOct( data, count ) {

	const max = fround( ( 1 << ( data.BYTES_PER_ELEMENT * 8 - 1 ) ) - 1 );

	for ( let i = 0; i < count; i ++ ) {

		let x = data[ i * 4 ], y = data[ i * 4 + 1 ];
		const z = fround( data[ i * 4 + 2 ] - Math.abs( x ) - Math.abs( y ) );
		const t = z >= 0 ? 0 : z;
		x = fround( x + ( x >= 0 ? t : - t ) );
		y = fround( y + ( y >= 0 ? t : - t ) );
		const l = fround( Math.sqrt( fround( fround( x * x + y * y ) + z * z ) ) );
		const s = fround( max / l );
		data[ i * 4 ] = round( fround( x * s ) );
		data[ i * 4 + 1 ] = round( fround( y * s ) );
		data[ i * 4 + 2 ] = round( fround( z * s ) );

	}

}

function filterQuat( data, count ) {

	const scale = fround( 32767 / fround( Math.SQRT2 ) );

	for ( let i = 0; i < count; i ++ ) {

		const sf = data[ i * 4 + 3 ] | 3;
		const s = sf;
		const x = data[ i * 4 ], y = data[ i * 4 + 1 ], z = data[ i * 4 + 2 ];
		const ww = fround( fround( s * s * 2 ) - x * x - y * y - z * z );
		const w = fround( Math.sqrt( ww >= 0 ? ww : 0 ) );
		const ss = fround( scale / s );
		const qc = data[ i * 4 + 3 ] & 3;
		data[ i * 4 + ( ( qc + 1 ) & 3 ) ] = round( fround( x * ss ) );
		data[ i * 4 + ( ( qc + 2 ) & 3 ) ] = round( fround( y * ss ) );
		data[ i * 4 + ( ( qc + 3 ) & 3 ) ] = round( fround( z * ss ) );
		data[ i * 4 + qc ] = Math.trunc( fround( w * ss ) + 0.5 );

	}

}

function filterExp( u32, count ) {

	const f32 = new Float32Array( u32.buffer, u32.byteOffset, u32.length );

	for ( let i = 0; i < count; i ++ ) {

		const v = u32[ i ];
		const m = ( v << 8 ) >> 8;
		const e = v >> 24;
		f32[ i ] = fround( 2 ** e * m );

	}

}

function filterColor( data, count, signed ) {

	const max = fround( 2 ** ( data.BYTES_PER_ELEMENT * 8 ) - 1 );
	const bits = data.BYTES_PER_ELEMENT * 8;

	for ( let i = 0; i < count; i ++ ) {

		let as = data[ i * 4 + 3 ];
		as |= as >> 1; as |= as >> 2; as |= as >> 4; as |= as >> 8;
		const sext = ( v ) => ( v << ( 32 - bits ) ) >> ( 32 - bits );
		const y = data[ i * 4 ], co = sext( data[ i * 4 + 1 ] ), cg = sext( data[ i * 4 + 2 ] );
		const r = y + co - cg, g = y + cg, b = y - co - cg;
		let a = data[ i * 4 + 3 ];
		a = ( ( a << 1 ) & as ) | ( a & 1 );
		const ss = fround( max / as );
		data[ i * 4 ] = Math.trunc( fround( r * ss ) + 0.5 );
		data[ i * 4 + 1 ] = Math.trunc( fround( g * ss ) + 0.5 );
		data[ i * 4 + 2 ] = Math.trunc( fround( b * ss ) + 0.5 );
		data[ i * 4 + 3 ] = Math.trunc( fround( a * ss ) + 0.5 );

	}

	void signed;

}

function applyFilter( bytes, count, stride, filter ) {

	const buffer = bytes.buffer, offset = bytes.byteOffset;

	switch ( filter ) {

		case 'OCTAHEDRAL':
			filterOct( stride === 4 ? new Int8Array( buffer, offset, count * 4 ) : new Int16Array( buffer, offset, count * 4 ), count );
			break;
		case 'QUATERNION':
			filterQuat( new Int16Array( buffer, offset, count * 4 ), count );
			break;
		case 'EXPONENTIAL':
			filterExp( new Uint32Array( buffer, offset, count * stride / 4 ), count * stride / 4 );
			break;
		case 'COLOR':
			filterColor( stride === 4 ? new Uint8Array( buffer, offset, count * 4 ) : new Uint16Array( buffer, offset, count * 4 ), count );
			break;
		case 'NONE': case undefined:
			break;
		default:
			fail( `unknown filter ${ filter }` );

	}

}

/**
 * Decodes one compressed bufferView extension object, given the loaded buffers.
 * @returns {Uint8Array} count * byteStride decoded bytes
 */
export function decodeMeshoptView( ext, buffers ) {

	const source = buffers[ ext.buffer ].subarray( ext.byteOffset || 0, ( ext.byteOffset || 0 ) + ext.byteLength );
	const { count, byteStride: stride, mode, filter } = ext;
	const out = new Uint8Array( count * stride );

	if ( mode === 'ATTRIBUTES' ) {

		decodeVertexBuffer( out, count, stride, source );
		applyFilter( out, count, stride, filter );

	} else if ( mode === 'TRIANGLES' || mode === 'INDICES' ) {

		const target = stride === 2 ? new Uint16Array( out.buffer ) : new Uint32Array( out.buffer );
		if ( mode === 'TRIANGLES' ) decodeIndexBuffer( target, count, source );
		else decodeIndexSequence( target, count, source );

	} else {

		fail( `unknown mode ${ mode }` );

	}

	return out;

}
