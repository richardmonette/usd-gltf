// Parser for the USD text format (.usda) into the Layer model in ../model.js.

import { AssetPath, DICT_TYPES, Layer, ListOp, PrimSpec, PropertySpec, Reference, arrayTypeFor, componentCount } from '../model.js';

const LIST_OPS = new Set( [ 'prepend', 'append', 'delete', 'add', 'reorder' ] );
const LIST_OP_FIELD = { prepend: 'prepended', append: 'appended', delete: 'deleted', add: 'added', reorder: 'ordered' };
const SPECIFIERS = new Set( [ 'def', 'over', 'class' ] );
const PATH_LIST_KEYS = new Set( [ 'inherits', 'specializes' ] );

// Raw values from the generic value grammar before they are typed.
class Tuple extends Array {}
class PathRef { constructor( path ) { this.path = path; } }
class AssetRef { constructor( path ) { this.path = path; } }
class Ident { constructor( name ) { this.name = name; } }

class Lexer {

	constructor( text ) {

		this.text = text;
		this.pos = 0;

	}

	error( message ) {

		const line = this.text.slice( 0, this.pos ).split( '\n' ).length;
		throw new Error( `usd-gltf: usda line ${ line }: ${ message }` );

	}

	skip() {

		const t = this.text;
		const n = t.length;

		while ( this.pos < n ) {

			const c = t.charCodeAt( this.pos );

			if ( c === 32 || c === 9 || c === 10 || c === 13 ) {

				this.pos ++;

			} else if ( c === 35 ) { // # comment

				const end = t.indexOf( '\n', this.pos );
				this.pos = end < 0 ? n : end + 1;

			} else if ( c === 47 && t.charCodeAt( this.pos + 1 ) === 47 ) { // // comment

				const end = t.indexOf( '\n', this.pos );
				this.pos = end < 0 ? n : end + 1;

			} else if ( c === 47 && t.charCodeAt( this.pos + 1 ) === 42 ) { // /* comment */

				const end = t.indexOf( '*/', this.pos + 2 );
				this.pos = end < 0 ? n : end + 2;

			} else {

				break;

			}

		}

	}

	peekChar() {

		this.skip();
		return this.text[ this.pos ];

	}

	eat( ch ) {

		if ( this.peekChar() === ch ) {

			this.pos ++;
			return true;

		}

		return false;

	}

	expect( ch ) {

		if ( ! this.eat( ch ) ) this.error( `expected '${ ch }' but found '${ this.text.slice( this.pos, this.pos + 20 ) }'` );

	}

	atEnd() {

		this.skip();
		return this.pos >= this.text.length;

	}

	// Identifiers may contain namespace colons, e.g. primvars:st:indices.
	peekIdent() {

		this.skip();
		const m = /[A-Za-z_][A-Za-z0-9_:]*/y;
		m.lastIndex = this.pos;
		const r = m.exec( this.text );
		return r ? r[ 0 ] : null;

	}

	ident() {

		const id = this.peekIdent();
		if ( id === null ) this.error( `expected identifier but found '${ this.text.slice( this.pos, this.pos + 20 ) }'` );
		this.pos += id.length;
		return id;

	}

	eatIdent( word ) {

		const id = this.peekIdent();

		if ( id === word ) {

			this.pos += id.length;
			return true;

		}

		return false;

	}

	string() {

		this.skip();
		const t = this.text;
		const q = t[ this.pos ];
		if ( q !== '"' && q !== '\'' ) this.error( 'expected string' );

		const triple = t.startsWith( q + q + q, this.pos );
		const delim = triple ? q + q + q : q;
		let i = this.pos + delim.length;
		let out = '';
		let start = i;

		for ( ;; ) {

			if ( i >= t.length ) this.error( 'unterminated string' );
			const c = t[ i ];

			if ( c === '\\' ) {

				out += t.slice( start, i );
				const e = t[ i + 1 ];
				i += 2;

				if ( e === 'n' ) out += '\n';
				else if ( e === 't' ) out += '\t';
				else if ( e === 'r' ) out += '\r';
				else if ( e === '0' ) out += '\0';
				else if ( e === 'x' ) { out += String.fromCharCode( parseInt( t.substr( i, 2 ), 16 ) ); i += 2; }
				else if ( e === 'u' ) { out += String.fromCharCode( parseInt( t.substr( i, 4 ), 16 ) ); i += 4; }
				else out += e;

				start = i;

			} else if ( t.startsWith( delim, i ) ) {

				out += t.slice( start, i );
				this.pos = i + delim.length;
				return out;

			} else {

				i ++;

			}

		}

	}

