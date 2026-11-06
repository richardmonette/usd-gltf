// Writes the Layer model in ../model.js as USD text (.usda).

import { AssetPath, DICT_TYPES, ListOp, arrayTypeFor, componentCount } from '../model.js';

const F32 = new Float32Array( 1 );

// Shortest decimal that round trips through float32, so 0.1f prints as 0.1 not 0.10000000149011612.
function formatFloat( v ) {

	if ( ! Number.isFinite( v ) ) return Number.isNaN( v ) ? 'nan' : v > 0 ? 'inf' : '-inf';
	if ( Object.is( v, - 0 ) ) return '-0';
	if ( Number.isInteger( v ) ) return String( v );
	F32[ 0 ] = v;
	const target = F32[ 0 ];

	for ( let p = 6; p < 10; p ++ ) {

		const s = + v.toPrecision( p );
		F32[ 0 ] = s;
		if ( F32[ 0 ] === target ) return String( s );

	}

	return String( v );

}

function formatDouble( v ) {

	if ( ! Number.isFinite( v ) ) return Number.isNaN( v ) ? 'nan' : v > 0 ? 'inf' : '-inf';
	return Object.is( v, - 0 ) ? '-0' : String( v );

}

function isSinglePrecision( base ) {

	return /^(half|float)[234]?$|[hf]$/.test( base );

}

function quote( s ) {

	if ( s.includes( '\n' ) && ! s.includes( '"""' ) ) return '"""' + s.replace( /\\/g, '\\\\' ) + '"""';
	return '"' + s.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\n/g, '\\n' ).replace( /\r/g, '\\r' ).replace( /\t/g, '\\t' ) + '"';

}

function formatAsset( a ) {

	const path = a instanceof AssetPath ? a.path : String( a );
	return path.includes( '@' ) ? '@@@' + path + '@@@' : '@' + path + '@';

}

function formatScalar( v, base ) {

	if ( v === null || v === undefined ) return 'None';
	if ( base === 'bool' ) return v ? 'true' : 'false';
	if ( base === 'string' || base === 'token' || base === 'pathExpression' ) return quote( String( v ) );
	if ( base === 'asset' ) return formatAsset( v );
	if ( base === 'dictionary' ) return formatDictionary( v, '' );

	const n = componentCount( base );
	const fmt = isSinglePrecision( base ) ? formatFloat : formatDouble;

	if ( n === 1 ) return fmt( v );

	if ( /^quat/.test( base ) ) return `(${ fmt( v[ 3 ] ) }, ${ fmt( v[ 0 ] ) }, ${ fmt( v[ 1 ] ) }, ${ fmt( v[ 2 ] ) })`;

	if ( /^matrix|^frame/.test( base ) ) {

		const size = Math.sqrt( n );
		const rows = [];
		for ( let r = 0; r < size; r ++ ) rows.push( '(' + Array.from( v.slice( r * size, r * size + size ), fmt ).join( ', ' ) + ')' );
		return '( ' + rows.join( ', ' ) + ' )';

	}

	return '(' + Array.from( v, fmt ).join( ', ' ) + ')';

}

export function formatValue( v, typeName ) {

	if ( v === null || v === undefined ) return 'None';
	if ( ! typeName.endsWith( '[]' ) ) return formatScalar( v, typeName );

	const base = typeName.slice( 0, - 2 );

	if ( arrayTypeFor( typeName ) ) {

		const n = componentCount( base );
		const parts = [];

		for ( let i = 0; i < v.length; i += n ) parts.push( formatScalar( n === 1 ? v[ i ] : v.subarray ? v.subarray( i, i + n ) : v.slice( i, i + n ), base ) );

		return '[' + parts.join( ', ' ) + ']';

	}

	return '[' + Array.from( v, ( x ) => formatScalar( x, base ) ).join( ', ' ) + ']';

}

function inferType( v ) {

	if ( typeof v === 'boolean' ) return 'bool';
	if ( typeof v === 'number' ) return Number.isInteger( v ) ? 'int' : 'double';
	if ( typeof v === 'string' ) return 'string';
	if ( v instanceof AssetPath ) return 'asset';
	if ( Array.isArray( v ) || ArrayBuffer.isView( v ) ) {

		const first = v[ 0 ];
		if ( typeof first === 'string' ) return 'string[]';
		if ( first instanceof AssetPath ) return 'asset[]';
		if ( typeof first === 'boolean' ) return 'bool[]';
		return v instanceof Int32Array || Array.from( v ).every( Number.isInteger ) ? 'int[]' : 'double[]';

	}

	return 'dictionary';

}

function formatDictionary( dict, indent ) {

	const keys = Object.keys( dict );
	if ( ! keys.length ) return '{\n' + indent + '}';

	const inner = indent + '    ';
	const types = dict[ DICT_TYPES ] || {};
	const lines = keys.map( ( key ) => {

		const v = dict[ key ];
		const type = types[ key ] || inferType( v );
		const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test( key ) ? key : quote( key );
		return `${ inner }${ type } ${ name } = ${ type === 'dictionary' ? formatDictionary( v, inner ) : formatValue( v, type ) }`;

	} );

	return '{\n' + lines.join( '\n' ) + '\n' + indent + '}';

}

