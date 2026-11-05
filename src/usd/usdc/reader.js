// Reads binary USD crate files (.usdc) into the Layer model.
// Layout reference: pxr/usd/sdf/crateFile.cpp in OpenUSD.

import { AssetPath, DICT_TYPES, Layer, ListOp, PrimSpec, PropertySpec, Reference } from '../model.js';
import { decompressFast } from './lz4.js';
import { decompressInts32, decompressInts64 } from './intcompression.js';
import { PERMISSIONS, POD, SCALAR_SIZE, SPEC, SPECIFIERS, TYPE, TYPE_NAMES, halfArrayToFloat32, halfToFloat, isMatrixType, isVecType } from './types.js';

const IS_ARRAY = 0x80000000;
const IS_INLINED = 0x40000000;
const IS_COMPRESSED = 0x20000000;
const IS_ARRAY_EDIT = 0x10000000;
const NO_FIELD = 0xffffffff;
const MIN_COMPRESSED_ARRAY_SIZE = 16;

const decoder = new TextDecoder();
const F32 = new Float32Array( 1 );
const U32 = new Uint32Array( F32.buffer );
const warned = new Set();

class UnsupportedType extends Error {}

function warnOnce( key, message ) {

	if ( warned.has( key ) ) return;
	warned.add( key );
	console.warn( message );

}

function version( major, minor, patch ) {

	return ( major << 16 ) | ( minor << 8 ) | patch;

}

const V0_4_0 = version( 0, 4, 0 );
const V0_5_0 = version( 0, 5, 0 );
const V0_6_0 = version( 0, 6, 0 );
const V0_7_0 = version( 0, 7, 0 );
const V0_8_0 = version( 0, 8, 0 );

class CrateReader {

	constructor( bytes ) {

		this.bytes = bytes;
		this.view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
		this.pos = 0;
		this.timesCache = new Map();

		if ( bytes.length < 88 || decoder.decode( bytes.subarray( 0, 8 ) ) !== 'PXR-USDC' ) throw new Error( 'usd-gltf: not a usdc file' );

		this.versionString = `${ bytes[ 8 ] }.${ bytes[ 9 ] }.${ bytes[ 10 ] }`;
		if ( bytes[ 8 ] !== 0 ) throw new Error( `usd-gltf: unsupported usdc version ${ this.versionString }` );
		this.version = version( bytes[ 8 ], bytes[ 9 ], bytes[ 10 ] );

		const tocOffset = this.u64At( 16 );
		if ( tocOffset >= bytes.length ) throw new Error( 'usd-gltf: truncated usdc file' );

		this.sections = {};
		const numSections = this.u64At( tocOffset );

		for ( let i = 0; i < numSections; i ++ ) {

			const p = tocOffset + 8 + i * 32;
			let end = p;
			while ( end < p + 16 && bytes[ end ] !== 0 ) end ++;
			const name = decoder.decode( bytes.subarray( p, end ) );
			this.sections[ name ] = { start: this.u64At( p + 16 ), size: this.u64At( p + 24 ) };

		}

		this.readTokens();
		this.readStrings();
		this.readFields();
		this.readFieldSets();
		this.readPaths();
		this.readSpecs();

	}

	// Primitive reads at this.pos.

	u8() {

		return this.bytes[ this.pos ++ ];

	}

	u32() {

		const v = this.view.getUint32( this.pos, true );
		this.pos += 4;
		return v;

	}

	i32() {

		const v = this.view.getInt32( this.pos, true );
		this.pos += 4;
		return v;

	}

	u64At( p ) {

		return this.view.getUint32( p, true ) + this.view.getUint32( p + 4, true ) * 4294967296;

	}

	u64() {

		const v = this.u64At( this.pos );
		this.pos += 8;
		return v;

	}

	i64() {

		const v = this.view.getUint32( this.pos, true ) + this.view.getInt32( this.pos + 4, true ) * 4294967296;
		this.pos += 8;
		return v;

	}

	f64() {

		const v = this.view.getFloat64( this.pos, true );
		this.pos += 8;
		return v;

	}