	asset() {

		this.skip();
		const t = this.text;

		if ( t.startsWith( '@@@', this.pos ) ) {

			const end = t.indexOf( '@@@', this.pos + 3 );
			const path = t.slice( this.pos + 3, end ).replace( /\\@@@/g, '@@@' );
			this.pos = end + 3;
			return path;

		}

		const end = t.indexOf( '@', this.pos + 1 );
		const path = t.slice( this.pos + 1, end );
		this.pos = end + 1;
		return path;

	}

	path() {

		this.expect( '<' );
		const end = this.text.indexOf( '>', this.pos );
		const path = this.text.slice( this.pos, end );
		this.pos = end + 1;
		return path;

	}

	number() {

		this.skip();
		const m = /[-+]?(?:inf|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
		m.lastIndex = this.pos;
		const r = m.exec( this.text );
		if ( ! r ) this.error( `expected number but found '${ this.text.slice( this.pos, this.pos + 20 ) }'` );
		this.pos += r[ 0 ].length;
		return parseNumber( r[ 0 ] );

	}

}

function parseNumber( s ) {

	if ( s.endsWith( 'inf' ) ) return s[ 0 ] === '-' ? - Infinity : Infinity;
	if ( s.endsWith( 'nan' ) ) return NaN;
	return + s;

}

// Generic value grammar: numbers, strings, identifiers, tuples ( ), lists [ ], dictionaries are handled separately.
function parseRaw( lx ) {

	const c = lx.peekChar();

	if ( c === '"' || c === '\'' ) return lx.string();
	if ( c === '@' ) return new AssetRef( lx.asset() );
	if ( c === '<' ) return new PathRef( lx.path() );

	if ( c === '(' ) {

		lx.pos ++;
		const tuple = new Tuple();
		while ( ! lx.eat( ')' ) ) {

			tuple.push( parseRaw( lx ) );
			lx.eat( ',' );

		}

		return tuple;

	}

	if ( c === '[' ) {

		lx.pos ++;
		const list = [];
		while ( ! lx.eat( ']' ) ) {

			list.push( parseRaw( lx ) );
			lx.eat( ',' );

		}

		return list;

	}

	if ( c === '{' ) return parseDictionary( lx );

	const id = lx.peekIdent();

	if ( id !== null && id !== 'inf' && id !== 'nan' ) {

		lx.pos += id.length;
		if ( id === 'true' ) return true;
		if ( id === 'false' ) return false;
		if ( id === 'None' ) return null;
		return new Ident( id );

	}

	return lx.number();

}

// { type key = value ... }
function parseDictionary( lx ) {

	lx.expect( '{' );
	const dict = {};
	const types = {};
	Object.defineProperty( dict, DICT_TYPES, { value: types } );

	while ( ! lx.eat( '}' ) ) {

		let type = lx.ident();
		if ( lx.eat( '[' ) ) { lx.expect( ']' ); type += '[]'; }
		const c = lx.peekChar();
		const key = c === '"' || c === '\'' ? lx.string() : lx.ident();
		lx.expect( '=' );

		dict[ key ] = type === 'dictionary' ? parseDictionary( lx ) : typeValue( parseRaw( lx ), type );
		types[ key ] = type;
		lx.eat( ';' );

	}

	return dict;

}

// Converts a raw value to the model representation for typeName.
function typeValue( raw, typeName ) {

	if ( raw === null ) return null;

	if ( typeName.endsWith( '[]' ) ) {

		const base = typeName.slice( 0, - 2 );
		const ArrayType = arrayTypeFor( typeName );

		if ( ArrayType ) {

			const n = componentCount( base );
			const out = new ArrayType( raw.length * n );
			const quat = base.startsWith( 'quat' );
			const matrix = base.startsWith( 'matrix' ) || base === 'frame4d';

			for ( let i = 0; i < raw.length; i ++ ) {

				const v = raw[ i ];
				if ( n === 1 ) out[ i ] = v;
				else if ( quat ) { out[ i * 4 ] = v[ 1 ]; out[ i * 4 + 1 ] = v[ 2 ]; out[ i * 4 + 2 ] = v[ 3 ]; out[ i * 4 + 3 ] = v[ 0 ]; }
				else if ( matrix ) out.set( v.flat(), i * n );
				else out.set( v, i * n );

			}

			return out;

		}

		return raw.map( ( v ) => typeValue( v, base ) );

	}

	if ( typeName === 'asset' ) return new AssetPath( raw instanceof AssetRef ? raw.path : String( raw ) );
	if ( typeName === 'bool' ) return raw === true || raw === 1;
	if ( typeName === 'string' || typeName === 'token' ) return raw instanceof Ident ? raw.name : raw;
	if ( /^quat[hfd]$/.test( typeName ) ) return [ raw[ 1 ], raw[ 2 ], raw[ 3 ], raw[ 0 ] ];
	if ( /^matrix[234]d$|^frame4d$/.test( typeName ) ) return raw.flat();
	if ( raw instanceof Tuple ) return Array.from( raw );
	return raw;

}

// Fast path for numeric arrays, which dominate file size: scan numbers between [ and ] ignoring ( ) and commas.
function parseNumericArray( lx, typeName ) {

	if ( lx.eatIdent( 'None' ) ) return null;

	lx.expect( '[' );
	const ArrayType = arrayTypeFor( typeName );
	const quat = typeName.startsWith( 'quat' );
	const values = [];
	const t = lx.text;
	const re = /[\s,()]*([^\s,()\]]+)|[\s,()]*(\])/y;

	re.lastIndex = lx.pos;

	for ( ;; ) {

		const m = re.exec( t );
		if ( ! m ) lx.error( 'bad numeric array' );
		if ( m[ 2 ] ) break;
		const s = m[ 1 ];
		values.push( s === 'true' ? 1 : s === 'false' ? 0 : parseNumber( s ) );

	}

	lx.pos = re.lastIndex;

	if ( quat ) {

		for ( let i = 0; i < values.length; i += 4 ) {

			const w = values[ i ];
			values[ i ] = values[ i + 1 ]; values[ i + 1 ] = values[ i + 2 ]; values[ i + 2 ] = values[ i + 3 ]; values[ i + 3 ] = w;

		}

	}

	return ArrayType.from( values );

}

