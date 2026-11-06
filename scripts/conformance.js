#!/usr/bin/env node
// Conformance run over the acceptance corpora (see scripts/fetch-corpus.js):
//
//   Apple AR Quick Look gallery, USD -> glTF:
//     per mesh triangle counts and world bounds at start / middle / end of the animation must match
//     OpenUSD with skinning baked, and the GLB must have no glTF Validator errors.
//   Khronos glTF Sample Assets, glTF -> USDZ -> glTF:
//     the USDZ must pass OpenUSD's validators, its geometry must match the source at several times,
//     and converting back must give the same materials, variants and animations, with no validator errors.
//
// Needs OpenUSD's Python module (pip install usd-core) in .venv or on PATH.
// Usage: node scripts/conformance.js [apple|khronos] [name filter]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import validator from 'gltf-validator';
import { readGLTF } from '../src/gltf/document.js';
import { GLTFToUSD } from '../src/convert/gltf-to-usd.js';
import { USDToGLTF } from '../src/convert/usd-to-gltf.js';
import { openStage } from '../src/usd/stage.js';
import { writeUSDC } from '../src/usd/usdc/writer.js';
import { writeUSDZ } from '../src/usd/usdz.js';
import { crc32 } from '../src/util/crc32.js';
import { decodeImage, imageMimeType } from '../src/image/index.js';
import { evaluateScene } from '../test/oracle/gltf-eval.js';

const root = new URL( '../', import.meta.url ).pathname.replace( /^\/([A-Za-z]:)/, '$1' );
const corpus = join( root, 'corpus' );
const out = join( root, 'out', 'conformance' );
const [ which, filter ] = process.argv.slice( 2 );
const TOLERANCE = 1e-3; // of the scene's size

const python = [ join( root, '.venv', 'Scripts', 'python.exe' ), join( root, '.venv', 'bin', 'python' ) ].find( existsSync ) || 'python3';

function usdStats( files, check ) {

	const json = join( out, `stats-${ Date.now() }.json` );
	execFileSync( python, [ join( root, 'test', 'oracle', 'usd_stats.py' ), json, ...( check ? [ '--check' ] : [] ), ...files ], { stdio: [ 'ignore', 'ignore', 'ignore' ], maxBuffer: 1 << 30 } );
	return JSON.parse( readFileSync( json, 'utf8' ) );

}

async function validateGLB( bytes ) {

	const report = await validator.validateBytes( bytes, { maxIssues: 20, writeTimestamp: false } );
	return report.issues.messages.filter( ( m ) => m.severity === 0 ).map( ( m ) => `${ m.code } ${ m.pointer }` );

}

// Worst bounds difference between glTF nodes / primitives and OpenUSD meshes, relative to scene size.
function compareBounds( stats, at ) {

	let size = 0;
	for ( const m of Object.values( stats.meshes ) ) for ( const [ lo, hi ] of Object.values( m.bounds ) ) if ( Number.isFinite( lo[ 0 ] ) ) size = Math.max( size, Math.hypot( hi[ 0 ] - lo[ 0 ], hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ) );

	let worst = 0, where = '';
	const missing = [], triangles = [];

	for ( const t of stats.times ) {

		const found = at( t );

		for ( const [ path, src ] of found ) {

			const usd = stats.meshes[ path ];
			if ( ! usd ) { if ( t === stats.times[ 0 ] && src.triangles ) missing.push( path ); continue; }
			if ( t === stats.times[ 0 ] && Math.round( src.triangles ) !== usd.triangles ) triangles.push( path );
			const b = usd.bounds[ String( t ) ] || usd.bounds[ t.toFixed( 1 ) ];
			if ( ! b || ! Number.isFinite( src.min[ 0 ] ) ) continue;

			for ( let k = 0; k < 3; k ++ ) {

				const e = Math.max( Math.abs( src.min[ k ] - b[ 0 ][ k ] ), Math.abs( src.max[ k ] - b[ 1 ][ k ] ) ) / ( size || 1 );
				if ( e > worst ) { worst = e; where = `${ path } t=${ t }`; }

			}

		}

	}

	const problems = [];
	if ( worst > TOLERANCE ) problems.push( `bounds differ by ${ worst.toExponential( 1 ) } at ${ where }` );
	if ( missing.length ) problems.push( `${ missing.length } meshes missing (${ missing[ 0 ] })` );
	if ( triangles.length ) problems.push( `${ triangles.length } triangle count mismatches (${ triangles[ 0 ] })` );
	return problems;

}

