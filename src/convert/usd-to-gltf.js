// USD stage -> glTF.

import { GLTFBuilder } from '../gltf/document.js';
import { Stage } from '../usd/stage.js';
import { getXformOps, evaluateOps, xformSampleTimes } from '../usd/xform.js';
import { MaterialConverter } from './usd-material.js';
import { triangulateMesh, normalizeNormals } from './usd-mesh.js';
import { generateShape } from './usd-shapes.js';
import { compose, decompose, identity, invert, isIdentity, multiply, normalMatrix, transformDirection, transformPoint } from '../util/math.js';

const SKIP_TYPES = new Set( [ 'Material', 'Shader', 'NodeGraph', 'GeomSubset', 'SkelAnimation', 'BlendShape', 'RenderSettings', 'RenderProduct', 'RenderVar', 'GeometryLight', 'DomeLight', 'Backdrop' ] );
const LIGHT_TYPES = new Set( [ 'DistantLight', 'SphereLight', 'DiskLight', 'RectLight', 'CylinderLight' ] );
const SHAPE_TYPES = new Set( [ 'Cube', 'Sphere', 'Cylinder', 'Cone', 'Capsule', 'Plane', 'Cylinder_1', 'Capsule_1' ] );

export class USDToGLTF {

	constructor( stage, { log = () => {}, materialVariants = true, debug = false } = {} ) {

		this.stage = stage;
		this.log = log;
		this.debug = debug; // records usd paths and time mapping in extras, for verification
		this.materialVariants = materialVariants;
		this.builder = new GLTFBuilder();
		this.materials = new MaterialConverter( stage, this.builder, { log } );
		this.json = this.builder.json;
		this.meshCache = new Map();
		this.primNodes = new Map(); // prim path -> node index (first instance)
		this.skeletons = new Map(); // skeleton path -> { jointNodes, joints, skin }
		this.channels = []; // { node, path, times, values, interpolation, animation }
		this.meshNodes = []; // { prim, node, primitives: [ { group } ] }
		this.cameras = new Map();
		this.lights = [];

	}

	async convert() {

		const stage = this.stage;
		const scene = { nodes: [] };
		this.json.scenes.push( scene );
		this.json.scene = 0;

		// root correction: z up -> y up, and units -> meters
		let rootMatrix = identity();
		if ( stage.upAxis === 'Z' ) rootMatrix = [ 1, 0, 0, 0, 0, 0, - 1, 0, 0, 1, 0, 0, 0, 0, 0, 1 ];
		const mpu = stage.metersPerUnit;
		if ( mpu !== 1 ) rootMatrix = multiply( rootMatrix, [ mpu, 0, 0, 0, 0, mpu, 0, 0, 0, 0, mpu, 0, 0, 0, 0, 1 ] );

		let parentList = scene.nodes;
		this.rootNode = null;

		if ( ! isIdentity( rootMatrix ) ) {

			this.rootNode = this.addNode( { name: stage.defaultPrim || 'root' } );
			setTransform( this.json.nodes[ this.rootNode ], rootMatrix );
			scene.nodes.push( this.rootNode );
			parentList = this.json.nodes[ this.rootNode ].children = [];

		}

		for ( const prim of stage.root.children ) {

			const node = await this.convertPrim( prim, null );
			if ( node !== null ) parentList.push( node );

		}

		if ( this.rootNode !== null && ! parentList.length ) delete this.json.nodes[ this.rootNode ].children;

		this.assignSkins();
		this.channels = this.collectChannels( stage, null );
		await this.convertVariants();
		this.writeAnimations();

		if ( this.lights.length ) {

			this.json.extensions = { ...this.json.extensions, KHR_lights_punctual: { lights: this.lights } };
			this.builder.useExtension( 'KHR_lights_punctual' );

		}

		return this.builder;

	}

	addNode( node ) {

		return this.json.nodes.push( node ) - 1;

	}

	isRenderable( prim ) {

		if ( prim.specifier !== 'def' ) return false;
		if ( SKIP_TYPES.has( prim.typeName ) ) return false;
		const purpose = prim.get( 'purpose', 'default' );
		return purpose === 'default' || purpose === 'render';

	}

	async convertPrim( prim, parentPrim ) {

		if ( ! this.isRenderable( prim ) ) return null;

		const node = { name: prim.name };
		if ( this.debug ) node.extras = { usdPath: prim.path };
		const index = this.addNode( node );
		if ( ! this.primNodes.has( prim.path ) ) this.primNodes.set( prim.path, index );

		// transform
		const { ops, resetsXformStack } = getXformOps( prim );
		if ( resetsXformStack && parentPrim ) this.log( `${ prim.path }: !resetXformStack! is approximated` );
		const times = xformSampleTimes( ops );
		setTransform( node, evaluateOps( ops, times.length ? times[ 0 ] : undefined ), times.length > 1 );

		const visibility = prim.getProperty( 'visibility' );

		if ( visibility ) {

			if ( visibility.value === 'invisible' || visibility.isAnimated ) {

				node.extensions = { KHR_node_visibility: { visible: visibility.value !== 'invisible' } };
				this.builder.useExtension( 'KHR_node_visibility' );

			}

		}

		const type = prim.typeName;

		if ( type === 'Mesh' ) await this.convertMesh( prim, index );
		else if ( SHAPE_TYPES.has( type ) ) await this.convertShape( prim, index );
		else if ( type === 'Points' || type === 'BasisCurves' ) await this.convertLines( prim, index );
		else if ( type === 'Camera' ) this.convertCamera( prim, node );
		else if ( LIGHT_TYPES.has( type ) ) this.convertLight( prim, node );
		else if ( type === 'Skeleton' ) this.convertSkeleton( prim, index );

		if ( type === 'PointInstancer' ) {

			await this.convertInstancer( prim, node );

		} else {

			const children = [];
			for ( const child of prim.children ) {

				const c = await this.convertPrim( child, prim );
				if ( c !== null ) children.push( c );

			}

			if ( children.length ) node.children = [ ...( node.children || [] ), ...children ];

		}

		return index;

	}