function parseTypedValue( lx, typeName ) {

	if ( typeName.endsWith( '[]' ) && arrayTypeFor( typeName ) && lx.peekChar() === '[' ) return parseNumericArray( lx, typeName );
	if ( typeName === 'dictionary' ) return lx.eatIdent( 'None' ) ? null : parseDictionary( lx );
	return typeValue( parseRaw( lx ), typeName );

}

// Parses a reference or payload list item: @asset@</path> (offset = 1; scale = 2; customData = {...})
function parseReferenceItem( lx ) {

	const ref = new Reference();
	if ( lx.peekChar() === '@' ) ref.assetPath = lx.asset();
	if ( lx.peekChar() === '<' ) ref.primPath = lx.path();

	if ( lx.eat( '(' ) ) {

		while ( ! lx.eat( ')' ) ) {

			const key = lx.ident();
			lx.expect( '=' );
			if ( key === 'offset' ) ref.layerOffset = { ...ref.layerOffset, offset: lx.number() };
			else if ( key === 'scale' ) ref.layerOffset = { ...ref.layerOffset, scale: lx.number() };
			else if ( key === 'customData' ) ref.customData = parseDictionary( lx );
			else parseRaw( lx );
			lx.eat( ';' );

		}

	}

	return ref;

}

function parseItems( lx, item ) {

	if ( lx.eatIdent( 'None' ) ) return [];

	if ( lx.eat( '[' ) ) {

		const items = [];
		while ( ! lx.eat( ']' ) ) {

			items.push( item( lx ) );
			lx.eat( ',' );

		}

		return items;

	}

	return [ item( lx ) ];

}

function setListOp( target, key, op, items ) {

	if ( ! op ) {

		target[ key ] = ListOp.explicit( items );
		return;

	}

	let listOp = target[ key ];
	if ( ! ( listOp instanceof ListOp ) || listOp.explicit !== null ) listOp = target[ key ] = listOp instanceof ListOp ? listOp : new ListOp();
	listOp[ LIST_OP_FIELD[ op ] ] = items;

}

