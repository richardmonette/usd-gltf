// 4x4 matrices are flat column-major arrays acting on column vectors, the glTF convention.
// USD writes matrix4d row-major for row vectors, which is the same 16 numbers in the same order,
// so USD matrices can be used directly.

export function identity() {

	return [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

}

export function isIdentity( m, eps = 1e-9 ) {

	for ( let i = 0; i < 16; i ++ ) if ( Math.abs( m[ i ] - ( i % 5 === 0 ? 1 : 0 ) ) > eps ) return false;
	return true;

}

export function multiply( a, b ) {

	const out = new Array( 16 );

	for ( let c = 0; c < 4; c ++ ) {

		for ( let r = 0; r < 4; r ++ ) {

			out[ c * 4 + r ] = a[ r ] * b[ c * 4 ] + a[ 4 + r ] * b[ c * 4 + 1 ] + a[ 8 + r ] * b[ c * 4 + 2 ] + a[ 12 + r ] * b[ c * 4 + 3 ];

		}

	}

	return out;

}

export function invert( m ) {

	const [ a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33 ] = m;
	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if ( ! det ) return identity();
	det = 1 / det;

	return [
		( a11 * b11 - a12 * b10 + a13 * b09 ) * det, ( a02 * b10 - a01 * b11 - a03 * b09 ) * det, ( a31 * b05 - a32 * b04 + a33 * b03 ) * det, ( a22 * b04 - a21 * b05 - a23 * b03 ) * det,
		( a12 * b08 - a10 * b11 - a13 * b07 ) * det, ( a00 * b11 - a02 * b08 + a03 * b07 ) * det, ( a32 * b02 - a30 * b05 - a33 * b01 ) * det, ( a20 * b05 - a22 * b02 + a23 * b01 ) * det,
		( a10 * b10 - a11 * b08 + a13 * b06 ) * det, ( a01 * b08 - a00 * b10 - a03 * b06 ) * det, ( a30 * b04 - a31 * b02 + a33 * b00 ) * det, ( a21 * b02 - a20 * b04 - a23 * b00 ) * det,
		( a11 * b07 - a10 * b09 - a12 * b06 ) * det, ( a00 * b09 - a01 * b07 + a02 * b06 ) * det, ( a31 * b01 - a30 * b03 - a32 * b00 ) * det, ( a20 * b03 - a21 * b01 + a22 * b00 ) * det,
	];

}

export function determinant3( m ) {

	return m[ 0 ] * ( m[ 5 ] * m[ 10 ] - m[ 6 ] * m[ 9 ] ) - m[ 4 ] * ( m[ 1 ] * m[ 10 ] - m[ 2 ] * m[ 9 ] ) + m[ 8 ] * ( m[ 1 ] * m[ 6 ] - m[ 2 ] * m[ 5 ] );

}

export function translation( x, y, z ) {

	return [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 ];

}

export function scaling( x, y, z ) {

	return [ x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1 ];

}

export function rotationAxis( axis, degrees ) {

	const r = degrees * Math.PI / 180;
	const c = Math.cos( r ), s = Math.sin( r );
	if ( axis === 'X' ) return [ 1, 0, 0, 0, 0, c, s, 0, 0, - s, c, 0, 0, 0, 0, 1 ];
	if ( axis === 'Y' ) return [ c, 0, - s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1 ];
	return [ c, s, 0, 0, - s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

}

// q = [ x, y, z, w ]
export function fromQuat( q ) {

	const [ x, y, z, w ] = q;
	const x2 = x + x, y2 = y + y, z2 = z + z;
	const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
	const wx = w * x2, wy = w * y2, wz = w * z2;
	return [ 1 - ( yy + zz ), xy + wz, xz - wy, 0, xy - wz, 1 - ( xx + zz ), yz + wx, 0, xz + wy, yz - wx, 1 - ( xx + yy ), 0, 0, 0, 0, 1 ];

}

export function compose( t, q, s ) {

	const m = fromQuat( q );
	for ( let i = 0; i < 3; i ++ ) {

		m[ i ] *= s[ 0 ];
		m[ 4 + i ] *= s[ 1 ];
		m[ 8 + i ] *= s[ 2 ];

	}

	m[ 12 ] = t[ 0 ]; m[ 13 ] = t[ 1 ]; m[ 14 ] = t[ 2 ];
	return m;

}

export function quatFromMatrix( m ) {

	const m11 = m[ 0 ], m12 = m[ 4 ], m13 = m[ 8 ], m21 = m[ 1 ], m22 = m[ 5 ], m23 = m[ 9 ], m31 = m[ 2 ], m32 = m[ 6 ], m33 = m[ 10 ];
	const trace = m11 + m22 + m33;
	let x, y, z, w;

	if ( trace > 0 ) {

		const s = 0.5 / Math.sqrt( trace + 1 );
		w = 0.25 / s; x = ( m32 - m23 ) * s; y = ( m13 - m31 ) * s; z = ( m21 - m12 ) * s;

	} else if ( m11 > m22 && m11 > m33 ) {

		const s = 2 * Math.sqrt( 1 + m11 - m22 - m33 );
		w = ( m32 - m23 ) / s; x = 0.25 * s; y = ( m12 + m21 ) / s; z = ( m13 + m31 ) / s;

	} else if ( m22 > m33 ) {

		const s = 2 * Math.sqrt( 1 + m22 - m11 - m33 );
		w = ( m13 - m31 ) / s; x = ( m12 + m21 ) / s; y = 0.25 * s; z = ( m23 + m32 ) / s;

	} else {

		const s = 2 * Math.sqrt( 1 + m33 - m11 - m22 );
		w = ( m21 - m12 ) / s; x = ( m13 + m31 ) / s; y = ( m23 + m32 ) / s; z = 0.25 * s;

	}

	return normalizeQuat( [ x, y, z, w ] );

}

export function normalizeQuat( q ) {

	const l = Math.hypot( q[ 0 ], q[ 1 ], q[ 2 ], q[ 3 ] ) || 1;
	return [ q[ 0 ] / l, q[ 1 ] / l, q[ 2 ] / l, q[ 3 ] / l ];

}

// Decomposes into translation, rotation quaternion and scale. Shear is lost.
export function decompose( m ) {

	let sx = Math.hypot( m[ 0 ], m[ 1 ], m[ 2 ] );
	const sy = Math.hypot( m[ 4 ], m[ 5 ], m[ 6 ] );
	const sz = Math.hypot( m[ 8 ], m[ 9 ], m[ 10 ] );
	if ( determinant3( m ) < 0 ) sx = - sx;

	const r = m.slice();
	for ( let i = 0; i < 3; i ++ ) {

		r[ i ] /= sx || 1;
		r[ 4 + i ] /= sy || 1;
		r[ 8 + i ] /= sz || 1;

	}

	return { t: [ m[ 12 ], m[ 13 ], m[ 14 ] ], r: quatFromMatrix( r ), s: [ sx, sy, sz ] };

}

export function transformPoint( m, x, y, z, out, o = 0 ) {

	const w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ] || 1;
	out[ o ] = ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ] ) / w;
	out[ o + 1 ] = ( m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ] ) / w;
	out[ o + 2 ] = ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w;

}