	// --- materials ---

	boundMaterial( prim, stage = this.stage ) {

		// UsdShade resolution: the nearest binding wins unless an ancestor's binding is
		// strongerThanDescendants. The preview purpose is preferred over all purpose.
		let bound = null;

		for ( let p = prim; p && p.path !== '/'; p = p.parent ) {

			for ( const name of [ 'material:binding:preview', 'material:binding' ] ) {

				const rel = p.getProperty( name );
				const targets = rel?.targets;
				if ( ! targets?.length ) continue;
				const mat = stage.getPrimAtPath( targets[ 0 ] );
				if ( ! mat || mat.typeName !== 'Material' ) continue;
				if ( ! bound || rel.getMetadata( 'bindMaterialAs' ) === 'strongerThanDescendants' ) bound = mat;
				break;

			}

		}

		return bound;

	}

	// --- meshes ---

	async convertMesh( prim, nodeIndex ) {

		const node = this.json.nodes[ nodeIndex ];
		const skel = this.skinningFor( prim );

		// uv sets the bound materials use
		const materials = new Set();
		const direct = this.boundMaterial( prim );
		if ( direct ) materials.add( direct );
		for ( const child of prim.children ) if ( child.typeName === 'GeomSubset' ) { const m = this.boundMaterial( child ); if ( m ) materials.add( m ); }

		const uvNames = new Set();
		for ( const mat of materials ) this.collectUVNames( mat, uvNames );
		if ( ! uvNames.size ) for ( const name of [ 'st', 'UVMap', 'uv', 'map1', 'st0' ] ) if ( prim.getProperty( 'primvars:' + name ) ) { uvNames.add( name ); break; }
		for ( const name of uvNames ) this.materials.uvIndex( name );

		const data = triangulateMesh( prim, { uvNames: [ ...uvNames ] } );
		if ( ! data || ! data.groups.length ) return;

		const doubleSided = prim.get( 'doubleSided', false );
		const mesh = { name: prim.name, primitives: [] };

		// geometry that every primitive shares
		let positions = data.positions;
		let normals = normalizeNormals( data.normals );

		if ( skel && skel.geomBind && ! isIdentity( skel.geomBind ) ) {

			positions = new Float32Array( positions.length );
			normals = new Float32Array( normals.length );
			const nm = normalMatrix( skel.geomBind );
			for ( let i = 0; i < data.vertexCount; i ++ ) {

				transformPoint( skel.geomBind, data.positions[ i * 3 ], data.positions[ i * 3 + 1 ], data.positions[ i * 3 + 2 ], positions, i * 3 );
				transformDirection( nm, data.normals[ i * 3 ], data.normals[ i * 3 + 1 ], data.normals[ i * 3 + 2 ], normals, i * 3 );

			}

		}

		const attributes = {
			POSITION: this.builder.addAccessor( positions, 'VEC3', { target: 34962, minmax: true } ),
			NORMAL: this.builder.addAccessor( normals, 'VEC3', { target: 34962 } ),
		};

		// texCoords in material order; a mesh missing a set reuses its first one so indices stay aligned
		const maxUV = Math.max( - 1, ...[ ...uvNames ].map( ( n ) => this.materials.uvNames.indexOf( n ) ) );
		const available = Object.keys( data.uvs );

		for ( let i = 0; i <= maxUV && available.length; i ++ ) {

			const name = this.materials.uvNames[ i ];
			const src = data.uvs[ name ] || data.uvs[ available[ 0 ] ];
			const uv = new Float32Array( src.length );
			for ( let k = 0; k < src.length; k += 2 ) { uv[ k ] = src[ k ]; uv[ k + 1 ] = 1 - src[ k + 1 ]; }
			attributes[ 'TEXCOORD_' + i ] = this.builder.addAccessor( uv, 'VEC2', { target: 34962 } );

		}

		// displayColor only reaches glTF when nothing else defines the color: no material, a material
		// reading the primvar, or a mesh converted from glTF that had COLOR_0
		const readsColor = ! materials.size || prim.getMetadata( 'customData' )?.gltf?.color0 ||
			[ ...materials ].some( ( m ) => this.materials.surfaceInputs( m ).diffuseColor.some( ( t ) => t.primvar ) );
		const vertexColors = !! data.colors && !! readsColor;

		if ( data.tangents ) attributes.TANGENT = this.builder.addAccessor( data.tangents, 'VEC4', { target: 34962 } );

		if ( vertexColors ) {

			const n = data.vertexCount;
			const rgba = new Float32Array( n * 4 );
			for ( let v = 0; v < n; v ++ ) {

				rgba[ v * 4 ] = clamp01( data.colors[ v * 3 ] );
				rgba[ v * 4 + 1 ] = clamp01( data.colors[ v * 3 + 1 ] );
				rgba[ v * 4 + 2 ] = clamp01( data.colors[ v * 3 + 2 ] );
				rgba[ v * 4 + 3 ] = data.opacity ? clamp01( data.opacity[ v ] ) : 1;

			}

			attributes.COLOR_0 = this.builder.addAccessor( rgba, 'VEC4', { target: 34962 } );

		}

		if ( skel ) this.addSkinAttributes( prim, data, skel, attributes, node );

		const targets = skel ? this.blendShapeTargets( prim, data, skel ) : null;

		for ( const group of data.groups ) {

			const indices = data.vertexCount < 65536 ? Uint16Array.from( group.indices ) : Uint32Array.from( group.indices );
			const primitive = { attributes: { ...attributes }, indices: this.builder.addAccessor( indices, 'SCALAR', { target: 34963 } ) };
			const material = ( group.subset && this.boundMaterial( group.subset ) ) || this.boundMaterial( prim );

			if ( material ) primitive.material = await this.materials.convert( material, { doubleSided, vertexColors } );
			else primitive.material = this.materials.defaultMaterial( data.constantColor, data.constantOpacity, vertexColors, doubleSided );

			if ( targets ) primitive.targets = targets.accessors;
			mesh.primitives.push( primitive );

		}

		if ( targets ) {

			mesh.extras = { targetNames: targets.names };
			if ( targets.defaultWeights.some( ( w ) => w ) ) mesh.weights = targets.defaultWeights;

		}

		node.mesh = this.json.meshes.push( mesh ) - 1;
		this.meshNodes.push( { prim, node: nodeIndex, mesh: node.mesh, groups: data.groups, doubleSided, vertexColors, blendShapes: targets?.names, skeleton: skel?.skeleton } );

	}

