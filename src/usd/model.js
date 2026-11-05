// The uncomposed USD data model shared by the usda and usdc readers and writers.
//
// A Layer holds the opinions of one file. Values are plain JavaScript, typed by the
// property's typeName rather than by the value itself:
//
//   bool                         boolean
//   uchar int uint int64 uint64  number
//   half float double timecode   number
//   string token                 string
//   asset                        AssetPath
//   vectors, colors, points...   number[]            e.g. float3 -> [ x, y, z ]
//   quath quatf quatd            number[4]           [ x, y, z, w ] (imaginary first, like glTF)
//   matrix2d matrix3d matrix4d   number[4|9|16]      row major, as written in usda
//   dictionary                   plain object
//
// Arrays (typeName ending in []) of numeric types are flat typed arrays:
// half and float based types -> Float32Array, double and timecode -> Float64Array,
// int -> Int32Array, uint -> Uint32Array, uchar -> Uint8Array, int64 and uint64 -> Float64Array.
// So point3f[] is a Float32Array of length 3n, matrix4d[] a Float64Array of length 16n and
// quatf[] a Float32Array of length 4n in [ x, y, z, w ] order. Arrays of bool, string, token
// and asset are plain Arrays.
//
// A value of null is a value block (None). undefined means no opinion.

// Dictionaries are plain objects. Value types that can't be inferred from the JS value (token vs string,
// float vs double, vectors...) can be recorded under this symbol as { key: typeName }.
export const DICT_TYPES = Symbol( 'usd-gltf.dictTypes' );

export class AssetPath {

	constructor( path, resolved = null ) {

		this.path = path; // as authored
		this.resolved = resolved; // filled in by composition, relative to the package or root file

	}

}

// Sdf list op. When explicit is non null the other lists are ignored.
export class ListOp {

	constructor( { explicit = null, prepended = [], appended = [], deleted = [], added = [], ordered = [] } = {} ) {

		this.explicit = explicit;
		this.prepended = prepended;
		this.appended = appended;
		this.deleted = deleted;
		this.added = added;
		this.ordered = ordered;

	}

	static explicit( items ) {

		return new ListOp( { explicit: items } );

	}

	isEmpty() {

		return this.explicit === null && ! this.prepended.length && ! this.appended.length && ! this.deleted.length && ! this.added.length && ! this.ordered.length;

	}

	// Applies this op over the weaker list and returns the result.
	apply( weaker = [], key = ( x ) => x ) {

		if ( this.explicit !== null ) return this.explicit.slice();

		const deleted = new Set( this.deleted.map( key ) );
		const front = new Set( this.prepended.map( key ) );
		const back = new Set( this.appended.map( key ) );
		const middle = weaker.filter( ( x ) => ! deleted.has( key( x ) ) && ! front.has( key( x ) ) && ! back.has( key( x ) ) );
		const result = [ ...this.prepended, ...middle, ...this.appended ];

		for ( const item of this.added ) if ( ! result.some( ( x ) => key( x ) === key( item ) ) ) result.push( item );

		return result;

	}

}

// A reference or payload arc. primPath is '' to target the layer's defaultPrim.
export class Reference {

	constructor( assetPath = '', primPath = '', layerOffset = { offset: 0, scale: 1 }, customData = null ) {

		this.assetPath = assetPath;
		this.primPath = primPath;
		this.layerOffset = layerOffset;
		this.customData = customData;

	}

}

export class PropertySpec {

	constructor( name, type = 'attribute' ) {

		this.name = name; // full namespaced name, e.g. 'primvars:st'
		this.type = type; // 'attribute' or 'relationship'
		this.typeName = ''; // attributes only, e.g. 'point3f[]'
		this.variability = 'varying'; // or 'uniform'
		this.custom = false;
		this.default = undefined;
		this.timeSamples = null; // Map<number, value>
		this.connections = null; // ListOp of property paths (attributes)
		this.targets = null; // ListOp of paths (relationships)
		this.metadata = {}; // interpolation, elementSize, colorSpace, customData, ...

	}

}

