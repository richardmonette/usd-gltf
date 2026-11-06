import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import draco3d from 'draco3d';
import validator from 'gltf-validator';
import { glbToUSD, usdToGLB, writeGLB, DracoMismatchError, ConversionLimitError } from '../src/index.js';
import { readGLTF } from '../src/gltf/document.js';

const encoder = await draco3d.createEncoderModule();
const dracoDecoder = await draco3d.createDecoderModule();

const root = path.resolve( import.meta.dirname, '..' );
const python = [ '.venv/Scripts/python.exe', '.venv/bin/python' ].map( ( p ) => path.join( root, p ) ).find( ( p ) => fs.existsSync( p ) );

// Draco data for a mesh of positions and triangle indices.
function encode( positions, indices ) {

	const mesh = new encoder.Mesh();
	const builder = new encoder.MeshBuilder();
	const e = new encoder.Encoder();
	const out = new encoder.DracoInt8Array();

	try {

		const id = builder.AddFloatAttributeToMesh( mesh, encoder.POSITION, positions.length / 3, 3, Float32Array.from( positions ) );
		builder.AddFacesToMesh( mesh, indices.length / 3, Uint32Array.from( indices ) );
		e.SetSpeedOptions( 5, 5 );
		const length = e.EncodeMeshToDracoBuffer( mesh, out );
		return { id, bytes: Uint8Array.from( { length }, ( _, i ) => out.GetValue( i ) ) };

	} finally {

		for ( const o of [ out, e, builder, mesh ] ) encoder.destroy( o );

	}

}

function grid( size ) {

	const positions = [], indices = [];
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) positions.push( x, y, 0 );
	for ( let y = 0; y + 1 < size; y ++ ) for ( let x = 0; x + 1 < size; x ++ ) { const v = y * size + x; indices.push( v, v + 1, v + size, v + 1, v + size + 1, v + size ); }
	return encode( positions, indices );

}

// bufferViews: 0 the triangle, 1 zeros for uncompressed accessors, 2 a bigger triangle, 3 a 17 x 17 grid (289 points)
const payloads = [ encode( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] ), { bytes: new Uint8Array( 512 ) }, encode( [ 0, 0, 0, 2, 0, 0, 0, 2, 0 ], [ 0, 1, 2 ] ), grid( 17 ) ];
const pad = ( n ) => ( n + 3 ) & ~ 3;
const bin = new Uint8Array( payloads.reduce( ( n, p ) => n + pad( p.bytes.length ), 0 ) );
const bufferViews = [];
for ( let offset = 0, i = 0; i < payloads.length; offset += pad( payloads[ i ].bytes.length ), i ++ ) { bin.set( payloads[ i ].bytes, offset ); bufferViews.push( { buffer: 0, byteOffset: offset, byteLength: payloads[ i ].bytes.length } ); }

const dracoPrimitive = ( position, indices, view ) => ( { attributes: { POSITION: position }, indices, extensions: { KHR_draco_mesh_compression: { bufferView: view, attributes: { POSITION: payloads[ view ].id } } } } );

// The triangle, as in the issue: accessor 0 POSITION, accessor 1 indices; edit changes the json.
function model( edit = () => {} ) {

	const json = {
		asset: { version: '2.0' },
		scene: 0, scenes: [ { nodes: [ 0 ] } ], nodes: [ { mesh: 0 } ],
		meshes: [ { primitives: [ dracoPrimitive( 0, 1, 0 ) ] } ],
		buffers: [ { byteLength: bin.length } ],
		bufferViews: structuredClone( bufferViews ),
		accessors: [
			{ componentType: 5126, type: 'VEC3', count: 3, min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] },
			{ componentType: 5123, type: 'SCALAR', count: 3 },
		],
		extensionsUsed: [ 'KHR_draco_mesh_compression' ],
		extensionsRequired: [ 'KHR_draco_mesh_compression' ],
	};
	edit( json );
	return writeGLB( json, bin );

}

const convert = ( glb, options = {} ) => glbToUSD( glb, { dracoDecoder, ...options } );

async function mismatch( glb, options ) {

	let error;
	await assert.rejects( convert( glb, options ), ( e ) => { error = e; return e instanceof DracoMismatchError; } );
	return error;

}

test( 'matching Draco metadata converts without any log', async () => {

	const log = [];
	await convert( model(), { log: ( m ) => log.push( m ), recoverDracoCounts: true } );
	assert.deepEqual( log, [] );

} );