// Inverse transpose of the upper 3x3, for transforming normals.
export function normalMatrix( m ) {

	const inv = invert( m );
	return [ inv[ 0 ], inv[ 4 ], inv[ 8 ], 0, inv[ 1 ], inv[ 5 ], inv[ 9 ], 0, inv[ 2 ], inv[ 6 ], inv[ 10 ], 0, 0, 0, 0, 1 ];

}

export function transformDirection( m, x, y, z, out, o = 0 ) {

	const nx = m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z;
	const ny = m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z;
	const nz = m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z;
	const l = Math.hypot( nx, ny, nz ) || 1;
	out[ o ] = nx / l; out[ o + 1 ] = ny / l; out[ o + 2 ] = nz / l;

}

export function quatMultiply( a, b ) {

	const [ ax, ay, az, aw ] = a, [ bx, by, bz, bw ] = b;
	return [ ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz ];

}

export function quatFromEuler( x, y, z ) {

	// intrinsic X then Y then Z in degrees: R = Rz * Ry * Rx
	return quatFromMatrix( multiply( rotationAxis( 'Z', z ), multiply( rotationAxis( 'Y', y ), rotationAxis( 'X', x ) ) ) );

}

// Euler angles in degrees for rotateXYZ (R = Rz * Ry * Rx) from a quaternion.
export function eulerXYZFromQuat( q ) {

	const m = fromQuat( q );
	const m11 = m[ 0 ], m12 = m[ 4 ], m22 = m[ 5 ], m32 = m[ 6 ], m33 = m[ 10 ], m21 = m[ 1 ], m31 = m[ 2 ];
	const deg = 180 / Math.PI;
	const y = Math.asin( - Math.max( - 1, Math.min( 1, m31 ) ) );
	let x, z;

	if ( Math.abs( m31 ) < 0.9999999 ) {

		x = Math.atan2( m32, m33 );
		z = Math.atan2( m21, m11 );

	} else {

		x = 0;
		z = Math.atan2( - m12, m22 );

	}

	return [ x * deg, y * deg, z * deg ];

}
