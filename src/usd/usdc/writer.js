// Writes the Layer model as a binary USD crate file (.usdc), version 0.8.0 or later.
// Layout reference: pxr/usd/sdf/crateFile.cpp in OpenUSD.

import { AssetPath, DICT_TYPES, ListOp, Reference } from '../model.js';
import { compressFast } from './lz4.js';
import { compressInts32 } from './intcompression.js';
import { Budget } from '../../limits.js';
import { PERMISSIONS, POD, SPEC, SPECIFIERS, TYPE, crateTypeFor, floatToHalf, halfToFloat, isMatrixType, isVecType } from './types.js';

const IS_ARRAY = 0x80000000;
const IS_INLINED = 0x40000000;
const IS_COMPRESSED = 0x20000000;
const MIN_COMPRESSED_ARRAY_SIZE = 16;
const TWO32 = 4294967296;

const encoder = new TextEncoder();
const F32 = new Float32Array( 1 );
const U32 = new Uint32Array( F32.buffer );

// Crate types of the metadata fields the model stores without a typeName.
const FIELD_TYPES = {
	defaultPrim: TYPE.Token, upAxis: TYPE.Token, kind: TYPE.Token, interpolation: TYPE.Token, colorSpace: TYPE.Token,
	connectability: TYPE.Token, renderType: TYPE.Token, symmetryFunction: TYPE.Token, colorManagementSystem: TYPE.Token,
	outputName: TYPE.Token, bindMaterialAs: TYPE.Token,
	metersPerUnit: TYPE.Double, kilogramsPerUnit: TYPE.Double, timeCodesPerSecond: TYPE.Double, framesPerSecond: TYPE.Double,
	startTimeCode: TYPE.Double, endTimeCode: TYPE.Double,
	documentation: TYPE.String, comment: TYPE.String, displayName: TYPE.String, displayGroup: TYPE.String, owner: TYPE.String,
	sessionOwner: TYPE.String, symmetricPeer: TYPE.String, renderSettingsPrimPath: TYPE.String,
	active: TYPE.Bool, hidden: TYPE.Bool, instanceable: TYPE.Bool, hasOwnedSubLayers: TYPE.Bool,
	elementSize: TYPE.Int, framePrecision: TYPE.Int,
	customData: TYPE.Dictionary, assetInfo: TYPE.Dictionary, customLayerData: TYPE.Dictionary, clips: TYPE.Dictionary,
	prefixSubstitutions: TYPE.Dictionary, suffixSubstitutions: TYPE.Dictionary, symmetryArguments: TYPE.Dictionary,
	sdrMetadata: TYPE.Dictionary, expressionVariables: TYPE.Dictionary,
	apiSchemas: TYPE.TokenListOp, variantSetNames: TYPE.StringListOp, clipSets: TYPE.StringListOp,
	inheritPaths: TYPE.PathListOp, specializes: TYPE.PathListOp,
	references: TYPE.ReferenceListOp, payload: TYPE.PayloadListOp,
	primOrder: TYPE.TokenVector, propertyOrder: TYPE.TokenVector, subLayers: TYPE.StringVector,
	subLayerOffsets: TYPE.LayerOffsetVector, variantSelection: TYPE.VariantSelectionMap,
	permission: TYPE.Permission, colorConfiguration: TYPE.AssetPath, relocates: TYPE.Relocates, layerRelocates: TYPE.Relocates
};

// Fields stored as arrays (VtArray) rather than vectors.
const ARRAY_FIELDS = { allowedTokens: TYPE.Token };

// Model metadata keys that differ from the Sdf field names.
const FIELD_NAMES = { doc: 'documentation', inherits: 'inheritPaths', variants: 'variantSelection' };

const VERSION_FOR = { [ TYPE.TimeCode ]: 9, [ TYPE.PathExpression ]: 10, [ TYPE.Relocates ]: 11, [ TYPE.Duration ]: 16 };

function isPlainObject( v ) {

	return v !== null && typeof v === 'object' && ! Array.isArray( v ) && ! ArrayBuffer.isView( v ) && ! ( v instanceof AssetPath ) && ! ( v instanceof ListOp ) && ! ( v instanceof Reference ) && ! ( v instanceof Map );

}