// Metadata block ( ... ) shared by layers, prims, properties and variants.
function parseMetadata( lx, metadata, kind ) {

	while ( ! lx.eat( ')' ) ) {

		const c = lx.peekChar();

		if ( c === '"' || c === '\'' ) {

			metadata[ kind === 'layer' ? 'doc' : 'documentation' ] = lx.string();
			lx.eat( ';' );
			continue;

		}

		let op = null;
		let key = lx.ident();

		if ( LIST_OPS.has( key ) ) {

			op = key;
			key = lx.ident();

		}

		lx.expect( '=' );

		if ( key === 'references' || key === 'payload' ) {

			setListOp( metadata, key, op, parseItems( lx, parseReferenceItem ) );

		} else if ( PATH_LIST_KEYS.has( key ) ) {

			setListOp( metadata, key, op, parseItems( lx, ( l ) => l.path() ) );

		} else if ( key === 'variantSets' || key === 'apiSchemas' ) {

			setListOp( metadata, key === 'variantSets' ? 'variantSetNames' : key, op, parseItems( lx, ( l ) => l.string() ) );

		} else if ( key === 'subLayers' ) {

			const layers = parseItems( lx, parseReferenceItem );
			metadata.subLayers = layers.map( ( r ) => r.assetPath );
			metadata.subLayerOffsets = layers.map( ( r ) => r.layerOffset );

		} else if ( key === 'variants' ) {

			metadata.variants = parseDictionary( lx );

		} else if ( key === 'customData' || key === 'assetInfo' || key === 'customLayerData' || key === 'clips' ) {

			metadata[ key ] = lx.eatIdent( 'None' ) ? null : parseDictionary( lx );

		} else if ( key === 'doc' ) {

			metadata[ kind === 'layer' ? 'doc' : 'documentation' ] = lx.string();

		} else if ( op ) {

			setListOp( metadata, key, op, parseItems( lx, ( l ) => unwrap( parseRaw( l ) ) ) );

		} else {

			metadata[ key ] = unwrap( parseRaw( lx ) );

		}

		lx.eat( ';' );

	}

}

// Untyped metadata values: identifiers become strings, tuples arrays.
function unwrap( raw ) {

	if ( raw instanceof Ident ) return raw.name;
	if ( raw instanceof AssetRef ) return new AssetPath( raw.path );
	if ( raw instanceof PathRef ) return raw.path;
	if ( Array.isArray( raw ) ) return Array.from( raw, unwrap );
	return raw;

}

function parseTimeSamples( lx, typeName ) {

	const samples = new Map();
	if ( lx.eatIdent( 'None' ) ) return samples;
	lx.expect( '{' );

	while ( ! lx.eat( '}' ) ) {

		const time = lx.number();
		lx.expect( ':' );
		samples.set( time, lx.eatIdent( 'None' ) ? null : parseTypedValue( lx, typeName ) );
		lx.eat( ',' );

	}

	return samples;

}

function skipBlock( lx, open, close ) {

	lx.expect( open );
	let depth = 1;

	while ( depth > 0 ) {

		const c = lx.peekChar();
		if ( c === undefined ) lx.error( 'unterminated block' );
		if ( c === '"' || c === '\'' ) { lx.string(); continue; }
		lx.pos ++;
		if ( c === open ) depth ++;
		else if ( c === close ) depth --;

	}

}

function getProperty( prim, name, type ) {

	let spec = prim.properties.get( name );

	if ( ! spec ) {

		spec = prim.addProperty( new PropertySpec( name, type ) );

	}

	return spec;

}

function parseProperty( lx, prim, first ) {

	let op = null;
	let word = first;

	if ( LIST_OPS.has( word ) ) {

		op = word;
		word = lx.ident();

	}

	let custom = false;
	let variability = 'varying';

	if ( word === 'custom' ) { custom = true; word = lx.ident(); }
	if ( word === 'uniform' || word === 'config' ) { variability = 'uniform'; word = lx.ident(); }
	else if ( word === 'varying' ) word = lx.ident();

	if ( word === 'rel' ) {

		const name = lx.ident();
		const spec = getProperty( prim, name, 'relationship' );
		spec.custom = custom;

		if ( lx.eat( '.' ) ) {

			const field = lx.ident(); // .default or .targets (legacy)
			lx.expect( '=' );
			const targets = parseItems( lx, ( l ) => l.path() );
			if ( field !== 'default' ) setTargets( spec, op, targets );

		} else if ( lx.eat( '=' ) ) {

			setTargets( spec, op, parseItems( lx, ( l ) => l.path() ) );

		}

		if ( lx.eat( '(' ) ) parsePropertyMetadata( lx, spec );
		return;

	}

	let typeName = word;
	if ( lx.eat( '[' ) ) { lx.expect( ']' ); typeName += '[]'; }

	const name = lx.ident();
	const spec = getProperty( prim, name, 'attribute' );
	spec.typeName = typeName;
	spec.custom = custom;
	spec.variability = variability;

	if ( lx.eat( '.' ) ) {

		const field = lx.ident();
		lx.expect( '=' );

		if ( field === 'connect' ) {

			const paths = parseItems( lx, ( l ) => l.path() );
			if ( ! op ) spec.connections = ListOp.explicit( paths );
			else {

				if ( ! spec.connections ) spec.connections = new ListOp();
				spec.connections[ LIST_OP_FIELD[ op ] ] = paths;

			}

		} else if ( field === 'timeSamples' ) {

			spec.timeSamples = parseTimeSamples( lx, typeName );

		} else {

			skipBlock( lx, '{', '}' ); // .spline and other unsupported fields

		}

	} else if ( lx.eat( '=' ) ) {

		spec.default = parseTypedValue( lx, typeName );

	}

	if ( lx.eat( '(' ) ) parsePropertyMetadata( lx, spec );

}