test( 'Draco count mismatches name what disagrees', async () => {

	const e = await mismatch( model( ( json ) => { json.accessors[ 0 ].count = 9; } ) );
	assert.deepEqual( { kind: e.kind, mesh: e.mesh, primitive: e.primitive, semantic: e.semantic, accessor: e.accessor, declared: e.declared, decoded: e.decoded, unrecoverable: e.unrecoverable, code: e.code },
		{ kind: 'count', mesh: 0, primitive: 0, semantic: 'POSITION', accessor: 0, declared: 9, decoded: 3, unrecoverable: null, code: 'USD_GLTF_DRACO_MISMATCH' } );
	assert.match( e.message, /POSITION decodes to 3 elements, but accessor 0 declares 9.*recoverDracoCounts/ );

	const i = await mismatch( model( ( json ) => { json.accessors[ 1 ].count = 6; } ) );
	assert.deepEqual( [ i.kind, i.semantic, i.accessor, i.declared, i.decoded ], [ 'index-count', 'indices', 1, 6, 3 ] );

} );

test( 'other Draco mismatches fail, with or without count recovery', async () => {

	for ( const recoverDracoCounts of [ false, true ] ) {

		const c = await mismatch( model( ( json ) => { json.accessors[ 0 ].type = 'VEC4'; } ), { recoverDracoCounts } );
		assert.deepEqual( [ c.kind, c.declared, c.decoded ], [ 'components', 'VEC4', 3 ] );

		// 289 points don't fit unsigned byte indices
		const t = await mismatch( model( ( json ) => {

			json.meshes[ 0 ].primitives[ 0 ] = dracoPrimitive( 0, 1, 3 );
			json.accessors = [ { componentType: 5126, type: 'VEC3', count: 289, min: [ 0, 0, 0 ], max: [ 16, 16, 0 ] }, { componentType: 5121, type: 'SCALAR', count: 1536 } ];

		} ), { recoverDracoCounts } );
		assert.deepEqual( [ t.kind, t.semantic, t.declared ], [ 'component-type', 'indices', 5121 ] );

		const a = await mismatch( model( ( json ) => { json.meshes[ 0 ].primitives[ 0 ].extensions.KHR_draco_mesh_compression.attributes.POSITION = 7; } ), { recoverDracoCounts } );
		assert.deepEqual( [ a.kind, a.declared ], [ 'attribute', 7 ] );

		// two Draco primitives decoding one accessor to different positions
		const s = await mismatch( model( ( json ) => { json.meshes[ 0 ].primitives.push( dracoPrimitive( 0, 1, 2 ) ); } ), { recoverDracoCounts } );
		assert.deepEqual( [ s.kind, s.mesh, s.primitive, s.accessor ], [ 'shared-accessor', 0, 1, 0 ] );

	}

} );

test( 'recoverDracoCounts uses the decoded counts, and logs it', async () => {

	for ( const edit of [ ( json ) => { json.accessors[ 0 ].count = 9; }, ( json ) => { json.accessors[ 1 ].count = 6; }, ( json ) => { json.accessors[ 0 ].count = 9; json.accessors[ 1 ].count = 6; } ] ) {

		const log = [];
		const usdz = await convert( model( edit ), { recoverDracoCounts: true, log: ( m ) => log.push( m ) } );
		assert.equal( log.length, 1 );
		assert.match( log[ 0 ], /^Draco mesh 0 primitive 0: using the decoded counts, / );

		const glb = await usdToGLB( usdz );
		const { json } = await readGLTF( glb );
		const primitive = json.meshes[ 0 ].primitives[ 0 ];
		const position = json.accessors[ primitive.attributes.POSITION ];
		assert.deepEqual( [ position.count, position.min, position.max, json.accessors[ primitive.indices ].count ], [ 3, [ 0, 0, 0 ], [ 1, 1, 0 ], 3 ] );

		const report = await validator.validateBytes( glb, { writeTimestamp: false } );
		assert.deepEqual( report.issues.messages.filter( ( m ) => m.severity === 0 ), [], 'glTF validator errors' );

	}

	// shared by two Draco primitives decoding the same data
	await convert( model( ( json ) => { json.accessors[ 0 ].count = 9; json.meshes[ 0 ].primitives.push( dracoPrimitive( 0, 1, 0 ) ); } ), { recoverDracoCounts: true } );

} );