// Best guess at a crate type for a value with no declared type: [ type, isArray ].
function inferType( v ) {

	if ( v === null ) return [ TYPE.ValueBlock, false ];
	if ( typeof v === 'boolean' ) return [ TYPE.Bool, false ];
	if ( typeof v === 'string' ) return [ TYPE.String, false ];
	if ( typeof v === 'number' ) return [ Number.isInteger( v ) && v >= - 2147483648 && v <= 2147483647 ? TYPE.Int : TYPE.Double, false ];
	if ( v instanceof AssetPath ) return [ TYPE.AssetPath, false ];
	if ( v instanceof Float32Array ) return [ TYPE.Float, true ];
	if ( v instanceof Int32Array ) return [ TYPE.Int, true ];
	if ( v instanceof Uint32Array ) return [ TYPE.UInt, true ];
	if ( v instanceof Uint8Array ) return [ TYPE.UChar, true ];
	if ( ArrayBuffer.isView( v ) ) return [ TYPE.Double, true ];

	if ( v instanceof ListOp ) {

		const items = [ ...( v.explicit || [] ), ...v.prepended, ...v.appended, ...v.added, ...v.deleted, ...v.ordered ];
		const first = items[ 0 ];
		if ( first instanceof Reference ) return [ TYPE.ReferenceListOp, false ];
		if ( typeof first === 'number' ) return [ items.every( Number.isInteger ) ? TYPE.Int64ListOp : TYPE.UnregisteredValueListOp, false ];
		return [ TYPE.TokenListOp, false ];

	}

	if ( Array.isArray( v ) ) {

		const first = v[ 0 ];
		if ( typeof first === 'string' ) return [ TYPE.String, true ];
		if ( typeof first === 'boolean' ) return [ TYPE.Bool, true ];
		if ( first instanceof AssetPath ) return [ TYPE.AssetPath, true ];
		if ( v.length >= 2 && v.length <= 4 && v.every( ( x ) => typeof x === 'number' ) ) return [ TYPE[ `Vec${ v.length }d` ], false ];
		return [ TYPE.Double, true ];

	}

	if ( isPlainObject( v ) ) return [ TYPE.Dictionary, false ];
	return [ - 1, false ];

}

// [ type, isArray ] for a USD type name like 'float3[]'.
function typeFromName( typeName ) {

	const isArray = typeName.endsWith( '[]' );
	return [ crateTypeFor( isArray ? typeName.slice( 0, - 2 ) : typeName ), isArray ];

}

// Splits '/A/B{v=x}C.prop' into [ element, isProperty ] pairs.
function pathElements( path ) {

	const out = [];
	const n = path.length;
	let i = path.charCodeAt( 0 ) === 47 ? 1 : 0;
	let sawProperty = false;

	while ( i < n ) {

		const c = path[ i ];

		if ( c === '/' ) {

			i ++;

		} else if ( c === '{' || c === '[' ) {

			const close = path.indexOf( c === '{' ? '}' : ']', i );
			const end = close < 0 ? n : close + 1;
			out.push( [ path.slice( i, end ), false ] );
			i = end;

		} else if ( c === '.' ) {

			let j = i + 1;
			while ( j < n && path[ j ] !== '[' && ( ! sawProperty || path[ j ] !== '.' ) ) j ++;
			out.push( sawProperty ? [ path.slice( i, j ), false ] : [ path.slice( i + 1, j ), true ] );
			sawProperty = true;
			i = j;

		} else {

			let j = i;
			while ( j < n && path[ j ] !== '/' && path[ j ] !== '{' && path[ j ] !== '.' && path[ j ] !== '[' ) j ++;
			out.push( [ path.slice( i, j ), false ] );
			i = j;

		}

	}

	return out;

}

class CrateWriter {

	constructor( budget = new Budget() ) {

		this.budget = budget;
		this.buf = new Uint8Array( 1 << 16 );
		this.view = new DataView( this.buf.buffer );
		this.pos = 88; // bootstrap, written last
		this.minor = 8;

		this.tokens = [];
		this.tokenIndex = new Map();
		this.strings = [];
		this.stringIndex = new Map();
		this.addToken( '' ); // index 0, so negated property token indexes are never -0

		this.pathCount = 0;
		this.pathIndex = new Map();
		this.pathRoot = { index: this.pathCount ++, token: 0, isProperty: false, children: new Map() };
		this.pathIndex.set( '/', this.pathRoot.index );

		this.fieldTokens = [];
		this.fieldReps = [];
		this.fieldIndex = new Map();
		this.fieldSets = [];
		this.fieldSetIndex = new Map();
		this.specs = [];
		this.timesCache = new Map();
		this.arrayCache = new Map(); // hash -> [ { values, type, rep } ], so identical arrays are written once

	}

	// Output buffer.

	ensure( n ) {

		if ( this.pos + n <= this.buf.length ) return;
		this.budget.output( this.pos + n, 'usdc' );
		let size = this.buf.length * 2;
		while ( size < this.pos + n ) size *= 2;
		size = Math.min( size, Math.max( this.pos + n, this.budget.maxOutputBytes ) );
		const buf = new Uint8Array( size );
		buf.set( this.buf );
		this.buf = buf;
		this.view = new DataView( buf.buffer );

	}

	u8( v ) {

		this.ensure( 1 );
		this.buf[ this.pos ++ ] = v;

	}

	u32( v ) {

		this.ensure( 4 );
		this.view.setUint32( this.pos, v, true );
		this.pos += 4;

	}

	i32( v ) {

		this.ensure( 4 );
		this.view.setInt32( this.pos, v, true );
		this.pos += 4;

	}

	u64( v ) {

		this.ensure( 8 );
		this.view.setUint32( this.pos, v % TWO32, true );
		this.view.setUint32( this.pos + 4, Math.floor( v / TWO32 ), true );
		this.pos += 8;

	}

