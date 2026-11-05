// Tessellates the UsdGeom intrinsic shapes (Cube, Sphere, Cylinder, Cone, Capsule, Plane).

const SEGMENTS = 32;
const RINGS = 16;

class Builder {

	constructor() {

		this.positions = [];
		this.normals = [];
		this.indices = [];

	}

	vertex( p, n ) {

		this.positions.push( ...p );
		this.normals.push( ...n );
		return this.positions.length / 3 - 1;

	}

	quad( a, b, c, d ) {

		this.indices.push( a, b, c, a, c, d );

	}

	// a surface of revolution around +Z from a profile of [ radius, z, normalRadial, normalZ ]
	lathe( profile, segments = SEGMENTS ) {

		const start = this.positions.length / 3;

		for ( const [ r, z, nr, nz ] of profile ) {

			for ( let s = 0; s <= segments; s ++ ) {

				const a = s / segments * Math.PI * 2;
				const c = Math.cos( a ), sn = Math.sin( a );
				this.vertex( [ r * c, r * sn, z ], [ nr * c, nr * sn, nz ] );

			}

		}

		for ( let i = 0; i + 1 < profile.length; i ++ ) {

			for ( let s = 0; s < segments; s ++ ) {

				const a = start + i * ( segments + 1 ) + s;
				const b = a + segments + 1;
				this.quad( a, a + 1, b + 1, b );

			}

		}

	}

	disk( r, z, up ) {

		const center = this.vertex( [ 0, 0, z ], [ 0, 0, up ] );
		const start = this.positions.length / 3;
		for ( let s = 0; s <= SEGMENTS; s ++ ) {

			const a = s / SEGMENTS * Math.PI * 2;
			this.vertex( [ r * Math.cos( a ), r * Math.sin( a ), z ], [ 0, 0, up ] );

		}

		for ( let s = 0; s < SEGMENTS; s ++ ) {

			if ( up > 0 ) this.indices.push( center, start + s, start + s + 1 );
			else this.indices.push( center, start + s + 1, start + s );

		}

	}

}

// Rotates z-axis aligned geometry to the requested axis.
function orient( b, axis ) {

	if ( axis === 'Z' ) return;
	const swap = ( arr ) => {

		for ( let i = 0; i < arr.length; i += 3 ) {

			const [ x, y, z ] = [ arr[ i ], arr[ i + 1 ], arr[ i + 2 ] ];
			if ( axis === 'X' ) { arr[ i ] = z; arr[ i + 1 ] = x; arr[ i + 2 ] = y; }
			else { arr[ i ] = y; arr[ i + 1 ] = z; arr[ i + 2 ] = x; }

		}

	};

	swap( b.positions );
	swap( b.normals );

}

export function generateShape( prim ) {

	const b = new Builder();
	const type = prim.typeName.replace( /_1$/, '' );
	const axis = prim.get( 'axis', 'Z' );

	if ( type === 'Cube' ) {

		const h = prim.get( 'size', 2 ) / 2;
		for ( let axisIndex = 0; axisIndex < 3; axisIndex ++ ) {

			for ( const sign of [ 1, - 1 ] ) {

				const u = ( axisIndex + 1 ) % 3, v = ( axisIndex + 2 ) % 3;
				const n = [ 0, 0, 0 ];
				n[ axisIndex ] = sign;
				const corner = ( su, sv ) => {

					const p = [ 0, 0, 0 ];
					p[ axisIndex ] = sign * h; p[ u ] = su * h; p[ v ] = sv * h;
					return b.vertex( p, n );

				};

				const a = corner( - 1, - 1 ), c1 = corner( 1, - 1 ), c2 = corner( 1, 1 ), d = corner( - 1, 1 );
				if ( sign > 0 ) b.quad( a, c1, c2, d );
				else b.quad( a, d, c2, c1 );

			}

		}

	} else if ( type === 'Sphere' ) {

		const r = prim.get( 'radius', 1 );
		const profile = [];
		for ( let i = 0; i <= RINGS; i ++ ) {

			const t = - Math.PI / 2 + i / RINGS * Math.PI;
			profile.push( [ r * Math.cos( t ), r * Math.sin( t ), Math.cos( t ), Math.sin( t ) ] );

		}

		b.lathe( profile );

	} else if ( type === 'Cylinder' || type === 'Cone' ) {

		const h = prim.get( 'height', 2 ) / 2;
		const rTop = type === 'Cone' ? 0 : prim.get( 'radiusTop', prim.get( 'radius', 1 ) );
		const rBottom = prim.get( 'radiusBottom', prim.get( 'radius', 1 ) );
		const slope = Math.atan2( rBottom - rTop, 2 * h );
		b.lathe( [ [ rBottom, - h, Math.cos( slope ), Math.sin( slope ) ], [ rTop, h, Math.cos( slope ), Math.sin( slope ) ] ] );
		b.disk( rBottom, - h, - 1 );
		if ( rTop > 0 ) b.disk( rTop, h, 1 );
		orient( b, axis );

	} else if ( type === 'Capsule' ) {

		const r = prim.get( 'radius', 0.5 );
		const h = prim.get( 'height', 1 ) / 2;
		const profile = [];
		for ( let i = 0; i <= RINGS / 2; i ++ ) {

			const t = - Math.PI / 2 + i / RINGS * Math.PI;
			profile.push( [ r * Math.cos( t ), - h + r * Math.sin( t ), Math.cos( t ), Math.sin( t ) ] );

		}

		for ( let i = RINGS / 2; i <= RINGS; i ++ ) {

			const t = - Math.PI / 2 + i / RINGS * Math.PI;
			profile.push( [ r * Math.cos( t ), h + r * Math.sin( t ), Math.cos( t ), Math.sin( t ) ] );

		}

		b.lathe( profile );
		orient( b, axis );

	} else if ( type === 'Plane' ) {

		const w = prim.get( 'width', 2 ) / 2, l = prim.get( 'length', 2 ) / 2;
		const n = [ 0, 0, 1 ];
		b.quad( b.vertex( [ - w, - l, 0 ], n ), b.vertex( [ w, - l, 0 ], n ), b.vertex( [ w, l, 0 ], n ), b.vertex( [ - w, l, 0 ], n ) );
		orient( b, axis );

	} else {

		return null;

	}

	const count = b.positions.length / 3;
	return {
		positions: Float32Array.from( b.positions ),
		normals: Float32Array.from( b.normals ),
		indices: count < 65536 ? Uint16Array.from( b.indices ) : Uint32Array.from( b.indices ),
	};

}