export class PrimSpec {

	constructor( name = '', specifier = 'def', typeName = '' ) {

		this.name = name;
		this.specifier = specifier; // 'def', 'over' or 'class'
		this.typeName = typeName;
		this.metadata = {}; // kind, active, apiSchemas, references, payload, inherits, specializes, variants, variantSetNames, ...
		this.properties = new Map(); // name -> PropertySpec, in authored order
		this.children = new Map(); // name -> PrimSpec, in authored order
		this.variantSets = new Map(); // set name -> Map( variant name -> PrimSpec holding that variant's opinions )

	}

	getChild( name ) {

		return this.children.get( name );

	}

	addChild( spec ) {

		this.children.set( spec.name, spec );
		return spec;

	}

	addProperty( spec ) {

		this.properties.set( spec.name, spec );
		return spec;

	}

}

export class Layer {

	constructor( identifier = 'anon.usda' ) {

		this.identifier = identifier; // path of the file, used to resolve relative asset paths
		this.metadata = {}; // defaultPrim, upAxis, metersPerUnit, timeCodesPerSecond, startTimeCode, endTimeCode, subLayers, subLayerOffsets, doc, ...
		this.root = new PrimSpec( '', 'def', '' ); // pseudo root; its children are the root prims

	}

	// Finds a prim spec by absolute path like '/World/Mesh', or '/World{shading=red}Mesh' through variants.
	getPrimAtPath( path ) {

		let spec = this.root;

		for ( const part of splitPrimPath( path ) ) {

			if ( part.variantSet ) {

				spec = spec.variantSets.get( part.variantSet )?.get( part.variant );

			} else {

				spec = spec.children.get( part.name );

			}

			if ( ! spec ) return null;

		}

		return spec;

	}

}

// '/A/B{set=sel}C' -> [ { name: 'A' }, { name: 'B' }, { variantSet: 'set', variant: 'sel' }, { name: 'C' } ]
export function splitPrimPath( path ) {

	const parts = [];
	const re = /\{([^=}]*)=([^}]*)\}|([^/{}]+)/g;
	let m;

	while ( ( m = re.exec( path ) ) ) {

		if ( m[ 3 ] !== undefined ) parts.push( { name: m[ 3 ] } );
		else parts.push( { variantSet: m[ 1 ], variant: m[ 2 ] } );

	}

	return parts;

}

const FLOAT_ARRAY = /^(half|float|point3[hf]|normal3[hf]|vector3[hf]|color[34][hf]|texCoord[23][hf]|quat[hf])/;
const DOUBLE_ARRAY = /^(double|timecode|point3d|normal3d|vector3d|color[34]d|texCoord[23]d|quatd|matrix[234]d|frame4d)/;

// The typed array constructor used for an array typeName like 'point3f[]', or null for plain Arrays.
export function arrayTypeFor( typeName ) {

	const base = typeName.replace( /\[\]$/, '' );
	if ( FLOAT_ARRAY.test( base ) ) return Float32Array;
	if ( DOUBLE_ARRAY.test( base ) ) return Float64Array;
	if ( /^int[234]?$/.test( base ) ) return Int32Array;
	if ( base === 'uint' ) return Uint32Array;
	if ( base === 'uchar' ) return Uint8Array;
	if ( base === 'int64' || base === 'uint64' ) return Float64Array;
	return null;

}

// Number of scalar components in one element of a type, e.g. point3f -> 3, matrix4d -> 16.
export function componentCount( typeName ) {

	const base = typeName.replace( /\[\]$/, '' );
	let m;
	if ( ( m = /^matrix([234])d$/.exec( base ) ) ) return m[ 1 ] * m[ 1 ];
	if ( base === 'frame4d' ) return 16;
	if ( /^quat[hfd]$/.test( base ) ) return 4;
	if ( ( m = /([234])[hfdi]$|^(?:half|float|double|int)([234])$/.exec( base ) ) ) return + ( m[ 1 ] || m[ 2 ] );
	return 1;

}