	i64( v ) {

		const hi = Math.floor( v / TWO32 );
		this.ensure( 8 );
		this.view.setUint32( this.pos, v - hi * TWO32, true );
		this.view.setInt32( this.pos + 4, hi, true );
		this.pos += 8;

	}

	f64( v ) {

		this.ensure( 8 );
		this.view.setFloat64( this.pos, v, true );
		this.pos += 8;

	}

	bytes( b ) {

		this.ensure( b.length );
		this.buf.set( b, this.pos );
		this.pos += b.length;

	}

	align( n ) {

		const pad = ( n - ( this.pos % n ) ) % n;
		this.ensure( pad );
		this.buf.fill( 0, this.pos, this.pos + pad );
		this.pos += pad;

	}

	rep( lo, hi ) {

		this.u32( lo );
		this.u32( hi );

	}

	// Tables.

	addToken( s ) {

		let i = this.tokenIndex.get( s );

		if ( i === undefined ) {

			i = this.tokens.length;
			this.tokens.push( s );
			this.tokenIndex.set( s, i );

		}

		return i;

	}

	addString( s ) {

		let i = this.stringIndex.get( s );

		if ( i === undefined ) {

			i = this.strings.length;
			this.strings.push( this.addToken( s ) );
			this.stringIndex.set( s, i );

		}

		return i;

	}

	addPath( path ) {

		let index = this.pathIndex.get( path );
		if ( index !== undefined ) return index;

		if ( path === '' ) {

			// the empty path gets an index but is not encoded in the path tree
			index = this.pathCount ++;
			this.pathIndex.set( path, index );
			return index;

		}

		let node = this.pathRoot;

		for ( const [ element, isProperty ] of pathElements( path ) ) {

			const key = ( isProperty ? '.' : '' ) + element;
			let child = node.children.get( key );

			if ( ! child ) {

				child = { index: this.pathCount ++, token: this.addToken( element ), isProperty, children: new Map() };
				node.children.set( key, child );

			}

			node = child;

		}

		this.pathIndex.set( path, node.index );
		return node.index;

	}

	addSpec( path, specType, fields ) {

		this.budget.check();
		const indexes = [];

		for ( const [ name, [ lo, hi ] ] of fields ) {

			const token = this.addToken( name );
			const key = token + ':' + lo + ':' + hi;
			let index = this.fieldIndex.get( key );

			if ( index === undefined ) {

				index = this.fieldTokens.length;
				this.fieldTokens.push( token );
				this.fieldReps.push( lo, hi );
				this.fieldIndex.set( key, index );

			}

			indexes.push( index );

		}

		const key = indexes.join( ',' );
		let fieldSet = this.fieldSetIndex.get( key );

		if ( fieldSet === undefined ) {

			fieldSet = this.fieldSets.length;
			this.fieldSets.push( ...indexes, 0xffffffff );
			this.fieldSetIndex.set( key, fieldSet );

		}

		this.specs.push( this.addPath( path ), fieldSet, specType );

	}

	// Values. pack() returns a ValueRep as [ lo, hi ], writing any out of line data first.

