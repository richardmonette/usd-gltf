// Evaluates a glTF scene at a time: animated node transforms, morph weights and skinning,
// returning world space bounds per mesh node. Used to check conversions against pxr.

import { compose, multiply, identity, transformPoint } from '../../src/util/math.js';

function slerp( a, b, t ) {

	let dot = a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ] + a[ 3 ] * b[ 3 ];
	if ( dot < 0 ) { b = b.map( ( v ) => - v ); dot = - dot; }
	if ( dot > 0.9995 ) {

		const r = a.map( ( v, i ) => v + ( b[ i ] - v ) * t );
		const l = Math.hypot( ...r );
		return r.map( ( v ) => v / l );

	}

	const theta = Math.acos( dot );
	const s = Math.sin( theta );
	const wa = Math.sin( ( 1 - t ) * theta ) / s, wb = Math.sin( t * theta ) / s;
	return a.map( ( v, i ) => v * wa + b[ i ] * wb );

}

function sampleChannel( doc, sampler, path, time, width ) {

	const input = doc.getAccessor( sampler.input ).array;
	const output = doc.getAccessor( sampler.output ).array;
	const n = input.length;
	const cubic = sampler.interpolation === 'CUBICSPLINE';
	const get = ( k ) => {

		const base = cubic ? ( k * 3 + 1 ) * width : k * width;
		return Array.from( output.slice( base, base + width ) );

	};

	if ( time <= input[ 0 ] ) return get( 0 );
	if ( time >= input[ n - 1 ] ) return get( n - 1 );

	let k = 0;
	while ( k < n - 2 && input[ k + 1 ] <= time ) k ++;
	const t0 = input[ k ], t1 = input[ k + 1 ];
	const u = ( time - t0 ) / ( t1 - t0 );

	if ( sampler.interpolation === 'STEP' ) return get( k );

	if ( cubic ) {

		const dt = t1 - t0;
		const p0 = get( k ), p1 = get( k + 1 );
		const m0 = Array.from( output.slice( ( k * 3 + 2 ) * width, ( k * 3 + 3 ) * width ) );
		const m1 = Array.from( output.slice( ( k + 1 ) * 3 * width, ( ( k + 1 ) * 3 + 1 ) * width ) );
		const u2 = u * u, u3 = u2 * u;
		const r = p0.map( ( _, i ) => ( 2 * u3 - 3 * u2 + 1 ) * p0[ i ] + ( u3 - 2 * u2 + u ) * dt * m0[ i ] + ( - 2 * u3 + 3 * u2 ) * p1[ i ] + ( u3 - u2 ) * dt * m1[ i ] );
		if ( path === 'rotation' ) { const l = Math.hypot( ...r ); return r.map( ( v ) => v / l ); }
		return r;

	}

	const a = get( k ), b = get( k + 1 );
	if ( path === 'rotation' ) return slerp( a, b, u );
	return a.map( ( v, i ) => v + ( b[ i ] - v ) * u );

}

/**
 * @param {import('../../src/gltf/document.js').GLTFDocument} doc
 * @returns {Map<number, { name, extras, min, max, triangles }>} per mesh node
 */
