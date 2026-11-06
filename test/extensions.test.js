import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glbToUSD, usdToGLB, readGLB, writeGLB } from '../src/index.js';
import { GLTFBuilder, readGLTF } from '../src/gltf/document.js';

function triangle() {

	const b = new GLTFBuilder( 'test' );
	const json = b.json;
	json.meshes.push( { primitives: [ {
		attributes: { POSITION: b.addAccessor( Float32Array.of( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 'VEC3', { minmax: true } ) },
		indices: b.addAccessor( Uint16Array.of( 0, 1, 2 ), 'SCALAR' ),
	} ] } );
	json.nodes.push( { mesh: 0 } );
	json.scenes.push( { nodes: [ 0 ] } );
	json.scene = 0;
	return readGLB( b.toGLB() );

}

// A Draco primitive whose compressed data is garbage: it must fail, not convert zeros.
function corruptDraco() {

	const { json, bin } = triangle();
	json.bufferViews.push( { buffer: 0, byteOffset: 0, byteLength: 4 } );
	const primitive = json.meshes[ 0 ].primitives[ 0 ];
	primitive.extensions = { KHR_draco_mesh_compression: { bufferView: json.bufferViews.length - 1, attributes: { POSITION: 0 } } };
	for ( const a of [ primitive.attributes.POSITION, primitive.indices ] ) delete json.accessors[ a ].bufferView;
	json.extensionsUsed = json.extensionsRequired = [ 'KHR_draco_mesh_compression' ];
	return writeGLB( json, bin );

}

test( 'Draco data that fails to decode is an error, not zero-filled geometry', async () => {

	await assert.rejects( glbToUSD( corruptDraco() ), /Draco/ );

} );

test( 'optional Draco with an uncompressed fallback converts from the fallback without a decoder', async () => {

	const { json, bin } = triangle();
	json.meshes[ 0 ].primitives[ 0 ].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
	json.extensionsUsed = [ 'KHR_draco_mesh_compression' ];
	const unused = new Proxy( {}, { get: () => { throw new Error( 'decoder used' ); } } );
	const doc = await readGLTF( await usdToGLB( await glbToUSD( writeGLB( json, bin ), { dracoDecoder: unused } ) ) );
	const position = doc.json.accessors[ doc.json.meshes[ 0 ].primitives[ 0 ].attributes.POSITION ];
	assert.deepEqual( [ position.min, position.max ], [ [ 0, 0, 0 ], [ 1, 1, 0 ] ] );

} );

test( 'other unsupported required extensions are named, supported ones pass', async () => {

	const { json, bin } = triangle();
	json.extensionsRequired = [ 'KHR_texture_basisu', 'KHR_materials_volume', 'KHR_mesh_quantization', 'EXT_unknown' ];
	await assert.rejects( glbToUSD( writeGLB( json, bin ) ), /required extensions KHR_texture_basisu, EXT_unknown not supported/ );

	json.extensionsRequired = [ 'KHR_materials_volume', 'KHR_mesh_quantization', 'KHR_texture_transform' ];
	await glbToUSD( writeGLB( json, bin ) );

} );

test( 'accessors without a bufferView still read as zeros plus sparse values', async () => {

	const { json, bin } = triangle();
	// replace POSITION with a sparse accessor over zeros: vertex 1 -> (1, 0, 0), vertex 2 -> (0, 1, 0)
	const extra = new Uint8Array( bin.length + 4 + 24 );
	extra.set( bin );
	new Uint16Array( extra.buffer, bin.length, 2 ).set( [ 1, 2 ] );
	new Float32Array( extra.buffer, bin.length + 4, 6 ).set( [ 1, 0, 0, 0, 1, 0 ] );
	json.buffers[ 0 ].byteLength = extra.length;
	json.bufferViews.push( { buffer: 0, byteOffset: bin.length, byteLength: 4 }, { buffer: 0, byteOffset: bin.length + 4, byteLength: 24 } );
	const n = json.bufferViews.length;
	json.accessors.push( { componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ], sparse: { count: 2, indices: { bufferView: n - 2, componentType: 5123 }, values: { bufferView: n - 1 } } } );
	json.meshes[ 0 ].primitives[ 0 ].attributes.POSITION = json.accessors.length - 1;

	const doc = await readGLTF( writeGLB( json, extra ) );
	assert.deepEqual( Array.from( doc.getFloats( json.accessors.length - 1 ).array ), [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
	await glbToUSD( writeGLB( json, extra ) );

} );

test( 'sparse accessors read correctly from Node Buffers', async () => {

	const { json, bin } = triangle();
	const data = new Uint8Array( bin.length + 4 + 24 );
	data.set( bin );
	new Uint16Array( data.buffer, bin.length, 2 ).set( [ 1, 2 ] );
	new Float32Array( data.buffer, bin.length + 4, 6 ).set( [ 1, 0, 0, 0, 1, 0 ] );
	const pooled = Buffer.from( data ); // small Buffers share a pool, so their slice().buffer isn't their bytes
	assert.notEqual( pooled.buffer.byteLength, pooled.length );

	json.buffers = [ { byteLength: data.length, uri: 'data.bin' } ];
	json.bufferViews.push( { buffer: 0, byteOffset: bin.length, byteLength: 4 }, { buffer: 0, byteOffset: bin.length + 4, byteLength: 24 } );
	const n = json.bufferViews.length;
	json.accessors.push( { componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ], sparse: { count: 2, indices: { bufferView: n - 2, componentType: 5123 }, values: { bufferView: n - 1 } } } );

	const doc = await readGLTF( Buffer.from( JSON.stringify( json ) ), { resolver: () => pooled } );
	assert.deepEqual( Array.from( doc.getFloats( json.accessors.length - 1 ).array ), [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );

} );