	collectUVNames( material, names ) {

		const visit = ( prim, depth ) => {

			if ( depth > 64 ) return;

			for ( const child of prim.children ) {

				if ( child.typeName === 'Shader' ) {

					const id = child.get( 'info:id', '' );
					if ( id.startsWith( 'UsdPrimvarReader_float2' ) ) {

						const v = this.materials.evalString( child.getProperty( 'inputs:varname' ) );
						if ( v ) names.add( v );

					} else if ( id === 'ND_geompropvalue_vector2' ) {

						const v = this.materials.evalString( child.getProperty( 'inputs:geomprop' ) );
						if ( v ) names.add( v );

					} else if ( id === 'ND_texcoord_vector2' ) {

						names.add( 'st' );

					}

				}

				visit( child, depth + 1 );

			}

		};

		visit( material, 0 );

	}

	async convertShape( prim, nodeIndex ) {

		const shape = generateShape( prim );
		if ( ! shape ) return;
		const node = this.json.nodes[ nodeIndex ];
		const attributes = {
			POSITION: this.builder.addAccessor( shape.positions, 'VEC3', { target: 34962, minmax: true } ),
			NORMAL: this.builder.addAccessor( shape.normals, 'VEC3', { target: 34962 } ),
		};
		const primitive = { attributes, indices: this.builder.addAccessor( shape.indices, 'SCALAR', { target: 34963 } ) };
		const material = this.boundMaterial( prim );
		const color = prim.get( 'primvars:displayColor' );
		const opacity = prim.get( 'primvars:displayOpacity' );
		primitive.material = material ? await this.materials.convert( material, {} ) : this.materials.defaultMaterial( color && Array.from( color.slice( 0, 3 ) ), opacity?.[ 0 ], false, false );
		node.mesh = this.json.meshes.push( { name: prim.name, primitives: [ primitive ] } ) - 1;

	}

	async convertLines( prim, nodeIndex ) {

		const points = prim.get( 'points' );
		if ( ! points || ! points.length ) return;
		const node = this.json.nodes[ nodeIndex ];
		const primitive = { attributes: { POSITION: this.builder.addAccessor( Float32Array.from( points ), 'VEC3', { target: 34962, minmax: true } ) } };

		if ( prim.typeName === 'Points' ) {

			primitive.mode = 0;

		} else {

			const counts = prim.get( 'curveVertexCounts', [ points.length / 3 ] );
			const wrap = prim.get( 'wrap', 'nonperiodic' ) === 'periodic';
			const indices = [];
			let start = 0;
			for ( const n of counts ) {

				for ( let i = 0; i + 1 < n; i ++ ) indices.push( start + i, start + i + 1 );
				if ( wrap && n > 2 ) indices.push( start + n - 1, start );
				start += n;

			}

			if ( ! indices.length ) return;
			primitive.mode = 1;
			primitive.indices = this.builder.addAccessor( points.length / 3 < 65536 ? Uint16Array.from( indices ) : Uint32Array.from( indices ), 'SCALAR', { target: 34963 } );

		}

		const color = prim.get( 'primvars:displayColor' );
		const material = this.boundMaterial( prim );
		if ( color && color.length === points.length ) {

			const rgba = new Float32Array( points.length / 3 * 4 );
			for ( let i = 0; i < points.length / 3; i ++ ) rgba.set( [ clamp01( color[ i * 3 ] ), clamp01( color[ i * 3 + 1 ] ), clamp01( color[ i * 3 + 2 ] ), 1 ], i * 4 );
			primitive.attributes.COLOR_0 = this.builder.addAccessor( rgba, 'VEC4', { target: 34962 } );

		}

		primitive.material = material ? await this.materials.convert( material, {} ) : this.materials.defaultMaterial( color && color.length === 3 ? Array.from( color ) : null, 1, !! primitive.attributes.COLOR_0, false );
		node.mesh = this.json.meshes.push( { name: prim.name, primitives: [ primitive ] } ) - 1;

	}

