// Turns a UsdGeomMesh into indexed triangle data with per vertex attributes, as glTF needs.

const F32 = new Float32Array( 1 );
const U32 = new Uint32Array( F32.buffer );

/**
 * A primvar resolved to a flat value array and the element index for each corner.
 */
function primvarSource( prim, name ) {

	const prop = prim.getProperty( name );
	if ( ! prop ) return null;
	const values = prop.value;
	if ( ! values || ! values.length ) return null;

	const interpolation = prop.getMetadata( 'interpolation' ) || ( name === 'normals' ? 'vertex' : 'constant' );
	const indices = prim.get( name + ':indices', null );
	const elementSize = prop.getMetadata( 'elementSize' ) || 1;
	return { values, interpolation, indices, elementSize, typeName: prop.typeName };

}

// Element index for a corner (face f, corner c in faceVarying order, point p).
function elementIndex( src, f, c, p ) {

	let i;
	switch ( src.interpolation ) {

		case 'constant': i = 0; break;
		case 'uniform': i = f; break;
		case 'vertex': case 'varying': i = p; break;
		default: i = c;

	}

	return src.indices ? src.indices[ i ] : i;

}

/**
 * @param {import('../usd/stage.js').Prim} prim a Mesh
 * @param {{ uvNames: string[] }} options
 * @returns mesh data with welded vertices and triangle groups per face set
 */
