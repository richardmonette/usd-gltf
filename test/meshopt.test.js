import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { decodeVertexBuffer, decodeIndexBuffer, decodeIndexSequence, decodeMeshoptView } from '../src/gltf/meshopt.js';

// the official decoder (WASM) is the oracle; skip when the dev dependency isn't installed
let MeshoptDecoder = null, MeshoptEncoder = null;

try {

	( { MeshoptDecoder, MeshoptEncoder } = await import( 'meshoptimizer' ) );
	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;

} catch {

	MeshoptDecoder = null;

}

const skip = ! MeshoptDecoder && 'meshoptimizer is not installed';

function random( seed ) {

	return () => ( seed = ( Math.imul( seed, 1664525 ) + 1013904223 ) >>> 0 ) / 4294967296;

}

test( 'vertex codec matches the official decoder', { skip }, () => {

	const rand = random( 1 );

	for ( const size of [ 4, 8, 12, 16, 20, 32, 64 ] ) {

		for ( const count of [ 1, 15, 16, 17, 255, 256, 257, 1000, 5000 ] ) {

			for ( const kind of [ 'random', 'smooth', 'floats' ] ) {

				const data = new Uint8Array( count * size );

				if ( kind === 'random' ) for ( let i = 0; i < data.length; i ++ ) data[ i ] = rand() * 256;
				else if ( kind === 'smooth' ) for ( let i = 0; i < data.length; i ++ ) data[ i ] = ( ( i / size ) | 0 ) * ( i % size + 1 ) + ( rand() * 3 | 0 );
				else new Float32Array( data.buffer ).forEach( ( _, i, a ) => { a[ i ] = Math.sin( i * 0.01 ) * 10 + rand() * 0.001; } );

				for ( const version of [ 0, 1 ] ) {

					const encoded = version === 0 && MeshoptEncoder.encodeVertexBufferLevel
						? MeshoptEncoder.encodeVertexBufferLevel( data, count, size, 2, 0 )
						: MeshoptEncoder.encodeVertexBuffer( data, count, size );
					const expected = new Uint8Array( count * size );
					MeshoptDecoder.decodeVertexBuffer( expected, count, size, encoded );
					const actual = decodeVertexBuffer( new Uint8Array( count * size ), count, size, encoded );
					assert.deepEqual( actual, expected, `size ${ size } count ${ count } ${ kind } v${ encoded[ 0 ] & 15 }` );
					assert.deepEqual( actual, data );

				}

			}

		}

	}

} );

test( 'index codecs match the official decoder', { skip }, () => {

	const rand = random( 2 );

	for ( const triangles of [ 1, 10, 100, 5000 ] ) {

		// a grid-like mesh plus random triangles exercises the fifo paths and free indices
		const indices = new Uint32Array( triangles * 3 );
		for ( let i = 0; i < triangles; i ++ ) {

			if ( i % 7 === 6 ) { indices[ i * 3 ] = rand() * 70000; indices[ i * 3 + 1 ] = rand() * 70000; indices[ i * 3 + 2 ] = rand() * 70000; continue; }
			const base = i >> 1;
			indices.set( i & 1 ? [ base, base + 101, base + 100 ] : [ base, base + 1, base + 101 ], i * 3 );

		}

		const encoded = MeshoptEncoder.encodeIndexBuffer( new Uint8Array( indices.buffer ), indices.length, 4 );
		const expected = new Uint32Array( indices.length );
		MeshoptDecoder.decodeIndexBuffer( new Uint8Array( expected.buffer ), indices.length, 4, encoded );
		assert.deepEqual( decodeIndexBuffer( new Uint32Array( indices.length ), indices.length, encoded ), expected );

		const seq = MeshoptEncoder.encodeIndexSequence( new Uint8Array( indices.buffer ), indices.length, 4 );
		assert.deepEqual( decodeIndexSequence( new Uint32Array( indices.length ), indices.length, seq ), indices );

	}

} );

