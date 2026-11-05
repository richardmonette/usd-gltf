// Reading glTF (json + external or embedded resources) and building new glTF assets.

import { readGLB, writeGLB } from './glb.js';

const COMPONENT_ARRAYS = {
	5120: Int8Array,
	5121: Uint8Array,
	5122: Int16Array,
	5123: Uint16Array,
	5125: Uint32Array,
	5126: Float32Array,
};

export const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function decodeDataURI( uri ) {

	const comma = uri.indexOf( ',' );
	const header = uri.slice( 5, comma );
	const data = uri.slice( comma + 1 );

	if ( header.endsWith( ';base64' ) ) {

		const binary = atob( data );
		const bytes = new Uint8Array( binary.length );
		for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );
		return { bytes, mimeType: header.slice( 0, - 7 ) };

	}

	return { bytes: new TextEncoder().encode( decodeURIComponent( data ) ), mimeType: header };

}

/**
 * A loaded glTF asset: json plus resolved buffers and image bytes.
 */
export class GLTFDocument {

	constructor( json, buffers, images ) {

		this.json = json;
		this.buffers = buffers; // Uint8Array per json.buffers entry
		this.images = images; // { bytes, mimeType, name } per json.images entry
		this.accessorCache = new Map();

	}

	bufferViewBytes( index ) {

		const view = this.json.bufferViews[ index ];
		const buffer = this.buffers[ view.buffer ];
		return buffer.subarray( view.byteOffset || 0, ( view.byteOffset || 0 ) + view.byteLength );

	}

	/**
	 * Reads an accessor into a tightly packed typed array of its component type.
	 * With normalize, normalized integer data is converted to floats.
	 * @returns {{ array: ArrayLike<number>, itemSize: number, count: number, normalized: boolean, componentType: number }}
	 */
	getAccessor( index, { normalize = true } = {} ) {

		const key = index + ( normalize ? 'n' : '' );
		if ( this.accessorCache.has( key ) ) return this.accessorCache.get( key );

		const accessor = this.json.accessors[ index ];
		const ArrayType = COMPONENT_ARRAYS[ accessor.componentType ];
		const itemSize = TYPE_SIZES[ accessor.type ];
		const count = accessor.count;
		let array = new ArrayType( count * itemSize );

		if ( accessor.bufferView !== undefined ) {

			const view = this.json.bufferViews[ accessor.bufferView ];
			const bytes = this.bufferViewBytes( accessor.bufferView );
			const elementBytes = ArrayType.BYTES_PER_ELEMENT;
			const offset = accessor.byteOffset || 0;

			// matrices of 1 and 2 byte components have column padding to 4 bytes
			let columns = 1;
			let rows = itemSize;
			if ( accessor.type.startsWith( 'MAT' ) && elementBytes < 4 ) { rows = Math.sqrt( itemSize ); columns = rows; }
			const columnStride = Math.ceil( rows * elementBytes / 4 ) * 4;
			const packed = columns === 1 ? itemSize * elementBytes : columnStride * columns;
			const stride = view.byteStride || packed;

			const dv = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
			const getters = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
			const get = getters[ accessor.componentType ];

			if ( stride === itemSize * elementBytes && columns === 1 && ( bytes.byteOffset + offset ) % elementBytes === 0 ) {

				array = new ArrayType( bytes.buffer, bytes.byteOffset + offset, count * itemSize ).slice();

			} else {

				for ( let i = 0; i < count; i ++ ) {

					const base = offset + i * stride;
					for ( let c = 0; c < columns; c ++ ) for ( let r = 0; r < rows; r ++ ) {

						array[ i * itemSize + c * rows + r ] = dv[ get ]( base + c * columnStride + r * elementBytes, true );

					}

				}

			}

		}

		if ( accessor.sparse ) {

			const { count: n, indices, values } = accessor.sparse;
			const IndexType = COMPONENT_ARRAYS[ indices.componentType ];
			const ib = this.bufferViewBytes( indices.bufferView );
			const vb = this.bufferViewBytes( values.bufferView );
			const idx = new IndexType( ib.slice( indices.byteOffset || 0, ( indices.byteOffset || 0 ) + n * IndexType.BYTES_PER_ELEMENT ).buffer );
			const vals = new ArrayType( vb.slice( values.byteOffset || 0, ( values.byteOffset || 0 ) + n * itemSize * ArrayType.BYTES_PER_ELEMENT ).buffer );
			for ( let i = 0; i < n; i ++ ) for ( let c = 0; c < itemSize; c ++ ) array[ idx[ i ] * itemSize + c ] = vals[ i * itemSize + c ];

		}

		let normalized = !! accessor.normalized;

		if ( normalize && normalized ) {

			const out = new Float32Array( array.length );
			const ct = accessor.componentType;
			for ( let i = 0; i < array.length; i ++ ) {

				const v = array[ i ];
				out[ i ] = ct === 5120 ? Math.max( v / 127, - 1 ) : ct === 5121 ? v / 255 : ct === 5122 ? Math.max( v / 32767, - 1 ) : ct === 5123 ? v / 65535 : v;

			}

			array = out;
			normalized = false;

		}

		const result = { array, itemSize, count, normalized, componentType: accessor.componentType };
		this.accessorCache.set( key, result );
		return result;

	}