export function triangulateMesh( prim, { uvNames = [] } = {} ) {

	const points = prim.get( 'points' );
	const counts = prim.get( 'faceVertexCounts' );
	const fvi = prim.get( 'faceVertexIndices' );
	if ( ! points || ! counts || ! fvi || ! points.length ) return null;

	const pointCount = points.length / 3;
	const holes = new Set( prim.get( 'holeIndices', [] ) );
	const leftHanded = prim.get( 'orientation', 'rightHanded' ) === 'leftHanded';

	// face start offsets
	const faceCount = counts.length;
	const faceStart = new Uint32Array( faceCount + 1 );
	for ( let f = 0; f < faceCount; f ++ ) faceStart[ f + 1 ] = faceStart[ f ] + counts[ f ];
	if ( faceStart[ faceCount ] > fvi.length ) return null;

	// attribute sources, each read with a fixed item size
	const attributes = [];
	const normalSource = primvarSource( prim, 'primvars:normals' ) || primvarSource( prim, 'normals' );
	if ( normalSource && normalSource.values.length >= 3 ) attributes.push( { key: 'normal', src: normalSource, size: 3 } );

	for ( const name of uvNames ) {

		const src = primvarSource( prim, 'primvars:' + name );
		if ( src && src.values.length >= 2 ) attributes.push( { key: 'uv:' + name, src, size: 2 } );

	}

	const tangents = primvarSource( prim, 'primvars:tangents' );
	if ( tangents && tangents.typeName.startsWith( 'float4' ) && tangents.interpolation !== 'constant' ) attributes.push( { key: 'tangent', src: tangents, size: 4 } );

	const color = primvarSource( prim, 'primvars:displayColor' );
	const opacity = primvarSource( prim, 'primvars:displayOpacity' );
	const colorVaries = color && color.interpolation !== 'constant' && color.values.length > 3;
	const opacityVaries = opacity && opacity.interpolation !== 'constant' && opacity.values.length > 1;
	if ( colorVaries ) attributes.push( { key: 'color', src: color, size: 3 } );
	if ( opacityVaries ) attributes.push( { key: 'opacity', src: opacity, size: 1 } );

	// welding: a corner's identity is its point plus the value of every attribute
	const totalCorners = faceStart[ faceCount ];
	const cornerVertex = new Int32Array( totalCorners ).fill( - 1 );
	let tableSize = 1;
	while ( tableSize < totalCorners * 2 ) tableSize <<= 1;
	const table = new Int32Array( tableSize ).fill( - 1 );
	const vertexCorner = []; // representative corner per output vertex
	const vertexFace = [];
	const elementIdx = attributes.map( () => new Int32Array( totalCorners ) );

	function hashCorner( c, p ) {

		let h = Math.imul( p + 1, 0x9E3779B1 );

		for ( let a = 0; a < attributes.length; a ++ ) {

			const { src, size } = attributes[ a ];
			const e = elementIdx[ a ][ c ];
			const v = src.values;
			for ( let k = 0; k < size; k ++ ) {

				F32[ 0 ] = v[ e * size + k ] || 0;
				h = Math.imul( h ^ U32[ 0 ], 0x85EBCA6B );
				h ^= h >>> 13;

			}

		}

		return h >>> 0;

	}

	function sameCorner( a, b ) {

		if ( fvi[ a ] !== fvi[ b ] ) return false;

		for ( let i = 0; i < attributes.length; i ++ ) {

			const { src, size } = attributes[ i ];
			const ea = elementIdx[ i ][ a ], eb = elementIdx[ i ][ b ];
			if ( ea === eb ) continue;
			for ( let k = 0; k < size; k ++ ) if ( src.values[ ea * size + k ] !== src.values[ eb * size + k ] ) return false;

		}

		return true;

	}

	for ( let f = 0; f < faceCount; f ++ ) {

		if ( holes.has( f ) ) continue;

		for ( let c = faceStart[ f ]; c < faceStart[ f + 1 ]; c ++ ) {

			const p = fvi[ c ];
			if ( p >= pointCount ) continue;
			for ( let a = 0; a < attributes.length; a ++ ) elementIdx[ a ][ c ] = elementIndex( attributes[ a ].src, f, c, p );

			let slot = hashCorner( c, p ) & ( tableSize - 1 );

			for ( ;; ) {

				const v = table[ slot ];

				if ( v === - 1 ) {

					table[ slot ] = vertexCorner.length;
					cornerVertex[ c ] = vertexCorner.length;
					vertexCorner.push( c );
					vertexFace.push( f );
					break;

				}

				if ( sameCorner( vertexCorner[ v ], c ) ) {

					cornerVertex[ c ] = v;
					break;

				}

				slot = ( slot + 1 ) & ( tableSize - 1 );

			}

		}

	}

	const vertexCount = vertexCorner.length;
	const vertexPoint = new Uint32Array( vertexCount );
	const positions = new Float32Array( vertexCount * 3 );

	for ( let v = 0; v < vertexCount; v ++ ) {

		const p = fvi[ vertexCorner[ v ] ];
		vertexPoint[ v ] = p;
		positions[ v * 3 ] = points[ p * 3 ];
		positions[ v * 3 + 1 ] = points[ p * 3 + 1 ];
		positions[ v * 3 + 2 ] = points[ p * 3 + 2 ];

	}

	const result = { prim, vertexCount, positions, vertexPoint, normals: null, uvs: {}, colors: null, groups: [] };

	attributes.forEach( ( { key, src, size }, a ) => {

		const out = new Float32Array( vertexCount * size );

		for ( let v = 0; v < vertexCount; v ++ ) {

			const e = elementIdx[ a ][ vertexCorner[ v ] ];
			for ( let k = 0; k < size; k ++ ) out[ v * size + k ] = src.values[ e * size + k ] ?? 0;

		}

		if ( key === 'normal' ) result.normals = out;
		else if ( key === 'color' ) result.colors = out;
		else if ( key === 'opacity' ) result.opacity = out;
		else if ( key === 'tangent' ) result.tangents = out;
		else result.uvs[ key.slice( 3 ) ] = out;

	} );

	if ( color && ! colorVaries ) result.constantColor = Array.from( color.values.slice( 0, 3 ) );
	if ( opacity && ! opacityVaries ) result.constantOpacity = opacity.values[ 0 ];

	// triangles per face, fanned; leftHanded reverses winding
	const faceTriangles = ( f, out ) => {

		const s = faceStart[ f ], n = counts[ f ];

		for ( let k = 1; k + 1 < n; k ++ ) {

			const a = cornerVertex[ s ], b = cornerVertex[ s + k ], c = cornerVertex[ s + k + 1 ];
			if ( a < 0 || b < 0 || c < 0 ) continue;
			if ( leftHanded ) out.push( a, c, b );
			else out.push( a, b, c );

		}

	};

	// face groups from material GeomSubsets
	const subsets = prim.children.filter( ( c ) => c.typeName === 'GeomSubset' && c.get( 'elementType', 'face' ) === 'face' && c.specifier === 'def' );
	const assigned = new Uint8Array( faceCount );

	for ( const subset of subsets ) {

		const family = subset.get( 'familyName', '' );
		if ( family && family !== 'materialBind' ) continue;
		const tris = [];
		for ( const f of subset.get( 'indices', [] ) ) {

			if ( f >= faceCount || assigned[ f ] || holes.has( f ) ) continue;
			assigned[ f ] = 1;
			faceTriangles( f, tris );

		}

		if ( tris.length ) result.groups.push( { subset, indices: tris } );

	}

	const rest = [];
	for ( let f = 0; f < faceCount; f ++ ) if ( ! assigned[ f ] && ! holes.has( f ) ) faceTriangles( f, rest );
	if ( rest.length ) result.groups.unshift( { subset: null, indices: rest } );

	if ( ! result.normals ) result.normals = computeNormals( positions, vertexPoint, pointCount, result.groups );

	return result;

}