// --- Apple: USD -> glTF ---

async function apple() {

	const dir = join( corpus, 'apple' );
	const files = readdirSync( dir ).filter( ( f ) => f.endsWith( '.usdz' ) && ( ! filter || f.includes( filter ) ) ).map( ( f ) => join( dir, f ) );
	const stats = usdStats( files, false );
	const results = [];

	for ( const file of files ) {

		const name = file.split( /[\\/]/ ).pop();
		const s = stats[ file ];
		const problems = [];

		try {

			const stage = await openStage( readFileSync( file ), { identifier: name } );
			const glb = ( await new USDToGLTF( stage, { debug: true } ).convert() ).toGLB();
			problems.push( ...( await validateGLB( glb ) ).map( ( e ) => 'validator: ' + e ) );
			const doc = await readGLTF( glb );
			const extras = doc.json.asset.extras || { timeOffset: s.startTimeCode, timeCodesPerSecond: s.timeCodesPerSecond };

			problems.push( ...compareBounds( s, ( t ) => {

				const nodes = evaluateScene( doc, ( t - extras.timeOffset ) / extras.timeCodesPerSecond, 0 );
				return [ ...nodes.values() ].filter( ( n ) => n.extras?.usdPath ).map( ( n ) => [ n.extras.usdPath, n ] );

			} ) );

		} catch ( e ) {

			problems.push( 'error: ' + e.message );

		}

		results.push( { corpus: 'apple', name, problems } );
		report( results[ results.length - 1 ] );

	}

	return results;

}

// --- Khronos: glTF -> USDZ -> glTF ---

const near = ( a, b, eps = 1e-4 ) => Math.abs( a - b ) <= eps * Math.max( 1, Math.abs( a ), Math.abs( b ) );

function imageKey( doc, textureIndex, pixels = false ) {

	const t = doc.json.textures?.[ textureIndex ];
	if ( ! t ) return null;
	const ext = t.extensions || {};
	const image = doc.images[ ext.KHR_texture_basisu?.source ?? ext.EXT_texture_webp?.source ?? t.source ];
	if ( ! image ) return null;
	// WebP has to become PNG for USDZ, so it compares by pixels
	if ( ! pixels && imageMimeType( image.bytes ) !== 'image/webp' ) return crc32( image.bytes );
	const d = decodeImage( image.bytes );
	return 'pixels:' + crc32( new Uint8Array( d.data.buffer, d.data.byteOffset, d.data.byteLength ) );

}

function describeMaterial( doc, m, pixels = false ) {

	const pbr = m?.pbrMetallicRoughness || {};
	const tex = ( info ) => info && {
		image: imageKey( doc, info.index, pixels ),
		texCoord: info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord ?? 0,
		transform: info.extensions?.KHR_texture_transform ? [ ...( info.extensions.KHR_texture_transform.offset || [ 0, 0 ] ), info.extensions.KHR_texture_transform.rotation || 0, ...( info.extensions.KHR_texture_transform.scale || [ 1, 1 ] ) ] : [ 0, 0, 0, 1, 1 ],
	};
	const strength = m?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
	const specGloss = !! m?.extensions?.KHR_materials_pbrSpecularGlossiness;

	return {
		baseColorFactor: specGloss ? null : pbr.baseColorFactor || [ 1, 1, 1, 1 ],
		metallicFactor: specGloss ? null : pbr.metallicFactor ?? 1,
		roughnessFactor: specGloss ? null : pbr.roughnessFactor ?? 1,
		emissive: ( m?.emissiveFactor || [ 0, 0, 0 ] ).map( ( v ) => v * strength ),
		alphaMode: m?.alphaMode || 'OPAQUE',
		alphaCutoff: m?.alphaMode === 'MASK' ? m.alphaCutoff ?? 0.5 : null,
		doubleSided: !! m?.doubleSided,
		baseColorTexture: specGloss ? null : tex( pbr.baseColorTexture ),
		metallicRoughnessTexture: specGloss ? null : tex( pbr.metallicRoughnessTexture ),
		normalTexture: tex( m?.normalTexture ),
		normalScale: m?.normalTexture?.scale ?? 1,
		occlusionTexture: tex( m?.occlusionTexture ),
		occlusionStrength: m?.occlusionTexture?.strength ?? 1,
		emissiveTexture: tex( m?.emissiveTexture ),
		extensions: Object.keys( m?.extensions || {} ).filter( ( k ) => k !== 'KHR_materials_emissive_strength' ).sort().join( '+' ),
	};

}