	pack( value, type, isArray = false ) {

		if ( value === null ) return [ 0, ( IS_INLINED | ( TYPE.ValueBlock << 16 ) ) >>> 0 ];
		if ( VERSION_FOR[ type ] ) this.minor = Math.max( this.minor, VERSION_FOR[ type ] );
		if ( isArray ) return this.packArray( value, type );

		const inlined = ( payload ) => [ payload >>> 0, ( IS_INLINED | ( type << 16 ) ) >>> 0 ];
		const at = ( pos ) => [ pos % TWO32, ( ( type << 16 ) | Math.floor( pos / TWO32 ) ) >>> 0 ];

		switch ( type ) {

			case TYPE.Bool: return inlined( value ? 1 : 0 );
			case TYPE.UChar: return inlined( value & 255 );
			case TYPE.Int: return inlined( value | 0 );
			case TYPE.UInt: return inlined( value >>> 0 );
			case TYPE.Half: return inlined( floatToHalf( value ) );
			case TYPE.Float: F32[ 0 ] = value; return inlined( U32[ 0 ] );
			case TYPE.String: return inlined( this.addString( String( value ) ) );
			case TYPE.Token: return inlined( this.addToken( String( value ) ) );
			case TYPE.AssetPath: return inlined( this.addToken( assetPathString( value ) ) );
			case TYPE.Specifier: return inlined( Math.max( 0, SPECIFIERS.indexOf( value ) ) );
			case TYPE.Permission: return inlined( Math.max( 0, PERMISSIONS.indexOf( value ) ) );
			case TYPE.Variability: return inlined( value === 'uniform' ? 1 : 0 );
			case TYPE.ValueBlock: return inlined( 0 );
			case TYPE.Vec2h: return inlined( floatToHalf( value[ 0 ] ) | ( floatToHalf( value[ 1 ] ) << 16 ) );

			case TYPE.Double: {

				if ( Math.fround( value ) === value || Number.isNaN( value ) ) {

					F32[ 0 ] = value;
					return [ U32[ 0 ], ( IS_INLINED | ( type << 16 ) ) >>> 0 ];

				}

				const pos = this.pos;
				this.f64( value );
				return at( pos );

			}

			case TYPE.Int64: case TYPE.UInt64: {

				const signed = type === TYPE.Int64;
				if ( Number.isInteger( value ) && ( signed ? value >= - 2147483648 && value <= 2147483647 : value >= 0 && value <= 4294967295 ) ) return [ value >>> 0, ( IS_INLINED | ( type << 16 ) ) >>> 0 ];
				const pos = this.pos;
				if ( signed ) this.i64( value );
				else this.u64( value );
				return at( pos );

			}

			case TYPE.Dictionary: {

				if ( ! value || Object.keys( value ).length === 0 ) return [ 0, ( IS_INLINED | ( type << 16 ) ) >>> 0 ];
				const pos = this.pos;
				this.writeDictionary( value );
				return at( pos );

			}

		}

		// vectors with int8 components and diagonal int8 matrices are inlined
		if ( isVecType( type ) ) {

			const n = POD[ type ][ 1 ];
			let ok = true;
			for ( let i = 0; i < n && ok; i ++ ) ok = isInt8( value[ i ] );

			if ( ok ) {

				let bits = 0;
				for ( let i = 0; i < n; i ++ ) bits |= ( value[ i ] & 255 ) << ( i * 8 );
				return inlined( bits );

			}

		} else if ( isMatrixType( type ) ) {

			const n = Math.sqrt( POD[ type ][ 1 ] );
			let ok = true;
			let bits = 0;

			for ( let r = 0; r < n && ok; r ++ ) {

				for ( let c = 0; c < n && ok; c ++ ) {

					const v = value[ r * n + c ];
					ok = r === c ? isInt8( v ) : v === 0;
					if ( r === c ) bits |= ( v & 255 ) << ( r * 8 );

				}

			}

			if ( ok ) return inlined( bits );

		}

		const pos = this.pos;
		this.writeValue( value, type );
		return at( pos );

	}

	// Writes a non inlined value at the current position.
	writeValue( value, type ) {

		const pod = POD[ type ];

		if ( pod ) {

			this.writeRaw( pod[ 0 ], pod[ 1 ] === 1 ? [ value ] : value );
			return;

		}

		switch ( type ) {

			case TYPE.String: case TYPE.PathExpression: this.u32( this.addString( String( value ) ) ); break;
			case TYPE.Token: this.u32( this.addToken( String( value ) ) ); break;
			case TYPE.AssetPath: this.u32( this.addString( assetPathString( value ) ) ); break;
			case TYPE.Dictionary: this.writeDictionary( value ); break;
			case TYPE.TokenListOp: this.writeListOp( value, ( v ) => this.u32( this.addToken( String( v ) ) ) ); break;
			case TYPE.StringListOp: this.writeListOp( value, ( v ) => this.u32( this.addString( String( v ) ) ) ); break;
			case TYPE.PathListOp: this.writeListOp( value, ( v ) => this.u32( this.addPath( String( v ) ) ) ); break;
			case TYPE.ReferenceListOp: this.writeListOp( value, ( v ) => this.writeReference( v ) ); break;
			case TYPE.PayloadListOp: this.writeListOp( value, ( v ) => this.writePayload( v ) ); break;
			case TYPE.IntListOp: this.writeListOp( value, ( v ) => this.i32( v ) ); break;
			case TYPE.UIntListOp: this.writeListOp( value, ( v ) => this.u32( v ) ); break;
			case TYPE.Int64ListOp: this.writeListOp( value, ( v ) => this.i64( v ) ); break;
			case TYPE.UInt64ListOp: this.writeListOp( value, ( v ) => this.u64( v ) ); break;
			case TYPE.UnregisteredValueListOp: this.writeListOp( value, ( v ) => this.writeVtValue( v ) ); break;
			case TYPE.PathVector: this.writeVector( value, ( v ) => this.u32( this.addPath( v ) ) ); break;
			case TYPE.TokenVector: this.writeVector( value, ( v ) => this.u32( this.addToken( String( v ) ) ) ); break;
			case TYPE.StringVector: this.writeVector( value, ( v ) => this.u32( this.addString( assetPathString( v ) ) ) ); break;
			case TYPE.DoubleVector: this.writeVector( value, ( v ) => this.f64( v ) ); break;
			case TYPE.LayerOffsetVector: this.writeVector( value, ( v ) => this.writeLayerOffset( v ) ); break;
			case TYPE.VariantSelectionMap: {

				const entries = Object.entries( value );
				this.u64( entries.length );

				for ( const [ k, v ] of entries ) {

					this.u32( this.addString( k ) );
					this.u32( this.addString( String( v ) ) );

				}

				break;

			}

			case TYPE.Payload: this.writePayload( value ); break;
			case TYPE.Relocates: this.writeVector( value, ( v ) => {

				this.u32( this.addPath( v[ 0 ] ) );
				this.u32( this.addPath( v[ 1 ] ) );

			} ); break;
			default: throw new Error( `usd-gltf: can't write usdc value of type ${ type }` );

		}

	}