function setTargets( spec, op, targets ) {

	if ( ! op ) {

		spec.targets = ListOp.explicit( targets );
		return;

	}

	if ( ! spec.targets || spec.targets.explicit !== null ) spec.targets = spec.targets && spec.targets.explicit === null ? spec.targets : new ListOp();
	spec.targets[ LIST_OP_FIELD[ op ] ] = targets;

}

function parsePropertyMetadata( lx, spec ) {

	while ( ! lx.eat( ')' ) ) {

		const c = lx.peekChar();

		if ( c === '"' || c === '\'' ) {

			spec.metadata.documentation = lx.string();
			lx.eat( ';' );
			continue;

		}

		const key = lx.ident();
		lx.expect( '=' );

		if ( key === 'customData' ) spec.metadata.customData = parseDictionary( lx );
		else if ( key === 'doc' ) spec.metadata.documentation = lx.string();
		else spec.metadata[ key ] = unwrap( parseRaw( lx ) );

		lx.eat( ';' );

	}

}

function parsePrimBody( lx, prim ) {

	lx.expect( '{' );

	while ( ! lx.eat( '}' ) ) {

		if ( lx.eat( ';' ) ) continue;

		const word = lx.ident();

		if ( SPECIFIERS.has( word ) ) {

			parsePrim( lx, prim, word );

		} else if ( word === 'variantSet' ) {

			parseVariantSet( lx, prim );

		} else if ( word === 'reorder' && ( lx.peekIdent() === 'nameChildren' || lx.peekIdent() === 'properties' ) ) {

			const what = lx.ident();
			lx.expect( '=' );
			const order = parseItems( lx, ( l ) => l.string() );
			prim.metadata[ what === 'nameChildren' ? 'primOrder' : 'propertyOrder' ] = order;

		} else {

			parseProperty( lx, prim, word );

		}

	}

}

function parsePrim( lx, parent, specifier ) {

	let typeName = '';
	if ( lx.peekChar() !== '"' ) typeName = lx.ident();
	const name = lx.string();

	const prim = parent.children.get( name ) ?? parent.addChild( new PrimSpec( name, specifier, typeName ) );
	prim.specifier = specifier;
	prim.typeName = typeName;

	if ( lx.eat( '(' ) ) parseMetadata( lx, prim.metadata, 'prim' );
	parsePrimBody( lx, prim );

}

function parseVariantSet( lx, prim ) {

	const setName = lx.string();
	lx.expect( '=' );
	lx.expect( '{' );

	let set = prim.variantSets.get( setName );
	if ( ! set ) prim.variantSets.set( setName, set = new Map() );

	while ( ! lx.eat( '}' ) ) {

		const variantName = lx.string();
		const variant = set.get( variantName ) ?? new PrimSpec( variantName, 'over', '' );
		set.set( variantName, variant );

		if ( lx.eat( '(' ) ) parseMetadata( lx, variant.metadata, 'prim' );
		parsePrimBody( lx, variant );

	}

}

/**
 * @param {string|Uint8Array} source
 * @param {string} [identifier]
 * @returns {Layer}
 */
export function readUSDA( source, identifier = 'anon.usda' ) {

	const text = typeof source === 'string' ? source : new TextDecoder().decode( source );
	if ( ! text.startsWith( '#usda' ) ) throw new Error( 'usd-gltf: not a usda file' );

	const layer = new Layer( identifier );
	const lx = new Lexer( text );
	lx.pos = text.indexOf( '\n' ) + 1 || text.length; // skip the #usda 1.0 header

	if ( lx.eat( '(' ) ) parseMetadata( lx, layer.metadata, 'layer' );

	while ( ! lx.atEnd() ) {

		if ( lx.eat( ';' ) ) continue;
		const word = lx.ident();

		if ( SPECIFIERS.has( word ) ) parsePrim( lx, layer.root, word );
		else if ( word === 'reorder' ) {

			lx.ident();
			lx.expect( '=' );
			layer.root.metadata.primOrder = parseItems( lx, ( l ) => l.string() );

		} else lx.error( `unexpected '${ word }'` );

	}

	return layer;

}

