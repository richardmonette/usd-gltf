// A small USD composition engine: loads a root layer and everything it references, then composes
// a stage of Prims following LIVRPS strength ordering (local, inherits, variants, references,
// payloads, specializes). Instances are expanded rather than shared and value clips are not supported.

import { AssetPath, ListOp } from './model.js';
import { readUSDA } from './usda/reader.js';
import { readZip } from './usdz.js';
import { Budget, rethrowFatal } from '../limits.js';

const decoder = new TextDecoder();

export function detectLayerFormat( bytes ) {

	const head = decoder.decode( bytes.subarray( 0, 8 ) );
	if ( head === 'PXR-USDC' ) return 'usdc';
	if ( head.startsWith( '#usda' ) ) return 'usda';
	if ( head.startsWith( 'PK\x03\x04' ) ) return 'usdz';
	return null;

}

// Identifiers are file paths, or 'package.usdz[inner/path]' for files inside a package.
function splitPackage( id ) {

	if ( ! id.endsWith( ']' ) ) return null;
	let depth = 0;

	for ( let i = id.length - 1; i >= 0; i -- ) {

		if ( id[ i ] === ']' ) depth ++;
		else if ( id[ i ] === '[' && -- depth === 0 ) return [ id.slice( 0, i ), id.slice( i + 1, - 1 ) ];

	}

	return null;

}

function dirname( path ) {

	const i = path.lastIndexOf( '/' );
	return i < 0 ? '' : path.slice( 0, i + 1 );

}

function normalize( path ) {

	const out = [];
	const absolute = path.startsWith( '/' );

	for ( const part of path.split( '/' ) ) {

		if ( part === '' || part === '.' ) continue;
		if ( part === '..' && out.length && out[ out.length - 1 ] !== '..' ) out.pop();
		else out.push( part );

	}

	return ( absolute ? '/' : '' ) + out.join( '/' );

}

/**
 * Resolves an authored asset path against the identifier of the layer it was authored in.
 */