function materialDiffs( a, b ) {

	const diffs = [];

	for ( const key of Object.keys( a ) ) {

		const x = a[ key ], y = b[ key ];
		if ( x === null ) continue;

		if ( Array.isArray( x ) ) {

			if ( x.length !== y?.length || x.some( ( v, i ) => ! near( v, y[ i ] ) ) ) diffs.push( key );

		} else if ( x && typeof x === 'object' ) {

			if ( ! y ) diffs.push( `${ key } missing` );
			else for ( const k of [ 'image', 'texCoord' ] ) if ( x[ k ] !== y[ k ] ) diffs.push( `${ key }.${ k }` );
			if ( y && x.transform.some( ( v, i ) => ! near( v, y.transform[ i ] ) ) ) diffs.push( `${ key }.transform` );

		} else if ( typeof x === 'number' ? ! near( x, y ) : x !== y ) {

			diffs.push( key );

		}

	}

	return diffs;

}

async function khronos() {

	const index = JSON.parse( readFileSync( join( corpus, 'khronos', 'Models', 'model-index.json' ), 'utf8' ) ).filter( ( m ) => ! filter || m.name.includes( filter ) );
	const usdzDir = join( out, 'usdz' );
	mkdirSync( usdzDir, { recursive: true } );
	const converted = new Map();

	// every model as .gltf, and as .glb and embedded .gltf where it has those variants
	const cases = [];

	for ( const model of index ) {

		for ( const [ variant, label ] of [ [ 'glTF', '' ], [ 'glTF-Binary', ' (glb)' ], [ 'glTF-Embedded', ' (embedded)' ] ] ) {

			const file = model.variants[ variant ] && join( corpus, 'khronos', 'Models', model.name, variant, model.variants[ variant ] );
			if ( file && existsSync( file ) ) cases.push( { name: model.name + label, file } );

		}

	}

	for ( const m of cases ) {

		const file = m.file;

		try {

			const doc = await readGLTF( readFileSync( file ), { resolver: ( uri ) => readFileSync( join( dirname( file ), uri ) ) } );
			const { layer, files, mapping } = await new GLTFToUSD( doc, { debug: true } ).convert();
			const usdz = writeUSDZ( [ { name: 'root.usdc', data: writeUSDC( layer ) }, ...files ] );
			const path = join( usdzDir, m.name + '.usdz' );
			writeFileSync( path, usdz );
			converted.set( m.name, { doc, mapping, usdz, path } );

		} catch ( e ) {

			converted.set( m.name, { error: e.message } );

		}

	}

	const stats = usdStats( [ ...converted.values() ].filter( ( c ) => c.path ).map( ( c ) => c.path ), true );
	const results = [];

	for ( const m of cases ) {

		const c = converted.get( m.name );
		const problems = [];

		if ( c.error ) {

			problems.push( 'error: ' + c.error );

		} else {

			const s = stats[ c.path ];
			if ( s.error ) problems.push( 'OpenUSD: ' + s.error );
			for ( const e of s.errors || [] ) problems.push( 'OpenUSD validator: ' + e );
			for ( const w of s.warnings || [] ) problems.push( 'OpenUSD warning: ' + w );

			if ( ! s.error ) problems.push( ...compareBounds( s, ( t ) => {

				// primitives sharing vertex data share a USD Mesh, so their bounds are combined
				const nodes = evaluateScene( c.doc, t / s.timeCodesPerSecond, 0 );
				const byPath = new Map();

				for ( const [ key, path ] of Object.entries( c.mapping ) ) {

					const [ node, p ] = key.split( '/' ).map( Number );
					const src = nodes.get( node )?.primitives[ p ];
					if ( ! src ) continue;
					const sum = byPath.get( path );
					if ( ! sum ) { byPath.set( path, { ...src, min: [ ...src.min ], max: [ ...src.max ] } ); continue; }
					sum.triangles += src.triangles;
					for ( let k = 0; k < 3; k ++ ) { sum.min[ k ] = Math.min( sum.min[ k ], src.min[ k ] ); sum.max[ k ] = Math.max( sum.max[ k ], src.max[ k ] ); }

				}

				return [ ...byPath ];

			} ) );

			// and back
			try {

				const stage = await openStage( c.usdz, { identifier: m.name + '.usdz' } );
				const glb = ( await new USDToGLTF( stage, { debug: true } ).convert() ).toGLB();
				problems.push( ...( await validateGLB( glb ) ).map( ( e ) => 'validator: ' + e ) );
				problems.push( ...roundTrip( c.doc, c.mapping, await readGLTF( glb ) ) );

			} catch ( e ) {

				problems.push( 'error converting back: ' + e.message );

			}

		}

		results.push( { corpus: 'khronos', name: m.name, problems } );
		report( results[ results.length - 1 ] );

	}

	return results;

}