	// --- skinning ---

	skeletonFor( prim ) {

		for ( let p = prim; p && p.path !== '/'; p = p.parent ) {

			const targets = p.getTargets( 'skel:skeleton' );
			if ( targets.length ) return this.stage.getPrimAtPath( targets[ 0 ] );

		}

		// a SkelRoot with a single skeleton binds implicitly
		for ( let p = prim.parent; p && p.path !== '/'; p = p.parent ) {

			if ( p.typeName === 'SkelRoot' ) {

				const skels = [ ...p.traverse() ].filter( ( c ) => c.typeName === 'Skeleton' );
				if ( skels.length === 1 ) return skels[ 0 ];

			}

		}

		return null;

	}

	skinningFor( prim ) {

		const indices = prim.getProperty( 'primvars:skel:jointIndices' );
		const weights = prim.getProperty( 'primvars:skel:jointWeights' );
		if ( ! indices || ! weights || ! indices.value || ! weights.value ) {

			// blend shapes alone still need the skeleton for their weights
			if ( prim.get( 'skel:blendShapes' ) && this.skeletonFor( prim ) ) return { skeleton: this.skeletonFor( prim ), indices: null };
			return null;

		}

		const skeleton = this.skeletonFor( prim );
		if ( ! skeleton ) return null;

		// the rigid one joint skeleton our glTF -> USD conversion adds for morph targets is not a skin
		if ( isMorphOnly( skeleton ) ) return { skeleton, indices: null };

		return {
			skeleton,
			indices: indices.value,
			weights: weights.value,
			elementSize: indices.getMetadata( 'elementSize' ) || 1,
			interpolation: indices.getMetadata( 'interpolation' ) || 'vertex',
			geomBind: prim.get( 'primvars:skel:geomBindTransform' ) ?? prim.get( 'skel:geomBindTransform' ) ?? null,
			meshJoints: prim.get( 'skel:joints' ) || null,
		};

	}

	convertSkeleton( prim, nodeIndex ) {

		const joints = prim.get( 'joints', [] );
		if ( ! joints.length || isMorphOnly( prim ) ) return;

		const bind = prim.get( 'bindTransforms' );
		const rest = prim.get( 'restTransforms' );
		const node = this.json.nodes[ nodeIndex ];
		const jointNodes = [];
		const parents = [];
		const byPath = new Map( joints.map( ( j, i ) => [ j, i ] ) );
		const mat = ( arr, i ) => arr ? Array.from( arr.subarray( i * 16, i * 16 + 16 ) ) : identity();

		joints.forEach( ( path, i ) => {

			const parts = path.split( '/' );
			const parent = parts.length > 1 ? byPath.get( parts.slice( 0, - 1 ).join( '/' ) ) ?? - 1 : - 1;
			parents.push( parent );
			let local;
			if ( rest && rest.length >= ( i + 1 ) * 16 ) local = mat( rest, i );
			else if ( bind ) local = parent >= 0 ? multiply( invert( mat( bind, parent ) ), mat( bind, i ) ) : mat( bind, i );
			else local = identity();

			const jointNode = { name: parts[ parts.length - 1 ] };
			setTransform( jointNode, local, true );
			jointNodes.push( this.addNode( jointNode ) );

		} );

		joints.forEach( ( _, i ) => {

			const parentNode = parents[ i ] >= 0 ? this.json.nodes[ jointNodes[ parents[ i ] ] ] : node;
			( parentNode.children ||= [] ).push( jointNodes[ i ] );

		} );

		// inverse bind matrices are the same for every mesh because geomBindTransform is baked into the points
		const ibm = new Float32Array( joints.length * 16 );
		joints.forEach( ( _, i ) => {

			const m = bind ? invert( mat( bind, i ) ) : identity();
			m[ 3 ] = 0; m[ 7 ] = 0; m[ 11 ] = 0; m[ 15 ] = 1; // exact affine, as the validator requires
			ibm.set( m, i * 16 );

		} );

		const skin = { name: prim.name, joints: jointNodes, skeleton: nodeIndex, inverseBindMatrices: this.builder.addAccessor( ibm, 'MAT4' ) };
		const skinIndex = ( this.json.skins ||= [] ).push( skin ) - 1;
		const info = { prim, joints, jointNodes, skinIndex, parents };
		this.skeletons.set( prim.path, info );

		this.applySkelRest( info, this.animationSourceFor( prim, this.stage ) );

	}

	animationSourceFor( skeleton, stage ) {

		for ( let p = stage.getPrimAtPath( skeleton.path ); p && p.path !== '/'; p = p.parent ) {

			const targets = p.getTargets( 'skel:animationSource' );
			if ( targets.length ) return stage.getPrimAtPath( targets[ 0 ] );

		}

		return null;

	}

	// A SkelAnimation's default values override the skeleton's rest pose.
	applySkelRest( info, anim ) {

		if ( ! anim || anim.typeName !== 'SkelAnimation' ) return;
		const map = this.jointMap( info, anim );

		for ( const [ attr, path, size ] of SKEL_ATTRIBUTES ) {

			const value = anim.getProperty( attr )?.value;
			if ( ! value ) continue;

			map.forEach( ( j, k ) => {

				if ( j < 0 || ( k + 1 ) * size > value.length ) return;
				setTRSComponent( this.json.nodes[ info.jointNodes[ j ] ], path, Array.from( value.subarray( k * size, k * size + size ) ) );

			} );

		}

	}