export function evaluateScene( doc, time = 0, animationIndex = 0 ) {

	const json = doc.json;
	const nodes = json.nodes || [];
	const local = nodes.map( ( n ) => ( {
		t: n.translation || [ 0, 0, 0 ], r: n.rotation || [ 0, 0, 0, 1 ], s: n.scale || [ 1, 1, 1 ], matrix: n.matrix, weights: null,
	} ) );

	const anim = json.animations?.[ animationIndex ];

	if ( anim ) {

		for ( const channel of anim.channels ) {

			const target = channel.target;
			if ( target.node === undefined ) continue;
			const sampler = anim.samplers[ channel.sampler ];
			const l = local[ target.node ];

			if ( target.path === 'weights' ) {

				const mesh = json.meshes[ nodes[ target.node ].mesh ];
				const count = mesh.primitives[ 0 ].targets?.length || 0;
				l.weights = sampleChannel( doc, sampler, 'weights', time, count );

			} else {

				l[ target.path[ 0 ] ] = sampleChannel( doc, sampler, target.path, time, target.path === 'rotation' ? 4 : 3 );
				l.matrix = undefined;

			}

		}

	}

	const world = new Array( nodes.length );
	const parents = new Array( nodes.length ).fill( - 1 );
	nodes.forEach( ( n, i ) => ( n.children || [] ).forEach( ( c ) => ( parents[ c ] = i ) ) );

	const worldOf = ( i ) => {

		if ( world[ i ] ) return world[ i ];
		const l = local[ i ];
		const m = l.matrix ? Array.from( l.matrix ) : compose( l.t, l.r, l.s );
		return ( world[ i ] = parents[ i ] >= 0 ? multiply( worldOf( parents[ i ] ), m ) : m );

	};

	const result = new Map();
	const tmp = [ 0, 0, 0 ];

	nodes.forEach( ( node, i ) => {

		if ( node.mesh === undefined ) return;
		const mesh = json.meshes[ node.mesh ];
		const weights = local[ i ].weights || mesh.weights || [];
		const skin = node.skin !== undefined ? json.skins[ node.skin ] : null;
		let jointMatrices = null;

		if ( skin ) {

			const ibm = skin.inverseBindMatrices !== undefined ? doc.getAccessor( skin.inverseBindMatrices ).array : null;
			jointMatrices = skin.joints.map( ( j, k ) => multiply( worldOf( j ), ibm ? Array.from( ibm.slice( k * 16, k * 16 + 16 ) ) : identity() ) );

		}

		const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
		let triangles = 0;
		const primitives = [];

		for ( const prim of mesh.primitives ) {

			const pmin = [ Infinity, Infinity, Infinity ], pmax = [ - Infinity, - Infinity, - Infinity ];
			const triBefore = triangles;

			const pos = doc.getFloats( prim.attributes.POSITION ).array;
			const count = pos.length / 3;
			const p = Float64Array.from( pos );
			const mode = prim.mode ?? 4;
			const indexCount = prim.indices !== undefined ? doc.json.accessors[ prim.indices ].count : count;
			if ( mode === 4 ) triangles += indexCount / 3;
			else if ( mode === 5 || mode === 6 ) triangles += Math.max( 0, indexCount - 2 );

			( prim.targets || [] ).forEach( ( target, k ) => {

				const w = weights[ k ] || 0;
				if ( ! w || target.POSITION === undefined ) return;
				const d = doc.getFloats( target.POSITION ).array;
				for ( let v = 0; v < p.length; v ++ ) p[ v ] += w * d[ v ];

			} );

			// only vertices referenced by the primitive count toward bounds
			let used = null;
			if ( prim.indices !== undefined ) {

				used = new Uint8Array( count );
				for ( const idx of doc.getAccessor( prim.indices ).array ) used[ idx ] = 1;

			}

			const sets = [];
			for ( let s = 0; prim.attributes[ 'JOINTS_' + s ] !== undefined; s ++ ) sets.push( [ doc.getAccessor( prim.attributes[ 'JOINTS_' + s ], { normalize: false } ).array, doc.getFloats( prim.attributes[ 'WEIGHTS_' + s ] ).array ] );
			const nodeWorld = worldOf( i );

			for ( let v = 0; v < count; v ++ ) {

				if ( used && ! used[ v ] ) continue;
				const x = p[ v * 3 ], y = p[ v * 3 + 1 ], z = p[ v * 3 + 2 ];

				if ( jointMatrices && sets.length ) {

					let ox = 0, oy = 0, oz = 0;
					for ( const [ joints, ws ] of sets ) for ( let k = 0; k < 4; k ++ ) {

						const w = ws[ v * 4 + k ];
						if ( ! w ) continue;
						transformPoint( jointMatrices[ joints[ v * 4 + k ] ], x, y, z, tmp );
						ox += w * tmp[ 0 ]; oy += w * tmp[ 1 ]; oz += w * tmp[ 2 ];

					}

					tmp[ 0 ] = ox; tmp[ 1 ] = oy; tmp[ 2 ] = oz;

				} else {

					transformPoint( nodeWorld, x, y, z, tmp );

				}

				for ( let k = 0; k < 3; k ++ ) {

					if ( tmp[ k ] < pmin[ k ] ) pmin[ k ] = tmp[ k ];
					if ( tmp[ k ] > pmax[ k ] ) pmax[ k ] = tmp[ k ];

				}

			}

			for ( let k = 0; k < 3; k ++ ) { min[ k ] = Math.min( min[ k ], pmin[ k ] ); max[ k ] = Math.max( max[ k ], pmax[ k ] ); }
			primitives.push( { min: pmin, max: pmax, triangles: triangles - triBefore, mode } );

		}

		result.set( i, { name: node.name, extras: node.extras, min, max, triangles, primitives } );

	} );

	return result;

}