	take( n ) {

		if ( this.pos + n > this.bytes.length ) throw new Error( 'usd-gltf: truncated usdc file' );
		const b = this.bytes.subarray( this.pos, this.pos + n );
		this.pos += n;
		return b;

	}

	compressedInts( n ) {

		const size = this.u64();
		return decompressInts32( this.take( size ), n );

	}

	// Structural sections.

	section( name ) {

		const s = this.sections[ name ];
		if ( s ) this.pos = s.start;
		return s;

	}

	readTokens() {

		this.tokens = [];
		if ( ! this.section( 'TOKENS' ) ) return;

		const count = this.u64();
		let chars;

		if ( this.version < V0_4_0 ) {

			chars = this.take( this.u64() );

		} else {

			const uncompressedSize = this.u64();
			const compressedSize = this.u64();
			chars = decompressFast( this.take( compressedSize ), uncompressedSize );

		}

		let start = 0;

		for ( let i = 0; i < count && start < chars.length; i ++ ) {

			let end = chars.indexOf( 0, start );
			if ( end < 0 ) end = chars.length;
			this.tokens.push( decoder.decode( chars.subarray( start, end ) ) );
			start = end + 1;

		}

	}

	readStrings() {

		this.strings = [];
		if ( ! this.section( 'STRINGS' ) ) return;

		const count = this.u64();
		for ( let i = 0; i < count; i ++ ) this.strings.push( this.tokens[ this.u32() ] );

	}

	readFields() {

		this.fieldTokens = new Uint32Array( 0 );
		this.fieldReps = new Uint32Array( 0 ); // lo, hi pairs
		if ( ! this.section( 'FIELDS' ) ) return;

		const count = this.u64();

		if ( this.version < V0_4_0 ) {

			this.fieldTokens = new Uint32Array( count );
			this.fieldReps = new Uint32Array( count * 2 );

			for ( let i = 0; i < count; i ++ ) {

				this.pos += 4; // padding
				this.fieldTokens[ i ] = this.u32();
				this.fieldReps[ i * 2 ] = this.u32();
				this.fieldReps[ i * 2 + 1 ] = this.u32();

			}

		} else {

			this.fieldTokens = new Uint32Array( this.compressedInts( count ).buffer );
			const repsSize = this.u64();
			const reps = decompressFast( this.take( repsSize ), count * 8 );
			this.fieldReps = new Uint32Array( reps.buffer, 0, count * 2 );

		}

	}

	readFieldSets() {

		this.fieldSets = new Uint32Array( 0 );
		if ( ! this.section( 'FIELDSETS' ) ) return;

		const count = this.u64();

		if ( this.version < V0_4_0 ) {

			this.fieldSets = new Uint32Array( count );
			for ( let i = 0; i < count; i ++ ) this.fieldSets[ i ] = this.u32();

		} else {

			this.fieldSets = new Uint32Array( this.compressedInts( count ).buffer );

		}

	}

	readPaths() {

		this.paths = [];
		this.pathInfo = [];
		if ( ! this.section( 'PATHS' ) ) return;

		const numPaths = this.u64();
		this.paths = new Array( numPaths ).fill( '' );
		this.pathInfo = new Array( numPaths ).fill( null );

		if ( this.version < V0_4_0 ) {

			this.readPathTree( this.version === version( 0, 0, 1 ) ? 16 : 12 );

		} else {

			const n = this.u64();
			const pathIndexes = this.compressedInts( n );
			const elementTokens = this.compressedInts( n );
			const jumps = this.compressedInts( n );
			const stack = [ 0, - 1 ];

			while ( stack.length ) {

				let parent = stack.pop();
				let i = stack.pop();
				let hasChild, hasSibling;

				do {

					const index = i ++;
					const pathIndex = pathIndexes[ index ];
					const token = elementTokens[ index ];
					this.addPath( pathIndex, parent, token < 0 ? this.tokens[ - token ] : this.tokens[ token ], token < 0 );

					const jump = jumps[ index ];
					hasChild = jump > 0 || jump === - 1;
					hasSibling = jump >= 0;

					if ( hasChild ) {

						if ( hasSibling ) stack.push( index + jump, parent );
						parent = pathIndex;

					}

				} while ( hasChild || hasSibling );

			}

		}

	}