function roundTrip( doc, mapping, back ) {

	const problems = new Map();
	const add = ( p ) => problems.set( p, ( problems.get( p ) || 0 ) + 1 );
	const byPath = new Map();
	back.json.nodes.forEach( ( n ) => { if ( n.extras?.usdPath && n.mesh !== undefined ) byPath.set( n.extras.usdPath, n ); } );

	// the k-th primitive mapped to a USD Mesh is its k-th GeomSubset, so the k-th primitive back
	const seen = new Map();

	for ( const [ key, path ] of Object.entries( mapping ) ) {

		const [ nodeIndex, p ] = key.split( '/' ).map( Number );
		const primitive = doc.json.meshes[ doc.json.nodes[ nodeIndex ].mesh ].primitives[ p ];
		const node = byPath.get( path );
		const k = seen.get( path ) || 0;
		seen.set( path, k + 1 );
		const outPrimitive = node ? back.json.meshes[ node.mesh ].primitives[ k ] : null;

		if ( ! outPrimitive ) {

			if ( ( primitive.mode ?? 4 ) >= 4 ) add( 'primitive missing' );
			continue;

		}

		const source = describeMaterial( doc, doc.json.materials?.[ primitive.material ] );
		const pixels = Object.values( source ).some( ( v ) => String( v?.image ).startsWith( 'pixels:' ) );
		for ( const d of materialDiffs( source, describeMaterial( back, back.json.materials?.[ outPrimitive.material ], pixels ) ) ) add( 'material ' + d );
		if ( ( primitive.attributes.COLOR_0 !== undefined ) !== ( outPrimitive.attributes.COLOR_0 !== undefined ) ) add( 'COLOR_0' );

	}

	const count = ( d, f ) => ( d.json.animations || [] ).reduce( ( n, a ) => n + a.channels.filter( f ).length, 0 );
	const pointerOrWeights = ( c ) => c.target.extensions?.KHR_animation_pointer || c.target.path === 'weights';
	if ( ( doc.json.animations?.length || 0 ) !== ( back.json.animations?.length || 0 ) ) add( `animations ${ doc.json.animations?.length || 0 } vs ${ back.json.animations?.length || 0 }` );
	if ( count( doc, pointerOrWeights ) && ! count( back, pointerOrWeights ) ) add( 'pointer / weight animation lost' );
	const variants = ( d ) => d.json.extensions?.KHR_materials_variants?.variants.length || 0;
	if ( variants( doc ) !== variants( back ) ) add( `variants ${ variants( doc ) } vs ${ variants( back ) }` );

	return [ ...problems ].map( ( [ p, n ] ) => `round trip: ${ p }${ n > 1 ? ` (x${ n })` : '' }` );

}

function report( r ) {

	console.log( `${ r.problems.length ? 'FAIL' : 'pass' }  ${ r.corpus.padEnd( 7 ) } ${ r.name }${ r.problems.length ? '\n        ' + r.problems.slice( 0, 4 ).join( '\n        ' ) : '' }` );

}

mkdirSync( out, { recursive: true } );
if ( ! existsSync( corpus ) ) {

	console.error( 'corpus/ is missing: run node scripts/fetch-corpus.js first' );
	process.exit( 1 );

}

const results = [];
if ( ! which || which === 'apple' ) results.push( ...await apple() );
if ( ! which || which === 'khronos' ) results.push( ...await khronos() );

const failed = results.filter( ( r ) => r.problems.length );
writeFileSync( join( out, 'report.json' ), JSON.stringify( results, null, 1 ) );
console.log( `\n${ results.length - failed.length } of ${ results.length } pass` );
process.exit( failed.length ? 1 : 0 );