	jointMap( info, anim ) {

		const index = new Map( info.joints.map( ( j, i ) => [ j, i ] ) );
		return anim.get( 'joints', [] ).map( ( j ) => index.get( j ) ?? - 1 );

	}

	// Every animated value on a stage as glTF channels: xforms, visibility, skeletons and blend shape weights.
	collectChannels( stage, animation ) {

		const channels = [];

		for ( const [ path, node ] of this.primNodes ) {

			const prim = stage.getPrimAtPath( path );
			if ( ! prim ) continue;

			const { ops } = getXformOps( prim );
			const times = xformSampleTimes( ops );

			if ( times.length > 1 ) {

				const t = [], r = [], s = [];
				let prev = null;

				for ( const time of times ) {

					const d = decompose( evaluateOps( ops, time ) );
					if ( prev ) d.r = shortestQuat( prev, d.r );
					prev = d.r;
					t.push( ...d.t ); r.push( ...d.r ); s.push( ...d.s );

				}

				channels.push( { node, path: 'translation', times, values: t, animation } );
				channels.push( { node, path: 'rotation', times, values: r, animation } );
				channels.push( { node, path: 'scale', times, values: s, animation } );

			}

			const visibility = prim.getProperty( 'visibility' );

			if ( visibility?.isAnimated ) {

				const vt = [ ...visibility.timeSamples.keys() ].sort( ( a, b ) => a - b );
				channels.push( { node, pointer: `/nodes/${ node }/extensions/KHR_node_visibility/visible`, times: vt, values: vt.map( ( t ) => visibility.timeSamples.get( t ) !== 'invisible' ), interpolation: 'STEP', type: 'bool', animation } );

			}

		}

		for ( const info of this.skeletons.values() ) {

			const anim = this.animationSourceFor( info.prim, stage );
			if ( ! anim || anim.typeName !== 'SkelAnimation' ) continue;
			const map = this.jointMap( info, anim );

			for ( const [ attr, path, size ] of SKEL_ATTRIBUTES ) {

				const prop = anim.getProperty( attr );
				if ( ! prop?.isAnimated ) continue;
				const times = [ ...prop.timeSamples.keys() ].sort( ( a, b ) => a - b );

				map.forEach( ( j, k ) => {

					if ( j < 0 ) return;
					const values = [];
					let prev = null;

					for ( const t of times ) {

						const v = prop.timeSamples.get( t );
						let x = v && v.length >= ( k + 1 ) * size ? Array.from( v.subarray( k * size, k * size + size ) ) : ( path === 'rotation' ? [ 0, 0, 0, 1 ] : path === 'scale' ? [ 1, 1, 1 ] : [ 0, 0, 0 ] );

						if ( path === 'rotation' ) {

							x = normalize4( x );
							if ( prev ) x = shortestQuat( prev, x );
							prev = x;

						}

						values.push( ...x );

					}

					channels.push( { node: info.jointNodes[ j ], path, times, values, animation } );

				} );

			}

		}

		for ( const entry of this.meshNodes ) {

			if ( ! entry.blendShapes ) continue;
			const anim = this.animationSourceFor( entry.skeleton, stage );
			const prop = anim?.getProperty( 'blendShapeWeights' );
			if ( ! prop?.isAnimated ) continue;

			const animNames = anim.get( 'blendShapes', [] );
			const map = entry.blendShapes.map( ( n ) => animNames.indexOf( n ) );
			const times = [ ...prop.timeSamples.keys() ].sort( ( a, b ) => a - b );
			const values = [];

			for ( const t of times ) {

				const v = prop.timeSamples.get( t );
				for ( const k of map ) values.push( k >= 0 && v ? v[ k ] ?? 0 : 0 );

			}

			channels.push( { node: entry.node, path: 'weights', times, values, animation } );

		}

		return channels;

	}

	addSkinAttributes( prim, data, skel, attributes, node ) {

		if ( ! skel.indices ) return;

		// the skin itself is assigned once every skeleton has been converted
		( this.pendingSkins ||= [] ).push( { node, skeleton: skel.skeleton } );
		const info = { joints: skel.skeleton.get( 'joints', [] ) };

		const es = skel.elementSize;
		const sets = Math.ceil( es / 4 );
		const n = data.vertexCount;
		const jointCount = info.joints.length;
		const remap = skel.meshJoints ? skel.meshJoints.map( ( name ) => Math.max( 0, info.joints.indexOf( name ) ) ) : null;
		const JointArray = jointCount > 255 ? Uint16Array : Uint8Array;
		const joints = Array.from( { length: sets }, () => new JointArray( n * 4 ) );
		const weights = Array.from( { length: sets }, () => new Float32Array( n * 4 ) );
		const constant = skel.interpolation === 'constant';

		for ( let v = 0; v < n; v ++ ) {

			const p = constant ? 0 : data.vertexPoint[ v ];
			let sum = 0;
			for ( let k = 0; k < es; k ++ ) sum += Math.max( 0, skel.weights[ p * es + k ] || 0 );

			for ( let k = 0; k < es; k ++ ) {

				let j = skel.indices[ p * es + k ] || 0;
				if ( remap ) j = remap[ j ] ?? 0;
				if ( j >= jointCount ) j = 0;
				const w = sum > 0 ? Math.max( 0, skel.weights[ p * es + k ] || 0 ) / sum : ( k === 0 ? 1 : 0 );
				joints[ k >> 2 ][ v * 4 + ( k & 3 ) ] = w > 0 ? j : 0;
				weights[ k >> 2 ][ v * 4 + ( k & 3 ) ] = w;

			}

		}

		for ( let s = 0; s < sets; s ++ ) {

			attributes[ 'JOINTS_' + s ] = this.builder.addAccessor( joints[ s ], 'VEC4', { target: 34962 } );
			attributes[ 'WEIGHTS_' + s ] = this.builder.addAccessor( weights[ s ], 'VEC4', { target: 34962 } );

		}

	}

