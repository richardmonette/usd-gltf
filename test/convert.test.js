import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glbToUSD, usdToGLB, readGLB, writeGLB, detectFormat, readUSDA } from '../src/index.js';
import { GLTFBuilder, readGLTF } from '../src/gltf/document.js';
import { encodePNG } from '../src/image/index.js';
import { readZip } from '../src/usd/usdz.js';
import { evaluateScene } from './oracle/gltf-eval.js';

// A small GLB: a textured, skinned, animated quad with a second static node.
function makeGLB() {

	const b = new GLTFBuilder( 'test' );
	const json = b.json;

	const positions = Float32Array.of( - 1, 0, 0, 1, 0, 0, 1, 2, 0, - 1, 2, 0 );
	const normals = Float32Array.of( 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1 );
	const uvs = Float32Array.of( 0, 1, 1, 1, 1, 0, 0, 0 );
	const joints = Uint8Array.of( 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0 );
	const weights = Float32Array.of( 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0 );
	const indices = Uint16Array.of( 0, 1, 2, 0, 2, 3 );

	const pixels = new Uint8Array( 4 * 4 * 3 ).map( ( _, i ) => ( i * 37 ) & 255 );
	const image = b.addImage( encodePNG( { width: 4, height: 4, channels: 3, data: pixels } ), 'image/png', 'checker' );
	json.samplers.push( { wrapS: 33071, wrapT: 10497 } );
	json.textures.push( { source: image, sampler: 0 } );
	json.materials.push( {
		name: 'painted',
		pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [ 1, 0.5, 0.25, 1 ], metallicFactor: 0.2, roughnessFactor: 0.7 },
		emissiveFactor: [ 0.1, 0.2, 0.3 ],
		doubleSided: true,
		extensions: { KHR_materials_sheen: { sheenColorFactor: [ 1, 0, 0 ] } },
	} );
	b.useExtension( 'KHR_materials_sheen' );

	json.meshes.push( { name: 'quad', primitives: [ {
		attributes: {
			POSITION: b.addAccessor( positions, 'VEC3', { minmax: true } ),
			NORMAL: b.addAccessor( normals, 'VEC3' ),
			TEXCOORD_0: b.addAccessor( uvs, 'VEC2' ),
			JOINTS_0: b.addAccessor( joints, 'VEC4' ),
			WEIGHTS_0: b.addAccessor( weights, 'VEC4' ),
		},
		indices: b.addAccessor( indices, 'SCALAR' ),
		material: 0,
	} ] } );

	// nodes: 0 root joint, 1 child joint, 2 skinned mesh, 3 static copy of the mesh, offset
	json.nodes.push( { name: 'hip', children: [ 1 ] }, { name: 'knee', translation: [ 0, 1, 0 ] }, { name: 'skinned', mesh: 0, skin: 0 }, { name: 'static', mesh: 0, translation: [ 3, 0, 0 ] } );
	const ibm = new Float32Array( 32 );
	ibm.set( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );
	ibm.set( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, - 1, 0, 1 ], 16 );
	json.skins = [ { joints: [ 0, 1 ], inverseBindMatrices: b.addAccessor( ibm, 'MAT4' ) } ];
	json.scenes.push( { nodes: [ 0, 2, 3 ] } );
	json.scene = 0;

	const times = Float32Array.of( 0, 1, 2 );
	const rotations = Float32Array.of( 0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 1, 0 );
	json.animations = [ { name: 'bend', samplers: [ { input: b.addAccessor( times, 'SCALAR', { minmax: true } ), output: b.addAccessor( rotations, 'VEC4' ) } ], channels: [ { sampler: 0, target: { node: 1, path: 'rotation' } } ] } ];

	return b.toGLB();

}

// World bounds of every mesh node, sorted, so node names and order don't matter.
function bounds( doc, time ) {

	return [ ...evaluateScene( doc, time ).values() ].map( ( n ) => [ ...n.min, ...n.max ].map( ( v ) => Math.round( v * 1e4 ) / 1e4 ).join( ' ' ) ).sort();

}