	// Pre 0.4.0 path trees: headers with child / sibling bits and absolute sibling offsets.
	readPathTree( headerSize ) {

		const pad = headerSize === 16 ? 4 : 0;
		const stack = [ this.pos, - 1 ];

		while ( stack.length ) {

			let parent = stack.pop();
			this.pos = stack.pop();
			let hasChild, hasSibling;

			do {

				const p = this.pos + pad;
				const pathIndex = this.view.getUint32( p, true );
				const token = this.view.getUint32( p + 4, true );
				const bits = this.bytes[ p + 8 ];
				this.pos += headerSize;

				this.addPath( pathIndex, parent, this.tokens[ token ], ( bits & 4 ) !== 0 );

				hasChild = ( bits & 1 ) !== 0;
				hasSibling = ( bits & 2 ) !== 0;

				if ( hasChild ) {

					if ( hasSibling ) stack.push( this.i64(), parent );
					parent = pathIndex;

				}

			} while ( hasChild || hasSibling );

		}

	}

	addPath( index, parent, element, isProperty ) {

		if ( index >= this.paths.length ) throw new Error( 'usd-gltf: corrupt usdc path table' );

		if ( parent < 0 ) {

			this.paths[ index ] = '/';
			this.pathInfo[ index ] = { parent: - 1, kind: 'root', name: '' };
			return;

		}

		const parentPath = this.paths[ parent ];
		const parentInfo = this.pathInfo[ parent ];
		let path, info;
		const c = element.charCodeAt( 0 );

		if ( isProperty ) {

			path = parentPath + '.' + element;
			info = { parent, kind: 'property', name: element };

		} else if ( c === 123 ) { // {set=variant}

			const eq = element.indexOf( '=' );
			path = parentPath + element;
			info = { parent, kind: 'variant', name: element.slice( eq + 1, - 1 ), set: element.slice( 1, eq ) };

		} else if ( c === 91 || c === 46 ) { // [target] or .relationalAttribute

			path = parentPath + element;
			info = { parent, kind: 'other', name: element };

		} else {

			path = parentInfo.kind === 'root' ? '/' + element : parentInfo.kind === 'variant' ? parentPath + element : parentPath + '/' + element;
			info = { parent, kind: 'prim', name: element };

		}

		this.paths[ index ] = path;
		this.pathInfo[ index ] = info;

	}

	readSpecs() {

		this.specPaths = new Uint32Array( 0 );
		this.specFieldSets = new Uint32Array( 0 );
		this.specTypes = new Uint32Array( 0 );
		if ( ! this.section( 'SPECS' ) ) return;

		const count = this.u64();

		if ( this.version < V0_4_0 ) {

			const pad = this.version === version( 0, 0, 1 ) ? 4 : 0;
			this.specPaths = new Uint32Array( count );
			this.specFieldSets = new Uint32Array( count );
			this.specTypes = new Uint32Array( count );

			for ( let i = 0; i < count; i ++ ) {

				this.pos += pad;
				this.specPaths[ i ] = this.u32();
				this.specFieldSets[ i ] = this.u32();
				this.specTypes[ i ] = this.u32();

			}

		} else {

			this.specPaths = new Uint32Array( this.compressedInts( count ).buffer );
			this.specFieldSets = new Uint32Array( this.compressedInts( count ).buffer );
			this.specTypes = new Uint32Array( this.compressedInts( count ).buffer );

		}

	}

	// Fields of spec i as [ name, lo, hi ] triples.
	specFields( i ) {

		const out = [];

		for ( let f = this.specFieldSets[ i ]; f < this.fieldSets.length; f ++ ) {

			const field = this.fieldSets[ f ];
			if ( field === NO_FIELD ) break;
			out.push( [ this.tokens[ this.fieldTokens[ field ] ], this.fieldReps[ field * 2 ], this.fieldReps[ field * 2 + 1 ] ] );

		}

		return out;

	}