	// Assigns skins to skinned mesh nodes, converting skeletons the node tree didn't reach.
	assignSkins() {

		for ( const { node, skeleton } of this.pendingSkins || [] ) {

			let info = this.skeletons.get( skeleton.path );

			if ( ! info ) {

				const index = this.addNode( { name: skeleton.name } );
				if ( this.rootNode !== null ) ( this.json.nodes[ this.rootNode ].children ||= [] ).push( index );
				else this.json.scenes[ 0 ].nodes.push( index );
				this.primNodes.set( skeleton.path, index );
				this.convertSkeleton( skeleton, index );
				info = this.skeletons.get( skeleton.path );

			}

			if ( info ) node.skin = info.skinIndex;

		}

	}

	blendShapeTargets( prim, data, skel ) {

		const names = prim.get( 'skel:blendShapes' );
		const targets = prim.getTargets( 'skel:blendShapeTargets' );
		if ( ! names || ! names.length || ! targets.length ) return null;

		const geomBind = skel.geomBind && ! isIdentity( skel.geomBind ) ? skel.geomBind : null;
		const accessors = [];
		const pointCount = prim.get( 'points' ).length / 3;

		for ( let i = 0; i < names.length; i ++ ) {

			const shape = this.stage.getPrimAtPath( targets[ i ] ?? targets[ 0 ] );
			const offsets = shape?.get( 'offsets' );
			const delta = new Float32Array( data.vertexCount * 3 );

			if ( offsets ) {

				const pointIndices = shape.get( 'pointIndices' );
				const perPoint = new Float32Array( pointCount * 3 );

				if ( pointIndices ) pointIndices.forEach( ( p, k ) => { if ( p < pointCount ) perPoint.set( offsets.subarray( k * 3, k * 3 + 3 ), p * 3 ); } );
				else perPoint.set( offsets.subarray( 0, Math.min( offsets.length, pointCount * 3 ) ) );

				for ( let v = 0; v < data.vertexCount; v ++ ) {

					const p = data.vertexPoint[ v ] * 3;
					if ( geomBind ) {

						const x = perPoint[ p ], y = perPoint[ p + 1 ], z = perPoint[ p + 2 ];
						delta[ v * 3 ] = geomBind[ 0 ] * x + geomBind[ 4 ] * y + geomBind[ 8 ] * z;
						delta[ v * 3 + 1 ] = geomBind[ 1 ] * x + geomBind[ 5 ] * y + geomBind[ 9 ] * z;
						delta[ v * 3 + 2 ] = geomBind[ 2 ] * x + geomBind[ 6 ] * y + geomBind[ 10 ] * z;

					} else {

						delta[ v * 3 ] = perPoint[ p ]; delta[ v * 3 + 1 ] = perPoint[ p + 1 ]; delta[ v * 3 + 2 ] = perPoint[ p + 2 ];

					}

				}

			}

			accessors.push( { POSITION: this.builder.addAccessor( delta, 'VEC3', { target: 34962, minmax: true } ) } );

		}

		// weights from the skeleton's animation
		const anim = this.animationSourceFor( skel.skeleton, this.stage );
		const defaultWeights = new Array( names.length ).fill( 0 );

		if ( anim ) {

			const animNames = anim.get( 'blendShapes', [] );
			const prop = anim.getProperty( 'blendShapeWeights' );
			const map = names.map( ( n ) => animNames.indexOf( n ) );

			if ( prop ) {

				const value = prop.value;
				if ( value ) map.forEach( ( k, i ) => { if ( k >= 0 ) defaultWeights[ i ] = value[ k ] ?? 0; } );

			}

		}

		return { accessors, names: Array.from( names ), defaultWeights };

	}

	// --- cameras, lights, instancers ---

	convertCamera( prim, node ) {

		const projection = prim.get( 'projection', 'perspective' );
		const h = prim.get( 'horizontalAperture', 20.955 );
		const v = prim.get( 'verticalAperture', 15.2908 );
		const f = prim.get( 'focalLength', 50 );
		const [ znear, zfar ] = prim.get( 'clippingRange', [ 1, 1000000 ] );
		let camera;

		if ( projection === 'orthographic' ) {

			camera = { type: 'orthographic', orthographic: { xmag: h / 20, ymag: v / 20, znear: Math.max( 0, znear ), zfar: Math.max( zfar, znear + 1e-6 ) } };

		} else {

			camera = { type: 'perspective', perspective: { yfov: 2 * Math.atan( v / ( 2 * f ) ), aspectRatio: h / v, znear: Math.max( znear, 1e-6 ) } };
			if ( Number.isFinite( zfar ) && zfar > znear ) camera.perspective.zfar = zfar;

		}

		camera.name = prim.name;
		node.camera = ( this.json.cameras ||= [] ).push( camera ) - 1;

	}

