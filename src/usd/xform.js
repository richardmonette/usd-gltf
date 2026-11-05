// Evaluates UsdGeomXformable ops into local matrices.

import { fromQuat, identity, invert, multiply, rotationAxis, scaling, translation } from '../util/math.js';

function opMatrix( type, value ) {

	if ( value === undefined || value === null ) return identity();

	switch ( type ) {

		case 'translate': return translation( value[ 0 ], value[ 1 ], value[ 2 ] );
		case 'scale': return scaling( value[ 0 ], value[ 1 ], value[ 2 ] );
		case 'rotateX': return rotationAxis( 'X', value );
		case 'rotateY': return rotationAxis( 'Y', value );
		case 'rotateZ': return rotationAxis( 'Z', value );
		case 'orient': return fromQuat( value );
		case 'transform': return Array.from( value );

	}

	const m = /^rotate([XYZ])([XYZ])([XYZ])$/.exec( type );

	if ( m ) {

		// rotateXYZ applies X first: R = Rz * Ry * Rx for column vectors
		const angles = { X: value[ 0 ], Y: value[ 1 ], Z: value[ 2 ] };
		const order = [ m[ 1 ], m[ 2 ], m[ 3 ] ];
		let r = identity();
		for ( const axis of order ) r = multiply( rotationAxis( axis, angles[ axis ] ), r );
		return r;

	}

	return identity();

}

/**
 * The ops of a prim: [ { name, type, invert, property } ] plus whether it resets the parent transform.
 */
export function getXformOps( prim ) {

	const order = prim.get( 'xformOpOrder', [] );
	const ops = [];
	let resetsXformStack = false;

	for ( let entry of order ) {

		if ( entry === '!resetXformStack!' ) {

			resetsXformStack = true;
			ops.length = 0;
			continue;

		}

		let inverted = false;
		if ( entry.startsWith( '!invert!' ) ) { inverted = true; entry = entry.slice( 8 ); }
		const type = entry.split( ':' )[ 1 ];
		ops.push( { name: entry, type, inverted, property: prim.getProperty( entry ) } );

	}

	return { ops, resetsXformStack };

}

export function evaluateOps( ops, time ) {

	let m = identity();

	for ( const op of ops ) {

		if ( ! op.property ) continue;
		const value = time === undefined ? op.property.value : op.property.valueAt( time );
		let om = opMatrix( op.type, value );
		if ( op.inverted ) om = invert( om );
		m = multiply( m, om );

	}

	return m;

}

// Sorted union of the sample times of all ops, or [] when nothing is animated.
export function xformSampleTimes( ops ) {

	const times = new Set();
	for ( const op of ops ) if ( op.property?.isAnimated ) for ( const t of op.property.timeSamples.keys() ) times.add( t );
	return [ ...times ].sort( ( a, b ) => a - b );

}

export function localTransform( prim, time ) {

	return evaluateOps( getXformOps( prim ).ops, time );

}