	writeVector( items, item ) {

		this.u64( items.length );
		for ( const v of items ) item( v );

	}

	writeListOp( op, item ) {

		const lists = [ [ 2, op.explicit || [] ], [ 4, op.added ], [ 32, op.prepended ], [ 64, op.appended ], [ 8, op.deleted ], [ 16, op.ordered ] ];
		let bits = op.explicit !== null ? 1 : 0;
		for ( const [ bit, list ] of lists ) if ( list && list.length ) bits |= bit;
		if ( bits & ( 32 | 64 ) ) this.minor = Math.max( this.minor, 2 );

		this.u8( bits );
		for ( const [ bit, list ] of lists ) if ( bits & bit ) this.writeVector( list, item );

	}

	writeLayerOffset( o ) {

		this.f64( o?.offset ?? 0 );
		this.f64( o?.scale ?? 1 );

	}

	writeReference( r ) {

		this.u32( this.addString( r.assetPath || '' ) );
		this.u32( this.addPath( r.primPath || '' ) );
		this.writeLayerOffset( r.layerOffset );
		this.writeDictionary( r.customData || {} );

	}

	writePayload( r ) {

		this.u32( this.addString( r.assetPath || '' ) );
		this.u32( this.addPath( r.primPath || '' ) );
		this.writeLayerOffset( r.layerOffset );

	}

	// A nested VtValue: forward offset, any out of line data, then the ValueRep.
	writeVtValue( value, typeName ) {

		const start = this.pos;
		this.i64( 0 );
		let [ type, isArray ] = typeName ? typeFromName( typeName ) : inferType( value );
		if ( typeName === 'dictionary' ) type = TYPE.Dictionary;
		if ( type < 0 ) [ type, isArray ] = inferType( value );
		const [ lo, hi ] = this.pack( value, type, isArray );
		this.view.setInt32( start, this.pos - start, true );
		this.rep( lo, hi );

	}

	writeDictionary( dict ) {

		const types = dict[ DICT_TYPES ] || {};
		const entries = Object.entries( dict ).filter( ( [ , v ] ) => v !== undefined );
		this.u64( entries.length );

		for ( const [ key, value ] of entries ) {

			this.u32( this.addString( key ) );
			this.writeVtValue( value, types[ key ] );

		}

	}

