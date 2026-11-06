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
const INDEX_ARRAYS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array };
const INDEX_MAX = { 5121: 0xFF, 5123: 0xFFFF, 5125: 0xFFFFFFFF };
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
 * Thrown when decoded Draco data doesn't match the accessors describing it, which the extension
 * requires. kind says what disagrees:
 * - 'count': an attribute decodes to a different number of elements than its accessor's count
 * - 'index-count': the decoded triangles need a different number of indices than declared
 * - 'components': an attribute decodes to a different number of components than its type has
 * - 'component-type': the accessor's componentType can't hold the decoded values
 * - 'attribute': the Draco data has no attribute with the extension's id
 * - 'shared-accessor': one accessor is decoded more than once, to different data
 * With recoverDracoCounts, count mismatches that can be checked are recovered instead; when one
 * can't be, unrecoverable says why.
 */
export class DracoMismatchError extends Error {

	constructor( { kind, mesh, primitive, semantic, accessor, declared, decoded, unrecoverable = null } ) {

		const what = {
			'count': () => `${ semantic } decodes to ${ decoded } elements, but accessor ${ accessor } declares ${ declared }`,
			'index-count': () => `the triangles decode to ${ decoded } indices, but accessor ${ accessor } declares ${ declared }`,
			'components': () => `${ semantic } decodes to ${ decoded } components, but accessor ${ accessor } is ${ declared }`,
			'component-type': () => `${ semantic } decodes to values accessor ${ accessor } can't hold as componentType ${ declared }`,
			'attribute': () => `there is no ${ semantic } attribute with id ${ declared }`,
			'shared-accessor': () => `accessor ${ accessor } (${ semantic }) is decoded more than once, to different data`,
		}[ kind ]();
		const counts = kind === 'count' || kind === 'index-count';
		const hint = unrecoverable ? `; not recovered, as ${ unrecoverable }` : counts ? '; the recoverDracoCounts option can use the decoded count' : '';
		super( `usd-gltf: Draco mesh ${ mesh } primitive ${ primitive }: ${ what }${ hint }` );
		this.name = 'DracoMismatchError';
		this.code = 'USD_GLTF_DRACO_MISMATCH';
		Object.assign( this, { kind, mesh, primitive, semantic, accessor, declared, decoded, unrecoverable } );

	}

}

/**
 * Decodes one Draco compressed primitive. Allocations are sized by the decoded data, never by
 * the declared accessor counts, which resolveDracoAccessors checks afterwards.
 * @param {object} draco decoder module
 * @param {Uint8Array} bytes the extension's bufferView
 * @param {object} json
 * @param {{ mesh: number, index: number, primitive: object }} where the primitive and its place in the document
 * @param {import('../limits.js').Budget} budget
 * @returns {{ points: number, indexCount: number|null, data: Map<number, ArrayLike<number>> }} data is accessor index -> values, in the accessor's component type
 */
export function decodeDracoPrimitive( draco, bytes, json, { mesh, index: primitiveIndex, primitive }, budget ) {

	const ext = primitive.extensions.KHR_draco_mesh_compression;
	const decoder = new draco.Decoder();
	const array = new Int8Array( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const mismatch = ( info ) => new DracoMismatchError( { mesh, primitive: primitiveIndex, ...info } );
	const data = new Map();
	let geometry = null, points = 0, indexCount = null;

	const put = ( semantic, accessor, values ) => {

		if ( data.has( accessor ) && ! sameValues( data.get( accessor ), values ) ) throw mismatch( { kind: 'shared-accessor', semantic, accessor } );
		data.set( accessor, values );

	};

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

		points = geometry.num_points();

		for ( const [ semantic, id ] of Object.entries( ext.attributes ) ) {

			const index = primitive.attributes[ semantic ];
			const accessor = json.accessors[ index ];
			if ( accessor === undefined ) continue;
			const ArrayType = COMPONENT_ARRAYS[ accessor.componentType ];
			const size = TYPE_SIZES[ accessor.type ];
			if ( ! size ) throw new Error( `usd-gltf: accessor ${ index } has an invalid type` );
			if ( ! ArrayType ) throw mismatch( { kind: 'component-type', semantic, accessor: index, declared: accessor.componentType } );
			const attribute = decoder.GetAttributeByUniqueId( geometry, id );
			if ( ! attribute || attribute.ptr === 0 ) throw mismatch( { kind: 'attribute', semantic, accessor: index, declared: id } );
			if ( attribute.num_components() !== size ) throw mismatch( { kind: 'components', semantic, accessor: index, declared: accessor.type, decoded: attribute.num_components() } );
			put( semantic, index, read( draco, points * size, ArrayType, budget, ( length, ptr ) => decoder.GetAttributeDataArrayForAllPoints( geometry, attribute, draco[ DATA_TYPES[ accessor.componentType ] ], length, ptr ) ) );

		}

		if ( primitive.indices !== undefined && type === draco.TRIANGULAR_MESH ) {

			const accessor = json.accessors[ primitive.indices ];
			if ( ! accessor ) throw new Error( `usd-gltf: accessor ${ primitive.indices } doesn't exist` );
			indexCount = geometry.num_faces() * 3;
			const indices = read( draco, indexCount, Uint32Array, budget, ( length, ptr ) => decoder.GetTrianglesUInt32Array( geometry, length, ptr ) );
			let max = - 1;
			for ( let i = 0; i < indices.length; i ++ ) if ( indices[ i ] > max ) max = indices[ i ];
			if ( max >= points ) throw new Error( 'usd-gltf: Draco indices are out of range' );
			const IndexType = INDEX_ARRAYS[ accessor.componentType ];
			if ( ! IndexType || max > INDEX_MAX[ accessor.componentType ] ) throw mismatch( { kind: 'component-type', semantic: 'indices', accessor: primitive.indices, declared: accessor.componentType } );
			put( 'indices', primitive.indices, IndexType === Uint32Array ? indices : IndexType.from( indices ) );

		}

	} finally {

		if ( geometry ) draco.destroy( geometry );
		draco.destroy( decoder );

	}

	return { points, indexCount, data };

}

