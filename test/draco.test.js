import { test } from 'node:test';
import assert from 'node:assert/strict';
import draco3d from 'draco3d';
import { glbToUSD, usdToGLB, ConversionLimitError } from '../src/index.js';
import { GLTFBuilder, readGLTF } from '../src/gltf/document.js';
import { loadDracoFromCDN } from '../src/gltf/draco.js';
import { evaluateScene } from './oracle/gltf-eval.js';

const encoder = await draco3d.createEncoderModule();

// A wavy grid of size x size vertices with normals and uvs, as Draco plus the json describing it.
function grid( size ) {

	const n = size * size;
	const positions = new Float32Array( n * 3 ), normals = new Float32Array( n * 3 ), uvs = new Float32Array( n * 2 );

	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const v = y * size + x;
		positions.set( [ x, Math.sin( x * 0.5 ) * Math.cos( y * 0.5 ), y ], v * 3 );
		normals.set( [ 0, 1, 0 ], v * 3 );
		uvs.set( [ x / ( size - 1 ), y / ( size - 1 ) ], v * 2 );

	}

	const indices = [];
	for ( let y = 0; y + 1 < size; y ++ ) for ( let x = 0; x + 1 < size; x ++ ) {

		const v = y * size + x;
		indices.push( v, v + size, v + 1, v + 1, v + size, v + size + 1 );

	}

	const mesh = new encoder.Mesh();
	const builder = new encoder.MeshBuilder();
	builder.AddFacesToMesh( mesh, indices.length / 3, Uint32Array.from( indices ) );
	const ids = {
		POSITION: builder.AddFloatAttributeToMesh( mesh, encoder.POSITION, n, 3, positions ),
		NORMAL: builder.AddFloatAttributeToMesh( mesh, encoder.NORMAL, n, 3, normals ),
		TEXCOORD_0: builder.AddFloatAttributeToMesh( mesh, encoder.TEX_COORD, n, 2, uvs ),
	};
	const e = new encoder.Encoder();
	e.SetAttributeQuantization( encoder.POSITION, 16 );
	const out = new encoder.DracoInt8Array();
	const length = e.EncodeMeshToDracoBuffer( mesh, out );
	const bytes = new Uint8Array( length );
	for ( let i = 0; i < length; i ++ ) bytes[ i ] = out.GetValue( i ) & 255;
	for ( const o of [ out, e, builder, mesh ] ) encoder.destroy( o );

	// the uncompressed reference, and the same asset with only Draco data
	const b = new GLTFBuilder( 'test' );
	const json = b.json;
	const attributes = { POSITION: b.addAccessor( positions, 'VEC3', { minmax: true } ), NORMAL: b.addAccessor( normals, 'VEC3' ), TEXCOORD_0: b.addAccessor( uvs, 'VEC2' ) };
	json.meshes.push( { primitives: [ { attributes, indices: b.addAccessor( Uint32Array.from( indices ), 'SCALAR' ) } ] } );
	json.nodes.push( { mesh: 0 } );
	json.scenes.push( { nodes: [ 0 ] } );
	json.scene = 0;
	const plain = b.toGLB();

	const view = b.addBufferView( bytes );
	const primitive = json.meshes[ 0 ].primitives[ 0 ];
	primitive.extensions = { KHR_draco_mesh_compression: { bufferView: view, attributes: ids } };
	const decodedPoints = n; // the mesh has no duplicate points to merge
	for ( const a of [ ...Object.values( attributes ), primitive.indices ] ) { delete json.accessors[ a ].bufferView; delete json.accessors[ a ].byteOffset; }
	for ( const a of Object.values( attributes ) ) json.accessors[ a ].count = decodedPoints;
	b.useExtension( 'KHR_draco_mesh_compression', true );
	return { plain, draco: b.toGLB() };

}

const bounds = ( doc ) => [ ...evaluateScene( doc, 0 ).values() ].map( ( n ) => [ ...n.min, ...n.max ].map( ( v ) => v.toFixed( 2 ) ).join( ' ' ) + ' ' + Math.round( n.triangles ) ); // Draco quantizes positions

test( 'Draco compressed glTF converts like the uncompressed original', async () => {

	const { plain, draco } = grid( 24 );
	const expected = bounds( await readGLTF( plain ) );
	assert.deepEqual( bounds( await readGLTF( draco ) ), expected, 'decoded' );
	assert.deepEqual( bounds( await readGLTF( await usdToGLB( await glbToUSD( draco ) ) ) ), expected, 'round trip' );

} );

test( 'a given dracoDecoder is used, and decoded data counts against the limits', async () => {

	const { draco } = grid( 24 );
	const module = await draco3d.createDecoderModule();
	let decoders = 0;
	const counting = new Proxy( module, { get: ( target, key ) => key === 'Decoder' ? function () { decoders ++; return new target.Decoder(); } : target[ key ] } );
	await glbToUSD( draco, { dracoDecoder: counting } );
	assert.equal( decoders, 1 );

	await assert.rejects( glbToUSD( draco, { dracoDecoder: module, maxDecodedBytes: 4000 } ), ( e ) => e instanceof ConversionLimitError && e.stage === 'draco' );
	await assert.rejects( glbToUSD( draco, { dracoDecoder: Promise.reject( new Error( 'no decoder here' ) ) } ), /no decoder here/ );

} );

test( 'the CDN decoder is only run when it matches its pinned hash', { skip: ! globalThis.crypto?.subtle && 'no Web Crypto global (Node 18)' }, async ( t ) => {

	t.mock.method( globalThis, 'fetch', async () => new Response( new TextEncoder().encode( 'globalThis.pwned = true' ) ) );
	await assert.rejects( loadDracoFromCDN(), /doesn't match its expected hash/ );
	assert.equal( globalThis.pwned, undefined );

} );
