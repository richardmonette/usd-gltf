import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glbToUSD, glbToUSDFiles, usdToGLB, readGLB, writeGLB, ConversionLimitError } from '../src/index.js';
import { GLTFBuilder } from '../src/gltf/document.js';
import { readZip } from '../src/usd/usdz.js';
import { deflate } from '../src/image/deflate.js';
import { crc32 } from '../src/util/crc32.js';
import { Budget } from '../src/limits.js';

// nodes copies of one textured mesh of n vertices
function scene( { n = 3000, nodes = 1 } = {} ) {

	const b = new GLTFBuilder( 'test' );
	const json = b.json;
	const positions = Float32Array.from( { length: n * 3 }, ( _, i ) => Math.sin( i ) );
	const indices = Uint32Array.from( { length: n - ( n % 3 ) }, ( _, i ) => i );
	json.meshes.push( { primitives: [ { attributes: { POSITION: b.addAccessor( positions, 'VEC3', { minmax: true } ) }, indices: b.addAccessor( indices, 'SCALAR' ) } ] } );
	for ( let i = 0; i < nodes; i ++ ) json.nodes.push( { mesh: 0, translation: [ i, 0, 0 ] } );
	json.scenes.push( { nodes: json.nodes.map( ( _, i ) => i ) } );
	json.scene = 0;
	return b.toGLB();

}

function limitError( stage, resource ) {

	return ( e ) => {

		assert.ok( e instanceof ConversionLimitError, e.message );
		assert.equal( e.resource, resource );
		assert.match( e.stage, stage );
		assert.ok( e.attempted > e.limit );
		return true;

	};

}

test( 'without limits nothing changes', async () => {

	const glb = scene();
	assert.deepEqual( await glbToUSD( glb, { maxDecodedBytes: Infinity, maxOutputBytes: Infinity } ), await glbToUSD( glb ) );

} );

test( 'a decoded data limit fails before the accessor is allocated', async () => {

	// 100 million vertices declared with no data behind them: valid glTF, 1.2 GB once decoded
	const { json, bin } = readGLB( scene() );
	json.accessors.push( { componentType: 5126, count: 1e8, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 0, 0, 0 ] } );
	json.meshes[ 0 ].primitives[ 0 ].attributes.POSITION = json.accessors.length - 1;
	delete json.meshes[ 0 ].primitives[ 0 ].indices;
	await assert.rejects( glbToUSD( writeGLB( json, bin ), { maxDecodedBytes: 64e6 } ), limitError( /^accessor/, 'decoded' ) );

} );

test( 'impossible sizes and out of bounds accessors are rejected whatever the limits', async () => {

	const { json, bin } = readGLB( scene() );
	json.accessors[ 0 ].count = 2 ** 52;
	await assert.rejects( glbToUSD( writeGLB( json, bin ) ), /invalid size in accessor 0/ );

	json.accessors[ 0 ].count = 1e6;
	await assert.rejects( glbToUSD( writeGLB( json, bin ) ), /accessor 0 reads past the end of its bufferView/ );

	json.accessors[ 0 ].count = 3000;
	json.bufferViews[ 0 ].byteLength = bin.length * 2;
	await assert.rejects( glbToUSD( writeGLB( json, bin ) ), /bufferView 0 is outside its buffer/ );

} );

test( 'repeated references to the same data count every time they are written', async () => {

	assert.ok( ( await glbToUSD( scene( { nodes: 1 } ), { maxDecodedBytes: 1e6 } ) ).length );
	// each node writes the mesh again in the USD layer: 72 KB of points and indices per copy
	await assert.rejects( glbToUSD( scene( { nodes: 40 } ), { maxDecodedBytes: 1e6 } ), limitError( /usd layer/, 'decoded' ) );

} );

test( 'an output limit fails before the container is allocated', async () => {

	const glb = scene( { nodes: 4 } );
	const size = ( await glbToUSD( glb ) ).length;

	await assert.rejects( glbToUSD( glb, { maxOutputBytes: size - 1 } ), limitError( /usdz|usdc/, 'output' ) );
	await assert.rejects( glbToUSD( glb, { format: 'usda', maxOutputBytes: 10000 } ), limitError( /usda/, 'output' ) );
	await assert.rejects( glbToUSDFiles( glb, { format: 'usdc', maxOutputBytes: 10000 } ), limitError( /usdc|usd files/, 'output' ) );
	assert.equal( ( await glbToUSD( glb, { maxOutputBytes: size } ) ).length, size );

	const usdz = await glbToUSD( glb );
	const back = ( await usdToGLB( usdz ) ).length;
	await assert.rejects( usdToGLB( usdz, { maxOutputBytes: back - 1 } ), limitError( /glb/, 'output' ) );
	assert.equal( ( await usdToGLB( usdz, { maxOutputBytes: back } ) ).length, back );

} );

