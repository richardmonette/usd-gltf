// KHR_draco_mesh_compression, decoded with Google's Draco decoder, which usd-gltf doesn't bundle.
// The decoder is the dracoDecoder option when given; otherwise the draco3d package in Node (an
// optional peer dependency), or in browsers Google's CDN build, pinned to one version and checked
// against its hash before it runs. Only loaded when a file needs it.
// https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_draco_mesh_compression

const CDN = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const CDN_FILES = {
	'draco_wasm_wrapper_gltf.js': 'i7KVLSun1n4UFPjfgZQQywQ0pma+U/Zx//dfaIQ9dvY=',
	'draco_decoder_gltf.wasm': 'cS2zRJriBB1uiiJMOVvabO20nlEyL644t9ub64s4GIk=',
};

const DATA_TYPES = { 5120: 'DT_INT8', 5121: 'DT_UINT8', 5122: 'DT_INT16', 5123: 'DT_UINT16', 5125: 'DT_UINT32', 5126: 'DT_FLOAT32' };
const COMPONENT_ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

let defaultDecoder = null;

/**
 * The default Draco decoder module: draco3d in Node, Google's CDN in browsers. Loaded once.
 * @returns {Promise<object>}
 */
export function loadDracoDecoder() {

	defaultDecoder ||= ( isNode() ? loadNode() : loadDracoFromCDN() ).catch( ( e ) => {

		defaultDecoder = null; // let a later conversion try again
		throw e;

	} );

	return defaultDecoder;

}

function isNode() {

	return typeof process !== 'undefined' && !! process.versions?.node;

}

async function loadNode() {

	const name = 'draco3d'; // not a literal, so bundlers don't try to include it
	let draco3d;

	try {

		draco3d = await import( /* webpackIgnore: true */ /* @vite-ignore */ name );

	} catch {

		throw new Error( 'usd-gltf: this glTF is Draco compressed; install the decoder with npm install draco3d, or pass a dracoDecoder' );

	}

	return ( draco3d.default ?? draco3d ).createDecoderModule();

}

// Exported for tests; loadDracoDecoder picks the source.
export async function loadDracoFromCDN() {

	if ( ! globalThis.crypto?.subtle ) throw new Error( 'usd-gltf: loading the Draco decoder needs a secure context (https) to check it; pass a dracoDecoder instead' );
	const [ wrapper, wasm ] = await Promise.all( Object.keys( CDN_FILES ).map( fetchVerified ) );
	// the wrapper is a classic script defining DracoDecoderModule, so it can't be imported as a module
	const factory = new Function( new TextDecoder().decode( wrapper ) + '\nreturn DracoDecoderModule;' )();
	return factory( { wasmBinary: wasm.buffer } );

}

async function fetchVerified( name ) {

	const response = await fetch( CDN + name );
	if ( ! response.ok ) throw new Error( `usd-gltf: could not load the Draco decoder (${ response.status } for ${ CDN + name })` );
	const bytes = new Uint8Array( await response.arrayBuffer() );
	const digest = new Uint8Array( await crypto.subtle.digest( 'SHA-256', bytes ) );
	if ( btoa( String.fromCharCode( ...digest ) ) !== CDN_FILES[ name ] ) throw new Error( `usd-gltf: ${ CDN + name } doesn't match its expected hash` );
	return bytes;

}

/**
 * Whether a primitive's data is only in its Draco extension: Draco is decoded only when the
 * accessors have no uncompressed fallback.
 */
export function needsDraco( json, primitive ) {

	if ( ! primitive.extensions?.KHR_draco_mesh_compression ) return false;
	const used = [ ...Object.values( primitive.attributes ), primitive.indices ].filter( ( a ) => a !== undefined );
	return used.some( ( a ) => json.accessors[ a ]?.bufferView === undefined && ! json.accessors[ a ]?.sparse );

}

/**
 * Decodes one Draco compressed primitive into the data of the accessors it describes.
 * @param {object} draco decoder module
 * @param {Uint8Array} bytes the extension's bufferView
 * @param {object} json
 * @param {object} primitive
 * @param {import('../limits.js').Budget} budget
 * @returns {Map<number, ArrayLike<number>>} accessor index -> data, in the accessor's component type
 */
export function decodeDracoPrimitive( draco, bytes, json, primitive, budget ) {

	const ext = primitive.extensions.KHR_draco_mesh_compression;
	const decoder = new draco.Decoder();
	const array = new Int8Array( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const out = new Map();
	let geometry = null;

	try {

		const type = decoder.GetEncodedGeometryType( array );
		let status;

		if ( type === draco.TRIANGULAR_MESH ) {

			geometry = new draco.Mesh();
			status = decoder.DecodeArrayToMesh( array, array.byteLength, geometry );

		} else if ( type === draco.POINT_CLOUD ) {

			geometry = new draco.PointCloud();
			status = decoder.DecodeArrayToPointCloud( array, array.byteLength, geometry );

		} else {

			throw new Error( 'usd-gltf: Draco data is neither a mesh nor a point cloud' );

		}

		if ( ! status.ok() || geometry.ptr === 0 ) throw new Error( `usd-gltf: Draco decoding failed: ${ status.error_msg() }` );

		const points = geometry.num_points();

		for ( const [ name, id ] of Object.entries( ext.attributes ) ) {

			const index = primitive.attributes[ name ];
			const accessor = json.accessors[ index ];
			if ( accessor === undefined ) continue;
			const ArrayType = COMPONENT_ARRAYS[ accessor.componentType ];
			const size = TYPE_SIZES[ accessor.type ];
			const attribute = decoder.GetAttributeByUniqueId( geometry, id );
			if ( ! ArrayType || ! size || ! attribute || attribute.ptr === 0 ) throw new Error( `usd-gltf: Draco data has no ${ name } attribute ${ id }` );
			if ( points !== accessor.count || attribute.num_components() !== size ) throw new Error( `usd-gltf: Draco ${ name } doesn't match accessor ${ index }` );
			out.set( index, read( draco, points * size, ArrayType, budget, ( length, ptr ) => decoder.GetAttributeDataArrayForAllPoints( geometry, attribute, draco[ DATA_TYPES[ accessor.componentType ] ], length, ptr ) ) );

		}

		if ( primitive.indices !== undefined && type === draco.TRIANGULAR_MESH ) {

			const accessor = json.accessors[ primitive.indices ];
			const count = geometry.num_faces() * 3;
			if ( ! accessor || accessor.count !== count ) throw new Error( `usd-gltf: Draco indices don't match accessor ${ primitive.indices }` );
			const indices = read( draco, count, Uint32Array, budget, ( length, ptr ) => decoder.GetTrianglesUInt32Array( geometry, length, ptr ) );
			const IndexType = COMPONENT_ARRAYS[ accessor.componentType ] || Uint32Array;
			out.set( primitive.indices, IndexType === Uint32Array ? indices : IndexType.from( indices ) );

		}

	} finally {

		if ( geometry ) draco.destroy( geometry );
		draco.destroy( decoder );

	}

	return out;

}

// Has the decoder fill a buffer on its heap, then copies it out.
function read( draco, count, ArrayType, budget, fill ) {

	const length = count * ArrayType.BYTES_PER_ELEMENT;
	budget.decode( length, 'draco' );
	const ptr = draco._malloc( length );

	try {

		if ( ! fill( length, ptr ) ) throw new Error( 'usd-gltf: Draco attribute could not be read' );
		return new ArrayType( draco.HEAPF32.buffer, ptr, count ).slice();

	} finally {

		draco._free( ptr );

	}

}