/**
 * Checks decoded primitives against their accessors and returns the accessor data. Count
 * mismatches are errors, unless recoverCounts is set and everything else that depends on those
 * counts agrees with the decoded data: then the accessors take the decoded counts, and log says so.
 * @param {object} json changed only by recovered counts
 * @param {Array<{ mesh: number, index: number, primitive: object, points: number, indexCount: number|null, data: Map<number, ArrayLike<number>> }>} decoded
 * @param {{ recoverCounts?: boolean, log?: ( message: string ) => void }} [options]
 * @returns {Map<number, ArrayLike<number>>}
 */
export function resolveDracoAccessors( json, decoded, { recoverCounts = false, log = () => {} } = {} ) {

	const out = new Map();

	for ( const d of decoded ) for ( const [ index, values ] of d.data ) {

		if ( out.has( index ) && ! sameValues( out.get( index ), values ) ) throw new DracoMismatchError( { kind: 'shared-accessor', mesh: d.mesh, primitive: d.index, semantic: semanticOf( d.primitive, index ), accessor: index } );
		out.set( index, values );

	}

	const uses = recoverCounts ? accessorUses( json ) : null;
	const recovered = new Map(); // accessor -> decoded count

	for ( const d of decoded ) {

		const { primitive } = d;
		const mismatches = [];

		for ( const semantic of Object.keys( primitive.extensions.KHR_draco_mesh_compression.attributes ) ) {

			const index = primitive.attributes[ semantic ];
			const declared = json.accessors[ index ]?.count;
			if ( index !== undefined && declared !== d.points ) mismatches.push( { kind: 'count', semantic, accessor: index, declared, decoded: d.points } );

		}

		const declaredIndices = d.indexCount !== null ? json.accessors[ primitive.indices ].count : null;
		if ( declaredIndices !== d.indexCount ) mismatches.push( { kind: 'index-count', semantic: 'indices', accessor: primitive.indices, declared: declaredIndices, decoded: d.indexCount } );

		if ( ! mismatches.length ) continue;
		const fail = ( unrecoverable ) => new DracoMismatchError( { mesh: d.mesh, primitive: d.index, ...mismatches[ 0 ], unrecoverable } );
		if ( ! recoverCounts ) throw fail( null );
		const reason = unrecoverable( json, d, mismatches, uses, out );
		if ( reason ) throw fail( reason );

		for ( const m of mismatches ) recovered.set( m.accessor, m.decoded );
		log( `Draco mesh ${ d.mesh } primitive ${ d.index }: using the decoded counts, ${ mismatches.map( ( m ) => `${ m.semantic } ${ m.decoded } where accessor ${ m.accessor } declares ${ m.declared }` ).join( ', ' ) }` );

	}

	for ( const [ index, count ] of recovered ) json.accessors[ index ].count = count;
	return out;

}