test( 'USD input counts against the decoded limit', async () => {

	const usdz = await glbToUSD( scene( { n: 30000 } ) );
	await assert.rejects( usdToGLB( usdz, { maxDecodedBytes: 100000 } ), limitError( /usdc/, 'decoded' ) );

} );

test( 'images are charged from their header before decoding', async () => {

	// a lossless WebP header claiming 16384 x 16384 pixels: 1 GB of RGBA
	const webp = new Uint8Array( 30 );
	webp.set( new TextEncoder().encode( 'RIFF' ), 0 );
	new DataView( webp.buffer ).setUint32( 4, 22, true );
	webp.set( new TextEncoder().encode( 'WEBPVP8L' ), 8 );
	new DataView( webp.buffer ).setUint32( 16, 10, true );
	webp[ 20 ] = 0x2F;
	new DataView( webp.buffer ).setUint32( 21, 16383 | ( 16383 << 14 ), true );

	const b = new GLTFBuilder( 'test' );
	const image = b.addImage( webp, 'image/webp' );
	b.json.textures.push( { extensions: { EXT_texture_webp: { source: image } } } );
	b.json.materials.push( { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } } );
	b.useExtension( 'EXT_texture_webp', true );
	b.json.meshes.push( { primitives: [ { attributes: { POSITION: b.addAccessor( Float32Array.of( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 'VEC3', { minmax: true } ) }, material: 0 } ] } );
	b.json.nodes.push( { mesh: 0 } );
	b.json.scenes.push( { nodes: [ 0 ] } );
	await assert.rejects( glbToUSD( b.toGLB(), { maxDecodedBytes: 256e6 } ), limitError( /image/, 'decoded' ) );

} );

test( 'zip entries must inflate to their declared size, which is charged first', () => {

	const big = new Uint8Array( 1 << 20 ); // a megabyte of zeros deflates to about a kilobyte
	const data = deflate( big );
	const zip = ( declared ) => {

		const name = new TextEncoder().encode( 'a.usda' );
		const local = new Uint8Array( 30 + name.length ), central = new Uint8Array( 46 + name.length ), end = new Uint8Array( 22 );
		const lv = new DataView( local.buffer ), cv = new DataView( central.buffer ), ev = new DataView( end.buffer );
		lv.setUint32( 0, 0x04034b50, true ); lv.setUint16( 8, 8, true ); lv.setUint32( 14, crc32( big ), true ); lv.setUint32( 18, data.length, true ); lv.setUint32( 22, declared, true ); lv.setUint16( 26, name.length, true ); local.set( name, 30 );
		cv.setUint32( 0, 0x02014b50, true ); cv.setUint16( 10, 8, true ); cv.setUint32( 16, crc32( big ), true ); cv.setUint32( 20, data.length, true ); cv.setUint32( 24, declared, true ); cv.setUint16( 28, name.length, true ); central.set( name, 46 );
		ev.setUint32( 0, 0x06054b50, true ); ev.setUint16( 8, 1, true ); ev.setUint16( 10, 1, true ); ev.setUint32( 12, central.length, true ); ev.setUint32( 16, local.length + data.length, true );
		const out = new Uint8Array( local.length + data.length + central.length + 22 );
		out.set( local ); out.set( data, local.length ); out.set( central, local.length + data.length ); out.set( end, local.length + data.length + central.length );
		return out;

	};

	assert.equal( readZip( zip( big.length ) ).get( 'a.usda' ).length, big.length );
	assert.throws( () => readZip( zip( 1000 ) ), /more than the expected 1000 bytes/ );
	assert.throws( () => readZip( zip( big.length ), { budget: new Budget( { maxDecodedBytes: 1e5 } ) } ), ConversionLimitError );

} );

test( 'cancelling stops the conversion and returns nothing', async () => {

	const glb = scene( { nodes: 4 } );
	const done = new AbortController();
	done.abort();
	await assert.rejects( glbToUSD( glb, { signal: done.signal } ), { name: 'AbortError' } );
	await assert.rejects( usdToGLB( await glbToUSD( glb ), { signal: done.signal } ), { name: 'AbortError' } );

	// cancelled while running: here when the external buffer is requested
	const { json, bin } = readGLB( glb );
	json.buffers = [ { byteLength: bin.length, uri: 'data.bin' } ];
	const running = new AbortController();
	const resolver = () => { running.abort( new Error( 'stop' ) ); return bin; };
	await assert.rejects( glbToUSD( new TextEncoder().encode( JSON.stringify( json ) ), { resolver, signal: running.signal } ), /stop/ );

} );