test( 'filters match the official decoder within one unit', { skip }, () => {

	const rand = random( 3 );
	const count = 1000;

	const check = ( filter, stride, make ) => {

		const data = make();
		const encoded = MeshoptEncoder.encodeVertexBuffer( data, count, stride );
		const expected = new Uint8Array( count * stride );
		MeshoptDecoder.decodeVertexBuffer( expected, count, stride, encoded, filter );
		const ext = { buffer: 0, byteOffset: 0, byteLength: encoded.length, byteStride: stride, count, mode: 'ATTRIBUTES', filter };
		const actual = decodeMeshoptView( ext, [ encoded ] );

		const View = filter === 'EXPONENTIAL' ? Float32Array : stride === 4 ? ( filter === 'COLOR' ? Uint8Array : Int8Array ) : ( filter === 'COLOR' ? Uint16Array : Int16Array );
		const a = new View( actual.buffer ), e = new View( expected.buffer );
		for ( let i = 0; i < a.length; i ++ ) {

			const tolerance = filter === 'EXPONENTIAL' ? Math.abs( e[ i ] ) * 1e-6 : 1;
			assert.ok( Math.abs( a[ i ] - e[ i ] ) <= tolerance, `${ filter } stride ${ stride } element ${ i }: ${ a[ i ] } vs ${ e[ i ] }` );

		}

	};

	const vectors = ( n ) => Float32Array.from( { length: count * n }, () => rand() * 2 - 1 );

	check( 'OCTAHEDRAL', 4, () => MeshoptEncoder.encodeFilterOct( vectors( 4 ), count, 4, 8 ) );
	check( 'OCTAHEDRAL', 8, () => MeshoptEncoder.encodeFilterOct( vectors( 4 ), count, 8, 12 ) );
	check( 'QUATERNION', 8, () => MeshoptEncoder.encodeFilterQuat( vectors( 4 ), count, 8, 12 ) );
	check( 'EXPONENTIAL', 12, () => MeshoptEncoder.encodeFilterExp( vectors( 3 ).map( ( v ) => v * 1000 ), count, 12, 15 ) );
	if ( MeshoptEncoder.encodeFilterColor ) check( 'COLOR', 4, () => MeshoptEncoder.encodeFilterColor( Float32Array.from( { length: count * 4 }, () => rand() ), count, 4, 8 ) );

} );

const corpus = new URL( '../corpus/khronos/Models/MeshoptCubeTest/glTF/', import.meta.url );

test( 'MeshoptCubeTest decodes like the official decoder', { skip: skip || ! existsSync( corpus ) && 'corpus not downloaded' }, async () => {

	const { readGLTF } = await import( '../src/gltf/document.js' );
	const file = new URL( 'MeshoptCubeTest.gltf', corpus );
	const doc = await readGLTF( readFileSync( file ), { resolver: ( uri ) => readFileSync( new URL( uri, corpus ) ) } );
	const json = doc.json;

	for ( const [ i, view ] of json.bufferViews.entries() ) {

		const ext = view.extensions?.KHR_meshopt_compression || view.extensions?.EXT_meshopt_compression;
		if ( ! ext ) continue;
		const source = doc.buffers[ ext.buffer ].subarray( ext.byteOffset || 0, ( ext.byteOffset || 0 ) + ext.byteLength );
		const expected = new Uint8Array( ext.count * ext.byteStride );
		MeshoptDecoder.decodeGltfBuffer( expected, ext.count, ext.byteStride, source, ext.mode, ext.filter );
		const actual = doc.bufferViewBytes( i );
		assert.equal( actual.length, expected.length, `view ${ i }` );
		let maxDiff = 0;
		for ( let k = 0; k < actual.length; k ++ ) maxDiff = Math.max( maxDiff, Math.abs( actual[ k ] - expected[ k ] ) );
		assert.ok( maxDiff <= 1 || ext.filter === 'EXPONENTIAL', `view ${ i } ${ ext.mode } ${ ext.filter } max byte diff ${ maxDiff }` );

	}

	const positions = doc.getFloats( json.meshes[ 0 ].primitives[ 0 ].attributes.POSITION ).array;
	assert.ok( positions.some( ( v ) => v !== 0 ), 'positions decoded' );

} );