test( 'GLB -> USDZ -> GLB keeps geometry, skinning, animation and materials', async () => {

	const glb = makeGLB();
	assert.equal( detectFormat( glb ), 'glb' );

	const usdz = await glbToUSD( glb );
	assert.equal( detectFormat( usdz ), 'usdz' );
	const files = readZip( usdz );
	assert.ok( [ ...files.keys() ][ 0 ].endsWith( '.usdc' ), 'root layer first' );
	assert.ok( [ ...files.keys() ].some( ( f ) => f.endsWith( '.png' ) ), 'texture packaged' );

	const back = await usdToGLB( usdz );
	assert.equal( detectFormat( back ), 'glb' );

	const a = await readGLTF( glb ), b = await readGLTF( back );

	for ( const t of [ 0, 0.5, 1, 2 ] ) {

		assert.deepEqual( bounds( b, t ), bounds( a, t ), `mesh bounds at ${ t }` );

	}

	const m = b.json.materials.find( ( x ) => x.name === 'painted' );
	assert.ok( m, 'material name kept' );
	assert.deepEqual( m.pbrMetallicRoughness.baseColorFactor.map( ( v ) => + v.toFixed( 5 ) ), [ 1, 0.5, 0.25, 1 ] );
	assert.ok( Math.abs( m.pbrMetallicRoughness.metallicFactor - 0.2 ) < 1e-6 );
	assert.ok( Math.abs( m.pbrMetallicRoughness.roughnessFactor - 0.7 ) < 1e-6 );
	assert.deepEqual( m.emissiveFactor.map( ( v ) => + v.toFixed( 5 ) ), [ 0.1, 0.2, 0.3 ] );
	assert.equal( m.doubleSided, true );
	assert.deepEqual( m.extensions.KHR_materials_sheen.sheenColorFactor, [ 1, 0, 0 ], 'unmappable extension restored' );

	const sampler = b.json.samplers[ b.json.textures[ m.pbrMetallicRoughness.baseColorTexture.index ].sampler ];
	assert.deepEqual( [ sampler.wrapS, sampler.wrapT ], [ 33071, 10497 ] );
	const imageIndex = b.json.textures[ m.pbrMetallicRoughness.baseColorTexture.index ].source;
	assert.deepEqual( b.images[ imageIndex ].bytes, a.images[ 0 ].bytes, 'texture bytes unchanged' );

	assert.equal( b.json.animations.length, 1 );
	assert.equal( b.json.skins.length, 1 );

} );

test( 'transmission becomes opacity in USD, and converts back to the original material', async () => {

	const b = new GLTFBuilder( 'test' );
	const json = b.json;
	const pixels = new Uint8Array( 4 * 4 * 3 ).map( ( _, i ) => ( i * 37 ) & 255 );
	json.textures.push( { source: b.addImage( encodePNG( { width: 4, height: 4, channels: 3, data: pixels } ), 'image/png', 'mask' ) } );
	json.materials.push(
		{ name: 'glass', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0 }, extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } },
		{ name: 'frosted', pbrMetallicRoughness: { metallicFactor: 0 }, extensions: { KHR_materials_transmission: { transmissionFactor: 0.8, transmissionTexture: { index: 0 } } } },
		{ name: 'tinted', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [ 1, 1, 1, 0.5 ], metallicFactor: 0 }, extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } },
		{ name: 'none', pbrMetallicRoughness: { metallicFactor: 0 }, extensions: { KHR_materials_transmission: { transmissionFactor: 0 } } },
	);
	b.useExtension( 'KHR_materials_transmission' );
	const attributes = { POSITION: b.addAccessor( Float32Array.of( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 'VEC3', { minmax: true } ), TEXCOORD_0: b.addAccessor( Float32Array.of( 0, 0, 1, 0, 0, 1 ), 'VEC2' ) };
	json.meshes.push( { primitives: json.materials.map( ( _, material ) => ( { attributes, material } ) ) } );
	json.nodes.push( { mesh: 0 } );
	json.scenes.push( { nodes: [ 0 ] } );
	json.scene = 0;
	const glb = b.toGLB();

	const usda = new TextDecoder().decode( await glbToUSD( glb, { format: 'usda' } ) );
	const material = ( name ) => usda.slice( usda.indexOf( `def Material "${ name }"` ) ).split( /\n {8}def Material / )[ 0 ];
	assert.match( material( 'glass' ), /float inputs:opacity = 0\n/ );
	assert.match( material( 'frosted' ), /float inputs:opacity.connect = <[^>]*\/transmissionTexture\.outputs:r>/ );
	assert.match( material( 'frosted' ), /float4 inputs:scale = \(-0\.8, -0\.8, -0\.8, 1\)/ );
	assert.match( material( 'frosted' ), /float4 inputs:bias = \(1, 1, 1, 0\)/ );
	assert.match( material( 'tinted' ), /float inputs:opacity = 0\.5\n/, 'blended materials keep their alpha' );
	assert.doesNotMatch( material( 'none' ), /opacity/ );

	const back = await readGLTF( await usdToGLB( await glbToUSD( glb ) ) );
	const byName = Object.fromEntries( back.json.materials.map( ( m ) => [ m.name, m ] ) );
	for ( const name of [ 'glass', 'frosted', 'none' ] ) {

		assert.equal( byName[ name ].alphaMode, undefined, `${ name } stays opaque` );
		assert.equal( byName[ name ].pbrMetallicRoughness.baseColorFactor, undefined, `${ name } base color alpha unchanged` );

	}
	assert.deepEqual( byName.glass.extensions.KHR_materials_transmission, { transmissionFactor: 1 } );
	assert.equal( byName.frosted.extensions.KHR_materials_transmission.transmissionFactor, 0.8 );
	assert.equal( typeof byName.frosted.extensions.KHR_materials_transmission.transmissionTexture.index, 'number' );
	assert.equal( byName.frosted.pbrMetallicRoughness.baseColorTexture, undefined, 'the transmission texture is not packed into the base color' );
	assert.deepEqual( [ byName.tinted.alphaMode, byName.tinted.pbrMetallicRoughness.baseColorFactor ], [ 'BLEND', [ 1, 1, 1, 0.5 ] ] );

} );