function formatLayerOffset( offset, customData = null, indent = '' ) {

	const parts = [];
	if ( offset?.offset ) parts.push( `offset = ${ offset.offset }` );
	if ( offset?.scale !== undefined && offset.scale !== 1 ) parts.push( `scale = ${ offset.scale }` );
	if ( customData && Object.keys( customData ).length ) parts.push( `customData = ${ formatDictionary( customData, indent ) }` );
	return parts.length ? ` (${ parts.join( '; ' ) })` : '';

}

function formatReference( r ) {

	let s = '';
	if ( r.assetPath ) s += formatAsset( r.assetPath );
	if ( r.primPath ) s += `<${ r.primPath }>`;
	return s + formatLayerOffset( r.layerOffset, r.customData );

}

function formatItems( items, format ) {

	if ( items.length === 1 ) return format( items[ 0 ] );
	return '[' + items.map( format ).join( ', ' ) + ']';

}

const OP_KEYWORDS = [ [ 'deleted', 'delete' ], [ 'added', 'add' ], [ 'prepended', 'prepend' ], [ 'appended', 'append' ], [ 'ordered', 'reorder' ] ];

// Returns [ [ keywordPrefix, items ] ] for a list op or plain array.
function listOpEntries( value ) {

	if ( ! ( value instanceof ListOp ) ) return [ [ '', Array.isArray( value ) ? value : [ value ] ] ];
	if ( value.explicit !== null ) return [ [ '', value.explicit ] ];
	return OP_KEYWORDS.filter( ( [ field ] ) => value[ field ].length ).map( ( [ field, kw ] ) => [ kw + ' ', value[ field ] ] );

}

const formatPath = ( p ) => `<${ p }>`;

function formatMetadataEntries( metadata, indent, kind ) {

	const lines = [];

	for ( const [ key, value ] of Object.entries( metadata ) ) {

		if ( value === undefined ) continue;
		if ( key === 'primOrder' || key === 'propertyOrder' ) continue;

		if ( key === 'documentation' || key === 'doc' ) {

			lines.push( `${ indent }doc = ${ quote( value ) }` );

		} else if ( key === 'references' || key === 'payload' ) {

			for ( const [ kw, items ] of listOpEntries( value ) ) lines.push( `${ indent }${ kw }${ key } = ${ items.length ? formatItems( items, formatReference ) : 'None' }` );

		} else if ( key === 'inherits' || key === 'specializes' ) {

			for ( const [ kw, items ] of listOpEntries( value ) ) lines.push( `${ indent }${ kw }${ key } = ${ items.length ? formatItems( items, formatPath ) : 'None' }` );

		} else if ( key === 'variantSetNames' || key === 'apiSchemas' ) {

			const name = key === 'variantSetNames' ? 'variantSets' : key;
			for ( const [ kw, items ] of listOpEntries( value ) ) lines.push( `${ indent }${ kw }${ name } = [${ items.map( quote ).join( ', ' ) }]` );

		} else if ( key === 'variants' ) {

			const inner = indent + '    ';
			const entries = Object.entries( value ).map( ( [ k, v ] ) => `${ inner }string ${ k } = ${ quote( v ) }` );
			lines.push( `${ indent }variants = {\n${ entries.join( '\n' ) }\n${ indent }}` );

		} else if ( key === 'subLayers' ) {

			const offsets = metadata.subLayerOffsets || [];
			lines.push( `${ indent }subLayers = [\n${ value.map( ( p, i ) => `${ indent }    ${ formatAsset( p ) }${ formatLayerOffset( offsets[ i ] ) }` ).join( ',\n' ) }\n${ indent }]` );

		} else if ( key === 'layerRelocates' || key === 'relocates' ) {

			const pairs = value.map( ( [ a, b ] ) => `${ indent }    <${ a }>: <${ b }>` );
			lines.push( `${ indent }relocates = {\n${ pairs.join( ',\n' ) }\n${ indent }}` );

		} else if ( key === 'subLayerOffsets' ) {

			continue;

		} else if ( value instanceof ListOp ) {

			for ( const [ kw, items ] of listOpEntries( value ) ) lines.push( `${ indent }${ kw }${ key } = ${ formatValue( items, inferType( items ) ) }` );

		} else if ( typeof value === 'string' ) {

			lines.push( `${ indent }${ key } = ${ quote( value ) }` );

		} else if ( typeof value === 'object' && value !== null && ! Array.isArray( value ) && ! ( value instanceof AssetPath ) && ! ArrayBuffer.isView( value ) ) {

			lines.push( `${ indent }${ key } = ${ formatDictionary( value, indent ) }` );

		} else {

			lines.push( `${ indent }${ key } = ${ formatValue( value, inferType( value ) ) }` );

		}

	}

	return lines;

}