	// Accessor data as Float32Array regardless of component type (dequantizing integers as-is when not normalized).
	getFloats( index ) {

		const { array, itemSize, count } = this.getAccessor( index );
		return { array: array instanceof Float32Array ? array : Float32Array.from( array ), itemSize, count };

	}

}

/**
 * Loads a glTF or GLB.
 * @param {Uint8Array} bytes
 * @param {{ resolver?: ( uri: string ) => Promise<Uint8Array>|Uint8Array }} [options] loads external uris (already decoded from URI escaping)
 */
export async function readGLTF( bytes, { resolver = null } = {} ) {

	let json, bin = null;

	if ( bytes[ 0 ] === 0x67 && bytes[ 1 ] === 0x6C && bytes[ 2 ] === 0x54 && bytes[ 3 ] === 0x46 ) ( { json, bin } = readGLB( bytes ) );
	else json = JSON.parse( new TextDecoder().decode( bytes ).replace( /^﻿/, '' ) );

	async function load( uri ) {

		if ( uri.startsWith( 'data:' ) ) return decodeDataURI( uri ).bytes;
		if ( ! resolver ) throw new Error( `usd-gltf: no resolver for external uri ${ uri }` );
		let path = uri;
		try { path = decodeURIComponent( uri ); } catch { /* keep as is */ }
		const data = await resolver( path );
		return data instanceof Uint8Array ? data : new Uint8Array( data );

	}

	const buffers = await Promise.all( ( json.buffers || [] ).map( async ( buffer, i ) => {

		if ( buffer.uri === undefined ) {

			if ( i === 0 && bin ) return bin;
			// e.g. EXT_meshopt_compression fallback buffers have no data
			return new Uint8Array( buffer.byteLength );

		}

		return load( buffer.uri );

	} ) );

	const doc = new GLTFDocument( json, buffers, [] );

	doc.images = await Promise.all( ( json.images || [] ).map( async ( image ) => {

		if ( image.bufferView !== undefined ) return { bytes: doc.bufferViewBytes( image.bufferView ), mimeType: image.mimeType, name: image.name, uri: null };
		if ( image.uri.startsWith( 'data:' ) ) return { ...decodeDataURI( image.uri ), name: image.name, uri: null };

		try {

			return { bytes: await load( image.uri ), mimeType: image.mimeType || guessMime( image.uri ), name: image.name, uri: image.uri };

		} catch ( e ) {

			console.warn( `usd-gltf: ${ e.message }` );
			return null;

		}

	} ) );

	return doc;

}