test( 'volume and specular are approximated in USD, and convert back to the original materials', async () => {

	const b = new GLTFBuilder( 'test' );
	const json = b.json;
	const pixels = new Uint8Array( 4 * 4 * 3 ).map( ( _, i ) => ( i * 37 ) & 255 );
	json.textures.push( { source: b.addImage( encodePNG( { width: 4, height: 4, channels: 3, data: pixels } ), 'image/png', 'rm' ) } );
	const glass = ( extensions, base ) => ( { pbrMetallicRoughness: { ...( base && { baseColorFactor: base } ), metallicFactor: 0, roughnessFactor: 0 }, extensions: { KHR_materials_transmission: { transmissionFactor: 1 }, ...extensions } } );
	json.materials.push(
		{ name: 'amber', ...glass( {}, [ 1, 0.6, 0.2, 1 ] ) },
		{ name: 'attenuated', ...glass( { KHR_materials_volume: { thicknessFactor: 0.5, attenuationDistance: 1, attenuationColor: [ 0.1, 0.5, 0.9 ] } } ) },
		{ name: 'thin', ...glass( { KHR_materials_volume: { attenuationDistance: 1, attenuationColor: [ 0.1, 0.5, 0.9 ] } } ) },
		{ name: 'dim', pbrMetallicRoughness: { baseColorFactor: [ 0.5, 0.5, 0.5, 1 ], metallicFactor: 0 }, extensions: { KHR_materials_specular: { specularFactor: 0.5, specularColorFactor: [ 2, 1, 1 ] } } },
		{ name: 'half metal', pbrMetallicRoughness: { baseColorFactor: [ 0.5, 0.5, 0.5, 1 ], metallicFactor: 0.5 }, extensions: { KHR_materials_specular: { specularFactor: 0.5 } } },
		{ name: 'metal texture', pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } }, extensions: { KHR_materials_specular: { specularFactor: 0.5 } } },
		{ name: 'animated', pbrMetallicRoughness: { baseColorFactor: [ 1, 0.6, 0.2, 1 ], metallicFactor: 0 }, extensions: { KHR_materials_transmission: { transmissionFactor: 1 }, KHR_materials_specular: { specularFactor: 0.5 } } },
	);
	for ( const e of [ 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_specular', 'KHR_animation_pointer' ] ) b.useExtension( e );
	const attributes = { POSITION: b.addAccessor( Float32Array.of( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 'VEC3', { minmax: true } ), TEXCOORD_0: b.addAccessor( Float32Array.of( 0, 0, 1, 0, 0, 1 ), 'VEC2' ) };
	json.meshes.push( { primitives: json.materials.map( ( _, material ) => ( { attributes, material } ) ) } );
	json.nodes.push( { mesh: 0 } );
	json.scenes.push( { nodes: [ 0 ] } );
	json.scene = 0;
	const times = b.addAccessor( Float32Array.of( 0, 1 ), 'SCALAR', { minmax: true } );
	json.animations = [ { samplers: [ { input: times, output: b.addAccessor( Float32Array.of( 1, 0.6, 0.2, 1, 0.2, 0.6, 1, 1 ), 'VEC4' ) } ], channels: [ { sampler: 0, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/materials/6/pbrMetallicRoughness/baseColorFactor' } } } } ] } ];
	const glb = b.toGLB();

	const usda = new TextDecoder().decode( await glbToUSD( glb, { format: 'usda' } ) );
	const surface = ( name ) => {

		const m = usda.slice( usda.indexOf( `def Material "${ name }"` ) ).split( /\n {8}def Material / )[ 0 ];
		const s = m.slice( m.indexOf( 'def Shader "PreviewSurface"' ) );
		return Object.fromEntries( [ ...s.matchAll( /^\s*\w+ inputs:(\w+) = (.*)$/gm ) ].map( ( [ , k, v ] ) => [ k, v.startsWith( '(' ) ? v.slice( 1, - 1 ).split( ', ' ).map( ( x ) => + ( + x ).toFixed( 4 ) ) : + v ] ) );

	};

	// amber glass: blue passes untinted (0.2), the rest of the blend is orange
	assert.deepEqual( [ surface( 'amber' ).diffuseColor, surface( 'amber' ).opacity ], [ [ 1, 0.5, 0 ], 0.8 ] );
	// attenuated over half its distance: sqrt( 0.1, 0.5, 0.9 ), red passes through 0.3162
	assert.deepEqual( [ surface( 'attenuated' ).opacity.toFixed( 4 ), surface( 'attenuated' ).diffuseColor ], [ '0.6838', [ 0, 0.5717, 0.925 ] ] );
	assert.deepEqual( [ surface( 'thin' ).opacity, surface( 'thin' ).diffuseColor ], [ 0, [ 1, 1, 1 ] ], 'no thickness: thin walled, no attenuation' );
	// F0 = min( 0.04 color, 1 ) 0.5
	assert.deepEqual( surface( 'dim' ), { diffuseColor: [ 0.5, 0.5, 0.5 ], useSpecularWorkflow: 1, specularColor: [ 0.04, 0.02, 0.02 ], roughness: 1 } );
	// diffuse = base ( 1 - m ), specular = F0 ( 1 - m ) + base m
	assert.deepEqual( surface( 'half_metal' ), { diffuseColor: [ 0.25, 0.25, 0.25 ], useSpecularWorkflow: 1, specularColor: [ 0.26, 0.26, 0.26 ], roughness: 1 } );
	assert.equal( surface( 'metal_texture' ).useSpecularWorkflow, undefined, 'metallic varies over the texture' );
	assert.deepEqual( [ surface( 'animated' ).useSpecularWorkflow, surface( 'animated' ).opacity ], [ undefined, 0 ], 'animated base color drives the inputs directly' );

	const back = await readGLTF( await usdToGLB( await glbToUSD( glb ) ) );
	const byName = Object.fromEntries( back.json.materials.map( ( m ) => [ m.name, m ] ) );
	for ( const original of json.materials ) {

		const m = byName[ original.name ];
		if ( original.pbrMetallicRoughness.metallicRoughnessTexture ) {

			assert.equal( typeof m.pbrMetallicRoughness.metallicRoughnessTexture.index, 'number' );
			assert.deepEqual( m.extensions, original.extensions );

		} else if ( original.name !== 'animated' ) {

			assert.deepEqual( m, original, original.name );

		}

	}

} );

test( 'GLB -> usda writes readable USD with UsdPreviewSurface and UsdSkel', async () => {

	const usda = new TextDecoder().decode( await glbToUSD( makeGLB(), { format: 'usda' } ) );
	const layer = readUSDA( usda );
	assert.equal( layer.metadata.upAxis, 'Y' );
	assert.match( usda, /info:id = "UsdPreviewSurface"/ );
	assert.match( usda, /def Skeleton/ );
	assert.match( usda, /def SkelAnimation/ );
	assert.match( usda, /uniform token\[\] joints = \["hip", "hip\/knee"\]/ );

} );

test( 'embedded .gltf (data URIs) converts like the GLB', async () => {

	const { json, bin } = readGLB( makeGLB() );
	const base64 = ( bytes ) => btoa( Array.from( bytes, ( c ) => String.fromCharCode( c ) ).join( '' ) );
	json.buffers = [ { byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + base64( bin ) } ];
	const gltf = new TextEncoder().encode( JSON.stringify( json ) );
	assert.equal( detectFormat( gltf ), 'gltf' );

	const fromGLTF = await readGLTF( await usdToGLB( await glbToUSD( gltf ) ) );
	const fromGLB = await readGLTF( await usdToGLB( await glbToUSD( writeGLB( json.buffers ? { ...json, buffers: [ { byteLength: bin.length } ] } : json, bin ) ) ) );
	assert.deepEqual( bounds( fromGLTF, 1 ), bounds( fromGLB, 1 ) );

} );

test( '.gltf with external files uses the resolver', async () => {

	const { json, bin } = readGLB( makeGLB() );
	json.buffers = [ { byteLength: bin.length, uri: 'quad data.bin' } ];
	const requested = [];
	const usdz = await glbToUSD( new TextEncoder().encode( JSON.stringify( json ) ), { resolver: ( uri ) => { requested.push( uri ); return bin; } } );
	assert.deepEqual( requested, [ 'quad data.bin' ] );
	assert.equal( detectFormat( usdz ), 'usdz' );

} );