function writeProperty( out, prop, indent ) {

	const meta = formatMetadataEntries( prop.metadata, indent + '    ', 'property' );
	const metaBlock = meta.length ? ` (\n${ meta.join( '\n' ) }\n${ indent })` : '';
	const custom = prop.custom ? 'custom ' : '';

	if ( prop.type === 'relationship' ) {

		const decl = `${ custom }rel ${ prop.name }`;
		const entries = prop.targets ? listOpEntries( prop.targets ) : [];

		if ( ! entries.length ) out.push( `${ indent }${ decl }${ metaBlock }` );

		entries.forEach( ( [ kw, items ], i ) => {

			const value = items.length ? formatItems( items, formatPath ) : 'None';
			out.push( `${ indent }${ kw }${ decl } = ${ value }${ i === entries.length - 1 ? metaBlock : '' }` );

		} );

		return;

	}

	const uniform = prop.variability === 'uniform' ? 'uniform ' : '';
	const decl = `${ custom }${ uniform }${ prop.typeName } ${ prop.name }`;
	let wrote = false;

	if ( prop.default !== undefined ) {

		out.push( `${ indent }${ decl } = ${ formatValue( prop.default, prop.typeName ) }${ metaBlock }` );
		wrote = true;

	}

	if ( prop.timeSamples ) {

		const inner = indent + '    ';
		const samples = [ ...prop.timeSamples ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] ).map( ( [ t, v ] ) => `${ inner }${ formatDouble( t ) }: ${ formatValue( v, prop.typeName ) },` );
		out.push( `${ indent }${ decl }.timeSamples = {\n${ samples.join( '\n' ) }\n${ indent }}${ wrote ? '' : metaBlock }` );
		wrote = true;

	}

	if ( prop.connections ) {

		for ( const [ kw, items ] of listOpEntries( prop.connections ) ) {

			out.push( `${ indent }${ kw }${ decl }.connect = ${ items.length ? formatItems( items, formatPath ) : 'None' }${ wrote ? '' : metaBlock }` );
			wrote = true;

		}

	}

	if ( ! wrote ) out.push( `${ indent }${ decl }${ metaBlock }` );

}

function writePrimContents( out, spec, indent ) {

	for ( const prop of spec.properties.values() ) writeProperty( out, prop, indent );

	if ( spec.metadata.propertyOrder ) out.push( `${ indent }reorder properties = [${ spec.metadata.propertyOrder.map( quote ).join( ', ' ) }]` );
	if ( spec.metadata.primOrder ) out.push( `${ indent }reorder nameChildren = [${ spec.metadata.primOrder.map( quote ).join( ', ' ) }]` );

	for ( const child of spec.children.values() ) {

		if ( out.length && out[ out.length - 1 ] !== '' && ! out[ out.length - 1 ].endsWith( '{' ) ) out.push( '' );
		writePrim( out, child, indent );

	}

	for ( const [ setName, variants ] of spec.variantSets ) {

		out.push( '' );
		out.push( `${ indent }variantSet ${ quote( setName ) } = {` );

		for ( const [ name, variant ] of variants ) {

			const meta = formatMetadataEntries( variant.metadata, indent + '        ', 'prim' );
			out.push( `${ indent }    ${ quote( name ) }${ meta.length ? ` (\n${ meta.join( '\n' ) }\n${ indent }    )` : '' } {` );
			writePrimContents( out, variant, indent + '        ' );
			out.push( `${ indent }    }` );

		}

		out.push( `${ indent }}` );

	}

}

function writePrim( out, spec, indent ) {

	const type = spec.typeName ? spec.typeName + ' ' : '';
	const meta = formatMetadataEntries( spec.metadata, indent + '    ', 'prim' );
	out.push( `${ indent }${ spec.specifier } ${ type }${ quote( spec.name ) }${ meta.length ? ` (\n${ meta.join( '\n' ) }\n${ indent })` : '' }` );
	out.push( `${ indent }{` );
	writePrimContents( out, spec, indent + '    ' );
	out.push( `${ indent }}` );

}

/**
 * @param {import('../model.js').Layer} layer
 * @param {{ budget?: import('../../limits.js').Budget }} [options] its output limit is checked as lines are written
 * @returns {string}
 */
export function writeUSDA( layer, { budget = null } = {} ) {

	const out = [ '#usda 1.0' ];

	if ( budget ) {

		let size = 0;
		const push = out.push;
		out.push = function ( ...lines ) {

			for ( const line of lines ) size += line.length + 1;
			budget.output( size, 'usda' );
			return push.apply( this, lines );

		};

	}
	const meta = formatMetadataEntries( layer.metadata, '    ', 'layer' );
	if ( meta.length ) out.push( '(', ...meta, ')' );
	out.push( '' );

	if ( layer.root.metadata.primOrder ) out.push( `reorder rootPrims = [${ layer.root.metadata.primOrder.map( quote ).join( ', ' ) }]`, '' );

	for ( const child of layer.root.children.values() ) {

		writePrim( out, child, '' );
		out.push( '' );

	}

	return out.join( '\n' );

}