// Smooth, area weighted normals shared by all vertices of a point.
export function computeNormals( positions, vertexPoint, pointCount, groups ) {

	const accum = new Float64Array( pointCount * 3 );

	for ( const { indices } of groups ) {

		for ( let i = 0; i < indices.length; i += 3 ) {

			const a = indices[ i ] * 3, b = indices[ i + 1 ] * 3, c = indices[ i + 2 ] * 3;
			const e1x = positions[ b ] - positions[ a ], e1y = positions[ b + 1 ] - positions[ a + 1 ], e1z = positions[ b + 2 ] - positions[ a + 2 ];
			const e2x = positions[ c ] - positions[ a ], e2y = positions[ c + 1 ] - positions[ a + 1 ], e2z = positions[ c + 2 ] - positions[ a + 2 ];
			const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;

			for ( const v of [ indices[ i ], indices[ i + 1 ], indices[ i + 2 ] ] ) {

				const p = vertexPoint[ v ] * 3;
				accum[ p ] += nx; accum[ p + 1 ] += ny; accum[ p + 2 ] += nz;

			}

		}

	}

	const normals = new Float32Array( vertexPoint.length * 3 );

	for ( let v = 0; v < vertexPoint.length; v ++ ) {

		const p = vertexPoint[ v ] * 3;
		const l = Math.hypot( accum[ p ], accum[ p + 1 ], accum[ p + 2 ] );
		if ( l > 0 ) {

			normals[ v * 3 ] = accum[ p ] / l;
			normals[ v * 3 + 1 ] = accum[ p + 1 ] / l;
			normals[ v * 3 + 2 ] = accum[ p + 2 ] / l;

		} else {

			normals[ v * 3 + 2 ] = 1;

		}

	}

	return normals;

}

// Normalizes normal vectors in place; zero length ones become +Z so the output validates.
export function normalizeNormals( normals ) {

	for ( let i = 0; i < normals.length; i += 3 ) {

		const l = Math.hypot( normals[ i ], normals[ i + 1 ], normals[ i + 2 ] );
		if ( l > 1e-12 && Number.isFinite( l ) ) {

			normals[ i ] /= l; normals[ i + 1 ] /= l; normals[ i + 2 ] /= l;

		} else {

			normals[ i ] = 0; normals[ i + 1 ] = 0; normals[ i + 2 ] = 1;

		}

	}

	return normals;

}