	// Values.

	unpack( lo, hi ) {

		const type = ( hi >>> 16 ) & 255;

		if ( hi & IS_ARRAY_EDIT ) throw new UnsupportedType( `${ TYPE_NAMES[ type ] } array edit` );
		if ( hi & IS_ARRAY ) return this.readArray( type, ( hi & 0xffff ) * 4294967296 + lo, ( hi & IS_COMPRESSED ) !== 0 );
		if ( hi & IS_INLINED ) return this.inlined( type, lo );

		const saved = this.pos;
		this.pos = ( hi & 0xffff ) * 4294967296 + lo;
		const value = this.readValue( type );
		this.pos = saved;
		return value;

	}

	inlined( type, x ) {

		switch ( type ) {

			case TYPE.Bool: return ( x & 255 ) !== 0;
			case TYPE.UChar: return x & 255;
			case TYPE.Int: case TYPE.Int64: return x | 0;
			case TYPE.UInt: case TYPE.UInt64: return x >>> 0;
			case TYPE.Half: return halfToFloat( x );
			case TYPE.Float: case TYPE.Double: U32[ 0 ] = x; return F32[ 0 ];

			case TYPE.String: return this.strings[ x ];
			case TYPE.Token: return this.tokens[ x ];
			case TYPE.AssetPath: return new AssetPath( this.tokens[ x ] );
			case TYPE.Specifier: return SPECIFIERS[ x ];
			case TYPE.Permission: return PERMISSIONS[ x ];
			case TYPE.Variability: return x === 0 ? 'varying' : 'uniform';
			case TYPE.ValueBlock: return null;
			case TYPE.Dictionary: return makeDict( {}, {} );
			case TYPE.Vec2h: return [ halfToFloat( x & 0xffff ), halfToFloat( x >>> 16 ) ];

		}

		if ( isVecType( type ) ) {

			const n = POD[ type ][ 1 ];
			const out = [];
			for ( let i = 0; i < n; i ++ ) out.push( ( x << ( 24 - i * 8 ) ) >> 24 );
			return out;

		}

		if ( isMatrixType( type ) ) {

			const n = Math.sqrt( POD[ type ][ 1 ] );
			const out = new Array( n * n ).fill( 0 );
			for ( let i = 0; i < n; i ++ ) out[ i * n + i ] = ( x << ( 24 - i * 8 ) ) >> 24;
			return out;

		}

		throw new UnsupportedType( TYPE_NAMES[ type ] || `type ${ type }` );

	}

	scalar( kind ) {

		const v = this.view;
		const p = this.pos;
		this.pos += SCALAR_SIZE[ kind ];

		switch ( kind ) {

			case 'b': return v.getUint8( p ) !== 0;
			case 'u8': return v.getUint8( p );
			case 'i32': return v.getInt32( p, true );
			case 'u32': return v.getUint32( p, true );
			case 'i64': return v.getUint32( p, true ) + v.getInt32( p + 4, true ) * 4294967296;
			case 'u64': return v.getUint32( p, true ) + v.getUint32( p + 4, true ) * 4294967296;
			case 'f16': return halfToFloat( v.getUint16( p, true ) );
			case 'f32': return v.getFloat32( p, true );
			case 'f64': return v.getFloat64( p, true );

		}

	}