	writeTimeSamples( samples, type, isArray ) {

		const entries = [ ...samples ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		const times = entries.map( ( e ) => e[ 0 ] );

		const start = this.pos;
		this.i64( 0 );
		const timesKey = times.join( ',' );
		let timesRep = this.timesCache.get( timesKey );

		if ( ! timesRep ) {

			const pos = this.pos;
			this.writeVector( times, ( t ) => this.f64( t ) );
			timesRep = [ pos % TWO32, ( ( TYPE.DoubleVector << 16 ) | Math.floor( pos / TWO32 ) ) >>> 0 ];
			this.timesCache.set( timesKey, timesRep );

		}

		this.view.setInt32( start, this.pos - start, true );
		this.rep( ...timesRep );

		const start2 = this.pos;
		this.i64( 0 );
		const reps = entries.map( ( e ) => this.pack( e[ 1 ], type, isArray ) );
		this.view.setInt32( start2, this.pos - start2, true );
		this.u64( reps.length );
		for ( const r of reps ) this.rep( ...r );

		return [ start % TWO32, ( ( TYPE.TimeSamples << 16 ) | Math.floor( start / TWO32 ) ) >>> 0 ];

	}

	// Plain numeric data, flat.
	writeRaw( kind, values ) {

		const n = values.length;

		switch ( kind ) {

			case 'b': {

				this.ensure( n );
				for ( let i = 0; i < n; i ++ ) this.buf[ this.pos ++ ] = values[ i ] ? 1 : 0;
				break;

			}

			case 'u8': this.bytes( values instanceof Uint8Array ? values : Uint8Array.from( values ) ); break;
			case 'i32': this.typed( values instanceof Int32Array ? values : Int32Array.from( values ) ); break;
			case 'u32': this.typed( values instanceof Uint32Array ? values : Uint32Array.from( values ) ); break;
			case 'f32': this.typed( values instanceof Float32Array ? values : Float32Array.from( values ) ); break;
			case 'f64': this.typed( values instanceof Float64Array ? values : Float64Array.from( values ) ); break;
			case 'f16': {

				const h = new Uint16Array( n );
				for ( let i = 0; i < n; i ++ ) h[ i ] = floatToHalf( values[ i ] );
				this.typed( h );
				break;

			}

			case 'i64': for ( let i = 0; i < n; i ++ ) this.i64( values[ i ] ); break;
			case 'u64': for ( let i = 0; i < n; i ++ ) this.u64( values[ i ] ); break;

		}

	}

	typed( a ) {

		this.bytes( new Uint8Array( a.buffer, a.byteOffset, a.byteLength ) );

	}

	// Identical numeric arrays share one copy in the file, as OpenUSD's crate writer does.
	packArray( values, type ) {

		if ( ! POD[ type ] || values.length < MIN_COMPRESSED_ARRAY_SIZE ) return this.packArrayData( values, type );

		const key = type + ':' + values.length + ':' + hashValues( values );
		const entries = this.arrayCache.get( key ) || this.arrayCache.set( key, [] ).get( key );
		const hit = entries.find( ( e ) => sameValues( e.values, values ) );
		if ( hit ) return hit.rep;

		const rep = this.packArrayData( values, type );
		entries.push( { values, rep } );
		return rep;

	}

	packArrayData( values, type ) {

		const flags = ( IS_ARRAY | ( type << 16 ) ) >>> 0;
		const pod = POD[ type ];
		const total = values.length;

		if ( total === 0 ) return [ 0, flags ];

		const at = ( pos, extra = 0 ) => [ pos % TWO32, ( flags | extra | Math.floor( pos / TWO32 ) ) >>> 0 ];

		if ( ! pod ) {

			let item;
			if ( type === TYPE.Token ) item = ( v ) => this.u32( this.addToken( String( v ) ) );
			else if ( type === TYPE.String || type === TYPE.PathExpression ) item = ( v ) => this.u32( this.addString( String( v ) ) );
			else if ( type === TYPE.AssetPath ) item = ( v ) => this.u32( this.addString( assetPathString( v ) ) );
			else throw new Error( `usd-gltf: can't write usdc arrays of type ${ type }` );

			this.align( 8 );
			const pos = this.pos;
			this.writeVector( values, item );
			return at( pos );

		}

		const [ kind, components ] = pod;
		const n = Math.floor( total / components );

		if ( components === 1 && n >= MIN_COMPRESSED_ARRAY_SIZE ) {

			if ( kind === 'i32' || kind === 'u32' ) {

				const pos = this.pos;
				this.u64( n );
				const data = compressInts32( kind === 'i32' ? Int32Array.from( values ) : new Int32Array( Uint32Array.from( values ).buffer ) );
				this.u64( data.length );
				this.bytes( data );
				return at( pos, IS_COMPRESSED );

			}

			if ( kind === 'f16' || kind === 'f32' || kind === 'f64' ) {

				const rep = this.packCompressedFloats( values, kind, n, at );
				if ( rep ) return rep;

			}

		}

		this.align( 8 );
		const pos = this.pos;
		this.u64( n );
		this.writeRaw( kind, values );
		return at( pos );

	}

	// The 'i' (all integers) and 't' (lookup table) encodings, or null when neither fits.
	packCompressedFloats( values, kind, n, at ) {

		const stored = kind === 'f64' ? Float64Array.from( values ) : Float32Array.from( values );
		if ( kind === 'f16' ) for ( let i = 0; i < n; i ++ ) stored[ i ] = halfToFloat( floatToHalf( stored[ i ] ) );

		let integral = true;

		for ( let i = 0; i < n && integral; i ++ ) {

			const v = stored[ i ];
			integral = ( v | 0 ) === v && ! Object.is( v, - 0 );

		}

		if ( integral ) {

			const pos = this.pos;
			this.u64( n );
			this.u8( 105 ); // 'i'
			const data = compressInts32( Int32Array.from( stored ) );
			this.u64( data.length );
			this.bytes( data );
			return at( pos, IS_COMPRESSED );

		}

		const maxLut = Math.min( Math.floor( n / 4 ), 1024 );
		const lut = new Map();
		const indexes = new Uint32Array( n );

		for ( let i = 0; i < n; i ++ ) {

			const v = stored[ i ];
			const key = Object.is( v, - 0 ) ? '-0' : v;
			let index = lut.get( key );

			if ( index === undefined ) {

				if ( lut.size === maxLut ) return null;
				index = lut.size;
				lut.set( key, index );

			}

			indexes[ i ] = index;

		}

		const pos = this.pos;
		this.u64( n );
		this.u8( 116 ); // 't'
		this.u32( lut.size );
		this.writeRaw( kind, [ ...lut.keys() ].map( ( k ) => k === '-0' ? - 0 : k ) );
		const data = compressInts32( new Int32Array( indexes.buffer ) );
		this.u64( data.length );
		this.bytes( data );
		return at( pos, IS_COMPRESSED );

	}

	// Structural sections.

	compressedInts( values ) {

		const data = compressInts32( values );
		this.u64( data.length );
		this.bytes( data );

	}

	finish() {

		const sections = [];
		const section = ( name, fn ) => {

			const start = this.pos;
			fn();
			sections.push( [ name, start, this.pos - start ] );

		};

		// paths first: encoding them adds no tokens, but keeps all token users before TOKENS
		const pathIndexes = [];
		const elementTokens = [];
		const jumps = [];

		const visit = ( siblings ) => {

			for ( let k = 0; k < siblings.length; k ++ ) {

				const node = siblings[ k ];
				const index = pathIndexes.length;
				pathIndexes.push( node.index );
				elementTokens.push( node.isProperty ? - node.token : node.token );
				jumps.push( 0 );

				const children = [ ...node.children.values() ];
				const hasChild = children.length > 0;
				const hasSibling = k < siblings.length - 1;
				if ( hasChild ) visit( children );
				jumps[ index ] = hasChild && hasSibling ? pathIndexes.length - index : hasSibling ? 0 : hasChild ? - 1 : - 2;

			}

		};

		visit( [ this.pathRoot ] );

		section( 'TOKENS', () => {

			const encoded = this.tokens.map( ( t ) => encoder.encode( t ) );
			const chars = new Uint8Array( encoded.reduce( ( n, e ) => n + e.length + 1, 0 ) );
			let o = 0;

			for ( const e of encoded ) {

				chars.set( e, o );
				o += e.length + 1;

			}

			const data = compressFast( chars );
			this.u64( this.tokens.length );
			this.u64( chars.length );
			this.u64( data.length );
			this.bytes( data );

		} );

		section( 'STRINGS', () => {

			this.u64( this.strings.length );
			for ( const s of this.strings ) this.u32( s );

		} );

		section( 'FIELDS', () => {

			this.u64( this.fieldTokens.length );
			this.compressedInts( this.fieldTokens );
			const reps = compressFast( new Uint8Array( Uint32Array.from( this.fieldReps ).buffer ) );
			this.u64( reps.length );
			this.bytes( reps );

		} );

		section( 'FIELDSETS', () => {

			this.u64( this.fieldSets.length );
			this.compressedInts( this.fieldSets );

		} );

		section( 'PATHS', () => {

			this.u64( this.pathCount );
			this.u64( pathIndexes.length );
			this.compressedInts( pathIndexes );
			this.compressedInts( elementTokens );
			this.compressedInts( jumps );

		} );

		section( 'SPECS', () => {

			const n = this.specs.length / 3;
			const get = ( k ) => Int32Array.from( { length: n }, ( _, i ) => this.specs[ i * 3 + k ] );
			this.u64( n );
			this.compressedInts( get( 0 ) );
			this.compressedInts( get( 1 ) );
			this.compressedInts( get( 2 ) );

		} );

		const tocOffset = this.pos;
		this.u64( sections.length );

		for ( const [ name, start, size ] of sections ) {

			const nameBytes = new Uint8Array( 16 );
			nameBytes.set( encoder.encode( name ) );
			this.bytes( nameBytes );
			this.u64( start );
			this.u64( size );

		}

		const end = this.pos;
		this.pos = 0;
		this.bytes( encoder.encode( 'PXR-USDC' ) );
		this.bytes( new Uint8Array( [ 0, this.minor, 0, 0, 0, 0, 0, 0 ] ) );
		this.u64( tocOffset );
		this.buf.fill( 0, 24, 88 );

		return this.buf.slice( 0, end );

	}

}

const F64 = new Float64Array( 1 );
const F64_WORDS = new Int32Array( F64.buffer );

function hashValues( values ) {

	let h = 0x811c9dc5;

	for ( let i = 0; i < values.length; i ++ ) {

		F64[ 0 ] = values[ i ];
		h = Math.imul( h ^ F64_WORDS[ 0 ], 16777619 );
		h = Math.imul( h ^ F64_WORDS[ 1 ], 16777619 );

	}

	return h >>> 0;

}

function sameValues( a, b ) {

	if ( a.length !== b.length ) return false;
	for ( let i = 0; i < a.length; i ++ ) if ( ! Object.is( a[ i ], b[ i ] ) ) return false;
	return true;

}

function isInt8( v ) {

	return Number.isInteger( v ) && v >= - 128 && v <= 127 && ! Object.is( v, - 0 );

}

function assetPathString( v ) {

	return v instanceof AssetPath ? v.path : String( v ?? '' );

}

// Model metadata -> [ fieldName, rep ] pairs.
function metadataFields( w, metadata, skip = null ) {

	const fields = [];

	for ( const [ key, value ] of Object.entries( metadata ) ) {

		if ( value === undefined || ( skip && skip.has( key ) ) ) continue;
		const name = FIELD_NAMES[ key ] || key;
		let type = FIELD_TYPES[ name ];
		let isArray = false;

		if ( ARRAY_FIELDS[ name ] !== undefined ) {

			type = ARRAY_FIELDS[ name ];
			isArray = true;

		} else if ( type === undefined || ( value === null && type !== TYPE.Dictionary ) ) {

			[ type, isArray ] = inferType( value );

		}

		if ( name === 'payload' && value instanceof Reference ) {

			fields.push( [ name, w.pack( ListOp.explicit( [ value ] ), TYPE.PayloadListOp ) ] );
			continue;

		}

		if ( type === TYPE.Dictionary && value === null ) continue;

		if ( type < 0 ) {

			console.warn( `usd-gltf: skipping metadata '${ key }' with an unsupported value` );
			continue;

		}

		fields.push( [ name, w.pack( value, type, isArray ) ] );

	}

	return fields;

}

function childNames( map ) {

	return [ ...map.keys() ];

}

function writePrim( w, spec, path, isVariant ) {

	const fields = [];

	if ( ! isVariant ) fields.push( [ 'specifier', w.pack( spec.specifier || 'def', TYPE.Specifier ) ] );
	if ( spec.typeName ) fields.push( [ 'typeName', w.pack( spec.typeName, TYPE.Token ) ] );
	fields.push( ...metadataFields( w, spec.metadata ) );
	if ( spec.variantSets.size ) fields.push( [ 'variantSetChildren', w.pack( childNames( spec.variantSets ), TYPE.TokenVector ) ] );
	if ( spec.children.size ) fields.push( [ 'primChildren', w.pack( childNames( spec.children ), TYPE.TokenVector ) ] );
	if ( spec.properties.size ) fields.push( [ 'properties', w.pack( childNames( spec.properties ), TYPE.TokenVector ) ] );

	w.addSpec( path, isVariant ? SPEC.Variant : SPEC.Prim, fields );
	writePrimContents( w, spec, path );

}

function writePrimContents( w, spec, path ) {

	const isVariantPath = path.endsWith( '}' );
	const childPath = ( name ) => path === '/' ? '/' + name : isVariantPath ? path + name : path + '/' + name;

	for ( const prop of spec.properties.values() ) writeProperty( w, prop, path + '.' + prop.name );
	for ( const child of spec.children.values() ) writePrim( w, child, childPath( child.name ), false );

	for ( const [ setName, variants ] of spec.variantSets ) {

		w.addSpec( `${ path }{${ setName }=}`, SPEC.VariantSet, [ [ 'variantChildren', w.pack( childNames( variants ), TYPE.TokenVector ) ] ] );
		for ( const [ name, variant ] of variants ) writePrim( w, variant, `${ path }{${ setName }=${ name }}`, true );

	}

}

function writeProperty( w, prop, path ) {

	const fields = [];

	if ( prop.type === 'relationship' ) {

		fields.push( [ 'variability', w.pack( 'uniform', TYPE.Variability ) ] );
		if ( prop.custom ) fields.push( [ 'custom', w.pack( true, TYPE.Bool ) ] );
		if ( prop.targets ) fields.push( [ 'targetPaths', w.pack( prop.targets, TYPE.PathListOp ) ] );
		fields.push( ...metadataFields( w, prop.metadata ) );
		w.addSpec( path, SPEC.Relationship, fields );
		return;

	}

	let [ type, isArray ] = typeFromName( prop.typeName || '' );
	const sample = prop.default !== undefined && prop.default !== null ? prop.default : prop.timeSamples ? [ ...prop.timeSamples.values() ].find( ( v ) => v !== null ) : undefined;
	if ( type < 0 && sample !== undefined ) [ type, isArray ] = inferType( sample );

	fields.push( [ 'custom', w.pack( !! prop.custom, TYPE.Bool ) ] );
	fields.push( [ 'typeName', w.pack( prop.typeName || '', TYPE.Token ) ] );
	fields.push( [ 'variability', w.pack( prop.variability || 'varying', TYPE.Variability ) ] );

	if ( prop.default !== undefined ) {

		if ( prop.default === null ) fields.push( [ 'default', w.pack( null ) ] );
		else if ( type >= 0 ) fields.push( [ 'default', w.pack( prop.default, type, isArray ) ] );

	}

	if ( prop.timeSamples && type >= 0 ) fields.push( [ 'timeSamples', w.writeTimeSamples( prop.timeSamples, type, isArray ) ] );
	if ( prop.connections ) fields.push( [ 'connectionPaths', w.pack( prop.connections, TYPE.PathListOp ) ] );
	fields.push( ...metadataFields( w, prop.metadata ) );
	w.addSpec( path, SPEC.Attribute, fields );

}

/**
 * Writes a Layer as a binary USD crate file.
 * @param {import('../model.js').Layer} layer
 * @param {{ budget?: import('../../limits.js').Budget }} [options]
 * @returns {Uint8Array}
 */
export function writeUSDC( layer, { budget = new Budget() } = {} ) {

	const w = new CrateWriter( budget );
	const root = layer.root;

	const fields = metadataFields( w, layer.metadata );
	if ( root.metadata.primOrder ) fields.push( [ 'primOrder', w.pack( root.metadata.primOrder, TYPE.TokenVector ) ] );
	if ( root.children.size ) fields.push( [ 'primChildren', w.pack( childNames( root.children ), TYPE.TokenVector ) ] );
	w.addSpec( '/', SPEC.PseudoRoot, fields );

	for ( const child of root.children.values() ) writePrim( w, child, '/' + child.name, false );

	return w.finish();

}

export { CrateWriter };