test( 'recovered output passes OpenUSD validation', { skip: ! python && 'needs usd-core in .venv' }, async () => {

	const dir = fs.mkdtempSync( path.join( os.tmpdir(), 'usd-gltf-draco-' ) );
	const file = path.join( dir, 'recovered.usdz' );
	fs.writeFileSync( file, await convert( model( ( json ) => { json.accessors[ 0 ].count = 9; } ), { recoverDracoCounts: true } ) );
	const out = path.join( dir, 'stats.json' );
	execFileSync( python, [ path.join( root, 'test', 'oracle', 'usd_stats.py' ), out, '--check', file ], { stdio: 'ignore' } );
	const stats = JSON.parse( fs.readFileSync( out, 'utf8' ) )[ file ];
	assert.deepEqual( [ stats.error, stats.errors, stats.warnings ], [ undefined, [], [] ] );
	const meshes = Object.values( stats.meshes );
	assert.equal( meshes.length, 1 );
	assert.equal( meshes[ 0 ].triangles, 1 );
	const [ lo, hi ] = Object.values( meshes[ 0 ].bounds )[ 0 ];
	assert.ok( hi[ 0 ] - lo[ 0 ] > 0 && hi[ 1 ] - lo[ 1 ] > 0, 'nonzero geometry' );

} );

test( 'counts are not recovered when other data depends on the declared ones', async () => {

	const cases = [
		[ ( json ) => { json.meshes.push( { primitives: [ { attributes: { POSITION: 0 } } ] } ); }, /accessor 0 is also used by mesh 1 primitive 0 POSITION/ ],
		[ ( json ) => { json.animations = [ { channels: [], samplers: [ { input: 2, output: 0 } ] } ]; json.accessors.push( { bufferView: 1, componentType: 5126, type: 'SCALAR', count: 9 } ); }, /accessor 0 is also used by animation 0 sampler 0/ ],
		[ ( json ) => { json.accessors.push( { bufferView: 1, componentType: 5126, type: 'VEC3', count: 9 } ); json.meshes[ 0 ].primitives[ 0 ].attributes.NORMAL = 2; }, /NORMAL isn't Draco compressed and has 9 elements, not 3/ ],
		[ ( json ) => { json.accessors.push( { bufferView: 1, componentType: 5126, type: 'VEC3', count: 9 } ); json.meshes[ 0 ].primitives[ 0 ].targets = [ { POSITION: 2 } ]; }, /morph target 0 POSITION has 9 elements, not 3/ ],
		[ ( json ) => { json.accessors[ 0 ].max = [ 5, 5, 0 ]; }, /decoded positions don't match POSITION accessor 0's min and max/ ],
		[ ( json ) => { delete json.accessors[ 0 ].min; delete json.accessors[ 0 ].max; }, /no min and max/ ],
	];

	for ( const [ edit, reason ] of cases ) {

		const e = await mismatch( model( ( json ) => { json.accessors[ 0 ].count = 9; edit( json ); } ), { recoverDracoCounts: true } );
		assert.equal( e.kind, 'count' );
		assert.match( e.unrecoverable, reason );
		assert.match( e.message, /not recovered, as / );

	}

} );

test( 'declared Draco counts are never allocated, and limits hold with recovery', async () => {

	// a billion declared positions: the decoded three are all that's allocated
	const huge = model( ( json ) => { json.accessors[ 0 ].count = 1e9; } );
	assert.equal( ( await mismatch( huge, { maxDecodedBytes: 100000 } ) ).declared, 1e9 );
	await convert( huge, { recoverDracoCounts: true, maxDecodedBytes: 100000 } );

	const declared = model( ( json ) => { json.accessors[ 0 ].count = 9; } );
	for ( const recoverDracoCounts of [ false, true ] ) {

		await assert.rejects( convert( declared, { recoverDracoCounts, maxDecodedBytes: 20 } ), ( e ) => e instanceof ConversionLimitError && e.stage === 'draco' );
		await assert.rejects( convert( declared, { recoverDracoCounts, signal: AbortSignal.abort() } ), { name: 'AbortError' } );

	}

	await assert.rejects( convert( declared, { recoverDracoCounts: true, maxOutputBytes: 100 } ), ConversionLimitError );

} );