	readValue( type ) {

		const pod = POD[ type ];

		if ( pod ) {

			if ( pod[ 1 ] === 1 ) return this.scalar( pod[ 0 ] );
			const out = new Array( pod[ 1 ] );
			for ( let i = 0; i < pod[ 1 ]; i ++ ) out[ i ] = this.scalar( pod[ 0 ] );
			return out;

		}

		switch ( type ) {

			case TYPE.String: case TYPE.PathExpression: return this.strings[ this.u32() ];
			case TYPE.Token: return this.tokens[ this.u32() ];
			case TYPE.AssetPath: return new AssetPath( this.strings[ this.u32() ] );
			case TYPE.Specifier: return SPECIFIERS[ this.u32() ];
			case TYPE.Permission: return PERMISSIONS[ this.u32() ];
			case TYPE.Variability: return this.u32() === 0 ? 'varying' : 'uniform';
			case TYPE.ValueBlock: return null;
			case TYPE.Dictionary: return this.readDictionary();
			case TYPE.TokenListOp: return this.readListOp( () => this.tokens[ this.u32() ] );
			case TYPE.StringListOp: return this.readListOp( () => this.strings[ this.u32() ] );
			case TYPE.PathListOp: return this.readListOp( () => this.paths[ this.u32() ] );
			case TYPE.ReferenceListOp: return this.readListOp( () => this.readReference() );
			case TYPE.PayloadListOp: return this.readListOp( () => this.readPayload() );
			case TYPE.IntListOp: return this.readListOp( () => this.i32() );
			case TYPE.UIntListOp: return this.readListOp( () => this.u32() );
			case TYPE.Int64ListOp: return this.readListOp( () => this.i64() );
			case TYPE.UInt64ListOp: return this.readListOp( () => this.u64() );
			case TYPE.UnregisteredValueListOp: return this.readListOp( () => this.readVtValue() );
			case TYPE.PathVector: return this.readVector( () => this.paths[ this.u32() ] );
			case TYPE.TokenVector: return this.readVector( () => this.tokens[ this.u32() ] );
			case TYPE.StringVector: return this.readVector( () => this.strings[ this.u32() ] );
			case TYPE.DoubleVector: return this.readVector( () => this.f64() );
			case TYPE.LayerOffsetVector: return this.readVector( () => this.readLayerOffset() );
			case TYPE.VariantSelectionMap: {

				const out = {};
				const n = this.u64();
				for ( let i = 0; i < n; i ++ ) out[ this.strings[ this.u32() ] ] = this.strings[ this.u32() ];
				return out;

			}

			case TYPE.TimeSamples: return this.readTimeSamples();
			case TYPE.Payload: return this.readPayload();
			case TYPE.Value: case TYPE.UnregisteredValue: return this.readVtValue();
			case TYPE.Relocates: return this.readVector( () => [ this.paths[ this.u32() ], this.paths[ this.u32() ] ] );

		}

		throw new UnsupportedType( TYPE_NAMES[ type ] || `type ${ type }` );

	}

	readVector( item ) {

		const n = this.u64();
		const out = new Array( n );
		for ( let i = 0; i < n; i ++ ) out[ i ] = item();
		return out;

	}

	readListOp( item ) {

		const bits = this.u8();
		const op = new ListOp();
		if ( bits & 1 ) op.explicit = [];
		if ( bits & 2 ) op.explicit = this.readVector( item );
		if ( bits & 4 ) op.added = this.readVector( item );
		if ( bits & 32 ) op.prepended = this.readVector( item );
		if ( bits & 64 ) op.appended = this.readVector( item );
		if ( bits & 8 ) op.deleted = this.readVector( item );
		if ( bits & 16 ) op.ordered = this.readVector( item );
		return op;

	}

	readLayerOffset() {

		const offset = this.f64();
		const scale = this.f64();
		return { offset, scale };

	}

	readReference() {

		const assetPath = this.strings[ this.u32() ];
		const primPath = this.paths[ this.u32() ];
		const layerOffset = this.readLayerOffset();
		const customData = this.readDictionary();
		return new Reference( assetPath, primPath, layerOffset, Object.keys( customData ).length ? customData : null );

	}

	readPayload() {

		const assetPath = this.strings[ this.u32() ];
		const primPath = this.paths[ this.u32() ];
		const layerOffset = this.version >= V0_8_0 ? this.readLayerOffset() : { offset: 0, scale: 1 };
		return new Reference( assetPath, primPath, layerOffset );

	}

	// A nested VtValue: an int64 forward offset to its ValueRep, which follows any nested data.
	readVtValue( types = null, key = null ) {

		const start = this.pos;
		this.pos = start + this.i64();
		const lo = this.u32();
		const hi = this.u32();
		if ( types ) types[ key ] = typeNameOf( lo, hi );
		return this.unpack( lo, hi );

	}

