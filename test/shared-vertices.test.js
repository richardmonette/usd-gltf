import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glbToUSD, usdToGLB, readUSDA } from '../src/index.js';
import { GLTFBuilder, readGLTF } from '../src/gltf/document.js';
import { evaluateScene } from './oracle/gltf-eval.js';

const QUADS = 64; // a row of quads, 4 vertices each

// One mesh whose primitives all index into the same vertex accessors, each drawing its own quads
// with its own material. With doubleSided, every other material is double sided, so the
// primitives can't share a USD Mesh and are written separately instead.
function partitioned( parts, { doubleSided = false, morph = false, skin = false } = {} ) {

	const b = new GLTFBuilder( 'test' );
	const json = b.json;
	const n = QUADS * 4;
	const positions = new Float32Array( n * 3 ), uvs = new Float32Array( n * 2 ), offsets = new Float32Array( n * 3 );
	const joints = new Uint8Array( n * 4 ), weights = new Float32Array( n * 4 );

	for ( let q = 0; q < QUADS; q ++ ) {

		[ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ].forEach( ( [ x, y ], c ) => {

			const v = q * 4 + c;
			positions.set( [ q + x, y, 0 ], v * 3 );
			uvs.set( [ x, y ], v * 2 );
			offsets.set( [ 0, 0, q ], v * 3 );
			joints[ v * 4 ] = q % 2;
			weights[ v * 4 ] = 1;

		} );

	}

	const attributes = { POSITION: b.addAccessor( positions, 'VEC3', { minmax: true } ), TEXCOORD_0: b.addAccessor( uvs, 'VEC2' ) };
	if ( skin ) Object.assign( attributes, { JOINTS_0: b.addAccessor( joints, 'VEC4' ), WEIGHTS_0: b.addAccessor( weights, 'VEC4' ) } );
	const targets = morph ? [ { POSITION: b.addAccessor( offsets, 'VEC3', { minmax: true } ) } ] : undefined;
	const mesh = { name: 'row', primitives: [] };
	if ( morph ) mesh.weights = [ 0.5 ];

	for ( let p = 0; p < parts; p ++ ) {

		const indices = [];
		for ( let q = p; q < QUADS; q += parts ) indices.push( q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3 );
		json.materials.push( { name: `m${ p }`, pbrMetallicRoughness: { baseColorFactor: [ p / parts, 0.5, 1 - p / parts, 1 ] }, doubleSided: doubleSided && p % 2 === 1 } );
		mesh.primitives.push( { attributes: { ...attributes }, indices: b.addAccessor( Uint16Array.from( indices ), 'SCALAR' ), material: p, ...( targets && { targets } ) } );

	}

	json.meshes.push( mesh );

	if ( skin ) {

		json.nodes.push( { name: 'mesh', mesh: 0, skin: 0 }, { name: 'a' }, { name: 'b', translation: [ 0, 2, 0 ] } );
		json.skins = [ { joints: [ 1, 2 ], inverseBindMatrices: b.addAccessor( Float32Array.of( 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, - 2, 0, 1 ), 'MAT4' ) } ];
		json.scenes.push( { nodes: [ 0, 1, 2 ] } );

	} else {

		json.nodes.push( { name: 'mesh', mesh: 0 } );
		json.scenes.push( { nodes: [ 0 ] } );

	}

	json.scene = 0;
	return b.toGLB();

}

function meshes( layer ) {

	const out = [];
	const walk = ( spec ) => { for ( const c of spec.children.values() ) { if ( c.typeName === 'Mesh' ) out.push( c ); walk( c ); } };
	walk( layer.root );
	return out;

}

// sorted per primitive bounds, triangle counts and base colors: what each primitive draws, in any order
function drawn( doc ) {

	const rows = [];

	for ( const [ i, n ] of evaluateScene( doc, 0 ) ) {

		doc.json.meshes[ doc.json.nodes[ i ].mesh ].primitives.forEach( ( p, k ) => {

			const s = n.primitives[ k ];
			const color = doc.json.materials[ p.material ].pbrMetallicRoughness.baseColorFactor.map( ( v ) => v.toFixed( 4 ) );
			rows.push( [ ...s.min, ...s.max ].map( ( v ) => v.toFixed( 4 ) ).join( ' ' ) + ` ${ s.triangles } ${ color }` );

		} );

	}

	return rows.sort();

}

test( 'primitives sharing vertex data become one Mesh with a GeomSubset each', async () => {

	const layer = readUSDA( new TextDecoder().decode( await glbToUSD( partitioned( 8 ), { format: 'usda' } ) ) );
	const [ mesh, ...others ] = meshes( layer );
	assert.equal( others.length, 0 );
	assert.equal( mesh.properties.get( 'points' ).default.length, QUADS * 4 * 3, 'vertex data written once' );
	const subsets = [ ...mesh.children.values() ].filter( ( c ) => c.typeName === 'GeomSubset' );
	assert.equal( subsets.length, 8 );
	assert.equal( subsets.reduce( ( n, s ) => n + s.properties.get( 'indices' ).default.length, 0 ), QUADS * 2, 'subsets partition the faces' );
	assert.ok( subsets.every( ( s ) => s.properties.get( 'material:binding' ) ) );

} );

test( 'output size follows the vertex data, not the number of primitives', async () => {

	const sizes = [];
	for ( const parts of [ 1, 4, 16, 64 ] ) sizes.push( ( await glbToUSD( partitioned( parts ), { format: 'usdc' } ) ).length );
	// subsets and materials add a little per primitive; vertex data repeated per primitive would add 5 KB each
	for ( let i = 1; i < sizes.length; i ++ ) assert.ok( sizes[ i ] - sizes[ 0 ] < 1500 * [ 1, 4, 16, 64 ][ i ], `sizes ${ sizes }` );

	const separate = [];
	for ( const parts of [ 2, 16 ] ) separate.push( ( await glbToUSD( partitioned( parts, { doubleSided: true } ), { format: 'usdc' } ) ).length );
	assert.ok( separate[ 1 ] < separate[ 0 ] * 4, `separate meshes are compacted: ${ separate }` );

} );

test( 'primitives that cannot share a Mesh keep only the vertices they use', async () => {

	const layer = readUSDA( new TextDecoder().decode( await glbToUSD( partitioned( 4, { doubleSided: true, morph: true } ), { format: 'usda' } ) ) );
	const all = meshes( layer );
	assert.equal( all.length, 2, 'double sided and single sided primitives grouped apart' );

	for ( const mesh of all ) {

		const points = mesh.properties.get( 'points' ).default.length / 3;
		assert.equal( points, QUADS * 4 / 2 );
		assert.equal( mesh.properties.get( 'primvars:st' ).default.length / 2, points );
		const shape = [ ...mesh.children.values() ].find( ( c ) => c.typeName === 'BlendShape' );
		assert.equal( shape.properties.get( 'offsets' ).default.length / 3, points );
		const indices = mesh.properties.get( 'faceVertexIndices' ).default;
		assert.ok( Math.max( ...indices ) < points );

	}

} );

for ( const [ label, options ] of [ [ 'shared', {} ], [ 'compacted', { doubleSided: true } ] ] ) {

	test( `round trip keeps every primitive's geometry, material, skinning and morph (${ label })`, async () => {

		for ( const extra of [ { morph: true }, { skin: true } ] ) {

			const glb = partitioned( 4, { ...options, ...extra } );
			const back = await readGLTF( await usdToGLB( await glbToUSD( glb ) ) );
			assert.deepEqual( drawn( back ), drawn( await readGLTF( glb ) ), JSON.stringify( extra ) );

		}

	} );

}