export function resolveAssetPath( anchor, assetPath ) {

	if ( ! assetPath ) return '';
	assetPath = assetPath.replace( /\\/g, '/' );

	if ( /^[a-z]+:\/\//i.test( assetPath ) || /^[A-Za-z]:\//.test( assetPath ) || assetPath.startsWith( '/' ) ) return assetPath;

	const pkg = splitPackage( anchor );
	if ( pkg ) return `${ pkg[ 0 ] }[${ normalize( dirname( pkg[ 1 ] ) + assetPath ) }]`;

	const dir = dirname( anchor.replace( /\\/g, '/' ) );
	return /^[a-z]+:\/\//i.test( dir ) ? new URL( assetPath, dir ).href : normalize( dir + assetPath );

}

// Reads bytes for identifiers, opening packages (including nested ones) through the user resolver.
export class AssetReader {

	constructor( resolver, budget = new Budget() ) {

		this.resolver = resolver;
		this.budget = budget;
		this.packages = new Map();
		this.files = new Map();

	}

	addPackage( identifier, files ) {

		this.packages.set( identifier, files );

	}

	async read( identifier ) {

		if ( this.files.has( identifier ) ) return this.files.get( identifier );

		const pkg = splitPackage( identifier );
		let bytes;

		if ( pkg ) {

			const files = await this.openPackage( pkg[ 0 ] );
			bytes = files.get( pkg[ 1 ] ) ?? files.get( pkg[ 1 ].replace( /^\.\//, '' ) );
			if ( ! bytes ) throw new Error( `usd-gltf: ${ pkg[ 1 ] } not found in ${ pkg[ 0 ] }` );

		} else {

			if ( ! this.resolver ) throw new Error( `usd-gltf: no resolver to load ${ identifier }` );
			bytes = await this.resolver( identifier );
			if ( ! bytes ) throw new Error( `usd-gltf: could not load ${ identifier }` );
			bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array( bytes );

		}

		this.files.set( identifier, bytes );
		return bytes;

	}

	async openPackage( identifier ) {

		if ( ! this.packages.has( identifier ) ) this.packages.set( identifier, readZip( await this.read( identifier ), { budget: this.budget } ) );
		return this.packages.get( identifier );

	}

	// The identifier of a package's root layer: its first usd file.
	async packageRoot( identifier ) {

		const files = await this.openPackage( identifier );
		const first = [ ...files.keys() ].find( ( name ) => /\.usd[acz]?$/i.test( name ) );
		if ( ! first ) throw new Error( `usd-gltf: ${ identifier } contains no usd layer` );
		return `${ identifier }[${ first }]`;

	}

}

async function parseLayer( bytes, identifier, budget ) {

	const format = detectLayerFormat( bytes );
	if ( format === 'usda' ) return readUSDA( bytes, identifier );

	if ( format === 'usdc' ) {

		const { readUSDC } = await import( './usdc/reader.js' );
		return readUSDC( bytes, identifier, { budget } );

	}

	throw new Error( `usd-gltf: ${ identifier } is not a usd layer` );

}

function* walkSpecs( spec ) {

	yield spec;
	for ( const child of spec.children.values() ) yield* walkSpecs( child );
	for ( const set of spec.variantSets.values() ) for ( const variant of set.values() ) yield* walkSpecs( variant );

}

function listOpItems( op ) {

	if ( ! op ) return [];
	if ( ! ( op instanceof ListOp ) ) return Array.isArray( op ) ? op : [ op ];
	return [ ...( op.explicit || [] ), ...op.prepended, ...op.appended, ...op.added ];

}

// Loads the root layer and all layers reachable through sublayers, references and payloads.
async function loadLayers( reader, rootIdentifier ) {

	const layers = new Map();

	async function load( identifier ) {

		if ( layers.has( identifier ) ) return layers.get( identifier );

		const bytes = await reader.read( identifier );

		if ( detectLayerFormat( bytes ) === 'usdz' ) {

			reader.addPackage( identifier, readZip( bytes, { budget: reader.budget } ) );
			const root = await load( await reader.packageRoot( identifier ) );
			layers.set( identifier, root );
			return root;

		}

		reader.budget.check();
		const layer = await parseLayer( bytes, identifier, reader.budget );
		layers.set( identifier, layer );

		const pending = [];
		for ( const sub of layer.metadata.subLayers || [] ) pending.push( resolveAssetPath( identifier, sub ) );

		for ( const spec of walkSpecs( layer.root ) ) {

			for ( const key of [ 'references', 'payload' ] ) {

				for ( const ref of listOpItems( spec.metadata[ key ] ) ) if ( ref.assetPath ) pending.push( resolveAssetPath( identifier, ref.assetPath ) );

			}

		}

		for ( const id of pending ) {

			try {

				await load( id );

			} catch ( e ) {

				rethrowFatal( e, reader.budget );
				console.warn( `usd-gltf: ${ e.message }` );

			}

		}

		return layer;

	}

	const root = await load( rootIdentifier );
	return { root, layers };

}

// --- composition ---

function childPath( path, name ) {

	if ( path === '/' || path === '' ) return '/' + name;
	return path.endsWith( '}' ) ? path + name : path + '/' + name;

}

function stripVariants( path ) {

	return path.replace( /\{[^}]*\}/g, '/' ).replace( /\/+/g, '/' ).replace( /(.)\/$/, '$1' );

}

// Sdf reorder semantics: unlisted names stay attached to the listed name before them.
function applyOrdering( names, order ) {

	const listed = new Set( order );
	const head = [];
	const chunks = new Map();
	let current = head;

	for ( const name of names ) {

		if ( listed.has( name ) ) chunks.set( name, current = [ name ] );
		else current.push( name );

	}

	const out = head;
	for ( const name of order ) if ( chunks.has( name ) ) out.push( ...chunks.get( name ) );
	return out;

}

// One site contributing opinions to a prim: a layer stack, a path in it, and how its namespace maps to the stage.
class Node {

	constructor( stack, path, srcRoot, dstRoot, offset ) {

		this.stack = stack; // [ { layer, offset: { offset, scale } } ] strongest first
		this.path = path;
		this.srcRoot = srcRoot;
		this.dstRoot = dstRoot;
		this.offset = offset; // maps this node's time to stage time
		this.specs = [];

		for ( const entry of stack ) {

			const spec = entry.layer.getPrimAtPath( path );
			if ( spec ) this.specs.push( { spec, layer: entry.layer, offset: composeOffset( offset, entry.offset ) } );

		}

	}

	child( name ) {

		return new Node( this.stack, childPath( this.path, name ), this.srcRoot, this.dstRoot, this.offset );

	}

	mapPath( path ) {

		const src = stripVariants( this.srcRoot );
		if ( src === '/' ) return this.dstRoot === '/' ? path : this.dstRoot + path;
		if ( path === src ) return this.dstRoot;
		if ( path.startsWith( src ) && ( path[ src.length ] === '/' || path[ src.length ] === '.' ) ) return this.dstRoot + path.slice( src.length );
		return path;

	}

}

function composeOffset( outer, inner ) {

	if ( ! inner ) return outer;
	const io = inner.offset || 0;
	const is = inner.scale ?? 1;
	return { offset: outer.offset + outer.scale * io, scale: outer.scale * is };

}

export class Property {

	constructor( prim, name ) {

		this.prim = prim;
		this.name = name;
		this.opinions = []; // [ { prop: PropertySpec, node, layer, offset } ] strongest first

	}

	get type() {

		return this.opinions[ 0 ].prop.type;

	}

	get typeName() {

		for ( const o of this.opinions ) if ( o.prop.typeName ) return o.prop.typeName;
		return '';

	}

	get variability() {

		for ( const o of this.opinions ) if ( o.prop.typeName ) return o.prop.variability;
		return 'varying';

	}

	// The strongest opinion holding a value: { default, timeSamples } with time samples in stage time.
	resolve() {

		if ( this._resolved !== undefined ) return this._resolved;

		let result = null;

		for ( const o of this.opinions ) {

			const p = o.prop;
			if ( p.default === undefined && ! p.timeSamples ) continue;

			let samples = null;

			if ( p.timeSamples && p.timeSamples.size ) {

				samples = new Map();
				const { offset, scale } = o.offset;
				for ( const [ t, v ] of p.timeSamples ) samples.set( offset + scale * t, this.anchor( v, o.layer ) );

			}

			result = { default: this.anchor( p.default, o.layer ), timeSamples: samples };
			break;

		}

		return ( this._resolved = result );

	}

	anchor( value, layer ) {

		if ( value instanceof AssetPath ) return new AssetPath( value.path, resolveAssetPath( layer.identifier, value.path ) );
		if ( Array.isArray( value ) && value[ 0 ] instanceof AssetPath ) return value.map( ( v ) => this.anchor( v, layer ) );
		return value;

	}

	get value() {

		const r = this.resolve();
		if ( ! r ) return undefined;
		if ( r.default !== undefined ) return r.default;
		if ( r.timeSamples ) return r.timeSamples.values().next().value; // earliest authored sample
		return undefined;

	}

	get timeSamples() {

		return this.resolve()?.timeSamples ?? null;

	}

	get isAnimated() {

		return ( this.timeSamples?.size ?? 0 ) > 1;

	}

	// Value at a stage time with linear interpolation of numeric values (held for others).
	valueAt( time ) {

		const r = this.resolve();
		if ( ! r ) return undefined;
		if ( ! r.timeSamples ) return r.default;
		return sampleAt( r.timeSamples, time );

	}

	getMetadata( key ) {

		for ( const o of this.opinions ) if ( o.prop.metadata[ key ] !== undefined ) return o.prop.metadata[ key ];
		return undefined;

	}

	composeList( field ) {

		let list = [];

		for ( let i = this.opinions.length - 1; i >= 0; i -- ) {

			const o = this.opinions[ i ];
			const op = o.prop[ field ];
			if ( ! op ) continue;
			const mapped = new ListOp( {
				explicit: op.explicit && op.explicit.map( ( p ) => o.node.mapPath( p ) ),
				prepended: op.prepended.map( ( p ) => o.node.mapPath( p ) ),
				appended: op.appended.map( ( p ) => o.node.mapPath( p ) ),
				deleted: op.deleted.map( ( p ) => o.node.mapPath( p ) ),
				added: op.added.map( ( p ) => o.node.mapPath( p ) ),
			} );
			list = mapped.apply( list );

		}

		return list;

	}

	get connections() {

		return this._connections ??= this.composeList( 'connections' );

	}

	get targets() {

		return this._targets ??= this.composeList( 'targets' );

	}

}

function lerpValue( a, b, t ) {

	if ( typeof a === 'number' && typeof b === 'number' ) return a + ( b - a ) * t;

	if ( ( Array.isArray( a ) || ArrayBuffer.isView( a ) ) && a.length === b?.length && typeof a[ 0 ] === 'number' ) {

		const out = new a.constructor( a.length );
		for ( let i = 0; i < a.length; i ++ ) out[ i ] = a[ i ] + ( b[ i ] - a[ i ] ) * t;
		return out;

	}

	return a;

}

export function sampleAt( samples, time ) {

	let prevT = - Infinity, prev, nextT = Infinity, next;

	for ( const [ t, v ] of samples ) {

		if ( t <= time && t > prevT ) { prevT = t; prev = v; }
		if ( t >= time && t < nextT ) { nextT = t; next = v; }

	}

	if ( prevT === - Infinity ) return next;
	if ( nextT === Infinity || nextT === prevT ) return prev;
	if ( prev === null || next === null ) return prev;
	return lerpValue( prev, next, ( time - prevT ) / ( nextT - prevT ) );

}

export class Prim {

	constructor( stage, parent, name, nodes ) {

		this.stage = stage;
		this.parent = parent;
		this.name = name;
		this.path = parent ? childPath( parent.path, name ) : '/';
		this.nodes = nodes;
		this.children = [];
		this._properties = null;

		this.specifier = 'over';
		this.typeName = '';

		for ( const node of nodes ) {

			for ( const { spec } of node.specs ) {

				if ( spec.specifier === 'def' && this.specifier !== 'class' ) this.specifier = 'def';
				if ( spec.specifier === 'class' && this.specifier === 'over' ) this.specifier = 'class';
				if ( ! this.typeName && spec.typeName ) this.typeName = spec.typeName;

			}

		}

	}

	getMetadata( key ) {

		for ( const node of this.nodes ) for ( const { spec } of node.specs ) if ( spec.metadata[ key ] !== undefined ) return spec.metadata[ key ];
		return undefined;

	}

	// Composes a list-op valued metadata field such as apiSchemas.
	getListMetadata( key ) {

		let list = [];
		const ops = [];
		for ( const node of this.nodes ) for ( const { spec } of node.specs ) if ( spec.metadata[ key ] ) ops.push( spec.metadata[ key ] );
		for ( let i = ops.length - 1; i >= 0; i -- ) list = ops[ i ] instanceof ListOp ? ops[ i ].apply( list ) : [ ...ops[ i ] ];
		return list;

	}

	get active() {

		return this.getMetadata( 'active' ) !== false;

	}

	get kind() {

		return this.getMetadata( 'kind' );

	}

	hasAPI( name ) {

		return this.getListMetadata( 'apiSchemas' ).some( ( s ) => s === name || s.startsWith( name + ':' ) );

	}

	get properties() {

		if ( this._properties ) return this._properties;

		const props = new Map();

		for ( const node of this.nodes ) {

			for ( const { spec, layer, offset } of node.specs ) {

				for ( const prop of spec.properties.values() ) {

					let p = props.get( prop.name );
					if ( ! p ) props.set( prop.name, p = new Property( this, prop.name ) );
					p.opinions.push( { prop, node, layer, offset } );

				}

			}

		}

		return ( this._properties = props );

	}

	getProperty( name ) {

		return this.properties.get( name ) ?? null;

	}

	// Default (or first sampled) value of an attribute, or fallback.
	get( name, fallback = undefined ) {

		const v = this.properties.get( name )?.value;
		return v === undefined || v === null ? fallback : v;

	}

	getTargets( name ) {

		return this.properties.get( name )?.targets ?? [];

	}

	*traverse() {

		for ( const child of this.children ) {

			yield child;
			yield* child.traverse();

		}

	}

	isA( typeName ) {

		return this.typeName === typeName;

	}

}

export class Stage {

	constructor( rootLayer, layers, reader, { variants = {} } = {} ) {

		this.rootLayer = rootLayer;
		this.layers = layers;
		this.reader = reader;
		this.variantOverrides = variants; // { primPath: { setName: selection } } or { setName: selection } for every prim
		this.prims = new Map();
		this.variantSets = []; // [ { path, name, variants: [], selection } ]

		const md = rootLayer.metadata;
		this.upAxis = md.upAxis || 'Y';
		this.metersPerUnit = md.metersPerUnit ?? 0.01;
		this.timeCodesPerSecond = md.timeCodesPerSecond ?? md.framesPerSecond ?? 24;
		this.startTimeCode = md.startTimeCode ?? 0;
		this.endTimeCode = md.endTimeCode ?? 0;
		this.defaultPrim = md.defaultPrim || '';

		this.rootStack = this.buildStack( rootLayer, { offset: 0, scale: 1 } );
		this.root = new Prim( this, null, '', [ new Node( this.rootStack, '/', '/', '/', { offset: 0, scale: 1 } ) ] );
		this.composeChildren( this.root );

	}

	buildStack( layer, offset, seen = new Set() ) {

		if ( seen.has( layer ) ) return [];
		seen.add( layer );

		const stack = [ { layer, offset } ];
		const subs = layer.metadata.subLayers || [];
		const offsets = layer.metadata.subLayerOffsets || [];

		subs.forEach( ( sub, i ) => {

			const subLayer = this.layers.get( resolveAssetPath( layer.identifier, sub ) );
			if ( subLayer ) stack.push( ...this.buildStack( subLayer, composeOffset( offset, offsets[ i ] ), seen ) );

		} );

		return stack;

	}

	layerFor( assetPath, anchorLayer ) {

		return this.layers.get( resolveAssetPath( anchorLayer.identifier, assetPath ) );

	}

	selectionFor( path, setName, nodes ) {

		const o = this.variantOverrides[ path ]?.[ setName ] ?? ( typeof this.variantOverrides[ setName ] === 'string' ? this.variantOverrides[ setName ] : undefined );
		if ( o !== undefined ) return o;

		for ( const node of nodes ) for ( const { spec } of node.specs ) {

			const sel = spec.metadata.variants?.[ setName ];
			if ( sel !== undefined ) return sel;

		}

		return '';

	}

	// Expands composition arcs on a node into the ordered list of nodes for the prim at stagePath.
	expand( node, stagePath, out, depth = 0 ) {

		if ( depth > 32 ) return;
		out.push( node );

		const arcs = { inherits: [], variants: [], references: [], payload: [], specializes: [] };

		for ( const { spec, layer } of node.specs ) {

			for ( const path of listOpItems( spec.metadata.inherits ) ) arcs.inherits.push( { path, layer } );
			for ( const path of listOpItems( spec.metadata.specializes ) ) arcs.specializes.push( { path, layer } );
			for ( const ref of listOpItems( spec.metadata.references ) ) arcs.references.push( { ref, layer } );
			for ( const ref of listOpItems( spec.metadata.payload ) ) arcs.payload.push( { ref, layer } );

		}

		for ( const { path } of arcs.inherits ) {

			this.expand( new Node( node.stack, path, path, stagePath, node.offset ), stagePath, out, depth + 1 );

		}

		// variant sets declared on this node, selected by the strongest opinion so far
		const setNames = [];
		for ( const { spec } of node.specs ) for ( const name of listOpItems( spec.metadata.variantSetNames ) ) if ( ! setNames.includes( name ) ) setNames.push( name );
		for ( const { spec } of node.specs ) for ( const name of spec.variantSets.keys() ) if ( ! setNames.includes( name ) ) setNames.push( name );

		for ( const setName of setNames ) {

			const available = new Set();
			for ( const { spec } of node.specs ) for ( const v of spec.variantSets.get( setName )?.keys() ?? [] ) available.add( v );

			const selection = this.selectionFor( stagePath, setName, out );
			this.recordVariantSet( stagePath, setName, [ ...available ], selection );

			if ( selection && available.has( selection ) ) {

				const vpath = `${ node.path }{${ setName }=${ selection }}`;
				this.expand( new Node( node.stack, vpath, node.srcRoot, node.dstRoot, node.offset ), stagePath, out, depth + 1 );

			}

		}

		for ( const kind of [ 'references', 'payload' ] ) {

			for ( const { ref, layer } of arcs[ kind ] ) {

				let target;
				let stack;

				if ( ref.assetPath ) {

					target = this.layerFor( ref.assetPath, layer );
					if ( ! target ) continue;
					stack = this.buildStack( target, { offset: 0, scale: 1 } );

				} else {

					target = layer;
					stack = node.stack;

				}

				const primPath = ref.primPath || ( target.metadata.defaultPrim ? '/' + target.metadata.defaultPrim : '' );
				if ( ! primPath ) continue;

				let offset = composeOffset( node.offset, ref.layerOffset );
				const tcps = target.metadata.timeCodesPerSecond ?? target.metadata.framesPerSecond;
				if ( ref.assetPath && tcps && tcps !== this.timeCodesPerSecond ) offset = { offset: offset.offset, scale: offset.scale * this.timeCodesPerSecond / tcps };

				this.expand( new Node( stack, primPath, primPath, stagePath, offset ), stagePath, out, depth + 1 );

			}

		}

		for ( const { path } of arcs.specializes ) {

			this.expand( new Node( node.stack, path, path, stagePath, node.offset ), stagePath, out, depth + 1 );

		}

	}

	recordVariantSet( path, name, variants, selection ) {

		const existing = this.variantSets.find( ( v ) => v.path === path && v.name === name );
		if ( existing ) {

			for ( const v of variants ) if ( ! existing.variants.includes( v ) ) existing.variants.push( v );
			return;

		}

		this.variantSets.push( { path, name, variants, selection } );

	}

	composeChildren( prim ) {

		const names = [];

		const orders = [];

		for ( const node of prim.nodes ) for ( const { spec } of node.specs ) {

			for ( const name of spec.children.keys() ) if ( ! names.includes( name ) ) names.push( name );
			if ( spec.metadata.primOrder ) orders.push( spec.metadata.primOrder );

		}

		for ( let i = orders.length - 1; i >= 0; i -- ) names.splice( 0, names.length, ...applyOrdering( names, orders[ i ] ) );

		for ( const name of names ) {

			const path = childPath( prim.path, name );
			const nodes = [];

			for ( const parentNode of prim.nodes ) {

				const child = parentNode.child( name );
				if ( ! child.specs.length ) continue;
				this.expand( child, path, nodes );

			}

			// direct arcs added nodes whose own children are composed below; drop nodes with no specs
			const live = nodes.filter( ( n ) => n.specs.length );
			const child = new Prim( this, prim, name, live );
			this.prims.set( path, child );
			if ( ! child.active ) continue;
			prim.children.push( child );
			this.composeChildren( child );

		}

	}

	getPrimAtPath( path ) {

		return path === '/' ? this.root : this.prims.get( path ) ?? null;

	}

	// Defined, non abstract prims in depth first order.
	*traverse( from = this.root ) {

		for ( const child of from.children ) {

			if ( child.specifier !== 'def' ) continue;
			yield child;
			yield* this.traverse( child );

		}

	}

	readAsset( identifier ) {

		return this.reader.read( identifier );

	}

}

/**
 * Opens and composes a stage.
 * @param {Uint8Array} bytes usda, usdc or usdz
 * @param {{ identifier?: string, resolver?: ( identifier: string ) => Promise<Uint8Array>|Uint8Array, variants?: object, budget?: import('../limits.js').Budget }} [options]
 * @returns {Promise<Stage>}
 */
export async function openStage( bytes, { identifier, resolver = null, variants = {}, budget = new Budget() } = {} ) {

	const format = detectLayerFormat( bytes );
	if ( ! format ) throw new Error( 'usd-gltf: input is not usda, usdc or usdz' );

	identifier ??= 'root.' + format;
	const reader = new AssetReader( resolver, budget );
	reader.files.set( identifier, bytes );

	const { root, layers } = await loadLayers( reader, identifier );
	return new Stage( root, layers, reader, { variants } );

}