	readDictionary() {

		const dict = {};
		const types = {};
		const n = this.u64();

		for ( let i = 0; i < n; i ++ ) {

			const key = this.strings[ this.u32() ];

			try {

				dict[ key ] = this.readVtValue( types, key );

			} catch ( e ) {

				if ( ! ( e instanceof UnsupportedType ) ) throw e;
				delete types[ key ];
				warnOnce( e.message, `usd-gltf: skipping unsupported usdc value type ${ e.message }` );

			}

		}

		return makeDict( dict, types );

	}

	readTimeSamples() {

		let start = this.pos;
		this.pos = start + this.i64();
		const timesLo = this.u32();
		const timesHi = this.u32();
		const key = timesLo + ',' + timesHi;
		let times = this.timesCache.get( key );

		if ( times === undefined ) {

			times = this.unpack( timesLo, timesHi );
			this.timesCache.set( key, times );

		}

		start = this.pos;
		this.pos = start + this.i64();
		const n = this.u64();
		const samples = new Map();

		for ( let i = 0; i < n; i ++ ) {

			const lo = this.u32();
			const hi = this.u32();
			samples.set( times[ i ], this.unpack( lo, hi ) );

		}

		return samples;

	}

	readArray( type, payload, compressed ) {

		const pod = POD[ type ];

		if ( payload === 0 ) return pod && pod[ 0 ] !== 'b' ? typedArrayFor( pod[ 0 ], 0 ) : [];

		const saved = this.pos;
		this.pos = payload;
		if ( this.version < V0_5_0 ) this.pos += 4; // shape rank
		const n = this.version < V0_7_0 ? this.u32() : this.u64();
		let out;

		if ( pod ) {

			const kind = pod[ 0 ];
			const count = n * pod[ 1 ];

			if ( compressed && pod[ 1 ] === 1 && n >= MIN_COMPRESSED_ARRAY_SIZE && ( kind === 'i32' || kind === 'u32' || kind === 'i64' || kind === 'u64' ) && this.version >= V0_5_0 ) {

				const size = this.u64();
				const data = this.take( size );
				if ( kind === 'i32' ) out = decompressInts32( data, n );
				else if ( kind === 'u32' ) out = new Uint32Array( decompressInts32( data, n ).buffer );
				else out = decompressInts64( data, n, kind === 'u64' );

			} else if ( compressed && pod[ 1 ] === 1 && n >= MIN_COMPRESSED_ARRAY_SIZE && ( kind === 'f16' || kind === 'f32' || kind === 'f64' ) && this.version >= V0_6_0 ) {

				out = this.readCompressedFloats( kind, n );

			} else {

				out = this.readRawArray( kind, count );

			}

		} else {

			switch ( type ) {

				case TYPE.String: case TYPE.PathExpression: out = this.readArrayItems( n, () => this.strings[ this.u32() ] ); break;
				case TYPE.Token: out = this.readArrayItems( n, () => this.tokens[ this.u32() ] ); break;
				case TYPE.AssetPath: out = this.readArrayItems( n, () => new AssetPath( this.strings[ this.u32() ] ) ); break;
				default:
					this.pos = saved;
					throw new UnsupportedType( `${ TYPE_NAMES[ type ] || type }[]` );

			}

		}

		this.pos = saved;
		return out;

	}

	readArrayItems( n, item ) {

		const out = new Array( n );
		for ( let i = 0; i < n; i ++ ) out[ i ] = item();
		return out;

	}

	readRawArray( kind, count ) {

		const size = SCALAR_SIZE[ kind ];
		const bytes = this.take( count * size ).slice(); // copy, also aligns

		switch ( kind ) {

			case 'b': return Array.from( bytes, ( b ) => b !== 0 );
			case 'u8': return bytes;
			case 'i32': return new Int32Array( bytes.buffer );
			case 'u32': return new Uint32Array( bytes.buffer );
			case 'f16': return halfArrayToFloat32( new Uint16Array( bytes.buffer ) );
			case 'f32': return new Float32Array( bytes.buffer );
			case 'f64': return new Float64Array( bytes.buffer );
			case 'i64': case 'u64': {

				const u = new Uint32Array( bytes.buffer );
				const out = new Float64Array( count );

				for ( let i = 0; i < count; i ++ ) {

					const hi = kind === 'i64' ? u[ i * 2 + 1 ] | 0 : u[ i * 2 + 1 ];
					out[ i ] = hi * 4294967296 + u[ i * 2 ];

				}

				return out;

			}

		}

	}