	convertLight( prim, node ) {

		const get = ( name, fallback ) => prim.get( 'inputs:' + name, prim.get( name, fallback ) );
		const intensity = get( 'intensity', 1 ) * Math.pow( 2, get( 'exposure', 0 ) );
		const color = Array.from( get( 'color', [ 1, 1, 1 ] ) );
		const light = { name: prim.name, color, intensity };

		if ( prim.typeName === 'DistantLight' ) {

			light.type = 'directional';

		} else {

			const cone = prim.get( 'inputs:shaping:cone:angle', prim.get( 'shaping:cone:angle' ) );

			if ( cone !== undefined && cone < 90 ) {

				const outer = Math.max( 1e-4, Math.min( Math.PI / 2, cone * Math.PI / 180 ) );
				const softness = prim.get( 'inputs:shaping:cone:softness', prim.get( 'shaping:cone:softness', 0 ) );
				light.type = 'spot';
				light.spot = { outerConeAngle: outer, innerConeAngle: Math.max( 0, Math.min( outer * 0.999, outer * ( 1 - softness ) ) ) };

			} else {

				light.type = 'point';

			}

		}

		node.extensions = { ...node.extensions, KHR_lights_punctual: { light: this.lights.push( light ) - 1 } };

	}

	async convertInstancer( prim, node ) {

		const protos = prim.getTargets( 'prototypes' ).map( ( p ) => this.stage.getPrimAtPath( p ) );
		const indices = prim.get( 'protoIndices', [] );
		const positions = prim.get( 'positions' );
		const orientations = prim.get( 'orientations' ) ?? prim.get( 'orientationsf' );
		const scales = prim.get( 'scales' );
		const invisible = new Set( prim.get( 'invisibleIds', [] ) );
		const ids = prim.get( 'ids' );
		const children = [];

		for ( let i = 0; i < indices.length; i ++ ) {

			if ( invisible.has( ids ? ids[ i ] : i ) ) continue;
			const proto = protos[ indices[ i ] ];
			if ( ! proto ) continue;

			const instance = { name: `${ proto.name }_${ i }` };
			if ( positions ) instance.translation = Array.from( positions.subarray( i * 3, i * 3 + 3 ) );
			if ( orientations ) instance.rotation = normalize4( Array.from( orientations.subarray( i * 4, i * 4 + 4 ) ) );
			if ( scales ) instance.scale = Array.from( scales.subarray( i * 3, i * 3 + 3 ) );
			const index = this.addNode( instance );
			const child = await this.convertPrim( proto, prim );
			if ( child !== null ) instance.children = [ child ];
			children.push( index );

		}

		if ( children.length ) node.children = children;

	}

	// --- variants ---

	async convertVariants() {

		const sets = this.stage.variantSets.filter( ( s ) => s.variants.length > 1 );
		if ( ! sets.length ) return;

		const baseStage = this.stage;
		const materialSets = []; // [ { set, variants: [ { variant, assignments } ] } ]

		for ( const set of sets ) {

			const results = [];
			let changesMaterials = false;

			for ( const variant of set.variants ) {

				const isDefault = variant === set.selection;
				const stage = isDefault ? baseStage : new Stage( baseStage.rootLayer, baseStage.layers, baseStage.reader, { variants: { [ set.path ]: { [ set.name ]: variant } } } );
				const assignments = [];

				for ( const entry of this.meshNodes ) {

					const prim = stage.getPrimAtPath( entry.prim.path );
					if ( ! prim ) continue;

					for ( let g = 0; g < entry.groups.length; g ++ ) {

						const group = entry.groups[ g ];
						const subset = group.subset ? stage.getPrimAtPath( group.subset.path ) : null;
						const material = ( subset && this.boundMaterial( subset, stage ) ) || this.boundMaterial( prim, stage );
						const primitive = this.json.meshes[ entry.mesh ].primitives[ g ];
						if ( ! material ) continue;

						this.materials.stage = stage;
						const before = this.json.materials.length;
						let index = await this.materials.convert( material, { doubleSided: entry.doubleSided, vertexColors: entry.vertexColors, variant: isDefault ? '' : `${ set.path }{${ set.name }=${ variant }}` } );
						index = this.dedupeMaterial( index, before );
						this.materials.stage = baseStage;

						assignments.push( { primitive, index } );
						if ( index !== primitive.material ) changesMaterials = true;

					}

				}

				results.push( { variant, assignments } );

				// a variant with different animation becomes a separate glTF animation
				if ( ! isDefault ) {

					const channels = this.collectChannels( stage, variant );
					const base = this.channels.filter( ( c ) => ! c.animation || c.animation === set.selection );

					if ( channelsSignature( channels ) !== channelsSignature( base ) ) {

						for ( const c of base ) c.animation = set.selection;
						this.channels.push( ...channels );

					}

				}

			}

			if ( changesMaterials ) materialSets.push( { set, results } );

		}

		if ( ! materialSets.length || ! this.materialVariants ) return;

		const variantNames = [];
		const mappings = new Map(); // primitive -> [ { material, variants } ]

		for ( const { set, results } of materialSets ) {

			for ( const { variant, assignments } of results ) {

				const v = variantNames.push( materialSets.length > 1 ? `${ set.name }:${ variant }` : variant ) - 1;

				for ( const { primitive, index } of assignments ) {

					if ( ! mappings.has( primitive ) ) mappings.set( primitive, [] );
					const list = mappings.get( primitive );
					const existing = list.find( ( m ) => m.material === index );
					if ( existing ) existing.variants.push( v );
					else list.push( { material: index, variants: [ v ] } );

				}

			}

		}

		this.json.extensions = { ...this.json.extensions, KHR_materials_variants: { variants: variantNames.map( ( name ) => ( { name } ) ) } };
		this.builder.useExtension( 'KHR_materials_variants' );
		for ( const [ primitive, list ] of mappings ) primitive.extensions = { ...primitive.extensions, KHR_materials_variants: { mappings: list } };

	}

