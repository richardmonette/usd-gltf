import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGLB, writeGLB, detectFormat } from '../src/index.js';

test( 'GLB round trips JSON and BIN with 4 byte alignment', () => {

	const json = { asset: { version: '2.0' }, buffers: [ { byteLength: 5 } ] };
	const bin = new Uint8Array( [ 1, 2, 3, 4, 5 ] );

	const glb = writeGLB( json, bin );
	assert.equal( glb.byteLength % 4, 0 );
	assert.equal( detectFormat( glb ), 'glb' );

	const out = readGLB( glb );
	assert.deepEqual( out.json, json );
	assert.deepEqual( [ ...out.bin.subarray( 0, 5 ) ], [ 1, 2, 3, 4, 5 ] );

} );

test( 'GLB without a BIN chunk', () => {

	const out = readGLB( writeGLB( { asset: { version: '2.0' } } ) );
	assert.equal( out.bin, null );

} );

test( 'readGLB rejects non GLB data', () => {

	assert.throws( () => readGLB( new Uint8Array( 16 ) ), /not a GLB/ );

} );

test( 'detectFormat recognises each format from its leading bytes', () => {

	const enc = ( s ) => new TextEncoder().encode( s );
	assert.equal( detectFormat( enc( '#usda 1.0\n' ) ), 'usda' );
	assert.equal( detectFormat( enc( 'PXR-USDC\0\0' ) ), 'usdc' );
	assert.equal( detectFormat( enc( 'PK\x03\x04....' ) ), 'usdz' );
	assert.equal( detectFormat( enc( '\n  {"asset":{}}' ) ), 'gltf' );
	assert.equal( detectFormat( enc( 'hello' ) ), null );

} );