	readCompressedFloats( kind, n ) {

		const code = this.u8();
		const out = typedArrayFor( kind, n );

		if ( code === 105 ) { // 'i': integers

			const ints = this.compressedInts( n );
			for ( let i = 0; i < n; i ++ ) out[ i ] = ints[ i ];

		} else if ( code === 116 ) { // 't': lookup table and indexes

			const lutSize = this.u32();
			const lut = this.readRawArray( kind, lutSize );
			const indexes = this.compressedInts( n );
			for ( let i = 0; i < n; i ++ ) out[ i ] = lut[ indexes[ i ] >>> 0 ];

		} else {

			throw new Error( 'usd-gltf: corrupt compressed array in usdc file' );

		}

		return out;

	}

}

function typedArrayFor( kind, n ) {

	switch ( kind ) {

		case 'u8': return new Uint8Array( n );
		case 'i32': return new Int32Array( n );
		case 'u32': return new Uint32Array( n );
		case 'f16': case 'f32': return new Float32Array( n );
		default: return new Float64Array( n );

	}

}

function makeDict( dict, types ) {

	Object.defineProperty( dict, DICT_TYPES, { value: types } );
	return dict;

}

// USD type name of a value rep, for DICT_TYPES.
function typeNameOf( lo, hi ) {

	const type = ( hi >>> 16 ) & 255;
	const array = ( hi & IS_ARRAY ) !== 0 ? '[]' : '';
	if ( POD[ type ] ) return POD[ type ][ 2 ] + array;

	switch ( type ) {

		case TYPE.String: return 'string' + array;
		case TYPE.Token: return 'token' + array;
		case TYPE.AssetPath: return 'asset' + array;
		case TYPE.PathExpression: return 'pathExpression' + array;
		case TYPE.Dictionary: return 'dictionary';
		case TYPE.TokenVector: return 'token[]';
		case TYPE.StringVector: return 'string[]';
		case TYPE.DoubleVector: return 'double[]';
		case TYPE.PathVector: return 'path[]';
		default: return TYPE_NAMES[ type ];

	}

}

function reorder( map, names ) {

	if ( ! Array.isArray( names ) ) return map;
	const out = new Map();

	for ( const name of names ) {

		if ( map.has( name ) ) out.set( name, map.get( name ) );

	}

	for ( const [ name, value ] of map ) if ( ! out.has( name ) ) out.set( name, value );
	return out;

}

function payloadListOp( value ) {

	if ( value instanceof Reference ) return value.assetPath ? ListOp.explicit( [ value ] ) : ListOp.explicit( [] );
	return value;

}

/**
 * Reads a binary USD crate file.
 * @param {Uint8Array|ArrayBuffer} data
 * @param {string} [identifier]
 * @returns {Layer}
 */