function guessMime( uri ) {

	const ext = uri.split( '?' )[ 0 ].split( '.' ).pop().toLowerCase();
	return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ktx2: 'image/ktx2' }[ ext ] || 'application/octet-stream';

}

/**
 * Incrementally builds a glTF asset with a single binary buffer.
 */
export class GLTFBuilder {

	constructor( generator = 'usd-gltf' ) {

		this.json = { asset: { version: '2.0', generator }, scenes: [], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [], accessors: [], bufferViews: [], buffers: [] };
		this.chunks = [];
		this.byteLength = 0;
		this.extensionsUsed = new Set();
		this.extensionsRequired = new Set();

	}

	useExtension( name, required = false ) {

		this.extensionsUsed.add( name );
		if ( required ) this.extensionsRequired.add( name );

	}

	addBufferView( bytes, target ) {

		const pad = ( 4 - ( this.byteLength % 4 ) ) % 4;
		if ( pad ) { this.chunks.push( new Uint8Array( pad ) ); this.byteLength += pad; }

		const view = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength };
		if ( target ) view.target = target;
		this.chunks.push( bytes instanceof Uint8Array ? bytes : new Uint8Array( bytes.buffer, bytes.byteOffset, bytes.byteLength ) );
		this.byteLength += bytes.byteLength;
		return this.json.bufferViews.push( view ) - 1;

	}

	/**
	 * @param {Float32Array|Uint32Array|Uint16Array|Uint8Array|Int16Array|Int8Array} array
	 * @param {string} type 'SCALAR', 'VEC3', ...
	 * @param {{ target?: number, normalized?: boolean, minmax?: boolean }} [options]
	 */
	addAccessor( array, type, { target, normalized = false, minmax = false } = {} ) {

		const componentType = { Int8Array: 5120, Uint8Array: 5121, Int16Array: 5122, Uint16Array: 5123, Uint32Array: 5125, Float32Array: 5126 }[ array.constructor.name ];
		const itemSize = TYPE_SIZES[ type ];
		const accessor = { bufferView: this.addBufferView( array, target ), componentType, count: array.length / itemSize, type };
		if ( normalized ) accessor.normalized = true;

		if ( minmax ) {

			const min = new Array( itemSize ).fill( Infinity );
			const max = new Array( itemSize ).fill( - Infinity );
			for ( let i = 0; i < array.length; i ++ ) {

				const c = i % itemSize;
				const v = array[ i ];
				if ( v < min[ c ] ) min[ c ] = v;
				if ( v > max[ c ] ) max[ c ] = v;

			}

			if ( componentType === 5126 ) {

				accessor.min = min.map( ( v ) => Math.fround( v ) );
				accessor.max = max.map( ( v ) => Math.fround( v ) );

			} else {

				accessor.min = min;
				accessor.max = max;

			}

		}

		return this.json.accessors.push( accessor ) - 1;

	}

	addImage( bytes, mimeType, name ) {

		const image = { bufferView: this.addBufferView( bytes ), mimeType };
		if ( name ) image.name = name;
		return this.json.images.push( image ) - 1;

	}

	toGLB() {

		const json = this.finalize();
		const bin = new Uint8Array( this.byteLength );
		let offset = 0;
		for ( const chunk of this.chunks ) {

			bin.set( chunk, offset );
			offset += chunk.byteLength;

		}

		return writeGLB( json, this.byteLength ? bin : null );

	}

	finalize() {

		const json = this.json;
		if ( this.byteLength ) json.buffers = [ { byteLength: this.byteLength } ];
		if ( this.extensionsUsed.size ) json.extensionsUsed = [ ...this.extensionsUsed ];
		if ( this.extensionsRequired.size ) json.extensionsRequired = [ ...this.extensionsRequired ];

		// drop empty top level arrays, the validator flags them
		for ( const key of Object.keys( json ) ) if ( Array.isArray( json[ key ] ) && json[ key ].length === 0 ) delete json[ key ];
		return json;

	}

}