	// Reuses an identical existing material instead of the one just added.
	dedupeMaterial( index, before ) {

		if ( index < before ) return index;
		const mats = this.json.materials;
		const key = JSON.stringify( { ...mats[ index ], name: undefined } );

		for ( let i = 0; i < before; i ++ ) {

			if ( JSON.stringify( { ...mats[ i ], name: undefined } ) === key ) {

				if ( index === mats.length - 1 ) {

					mats.pop();
					for ( const [ k, v ] of this.materials.materials ) if ( v === index ) this.materials.materials.set( k, i );

				}

				return i;

			}

		}

		return index;

	}

	// --- animation output ---

	writeAnimations() {

		const stage = this.stage;
		const tcps = stage.timeCodesPerSecond || 24;

		if ( ! this.channels.length ) return;

		let t0 = stage.startTimeCode;
		for ( const c of this.channels ) t0 = Math.min( t0, c.times[ 0 ] );
		if ( this.debug ) this.json.asset.extras = { timeOffset: t0, timeCodesPerSecond: tcps };

		const animations = new Map();
		const inputs = new Map();

		for ( const c of this.channels ) {

			const name = c.animation || 'default';
			if ( ! animations.has( name ) ) animations.set( name, { name: c.animation || 'animation', channels: [], samplers: [] } );
			const anim = animations.get( name );

			const times = c.times;
			const key = name + ':' + times.join( ',' );
			if ( ! inputs.has( key ) ) inputs.set( key, this.builder.addAccessor( Float32Array.from( times, ( t ) => ( t - t0 ) / tcps ), 'SCALAR', { minmax: true } ) );

			const output = c.type === 'bool'
				? this.builder.addAccessor( Uint8Array.from( c.values, ( v ) => ( v ? 1 : 0 ) ), 'SCALAR' )
				: this.builder.addAccessor( Float32Array.from( c.values ), c.path === 'weights' ? 'SCALAR' : c.path === 'rotation' ? 'VEC4' : 'VEC3' );

			const sampler = anim.samplers.push( { input: inputs.get( key ), output, interpolation: c.interpolation || 'LINEAR' } ) - 1;

			if ( c.pointer ) {

				this.builder.useExtension( 'KHR_animation_pointer' );
				anim.channels.push( { sampler, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: c.pointer } } } } );

			} else {

				anim.channels.push( { sampler, target: { node: c.node, path: c.path } } );

			}

		}

		this.json.animations = [ ...animations.values() ].filter( ( a ) => a.channels.length );

	}

}

const SKEL_ATTRIBUTES = [ [ 'translations', 'translation', 3 ], [ 'rotations', 'rotation', 4 ], [ 'scales', 'scale', 3 ] ];

function channelsSignature( channels ) {

	let h = 0;
	const f = new Float32Array( 1 ), u = new Uint32Array( f.buffer );

	for ( const c of channels ) {

		h = Math.imul( h ^ ( c.node + 1 ), 0x9E3779B1 ) ^ c.times.length;
		for ( const v of c.values ) { f[ 0 ] = + v; h = Math.imul( h ^ u[ 0 ], 0x85EBCA6B ); }

	}

	return channels.length + ':' + h;

}

function isMorphOnly( skeleton ) {

	return !! skeleton.getMetadata( 'customData' )?.gltf?.morphOnly;

}

function setTransform( node, m, alwaysTRS = false ) {

	delete node.matrix; delete node.translation; delete node.rotation; delete node.scale;
	if ( isIdentity( m, 1e-12 ) && ! alwaysTRS ) return;

	const d = decompose( m );
	const back = compose( d.t, d.r, d.s );
	let exact = true;
	for ( let i = 0; i < 16; i ++ ) if ( Math.abs( back[ i ] - m[ i ] ) > 1e-5 * ( 1 + Math.abs( m[ i ] ) ) ) exact = false;

	if ( ! exact ) {

		node.matrix = m.map( Number );
		return;

	}

	if ( d.t.some( ( v ) => v !== 0 ) ) node.translation = d.t;
	if ( d.r[ 3 ] < 1 - 1e-12 ) node.rotation = d.r;
	if ( d.s.some( ( v ) => Math.abs( v - 1 ) > 1e-12 ) ) node.scale = d.s;

}

function setTRSComponent( node, path, value ) {

	if ( node.matrix ) {

		const d = decompose( node.matrix );
		delete node.matrix;
		node.translation = d.t; node.rotation = d.r; node.scale = d.s;

	}

	node[ path ] = path === 'rotation' ? normalize4( value ) : value;

}

function normalize4( q ) {

	const l = Math.hypot( q[ 0 ], q[ 1 ], q[ 2 ], q[ 3 ] ) || 1;
	return [ q[ 0 ] / l, q[ 1 ] / l, q[ 2 ] / l, q[ 3 ] / l ];

}

function shortestQuat( prev, q ) {

	return prev[ 0 ] * q[ 0 ] + prev[ 1 ] * q[ 1 ] + prev[ 2 ] * q[ 2 ] + prev[ 3 ] * q[ 3 ] < 0 ? q.map( ( v ) => - v ) : q;

}

function clamp01( v ) {

	return Math.min( 1, Math.max( 0, + v || 0 ) );

}