export function readUSDC( data, identifier = 'anon.usdc' ) {

	// a plain view, so subarray().slice() copies even for a Node Buffer
	const bytes = ArrayBuffer.isView( data ) ? new Uint8Array( data.buffer, data.byteOffset, data.byteLength ) : new Uint8Array( data );
	const crate = new CrateReader( bytes );
	const layer = new Layer( identifier );

	const specs = new Map(); // path index -> { type, object, order }
	const count = crate.specTypes.length;

	for ( let i = 0; i < count; i ++ ) {

		const pathIndex = crate.specPaths[ i ];
		const info = crate.pathInfo[ pathIndex ];
		const type = crate.specTypes[ i ];
		if ( ! info ) continue;

		const entry = { type, info, object: null, order: {} };
		const fields = [];

		for ( const [ name, lo, hi ] of crate.specFields( i ) ) {

			try {

				fields.push( [ name, crate.unpack( lo, hi ) ] );

			} catch ( e ) {

				if ( ! ( e instanceof UnsupportedType ) ) throw e;
				warnOnce( e.message, `usd-gltf: skipping unsupported usdc value type ${ e.message } (field '${ name }')` );

			}

		}

		if ( type === SPEC.PseudoRoot ) {

			entry.object = layer.root;

			for ( const [ name, value ] of fields ) {

				if ( name === 'primChildren' ) entry.order.children = value;
				else if ( name === 'documentation' ) layer.metadata.doc = value;
				else if ( name === 'primOrder' ) layer.root.metadata.primOrder = value;
				else layer.metadata[ name ] = value;

			}

		} else if ( type === SPEC.Prim || type === SPEC.Variant ) {

			const prim = new PrimSpec( info.name, 'over', '' ); // Sdf's fallback specifier is over
			entry.object = prim;

			for ( const [ name, value ] of fields ) {

				switch ( name ) {

					case 'specifier': prim.specifier = value; break;
					case 'typeName': prim.typeName = value; break;
					case 'primChildren': entry.order.children = value; break;
					case 'properties': entry.order.properties = value; break;
					case 'variantSetChildren': entry.order.variantSets = value; break;
					case 'variantSelection': prim.metadata.variants = value; break;
					case 'inheritPaths': prim.metadata.inherits = value; break;
					case 'payload': prim.metadata.payload = payloadListOp( value ); break;
					default: prim.metadata[ name ] = value;

				}

			}

		} else if ( type === SPEC.Attribute || type === SPEC.Relationship ) {

			const prop = new PropertySpec( info.name, type === SPEC.Attribute ? 'attribute' : 'relationship' );
			entry.object = prop;

			for ( const [ name, value ] of fields ) {

				switch ( name ) {

					case 'typeName': prop.typeName = value; break;
					case 'variability': prop.variability = value; break;
					case 'custom': prop.custom = value; break;
					case 'default': prop.default = value; break;
					case 'timeSamples': prop.timeSamples = value; break;
					case 'connectionPaths': prop.connections = value; break;
					case 'targetPaths': prop.targets = value; break;
					case 'connectionChildren': case 'targetChildren': break;
					default: prop.metadata[ name ] = value;

				}

			}

		} else if ( type === SPEC.VariantSet ) {

			for ( const [ name, value ] of fields ) if ( name === 'variantChildren' ) entry.order.variants = value;

		} else {

			continue;

		}

		specs.set( pathIndex, entry );

	}

	// Attach specs to their parents.
	for ( const entry of specs.values() ) {

		const { info, object } = entry;
		const parent = specs.get( info.parent );
		if ( ! parent || ! parent.object || ! ( parent.object instanceof PrimSpec ) ) continue;
		const prim = parent.object;

		if ( entry.type === SPEC.Prim ) {

			prim.children.set( info.name, object );

		} else if ( entry.type === SPEC.Attribute || entry.type === SPEC.Relationship ) {

			prim.properties.set( info.name, object );

		} else if ( entry.type === SPEC.Variant || entry.type === SPEC.VariantSet ) {

			let set = prim.variantSets.get( info.set );
			if ( ! set ) prim.variantSets.set( info.set, set = new Map() );
			if ( entry.type === SPEC.Variant ) set.set( info.name, object );
			else entry.set = set;

		}

	}

	// Apply the authored child orders.
	for ( const entry of specs.values() ) {

		const { order, object } = entry;

		if ( entry.type === SPEC.VariantSet ) {

			if ( order.variants && entry.set ) {

				const prim = specs.get( entry.info.parent ).object;
				prim.variantSets.set( entry.info.set, reorder( entry.set, order.variants ) );

			}

			continue;

		}

		if ( ! ( object instanceof PrimSpec ) ) continue;
		if ( order.children ) object.children = reorder( object.children, order.children );
		if ( order.properties ) object.properties = reorder( object.properties, order.properties );
		if ( order.variantSets ) object.variantSets = reorder( object.variantSets, order.variantSets );

	}

	return layer;

}

export { CrateReader };