// Why a primitive's mismatched counts can't be replaced by the decoded ones, or null when they can.
function unrecoverable( json, d, mismatches, uses, decodedData ) {

	const { primitive, points } = d;
	const compressed = primitive.extensions.KHR_draco_mesh_compression.attributes;

	for ( const m of mismatches ) {

		if ( json.accessors[ m.accessor ].sparse ) return `accessor ${ m.accessor } is sparse`;
		// other Draco primitives decoding the same data are checked on their own
		const other = uses.get( m.accessor ).find( ( use ) => ! use.draco );
		if ( other ) return `accessor ${ m.accessor } is also used by ${ other.what }`;

	}

	for ( const [ semantic, index ] of Object.entries( primitive.attributes ) ) {

		const count = json.accessors[ index ]?.count;
		if ( ! ( semantic in compressed ) && count !== points ) return `${ semantic } isn't Draco compressed and has ${ count } elements, not ${ points }`;

	}

	for ( const [ t, target ] of ( primitive.targets || [] ).entries() ) {

		for ( const [ semantic, index ] of Object.entries( target ) ) {

			const count = json.accessors[ index ]?.count;
			if ( count !== points ) return `morph target ${ t } ${ semantic } has ${ count } elements, not ${ points }`;

		}

	}

	const position = primitive.attributes.POSITION;

	if ( mismatches.some( ( m ) => m.accessor === position ) ) {

		// the bounds must still describe the decoded positions, allowing for 8 bits of Draco quantization over the largest extent
		const { min, max } = json.accessors[ position ];
		if ( ! ( min?.length === 3 && max?.length === 3 ) ) return `POSITION accessor ${ position } has no min and max to check the decoded positions against`;
		const values = decodedData.get( position );
		const lo = [ Infinity, Infinity, Infinity ], hi = [ - Infinity, - Infinity, - Infinity ];

		for ( let i = 0; i < values.length; i += 3 ) for ( let c = 0; c < 3; c ++ ) {

			lo[ c ] = Math.min( lo[ c ], values[ i + c ] );
			hi[ c ] = Math.max( hi[ c ], values[ i + c ] );

		}

		const tolerance = Math.max( max[ 0 ] - min[ 0 ], max[ 1 ] - min[ 1 ], max[ 2 ] - min[ 2 ] ) / 256 + 1e-6;
		for ( let c = 0; c < 3; c ++ ) if ( ! ( Math.abs( lo[ c ] - min[ c ] ) <= tolerance && Math.abs( hi[ c ] - max[ c ] ) <= tolerance ) ) return `the decoded positions don't match POSITION accessor ${ position }'s min and max`;

	}

	return null;

}

// Every reference to each accessor, marking those a Draco extension provides.
function accessorUses( json ) {

	const uses = new Map();
	const add = ( accessor, what, draco ) => { if ( accessor !== undefined ) uses.set( accessor, [ ...( uses.get( accessor ) || [] ), { what, draco } ] ); };

	( json.meshes || [] ).forEach( ( mesh, m ) => ( mesh.primitives || [] ).forEach( ( primitive, p ) => {

		const draco = primitive.extensions?.KHR_draco_mesh_compression;
		const where = `mesh ${ m } primitive ${ p }`;
		for ( const [ semantic, a ] of Object.entries( primitive.attributes || {} ) ) add( a, `${ where } ${ semantic }`, !! draco && semantic in draco.attributes );
		add( primitive.indices, `${ where } indices`, !! draco );
		( primitive.targets || [] ).forEach( ( target, t ) => { for ( const [ semantic, a ] of Object.entries( target ) ) add( a, `${ where } morph target ${ t } ${ semantic }`, false ); } );

	} ) );

	( json.skins || [] ).forEach( ( skin, s ) => add( skin.inverseBindMatrices, `skin ${ s }`, false ) );
	( json.animations || [] ).forEach( ( animation, a ) => ( animation.samplers || [] ).forEach( ( sampler, s ) => {

		add( sampler.input, `animation ${ a } sampler ${ s }`, false );
		add( sampler.output, `animation ${ a } sampler ${ s }`, false );

	} ) );
	( json.nodes || [] ).forEach( ( node, n ) => {

		for ( const a of Object.values( node.extensions?.EXT_mesh_gpu_instancing?.attributes || {} ) ) add( a, `node ${ n } instancing`, false );

	} );

	return uses;

}

function semanticOf( primitive, accessor ) {

	if ( primitive.indices === accessor ) return 'indices';
	return Object.keys( primitive.attributes ).find( ( s ) => primitive.attributes[ s ] === accessor );

}

function sameValues( a, b ) {

	if ( a.length !== b.length || a.constructor !== b.constructor ) return false;
	for ( let i = 0; i < a.length; i ++ ) if ( ! Object.is( a[ i ], b[ i ] ) ) return false;
	return true;

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
