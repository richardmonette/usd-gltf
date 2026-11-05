// glTF -> USD layer (plus the image files a usdz package needs).
//
// Mapping:
//   nodes            Xform prims with translate / orient / scale ops (time sampled when animated)
//   mesh primitives  Mesh prims (Points / BasisCurves for point and line modes) under the node
//   materials        UsdPreviewSurface networks; glTF data UsdPreviewSurface can't express is kept
//                    as JSON in the material's customData so converting back is lossless
//   skins            a SkelRoot per skin with Skeleton, SkelAnimation and the skinned meshes
//   morph targets    BlendShapes driven by a SkelAnimation
//   animations       time samples; several animations become variants of an "animation" variant set
//   materials variants  a "materialVariant" variant set switching material bindings
//   cameras, KHR_lights_punctual, KHR_node_visibility, EXT_mesh_gpu_instancing (PointInstancer)

import { AssetPath, Layer, ListOp, PrimSpec, PropertySpec } from '../usd/model.js';
import { compose, decompose, identity, invert, multiply } from '../util/math.js';
import { decodeImageAsync, encodePNG, imageMimeType } from '../image/index.js';

const MODES = { POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6 };
const WRAP = { 10497: 'repeat', 33648: 'mirror', 33071: 'clamp' };
const TIME_CODES_PER_SECOND = 60;

// Extensions whose data is fully expressed in USD; anything else on a material is stashed.
const MAPPED_MATERIAL_EXTENSIONS = new Set( [ 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_clearcoat' ] );

function sanitize( name, fallback ) {

	let s = String( name ?? '' ).normalize( 'NFKD' ).replace( /[^A-Za-z0-9_]/g, '_' );
	if ( ! s || ! /[A-Za-z0-9]/.test( s ) ) s = fallback;
	if ( /^[0-9]/.test( s ) ) s = '_' + s;
	return s;

}

class Builder {

	constructor() {

		this.layer = new Layer( 'root.usda' );
		this.paths = new Map(); // PrimSpec -> path

	}

	uniqueName( parent, name ) {

		let n = name, i = 1;
		while ( parent.children.has( n ) || parent.properties.has( n ) ) n = `${ name }_${ i ++ }`;
		return n;

	}

	def( parent, name, typeName = '', specifier = 'def' ) {

		const spec = parent.addChild( new PrimSpec( this.uniqueName( parent, name ), specifier, typeName ) );
		const parentPath = this.paths.get( parent ) ?? '';
		this.paths.set( spec, ( parentPath === '/' ? '' : parentPath ) + '/' + spec.name );
		return spec;

	}

	path( spec ) {

		return this.paths.get( spec );

	}

	attr( prim, name, typeName, value, { interpolation, uniform = false, metadata = {}, timeSamples = null, custom = false } = {} ) {

		const p = prim.addProperty( new PropertySpec( name, 'attribute' ) );
		p.typeName = typeName;
		if ( value !== undefined ) p.default = value;
		if ( timeSamples ) p.timeSamples = timeSamples;
		if ( uniform ) p.variability = 'uniform';
		if ( custom ) p.custom = true;
		if ( interpolation ) p.metadata.interpolation = interpolation;
		Object.assign( p.metadata, metadata );
		return p;

	}

	connect( prim, name, typeName, target ) {

		const p = prim.addProperty( new PropertySpec( name, 'attribute' ) );
		p.typeName = typeName;
		p.connections = ListOp.explicit( [ target ] );
		return p;

	}

	rel( prim, name, targets, metadata = {} ) {

		const p = prim.addProperty( new PropertySpec( name, 'relationship' ) );
		p.targets = ListOp.explicit( targets );
		Object.assign( p.metadata, metadata );
		return p;

	}

	apiSchema( prim, name ) {

		const op = prim.metadata.apiSchemas ||= new ListOp();
		if ( ! op.prepended.includes( name ) ) op.prepended.push( name );

	}

}

export class GLTFToUSD {

	constructor( doc, { log = () => {}, textureDir = 'textures', debug = false, imageDecoder = null } = {} ) {

		this.doc = doc;
		this.json = doc.json;
		this.log = log;
		this.textureDir = textureDir;
		this.imageDecoder = imageDecoder;
		this.debug = debug; // returns the node/primitive -> prim path mapping, for verification
		this.b = new Builder();
		this.files = []; // { name, data } for the package
		this.imageFiles = new Map(); // image index -> path | null
		this.materialPaths = new Map(); // material index (or 'default') -> path
		this.nodePrims = new Map(); // node index -> prim spec
		this.meshPrims = new Map(); // `${node}/${primitive}` -> prim spec
		this.jointNodes = new Set();
		this.timeCodes = new Set();

	}

	async convert() {

		const json = this.json;
		const layer = this.b.layer;
		const sceneIndex = json.scene ?? 0;
		const scene = json.scenes?.[ sceneIndex ] ?? { nodes: ( json.nodes || [] ).map( ( _, i ) => i ).filter( ( i ) => ! ( json.nodes || [] ).some( ( n ) => n.children?.includes( i ) ) ) };

		const needsSkel = ( json.skins || [] ).length > 0 || ( json.meshes || [] ).some( ( m ) => m.primitives.some( ( p ) => p.targets?.length ) );
		this.root = this.b.def( layer.root, sanitize( scene.name, 'root' ), needsSkel ? 'SkelRoot' : 'Xform' );
		this.root.metadata.kind = 'component';
		layer.metadata.defaultPrim = this.root.name;
		layer.metadata.upAxis = 'Y';
		layer.metadata.metersPerUnit = 1;
		layer.metadata.timeCodesPerSecond = TIME_CODES_PER_SECOND;
		layer.metadata.doc = `Converted from glTF by usd-gltf${ json.asset?.generator ? ` (source generator: ${ json.asset.generator })` : '' }`;

		const stash = {};
		if ( json.asset ) stash.asset = json.asset;
		if ( json.extras !== undefined ) stash.extras = json.extras;
		if ( json.extensions?.KHR_xmp_json_ld ) stash.KHR_xmp_json_ld = json.extensions.KHR_xmp_json_ld;
		if ( json.extensions?.KHR_xmp ) stash.KHR_xmp = json.extensions.KHR_xmp;
		layer.metadata.customLayerData = { gltf: { json: JSON.stringify( stash ) } };

		for ( const skin of json.skins || [] ) for ( const j of skin.joints ) this.jointNodes.add( j );

		await this.convertMaterials();

		this.materialScope = this.materialScope ?? null;
		for ( const index of scene.nodes || [] ) this.convertNode( index, this.root );

		this.convertSkins();
		this.convertAnimations();
		this.convertMaterialVariants();

		if ( this.timeCodes.size ) {

			const times = [ ...this.timeCodes ];
			layer.metadata.startTimeCode = Math.min( 0, ...times );
			layer.metadata.endTimeCode = Math.max( ...times );

		}

		const mapping = this.debug ? Object.fromEntries( [ ...this.meshPrims ].map( ( [ key, prim ] ) => [ key, this.b.path( prim ) ] ) ) : null;
		return { layer, files: this.files, mapping };

	}

	// --- materials and textures ---

	async imagePath( index ) {

		if ( this.imageFiles.has( index ) ) return this.imageFiles.get( index );

		const image = this.doc.images[ index ];
		let path = null;

		if ( image?.bytes ) {

			let bytes = image.bytes;
			let mime = imageMimeType( bytes ) || image.mimeType;

			if ( mime !== 'image/png' && mime !== 'image/jpeg' ) {

				// usdz packages may only hold png and jpeg images
				try {

					bytes = encodePNG( await decodeImageAsync( bytes, mime, this.imageDecoder ) );
					mime = 'image/png';

				} catch ( e ) {

					this.log( `image ${ index }: ${ e.message }` );
					bytes = null;

				}

			}

			if ( bytes ) {

				const base = sanitize( image.name || image.uri?.split( '/' ).pop()?.replace( /\.[^.]*$/, '' ), 'image' ) + '_' + index;
				path = `${ this.textureDir }/${ base }.${ mime === 'image/png' ? 'png' : 'jpg' }`;
				this.files.push( { name: path, data: bytes } );

			}

		}

		this.imageFiles.set( index, path );
		return path;

	}

	textureSource( textureIndex ) {

		const texture = this.json.textures?.[ textureIndex ];
		if ( ! texture ) return undefined;
		const ext = texture.extensions || {};
		return ext.KHR_texture_basisu?.source ?? ext.EXT_texture_webp?.source ?? ext.EXT_texture_avif?.source ?? texture.source;

	}

	async convertMaterials() {

		const materials = this.json.materials || [];
		if ( ! materials.length && ! this.needsDefaultMaterial() ) return;

		this.materialScope = this.b.def( this.root, 'Materials', 'Scope' );

		for ( let i = 0; i < materials.length; i ++ ) {

			this.materialPaths.set( i, await this.convertMaterial( materials[ i ], i ) );

		}

	}

	needsDefaultMaterial() {

		return ( this.json.meshes || [] ).some( ( m ) => m.primitives.some( ( p ) => p.material === undefined ) );

	}

	defaultMaterialPath() {

		if ( ! this.materialPaths.has( 'default' ) ) {

			this.materialScope ??= this.b.def( this.root, 'Materials', 'Scope' );
			const m = this.b.def( this.materialScope, 'default', 'Material' );
			const shader = this.b.def( m, 'PreviewSurface', 'Shader' );
			this.b.attr( shader, 'info:id', 'token', 'UsdPreviewSurface', { uniform: true } );
			this.b.attr( shader, 'inputs:diffuseColor', 'color3f', [ 1, 1, 1 ] );
			this.b.attr( shader, 'inputs:metallic', 'float', 1 );
			this.b.attr( shader, 'inputs:roughness', 'float', 1 );
			this.b.attr( shader, 'outputs:surface', 'token' );
			this.b.connect( m, 'outputs:surface', 'token', this.b.path( shader ) + '.outputs:surface' );
			this.materialPaths.set( 'default', this.b.path( m ) );

		}

		return this.materialPaths.get( 'default' );

	}

	async convertMaterial( material, index ) {

		const b = this.b;
		const m = b.def( this.materialScope, sanitize( material.name, 'material' ), 'Material' );
		const mPath = b.path( m );
		const shader = b.def( m, 'PreviewSurface', 'Shader' );
		const sPath = b.path( shader );
		b.attr( shader, 'info:id', 'token', 'UsdPreviewSurface', { uniform: true } );
		b.attr( shader, 'outputs:surface', 'token' );
		b.connect( m, 'outputs:surface', 'token', sPath + '.outputs:surface' );

		const ext = material.extensions || {};
		const pbr = material.pbrMetallicRoughness || {};
		const readers = new Map(); // uv set -> reader path
		const textures = new Map();
		this.shaderInputs = this.shaderInputs || new Map();
		const inputs = {};
		this.shaderInputs.set( index, inputs );

		const uvReader = ( texCoord ) => {

			if ( ! readers.has( texCoord ) ) {

				const r = b.def( m, texCoord ? `uvReader_st${ texCoord }` : 'uvReader_st', 'Shader' );
				b.attr( r, 'info:id', 'token', 'UsdPrimvarReader_float2', { uniform: true } );
				b.attr( r, 'inputs:varname', 'string', texCoord ? `st${ texCoord }` : 'st' );
				b.attr( r, 'outputs:result', 'float2' );
				readers.set( texCoord, b.path( r ) + '.outputs:result' );

			}

			return readers.get( texCoord );

		};

		// A UsdUVTexture for a glTF textureInfo with per channel scale and bias.
		const texture = async ( info, name, { scale = [ 1, 1, 1, 1 ], bias = [ 0, 0, 0, 0 ], colorSpace = 'raw' } = {} ) => {

			const source = this.textureSource( info.index );
			const file = source !== undefined ? await this.imagePath( source ) : null;
			if ( ! file ) return null;

			const transform = info.extensions?.KHR_texture_transform;
			const texCoord = transform?.texCoord ?? info.texCoord ?? 0;
			const key = JSON.stringify( [ file, texCoord, transform, scale, bias, colorSpace, this.json.textures[ info.index ].sampler ] );
			if ( textures.has( key ) ) return textures.get( key );

			const t = b.def( m, name, 'Shader' );
			const tPath = b.path( t );
			b.attr( t, 'info:id', 'token', 'UsdUVTexture', { uniform: true } );
			b.attr( t, 'inputs:file', 'asset', new AssetPath( './' + file ) );
			b.attr( t, 'inputs:sourceColorSpace', 'token', colorSpace );

			let st = uvReader( texCoord );

			if ( transform ) {

				const tr = b.def( m, name + '_transform', 'Shader' );
				const u = usdTextureTransform( transform );
				b.attr( tr, 'info:id', 'token', 'UsdTransform2d', { uniform: true } );
				b.connect( tr, 'inputs:in', 'float2', st );
				b.attr( tr, 'inputs:rotation', 'float', u.rotation );
				b.attr( tr, 'inputs:scale', 'float2', u.scale );
				b.attr( tr, 'inputs:translation', 'float2', u.translation );
				b.attr( tr, 'outputs:result', 'float2' );
				st = b.path( tr ) + '.outputs:result';
				inputs[ `texture:${ info.index }:transform` ] = b.path( tr );

			}

			b.connect( t, 'inputs:st', 'float2', st );

			const sampler = this.json.samplers?.[ this.json.textures[ info.index ].sampler ] || {};
			b.attr( t, 'inputs:wrapS', 'token', WRAP[ sampler.wrapS ?? 10497 ] );
			b.attr( t, 'inputs:wrapT', 'token', WRAP[ sampler.wrapT ?? 10497 ] );
			if ( scale.some( ( v ) => v !== 1 ) ) b.attr( t, 'inputs:scale', 'float4', scale );
			if ( bias.some( ( v ) => v !== 0 ) ) b.attr( t, 'inputs:bias', 'float4', bias );
			for ( const out of [ 'rgb', 'r', 'g', 'b', 'a' ] ) b.attr( t, 'outputs:' + out, out === 'rgb' ? 'float3' : 'float' );

			textures.set( key, tPath );
			return tPath;

		};

		const set = ( name, type, value ) => {

			b.attr( shader, 'inputs:' + name, type, value );
			inputs[ name ] = sPath + '.inputs:' + name;

		};

		const link = ( name, type, texPath, output ) => b.connect( shader, 'inputs:' + name, type, `${ texPath }.outputs:${ output }` );

		// base color and opacity
		const specGloss = ext.KHR_materials_pbrSpecularGlossiness;
		const baseFactor = specGloss ? specGloss.diffuseFactor ?? [ 1, 1, 1, 1 ] : pbr.baseColorFactor ?? [ 1, 1, 1, 1 ];
		const baseInfo = specGloss ? specGloss.diffuseTexture : pbr.baseColorTexture;
		const alphaMode = material.alphaMode || 'OPAQUE';
		const unlit = !! ext.KHR_materials_unlit;
		const baseTex = baseInfo && await texture( baseInfo, 'baseColorTexture', { scale: baseFactor, colorSpace: 'sRGB' } );

		const colorInput = unlit ? 'emissiveColor' : 'diffuseColor';
		if ( baseTex ) link( colorInput, 'color3f', baseTex, 'rgb' );
		else set( colorInput, 'color3f', baseFactor.slice( 0, 3 ) );
		if ( unlit ) set( 'diffuseColor', 'color3f', [ 0, 0, 0 ] );
		inputs.baseColorTexture = baseTex;

		if ( alphaMode !== 'OPAQUE' ) {

			if ( baseTex ) link( 'opacity', 'float', baseTex, 'a' );
			else set( 'opacity', 'float', baseFactor[ 3 ] );
			if ( alphaMode === 'MASK' ) set( 'opacityThreshold', 'float', material.alphaCutoff ?? 0.5 );

		}

		if ( specGloss ) {

			// specular workflow: UsdPreviewSurface supports it directly
			set( 'useSpecularWorkflow', 'int', 1 );
			const sf = specGloss.specularFactor ?? [ 1, 1, 1 ];
			const g = specGloss.glossinessFactor ?? 1;
			const sgTex = specGloss.specularGlossinessTexture && await texture( specGloss.specularGlossinessTexture, 'specularGlossinessTexture', { scale: [ ...sf, - g ], bias: [ 0, 0, 0, 1 ], colorSpace: 'sRGB' } );
			if ( sgTex ) { link( 'specularColor', 'color3f', sgTex, 'rgb' ); link( 'roughness', 'float', sgTex, 'a' ); }
			else { set( 'specularColor', 'color3f', sf ); set( 'roughness', 'float', 1 - g ); }

		} else {

			const metallic = pbr.metallicFactor ?? 1;
			const roughness = pbr.roughnessFactor ?? 1;
			const mrTex = pbr.metallicRoughnessTexture && await texture( pbr.metallicRoughnessTexture, 'metallicRoughnessTexture', { scale: [ 1, roughness, metallic, 1 ] } );
			if ( mrTex ) { link( 'roughness', 'float', mrTex, 'g' ); link( 'metallic', 'float', mrTex, 'b' ); }
			else { set( 'roughness', 'float', roughness ); set( 'metallic', 'float', metallic ); }
			inputs.metallicRoughnessTexture = mrTex;

		}

		if ( ! unlit ) {

			// emissive
			const strength = ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
			const ef = ( material.emissiveFactor ?? [ 0, 0, 0 ] ).map( ( v ) => v * strength );
			const emTex = material.emissiveTexture && ef.some( ( v ) => v > 0 ) && await texture( material.emissiveTexture, 'emissiveTexture', { scale: [ ...ef, 1 ], colorSpace: 'sRGB' } );
			if ( emTex ) link( 'emissiveColor', 'color3f', emTex, 'rgb' );
			else if ( ef.some( ( v ) => v > 0 ) ) set( 'emissiveColor', 'color3f', ef );
			inputs.emissiveTexture = emTex;

			// normal: n = ( tex * 2 - 1 ) * ( s, s, 1 )
			if ( material.normalTexture ) {

				const s = material.normalTexture.scale ?? 1;
				const nTex = await texture( material.normalTexture, 'normalTexture', { scale: [ 2 * s, 2 * s, 2, 1 ], bias: [ - s, - s, - 1, 0 ] } );
				if ( nTex ) link( 'normal', 'normal3f', nTex, 'rgb' );

			}

			// occlusion: lerp( 1, tex, strength )
			if ( material.occlusionTexture ) {

				const s = material.occlusionTexture.strength ?? 1;
				const oTex = await texture( material.occlusionTexture, 'occlusionTexture', { scale: [ s, s, s, 1 ], bias: [ 1 - s, 1 - s, 1 - s, 0 ] } );
				if ( oTex ) link( 'occlusion', 'float', oTex, 'r' );

			}

			const cc = ext.KHR_materials_clearcoat;

			if ( cc && ( cc.clearcoatFactor ?? 0 ) > 0 ) {

				const f = cc.clearcoatFactor ?? 0;
				const ccTex = cc.clearcoatTexture && await texture( cc.clearcoatTexture, 'clearcoatTexture', { scale: [ f, f, f, 1 ] } );
				if ( ccTex ) link( 'clearcoat', 'float', ccTex, 'r' );
				else set( 'clearcoat', 'float', f );

				const r = cc.clearcoatRoughnessFactor ?? 0;
				const ccrTex = cc.clearcoatRoughnessTexture && await texture( cc.clearcoatRoughnessTexture, 'clearcoatRoughnessTexture', { scale: [ r, r, r, 1 ] } );
				if ( ccrTex ) link( 'clearcoatRoughness', 'float', ccrTex, 'g' );
				else set( 'clearcoatRoughness', 'float', r );

			}

			if ( ext.KHR_materials_ior && ext.KHR_materials_ior.ior !== undefined ) set( 'ior', 'float', ext.KHR_materials_ior.ior );

		}

		// keep whatever UsdPreviewSurface can't express, with textures as package paths
		const stash = {};
		for ( const [ key, value ] of Object.entries( ext ) ) if ( ! MAPPED_MATERIAL_EXTENSIONS.has( key ) ) stash[ key ] = await this.stashTextures( value );
		if ( ext.KHR_materials_ior ) stash.KHR_materials_ior = ext.KHR_materials_ior;
		if ( material.extras !== undefined ) stash.extras = material.extras;
		if ( material.doubleSided ) stash.doubleSided = true;
		// blending can't be inferred from an opaque opacity
		if ( alphaMode !== 'OPAQUE' ) { stash.alphaMode = alphaMode; if ( alphaMode === 'MASK' ) stash.alphaCutoff = material.alphaCutoff ?? 0.5; }
		if ( Object.keys( stash ).length ) {

			stash.name = material.name;
			m.metadata.customData = { gltf: { json: JSON.stringify( stash ) } };

		}

		return mPath;

	}

	async stashTextures( value ) {

		if ( Array.isArray( value ) ) return Promise.all( value.map( ( v ) => this.stashTextures( v ) ) );
		if ( ! value || typeof value !== 'object' ) return value;

		const out = {};

		for ( const [ k, v ] of Object.entries( value ) ) {

			if ( /Texture$/.test( k ) && v && typeof v.index === 'number' ) {

				const source = this.textureSource( v.index );
				const path = source !== undefined ? await this.imagePath( source ) : null;
				const sampler = this.json.samplers?.[ this.json.textures[ v.index ].sampler ];
				out[ k ] = { ...v, index: undefined, uri: path, sampler };

			} else {

				out[ k ] = await this.stashTextures( v );

			}

		}

		return out;

	}

	// --- nodes ---

	// Joints are written as Skeleton joints; their Xform is only needed when content hangs below them.
	hasContent( index ) {

		const node = this.json.nodes[ index ];
		if ( node.mesh !== undefined || node.camera !== undefined || node.extensions?.KHR_lights_punctual ) return true;
		return ( node.children || [] ).some( ( c ) => this.hasContent( c ) );

	}

	convertNode( index, parent ) {

		const node = this.json.nodes[ index ];
		const b = this.b;
		if ( this.jointNodes.has( index ) && ! this.hasContent( index ) ) return null;
		const prim = b.def( parent, sanitize( node.name, `node_${ index }` ), 'Xform' );
		this.nodePrims.set( index, prim );
		this.writeTransform( prim, node );

		if ( node.extensions?.KHR_node_visibility?.visible === false ) b.attr( prim, 'visibility', 'token', 'invisible' );
		if ( node.extras !== undefined ) prim.metadata.customData = { gltf: { extras: JSON.stringify( node.extras ) } };

		if ( node.mesh !== undefined ) this.convertMeshInstance( index, prim );
		if ( node.camera !== undefined ) this.convertCamera( node.camera, prim );

		const light = node.extensions?.KHR_lights_punctual?.light;
		if ( light !== undefined ) this.convertLight( light, prim );

		for ( const child of node.children || [] ) this.convertNode( child, prim );

		return prim;

	}

	writeTransform( prim, node ) {

		const b = this.b;
		let t = node.translation, r = node.rotation, s = node.scale;

		if ( node.matrix ) {

			const d = decompose( node.matrix );
			const back = compose( d.t, d.r, d.s );
			const exact = back.every( ( v, i ) => Math.abs( v - node.matrix[ i ] ) <= 1e-6 * ( 1 + Math.abs( node.matrix[ i ] ) ) );

			if ( ! exact ) {

				b.attr( prim, 'xformOp:transform', 'matrix4d', Array.from( node.matrix ) );
				b.attr( prim, 'xformOpOrder', 'token[]', [ 'xformOp:transform' ], { uniform: true } );
				return;

			}

			t = d.t; r = d.r; s = d.s;

		}

		const order = [];
		if ( t && t.some( ( v ) => v !== 0 ) ) { b.attr( prim, 'xformOp:translate', 'double3', Array.from( t ) ); order.push( 'xformOp:translate' ); }
		if ( r && ( r[ 0 ] || r[ 1 ] || r[ 2 ] || r[ 3 ] !== 1 ) ) { b.attr( prim, 'xformOp:orient', 'quatf', Array.from( r ) ); order.push( 'xformOp:orient' ); }
		if ( s && s.some( ( v ) => v !== 1 ) ) { b.attr( prim, 'xformOp:scale', 'float3', Array.from( s ) ); order.push( 'xformOp:scale' ); }
		if ( order.length ) b.attr( prim, 'xformOpOrder', 'token[]', order, { uniform: true } );

	}

	// Ensures a node prim has a given op (for animation), keeping translate, orient, scale order.
	ensureOp( prim, path ) {

		const op = { translation: 'xformOp:translate', rotation: 'xformOp:orient', scale: 'xformOp:scale' }[ path ];
		const order = prim.properties.get( 'xformOpOrder' );

		if ( order && order.default.includes( 'xformOp:transform' ) ) {

			// a sheared matrix node that is also animated: fall back to TRS
			const m = prim.properties.get( 'xformOp:transform' ).default;
			prim.properties.delete( 'xformOp:transform' );
			prim.properties.delete( 'xformOpOrder' );
			const d = decompose( m );
			this.writeTransform( prim, { translation: d.t, rotation: d.r, scale: d.s } );
			return this.ensureOp( prim, path );

		}

		if ( ! prim.properties.has( op ) ) {

			const fallback = { translation: [ 0, 0, 0 ], rotation: [ 0, 0, 0, 1 ], scale: [ 1, 1, 1 ] }[ path ];
			this.b.attr( prim, op, { translation: 'double3', rotation: 'quatf', scale: 'float3' }[ path ], fallback );
			const ops = [ 'xformOp:translate', 'xformOp:orient', 'xformOp:scale' ].filter( ( o ) => prim.properties.has( o ) );
			prim.properties.delete( 'xformOpOrder' );
			this.b.attr( prim, 'xformOpOrder', 'token[]', ops, { uniform: true } );

		}

		return prim.properties.get( op );

	}

	// --- meshes ---

	convertMeshInstance( nodeIndex, prim ) {

		const node = this.json.nodes[ nodeIndex ];
		const mesh = this.json.meshes[ node.mesh ];
		const skinned = node.skin !== undefined;
		const instancing = node.extensions?.EXT_mesh_gpu_instancing;

		mesh.primitives.forEach( ( primitive, p ) => {

			const name = sanitize( mesh.primitives.length > 1 ? `${ mesh.name || 'mesh' }_${ p }` : mesh.name, `mesh_${ node.mesh }` );

			if ( instancing && ! skinned ) {

				this.convertInstancer( prim, name, primitive, instancing, nodeIndex, p );
				return;

			}

			const meshPrim = this.convertPrimitive( prim, name, primitive, { nodeIndex, joints: skinned } );
			if ( ! meshPrim ) return;
			this.meshPrims.set( `${ nodeIndex }/${ p }`, meshPrim );

			// skins are bound once skeletons exist; morph only meshes get a rigid one joint skeleton
			if ( skinned ) ( this.pendingSkinned ||= [] ).push( { nodeIndex, primitive, p, meshPrim } );
			else if ( primitive.targets?.length ) this.addMorphSkeleton( prim, meshPrim, nodeIndex, primitive );

		} );

	}

	/**
	 * Writes one glTF primitive as a Mesh, Points or BasisCurves prim.
	 */
	convertPrimitive( parent, name, primitive, { nodeIndex, joints = null } = {} ) {

		const doc = this.doc;
		const b = this.b;
		const attrs = primitive.attributes;
		if ( attrs.POSITION === undefined ) return null;

		const mode = primitive.mode ?? MODES.TRIANGLES;
		const positions = doc.getFloats( attrs.POSITION ).array;
		const count = positions.length / 3;
		let indices = primitive.indices !== undefined ? doc.getAccessor( primitive.indices ).array : null;
		if ( ! indices ) indices = Uint32Array.from( { length: count }, ( _, i ) => i );

		if ( mode === MODES.POINTS ) {

			const prim = b.def( parent, name, 'Points' );
			const used = primitive.indices !== undefined ? Float32Array.from( Array.from( indices ).flatMap( ( i ) => [ positions[ i * 3 ], positions[ i * 3 + 1 ], positions[ i * 3 + 2 ] ] ) ) : positions;
			b.attr( prim, 'points', 'point3f[]', used );
			b.attr( prim, 'widths', 'float[]', Float32Array.of( 0.01 ), { interpolation: 'constant' } );
			b.attr( prim, 'extent', 'float3[]', extent( used ) );
			this.writeColors( prim, attrs, primitive.indices !== undefined ? indices : null, 'vertex' );
			this.bindMaterial( prim, primitive.material );
			return prim;

		}

		if ( mode === MODES.LINES || mode === MODES.LINE_STRIP || mode === MODES.LINE_LOOP ) {

			const prim = b.def( parent, name, 'BasisCurves' );
			b.attr( prim, 'type', 'token', 'linear', { uniform: true } );
			let verts;
			let counts;

			if ( mode === MODES.LINES ) {

				verts = Array.from( indices );
				counts = new Int32Array( indices.length / 2 ).fill( 2 );

			} else {

				verts = Array.from( indices );
				if ( mode === MODES.LINE_LOOP ) verts.push( indices[ 0 ] );
				counts = Int32Array.of( verts.length );

			}

			const pts = Float32Array.from( verts.flatMap( ( i ) => [ positions[ i * 3 ], positions[ i * 3 + 1 ], positions[ i * 3 + 2 ] ] ) );
			b.attr( prim, 'points', 'point3f[]', pts );
			b.attr( prim, 'curveVertexCounts', 'int[]', counts );
			b.attr( prim, 'widths', 'float[]', Float32Array.of( 0.01 ), { interpolation: 'constant' } );
			b.attr( prim, 'extent', 'float3[]', extent( pts ) );
			this.writeColors( prim, attrs, Uint32Array.from( verts ), 'vertex' );
			this.bindMaterial( prim, primitive.material );
			return prim;

		}

		// triangles; strips and fans are expanded
		let tris = indices;

		if ( mode === MODES.TRIANGLE_STRIP ) {

			const out = [];
			for ( let i = 0; i + 2 < indices.length; i ++ ) {

				if ( i % 2 === 0 ) out.push( indices[ i ], indices[ i + 1 ], indices[ i + 2 ] );
				else out.push( indices[ i + 1 ], indices[ i ], indices[ i + 2 ] );

			}

			tris = Uint32Array.from( out );

		} else if ( mode === MODES.TRIANGLE_FAN ) {

			const out = [];
			for ( let i = 1; i + 1 < indices.length; i ++ ) out.push( indices[ 0 ], indices[ i ], indices[ i + 1 ] );
			tris = Uint32Array.from( out );

		}

		tris = tris.subarray( 0, tris.length - ( tris.length % 3 ) );
		const prim = b.def( parent, name, 'Mesh' );
		b.attr( prim, 'points', 'point3f[]', positions );
		b.attr( prim, 'faceVertexCounts', 'int[]', new Int32Array( tris.length / 3 ).fill( 3 ) );
		b.attr( prim, 'faceVertexIndices', 'int[]', Int32Array.from( tris ) );
		b.attr( prim, 'extent', 'float3[]', extent( positions ) );
		b.attr( prim, 'subdivisionScheme', 'token', 'none', { uniform: true } );

		if ( attrs.NORMAL !== undefined ) b.attr( prim, 'normals', 'normal3f[]', doc.getFloats( attrs.NORMAL ).array, { interpolation: 'vertex' } );

		for ( let i = 0; attrs[ 'TEXCOORD_' + i ] !== undefined; i ++ ) {

			const uv = doc.getFloats( attrs[ 'TEXCOORD_' + i ] ).array;
			const st = new Float32Array( uv.length );
			for ( let k = 0; k < uv.length; k += 2 ) { st[ k ] = uv[ k ]; st[ k + 1 ] = 1 - uv[ k + 1 ]; }
			b.attr( prim, i ? `primvars:st${ i }` : 'primvars:st', 'texCoord2f[]', st, { interpolation: 'vertex' } );

		}

		if ( attrs.TANGENT !== undefined ) b.attr( prim, 'primvars:tangents', 'float4[]', doc.getFloats( attrs.TANGENT ).array, { interpolation: 'vertex' } );

		this.writeColors( prim, attrs, null, 'vertex' );
		if ( attrs.COLOR_0 !== undefined ) gltfData( prim ).color0 = true;

		const material = primitive.material !== undefined ? this.json.materials[ primitive.material ] : null;
		if ( material?.doubleSided ) b.attr( prim, 'doubleSided', 'bool', true, { uniform: true } );
		this.bindMaterial( prim, primitive.material );

		if ( joints ) this.writeSkinWeights( prim, attrs, joints );

		void nodeIndex;
		return prim;

	}

	writeColors( prim, attrs, indices, interpolation ) {

		if ( attrs.COLOR_0 === undefined ) return;
		const c = this.doc.getFloats( attrs.COLOR_0 );
		const n = indices ? indices.length : c.count;
		const rgb = new Float32Array( n * 3 );
		const alpha = c.itemSize === 4 ? new Float32Array( n ) : null;

		for ( let i = 0; i < n; i ++ ) {

			const v = indices ? indices[ i ] : i;
			rgb[ i * 3 ] = c.array[ v * c.itemSize ];
			rgb[ i * 3 + 1 ] = c.array[ v * c.itemSize + 1 ];
			rgb[ i * 3 + 2 ] = c.array[ v * c.itemSize + 2 ];
			if ( alpha ) alpha[ i ] = c.array[ v * 4 + 3 ];

		}

		// glTF vertex colors are linear and multiply base color; UsdPreviewSurface reads displayColor through a primvar reader
		this.b.attr( prim, 'primvars:displayColor', 'color3f[]', rgb, { interpolation } );
		if ( alpha && alpha.some( ( a ) => a !== 1 ) ) this.b.attr( prim, 'primvars:displayOpacity', 'float[]', alpha, { interpolation } );

	}

	bindMaterial( prim, materialIndex ) {

		const path = materialIndex !== undefined ? this.materialPaths.get( materialIndex ) : this.defaultMaterialPath();
		if ( ! path ) return;
		this.b.apiSchema( prim, 'MaterialBindingAPI' );
		this.b.rel( prim, 'material:binding', [ path ] );

	}

	convertInstancer( parent, name, primitive, instancing, nodeIndex, p ) {

		const b = this.b;
		const inst = b.def( parent, name + '_instances', 'PointInstancer' );
		const protos = b.def( inst, 'Prototypes', 'Scope' );
		const proto = this.convertPrimitive( protos, name, primitive, { nodeIndex } );
		if ( ! proto ) return;
		this.meshPrims.set( `${ nodeIndex }/${ p }`, proto );

		const a = instancing.attributes || {};
		const t = a.TRANSLATION !== undefined ? this.doc.getFloats( a.TRANSLATION ) : null;
		const r = a.ROTATION !== undefined ? this.doc.getFloats( a.ROTATION ) : null;
		const s = a.SCALE !== undefined ? this.doc.getFloats( a.SCALE ) : null;
		const n = ( t || r || s ).count;

		b.rel( inst, 'prototypes', [ b.path( proto ) ] );
		b.attr( inst, 'protoIndices', 'int[]', new Int32Array( n ) );
		b.attr( inst, 'positions', 'point3f[]', t ? t.array : new Float32Array( n * 3 ) );
		if ( r ) b.attr( inst, 'orientations', 'quath[]', Float32Array.from( r.array ) );
		if ( s ) b.attr( inst, 'scales', 'float3[]', s.array );

	}

	// --- skins and morph targets ---

	writeSkinWeights( prim, attrs, joints ) {

		const sets = [];
		for ( let s = 0; attrs[ 'JOINTS_' + s ] !== undefined; s ++ ) sets.push( [ this.doc.getAccessor( attrs[ 'JOINTS_' + s ], { normalize: false } ).array, this.doc.getFloats( attrs[ 'WEIGHTS_' + s ] ).array ] );
		if ( ! sets.length ) return;

		const n = sets[ 0 ][ 0 ].length / 4;
		const es = sets.length * 4;
		const idx = new Int32Array( n * es );
		const w = new Float32Array( n * es );

		for ( let v = 0; v < n; v ++ ) {

			let sum = 0;
			sets.forEach( ( [ , ws ] ) => { for ( let k = 0; k < 4; k ++ ) sum += ws[ v * 4 + k ]; } );

			sets.forEach( ( [ js, ws ], s ) => {

				for ( let k = 0; k < 4; k ++ ) {

					idx[ v * es + s * 4 + k ] = js[ v * 4 + k ];
					w[ v * es + s * 4 + k ] = sum > 0 ? ws[ v * 4 + k ] / sum : 0;

				}

			} );

		}

		this.b.apiSchema( prim, 'SkelBindingAPI' );
		this.b.attr( prim, 'primvars:skel:jointIndices', 'int[]', idx, { interpolation: 'vertex', metadata: { elementSize: es } } );
		this.b.attr( prim, 'primvars:skel:jointWeights', 'float[]', w, { interpolation: 'vertex', metadata: { elementSize: es } } );
		this.b.attr( prim, 'primvars:skel:geomBindTransform', 'matrix4d', identity() );
		void joints;

	}

	writeBlendShapes( meshPrim, primitive, names ) {

		const b = this.b;
		const targets = [];
		const shapeNames = [];

		primitive.targets.forEach( ( target, i ) => {

			const name = sanitize( names?.[ i ], `target_${ i }` );
			const shape = b.def( meshPrim, name, 'BlendShape' );
			const count = this.doc.json.accessors[ primitive.attributes.POSITION ].count;
			b.attr( shape, 'offsets', 'vector3f[]', target.POSITION !== undefined ? this.doc.getFloats( target.POSITION ).array : new Float32Array( count * 3 ), { uniform: true } );
			if ( target.NORMAL !== undefined ) b.attr( shape, 'normalOffsets', 'vector3f[]', this.doc.getFloats( target.NORMAL ).array, { uniform: true } );
			targets.push( b.path( shape ) );
			shapeNames.push( shape.name );

		} );

		b.apiSchema( meshPrim, 'SkelBindingAPI' );
		b.attr( meshPrim, 'skel:blendShapes', 'token[]', shapeNames, { uniform: true } );
		b.rel( meshPrim, 'skel:blendShapeTargets', targets );
		return shapeNames;

	}

	// UsdSkel only applies blend shapes through a skeleton binding, so a non-skinned mesh with morph
	// targets gets a one joint skeleton beside it that binds it rigidly in place.
	addMorphSkeleton( parent, meshPrim, nodeIndex, primitive ) {

		const b = this.b;
		const mesh = this.json.meshes[ this.json.nodes[ nodeIndex ].mesh ];
		const names = this.writeBlendShapes( meshPrim, primitive, mesh.extras?.targetNames );
		const skel = b.def( parent, meshPrim.name + '_skeleton', 'Skeleton' );
		skel.metadata.customData = { gltf: { morphOnly: true } };
		b.attr( skel, 'joints', 'token[]', [ 'root' ], { uniform: true } );
		b.attr( skel, 'bindTransforms', 'matrix4d[]', Float64Array.from( identity() ), { uniform: true } );
		b.attr( skel, 'restTransforms', 'matrix4d[]', Float64Array.from( identity() ), { uniform: true } );
		b.attr( meshPrim, 'primvars:skel:jointIndices', 'int[]', Int32Array.of( 0 ), { interpolation: 'constant', metadata: { elementSize: 1 } } );
		b.attr( meshPrim, 'primvars:skel:jointWeights', 'float[]', Float32Array.of( 1 ), { interpolation: 'constant', metadata: { elementSize: 1 } } );
		b.attr( meshPrim, 'primvars:skel:geomBindTransform', 'matrix4d', identity() );
		const anim = b.def( skel, 'Animation', 'SkelAnimation' );
		b.attr( anim, 'blendShapes', 'token[]', names, { uniform: true } );
		const weights = this.json.nodes[ nodeIndex ].weights ?? mesh.weights ?? new Array( names.length ).fill( 0 );
		b.attr( anim, 'blendShapeWeights', 'float[]', Float32Array.from( names, ( _, i ) => weights[ i ] ?? 0 ) );
		b.apiSchema( skel, 'SkelBindingAPI' );
		b.rel( skel, 'skel:animationSource', [ b.path( anim ) ] );
		b.apiSchema( meshPrim, 'SkelBindingAPI' );
		b.rel( meshPrim, 'skel:skeleton', [ b.path( skel ) ] );
		( this.morphAnimations ||= new Map() ).set( nodeIndex, ( this.morphAnimations.get( nodeIndex ) || [] ).concat( [ anim ] ) );

	}

	convertSkins() {

		const json = this.json;
		const b = this.b;
		this.skinInfo = [];

		( json.skins || [] ).forEach( ( skin, s ) => {

			const pending = ( this.pendingSkinned || [] ).filter( ( e ) => json.nodes[ e.nodeIndex ].skin === s );
			if ( ! pending.length && ! skin.joints.length ) return;

			const jointSet = new Set( skin.joints );
			const parents = new Map();
			json.nodes.forEach( ( n, i ) => ( n.children || [] ).forEach( ( c ) => parents.set( c, i ) ) );

			// the skeleton sits under the nearest written node above all root joints, so joint
			// transforms stay plain node transforms (root joints fold in any skipped nodes between)
			const roots = skin.joints.filter( ( j ) => jointParent( j, parents, jointSet ) === null );
			const ancestors = ( j ) => { const a = []; for ( let p = parents.get( j ); p !== undefined; p = parents.get( p ) ) a.push( p ); return a; };
			let base = null;
			for ( const candidate of ancestors( roots[ 0 ] ) ) {

				if ( this.nodePrims.has( candidate ) && roots.every( ( r ) => ancestors( r ).includes( candidate ) ) ) { base = candidate; break; }

			}

			const skel = b.def( base !== null ? this.nodePrims.get( base ) : this.root, sanitize( skin.name, `skeleton_${ s }` ), 'Skeleton' );

			// joint paths: names along joint ancestry, unique among siblings
			const tokens = [];
			const used = new Set();
			const tokenOf = new Map();
			const order = orderJoints( skin.joints, parents, jointSet );

			for ( const j of order ) {

				const parent = jointParent( j, parents, jointSet );
				const prefix = parent !== null ? tokenOf.get( parent ) + '/' : '';
				let name = sanitize( json.nodes[ j ].name, `joint_${ j }` );
				let token = prefix + name;
				for ( let k = 1; used.has( token ); k ++ ) token = prefix + name + '_' + k;
				used.add( token );
				tokenOf.set( j, token );
				tokens.push( token );

			}

			// joint index in the skin -> index in the ordered skeleton
			const remap = skin.joints.map( ( j ) => order.indexOf( j ) );
			const ibm = skin.inverseBindMatrices !== undefined ? this.doc.getFloats( skin.inverseBindMatrices ).array : null;
			const bind = new Float64Array( order.length * 16 );
			skin.joints.forEach( ( j, k ) => bind.set( ibm ? invert( Array.from( ibm.subarray( k * 16, k * 16 + 16 ) ) ) : identity(), remap[ k ] * 16 ) );

			const info = { skin: s, order, parents, jointSet, base, blendNames: [] };
			const rest = new Float64Array( order.length * 16 );
			order.forEach( ( j, k ) => rest.set( this.jointLocal( j, info, 0, null ), k * 16 ) );

			b.attr( skel, 'joints', 'token[]', tokens, { uniform: true } );
			b.attr( skel, 'bindTransforms', 'matrix4d[]', bind, { uniform: true } );
			b.attr( skel, 'restTransforms', 'matrix4d[]', rest, { uniform: true } );

			const anim = b.def( skel, 'Animation', 'SkelAnimation' );
			b.attr( anim, 'joints', 'token[]', tokens, { uniform: true } );
			b.apiSchema( skel, 'SkelBindingAPI' );
			b.rel( skel, 'skel:animationSource', [ b.path( anim ) ] );

			const blendNames = info.blendNames;
			info.anim = anim;

			for ( const { meshPrim, nodeIndex, primitive } of pending ) {

				// remap joint indices into skeleton order
				const ji = meshPrim.properties.get( 'primvars:skel:jointIndices' );
				if ( ji ) for ( let i = 0; i < ji.default.length; i ++ ) ji.default[ i ] = remap[ ji.default[ i ] ] ?? 0;
				b.rel( meshPrim, 'skel:skeleton', [ b.path( skel ) ] );

				if ( primitive.targets?.length ) {

					const mesh = json.meshes[ json.nodes[ nodeIndex ].mesh ];
					const names = this.writeBlendShapes( meshPrim, primitive, mesh.extras?.targetNames );
					for ( const n of names ) if ( ! blendNames.includes( n ) ) blendNames.push( n );
					( this.skinnedMorphs ||= [] ).push( { nodeIndex, names, anim } );

				}

			}

			if ( blendNames.length ) {

				b.attr( anim, 'blendShapes', 'token[]', blendNames, { uniform: true } );
				const weights = new Float32Array( blendNames.length );
				for ( const m of this.skinnedMorphs.filter( ( x ) => x.anim === anim ) ) {

					const node = json.nodes[ m.nodeIndex ];
					const w = node.weights ?? json.meshes[ node.mesh ].weights ?? [];
					m.names.forEach( ( n, i ) => { weights[ blendNames.indexOf( n ) ] = w[ i ] ?? 0; } );

				}

				b.attr( anim, 'blendShapeWeights', 'float[]', weights );

			}

			this.skinInfo.push( info );

		} );

	}

	// Local transform of a node at a time in an animation (null = rest pose).
	nodeLocal( index, time, animation ) {

		const node = this.json.nodes[ index ];
		let t = node.translation || [ 0, 0, 0 ], r = node.rotation || [ 0, 0, 0, 1 ], s = node.scale || [ 1, 1, 1 ];

		if ( node.matrix ) {

			const d = decompose( node.matrix );
			t = d.t; r = d.r; s = d.s;

		}

		if ( animation ) {

			for ( const c of animation.channels ) {

				if ( c.node !== index ) continue;
				const v = sampleTrack( c, time );
				if ( c.path === 'translation' ) t = v;
				else if ( c.path === 'rotation' ) r = v;
				else if ( c.path === 'scale' ) s = v;

			}

		}

		if ( node.matrix && ! animation?.channels.some( ( c ) => c.node === index ) ) return Array.from( node.matrix );
		return compose( t, r, s );

	}

	// Joint transform relative to its parent joint, or to the skeleton's node for root joints.
	// Nodes in between that aren't written (joints without content) are folded in.
	jointLocal( j, info, time, animation ) {

		const parent = jointParent( j, info.parents, info.jointSet );
		const stop = parent !== null ? parent : info.base;
		let m = this.nodeLocal( j, time, animation );
		for ( let p = info.parents.get( j ); p !== undefined && p !== stop; p = info.parents.get( p ) ) m = multiply( this.nodeLocal( p, time, animation ), m );
		return m;

	}

	// --- cameras and lights ---

	convertCamera( index, parent ) {

		const camera = this.json.cameras[ index ];
		const b = this.b;
		const prim = b.def( parent, sanitize( camera.name, `camera_${ index }` ), 'Camera' );

		if ( camera.type === 'orthographic' ) {

			const o = camera.orthographic;
			b.attr( prim, 'projection', 'token', 'orthographic' );
			b.attr( prim, 'horizontalAperture', 'float', o.xmag * 20 );
			b.attr( prim, 'verticalAperture', 'float', o.ymag * 20 );
			b.attr( prim, 'clippingRange', 'float2', [ o.znear, o.zfar ] );

		} else {

			const p = camera.perspective;
			const focal = 50;
			const v = 2 * focal * Math.tan( p.yfov / 2 );
			b.attr( prim, 'projection', 'token', 'perspective' );
			b.attr( prim, 'focalLength', 'float', focal );
			b.attr( prim, 'verticalAperture', 'float', v );
			b.attr( prim, 'horizontalAperture', 'float', v * ( p.aspectRatio ?? 1 ) );
			b.attr( prim, 'clippingRange', 'float2', [ p.znear, p.zfar ?? 1e6 ] );
			if ( p.aspectRatio === undefined ) prim.metadata.customData = { gltf: { json: JSON.stringify( { aspectRatio: null } ) } };

		}

	}

	convertLight( index, parent ) {

		const light = this.json.extensions.KHR_lights_punctual.lights[ index ];
		const b = this.b;
		const type = light.type === 'directional' ? 'DistantLight' : 'SphereLight';
		const prim = b.def( parent, sanitize( light.name, `light_${ index }` ), type );
		b.attr( prim, 'inputs:intensity', 'float', light.intensity ?? 1 );
		b.attr( prim, 'inputs:color', 'color3f', light.color ?? [ 1, 1, 1 ] );

		if ( type === 'SphereLight' ) {

			b.attr( prim, 'inputs:radius', 'float', 0 );
			b.attr( prim, 'treatAsPoint', 'bool', true );

		}

		if ( light.type === 'spot' ) {

			const outer = light.spot?.outerConeAngle ?? Math.PI / 4;
			const inner = light.spot?.innerConeAngle ?? 0;
			b.apiSchema( prim, 'ShapingAPI' );
			b.attr( prim, 'inputs:shaping:cone:angle', 'float', outer * 180 / Math.PI );
			b.attr( prim, 'inputs:shaping:cone:softness', 'float', outer > 0 ? 1 - inner / outer : 0 );

		}

		if ( light.range !== undefined ) prim.metadata.customData = { gltf: { json: JSON.stringify( { range: light.range } ) } };
		( this.lightPrims ||= new Map() ).set( index, prim );

	}

	// --- animation ---

	tracks( animation ) {

		const doc = this.doc;
		return animation.channels.map( ( channel ) => {

			const sampler = animation.samplers[ channel.sampler ];
			let target = channel.target;
			let pointer = target.extensions?.KHR_animation_pointer?.pointer;

			if ( pointer ) {

				const m = /^\/nodes\/(\d+)\/(translation|rotation|scale|weights)$/.exec( pointer );
				if ( m ) { target = { node: + m[ 1 ], path: m[ 2 ] }; pointer = null; }

			}

			const input = doc.getAccessor( sampler.input ).array;
			const output = doc.getFloats( sampler.output );
			const interpolation = sampler.interpolation || 'LINEAR';
			// weights are scalar accessors holding one value per morph target per key
			const width = target.path === 'weights' ? output.array.length / input.length / ( interpolation === 'CUBICSPLINE' ? 3 : 1 ) : output.itemSize;
			return { node: target.node, path: pointer ? 'pointer' : target.path, pointer, input, output: output.array, width, interpolation };

		} ).filter( ( c ) => c.input.length );

	}

	convertAnimations() {

		const animations = this.json.animations || [];
		if ( ! animations.length ) return;

		const b = this.b;
		this.animTracks = animations.map( ( a ) => ( { channels: this.tracks( a ) } ) );
		const multiple = animations.length > 1;
		let variantSet = null;

		if ( multiple ) {

			variantSet = new Map();
			this.root.variantSets.set( 'animation', variantSet );
			this.root.metadata.variantSetNames = new ListOp( { prepended: [ 'animation' ] } );

		}

		const names = [];

		animations.forEach( ( animation, a ) => {

			let name = sanitize( animation.name, `animation_${ a }` );
			while ( names.includes( name ) ) name += '_';
			names.push( name );

			// with several animations, each writes its samples into overs inside its variant
			const target = multiple ? new PrimSpec( name, 'over', '' ) : null;
			if ( target ) variantSet.set( name, target );
			const specFor = ( prim ) => target ? this.overFor( target, prim ) : prim;

			this.writeAnimation( this.animTracks[ a ], specFor, a );

		} );

		if ( multiple ) {

			this.root.metadata.variants = { ...this.root.metadata.variants, animation: names[ 0 ] };
			this.moveDefaultsIntoVariants( variantSet );

		}

		void b;

	}

	// Local opinions are stronger than variant opinions, so a value authored on the prim itself would
	// hide the time samples inside the variants. Defaults of anything a variant animates move into
	// every variant instead.
	moveDefaultsIntoVariants( variantSet ) {

		const animated = new Map(); // path below the root -> Set of property names

		const collect = ( spec, path ) => {

			for ( const prop of spec.properties.values() ) if ( prop.timeSamples || prop.targets ) ( animated.get( path ) || animated.set( path, new Set() ).get( path ) ).add( prop.name );
			for ( const child of spec.children.values() ) collect( child, path + '/' + child.name );

		};

		for ( const variant of variantSet.values() ) collect( variant, '' );

		for ( const [ path, names ] of animated ) {

			const local = this.findSpec( this.b.path( this.root ) + path );
			if ( ! local ) continue;

			for ( const name of names ) {

				const prop = local.properties.get( name );
				if ( ! prop ) continue;
				const value = prop.type === 'relationship' ? prop.targets : prop.default;
				if ( value === undefined || value === null ) continue;

				for ( const variant of variantSet.values() ) {

					let spec = variant;
					for ( const part of path.split( '/' ).filter( Boolean ) ) spec = spec.children.get( part ) ?? spec.addChild( new PrimSpec( part, 'over', '' ) );
					let own = spec.properties.get( name );
					if ( ! own ) {

						own = spec.addProperty( new PropertySpec( name, prop.type ) );
						own.typeName = prop.typeName;

					}

					if ( prop.type === 'relationship' ) { if ( ! own.targets ) own.targets = value; }
					else if ( ! own.timeSamples && own.default === undefined ) own.default = value;

				}

				if ( prop.type === 'relationship' ) local.properties.delete( name );
				else prop.default = undefined;

			}

		}

	}

	// The over inside a variant mirroring a prim's path below the root.
	overFor( variant, prim ) {

		const path = this.b.path( prim );
		const rootPath = this.b.path( this.root );
		const parts = path.slice( rootPath.length + 1 ).split( '/' ).filter( Boolean );
		let spec = variant;
		for ( const part of parts ) spec = spec.children.get( part ) ?? spec.addChild( new PrimSpec( part, 'over', '' ) );
		return spec;

	}

	writeAnimation( anim, specFor, animationIndex ) {

		const b = this.b;
		const json = this.json;

		// node transforms
		for ( const track of anim.channels ) {

			if ( track.path === 'pointer' ) {

				this.writePointerTrack( track, specFor );
				continue;

			}

			if ( track.path === 'weights' ) continue;
			const prim = this.nodePrims.get( track.node );
			if ( ! prim || this.jointNodes.has( track.node ) && ! this.nodePrims.has( track.node ) ) continue;

			const op = this.ensureOp( prim, track.path );
			const spec = specFor( prim );
			const prop = spec === prim ? op : spec.properties.get( op.name ) ?? spec.addProperty( Object.assign( new PropertySpec( op.name ), { typeName: op.typeName } ) );
			prop.timeSamples = this.sampleTrack( track );

		}

		// skeletons: joints relative to their parent joint (root joints relative to the scene)
		for ( const info of this.skinInfo || [] ) {

			const affected = anim.channels.some( ( c ) => c.node !== undefined && ( info.jointSet.has( c.node ) || this.isAncestorOfJoint( c.node, info ) ) );
			const morphs = ( this.skinnedMorphs || [] ).filter( ( m ) => m.anim === info.anim );
			const weightTracks = anim.channels.filter( ( c ) => c.path === 'weights' && morphs.some( ( m ) => m.nodeIndex === c.node ) );
			if ( ! affected && ! weightTracks.length ) continue;

			const spec = specFor( info.anim );

			if ( affected ) {

				const times = this.trackTimes( anim.channels.filter( ( c ) => c.node !== undefined && c.path !== 'weights' ) );
				const translations = new Map(), rotations = new Map(), scales = new Map();
				const prev = new Map();

				for ( const t of times ) {

					const tr = new Float32Array( info.order.length * 3 ), ro = new Float32Array( info.order.length * 4 ), sc = new Float32Array( info.order.length * 3 );

					info.order.forEach( ( j, k ) => {

						const d = decompose( this.jointLocal( j, info, t, anim ) );
						const p = prev.get( k );
						if ( p && p[ 0 ] * d.r[ 0 ] + p[ 1 ] * d.r[ 1 ] + p[ 2 ] * d.r[ 2 ] + p[ 3 ] * d.r[ 3 ] < 0 ) d.r = d.r.map( ( v ) => - v );
						prev.set( k, d.r );
						tr.set( d.t, k * 3 ); ro.set( d.r, k * 4 ); sc.set( d.s, k * 3 );

					} );

					const code = t * TIME_CODES_PER_SECOND;
					this.timeCodes.add( code );
					translations.set( code, tr ); rotations.set( code, ro ); scales.set( code, sc );

				}

				setSamples( spec, 'translations', 'float3[]', translations );
				setSamples( spec, 'rotations', 'quatf[]', rotations );
				setSamples( spec, 'scales', 'half3[]', scales );

			}

			if ( weightTracks.length ) {

				const times = this.trackTimes( weightTracks );
				const samples = new Map();

				for ( const t of times ) {

					const w = new Float32Array( info.blendNames.length );
					for ( const m of morphs ) {

						const track = weightTracks.find( ( c ) => c.node === m.nodeIndex );
						const node = json.nodes[ m.nodeIndex ];
						const values = track ? sampleTrack( track, t ) : node.weights ?? json.meshes[ node.mesh ].weights ?? [];
						m.names.forEach( ( n, i ) => { w[ info.blendNames.indexOf( n ) ] = values[ i ] ?? 0; } );

					}

					samples.set( t * TIME_CODES_PER_SECOND, w );
					this.timeCodes.add( t * TIME_CODES_PER_SECOND );

				}

				setSamples( spec, 'blendShapeWeights', 'float[]', samples );

			}

		}

		// morph weights of non skinned meshes
		for ( const track of anim.channels.filter( ( c ) => c.path === 'weights' ) ) {

			for ( const animPrim of this.morphAnimations?.get( track.node ) || [] ) {

				const samples = new Map();
				for ( const t of this.trackTimes( [ track ] ) ) {

					samples.set( t * TIME_CODES_PER_SECOND, Float32Array.from( sampleTrack( track, t ) ) );
					this.timeCodes.add( t * TIME_CODES_PER_SECOND );

				}

				setSamples( specFor( animPrim ), 'blendShapeWeights', 'float[]', samples );

			}

		}

		void b; void animationIndex;

	}

	isAncestorOfJoint( node, info ) {

		for ( const j of info.order ) for ( let p = info.parents.get( j ); p !== undefined; p = info.parents.get( p ) ) if ( p === node ) return true;
		return false;

	}

	// Key times for a set of tracks, densified for cubic and step interpolation.
	trackTimes( tracks ) {

		const times = new Set();

		for ( const track of tracks ) {

			const input = track.input;
			for ( let i = 0; i < input.length; i ++ ) {

				times.add( input[ i ] );
				if ( track.interpolation === 'STEP' && i + 1 < input.length ) times.add( Math.max( input[ i ], input[ i + 1 ] - 1e-4 ) );
				if ( track.interpolation === 'CUBICSPLINE' && i + 1 < input.length ) for ( let k = 1; k < 4; k ++ ) times.add( input[ i ] + ( input[ i + 1 ] - input[ i ] ) * k / 4 );

			}

		}

		return [ ...times ].sort( ( a, b ) => a - b );

	}

	sampleTrack( track ) {

		const samples = new Map();
		const isRotation = track.path === 'rotation';
		let prev = null;

		for ( const t of this.trackTimes( [ track ] ) ) {

			let v = sampleTrack( track, t );
			if ( isRotation ) {

				if ( prev && prev[ 0 ] * v[ 0 ] + prev[ 1 ] * v[ 1 ] + prev[ 2 ] * v[ 2 ] + prev[ 3 ] * v[ 3 ] < 0 ) v = v.map( ( x ) => - x );
				prev = v;

			}

			const code = t * TIME_CODES_PER_SECOND;
			this.timeCodes.add( code );
			samples.set( code, v );

		}

		return samples;

	}

	writePointerTrack( track, specFor ) {

		const pointer = track.pointer;
		let m;

		if ( ( m = /^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/.exec( pointer ) ) ) {

			const prim = this.nodePrims.get( + m[ 1 ] );
			if ( ! prim ) return;
			const samples = new Map();
			for ( let i = 0; i < track.input.length; i ++ ) {

				const code = track.input[ i ] * TIME_CODES_PER_SECOND;
				this.timeCodes.add( code );
				samples.set( code, track.output[ i * track.width ] ? 'inherited' : 'invisible' );

			}

			setSamples( specFor( prim ), 'visibility', 'token', samples );
			return;

		}

		if ( ( m = /^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/(intensity|color)$/.exec( pointer ) ) ) {

			const prim = this.lightPrims?.get( + m[ 1 ] );
			if ( ! prim ) return;
			const samples = this.sampleTrack( track );
			setSamples( specFor( prim ), 'inputs:' + m[ 2 ], m[ 2 ] === 'color' ? 'color3f' : 'float', samples );
			return;

		}

		if ( ( m = /^\/materials\/(\d+)\/(.*)$/.exec( pointer ) ) ) {

			if ( this.writeMaterialTrack( + m[ 1 ], m[ 2 ], track, specFor ) ) return;

		}

		// anything else is kept as data for the way back
		( this.unmappedPointers ||= [] ).push( pointer );

	}

	writeMaterialTrack( index, path, track, specFor ) {

		const inputs = this.shaderInputs?.get( index );
		const material = this.json.materials?.[ index ];
		if ( ! inputs || ! material ) return false;
		const samples = this.sampleTrack( track );
		const at = ( attrPath ) => {

			const [ primPath, name ] = [ attrPath.slice( 0, attrPath.lastIndexOf( '.' ) ), attrPath.slice( attrPath.lastIndexOf( '.' ) + 1 ) ];
			const prim = this.findSpec( primPath );
			return prim ? { prim, name } : null;

		};

		if ( path === 'pbrMetallicRoughness/baseColorFactor' ) {

			if ( inputs.baseColorTexture ) {

				const t = at( inputs.baseColorTexture + '.inputs:scale' );
				if ( t ) setSamples( specFor( t.prim ), 'inputs:scale', 'float4', samples );

			} else if ( inputs.diffuseColor ) {

				const t = at( inputs.diffuseColor );
				const rgb = new Map( [ ...samples ].map( ( [ k, v ] ) => [ k, v.slice( 0, 3 ) ] ) );
				if ( t ) setSamples( specFor( t.prim ), t.name, 'color3f', rgb );
				if ( inputs.opacity ) {

					const o = at( inputs.opacity );
					if ( o ) setSamples( specFor( o.prim ), o.name, 'float', new Map( [ ...samples ].map( ( [ k, v ] ) => [ k, v[ 3 ] ] ) ) );

				}

			}

			return true;

		}

		if ( path === 'emissiveFactor' ) {

			const strength = material.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
			const scaled = new Map( [ ...samples ].map( ( [ k, v ] ) => [ k, v.map( ( x ) => x * strength ) ] ) );

			if ( inputs.emissiveTexture ) {

				const t = at( inputs.emissiveTexture + '.inputs:scale' );
				if ( t ) setSamples( specFor( t.prim ), 'inputs:scale', 'float4', new Map( [ ...scaled ].map( ( [ k, v ] ) => [ k, [ ...v, 1 ] ] ) ) );

			} else {

				const prim = this.findSpec( this.materialPaths.get( index ) + '/PreviewSurface' );
				if ( prim ) setSamples( specFor( prim ), 'inputs:emissiveColor', 'color3f', scaled );

			}

			return true;

		}

		const tt = /^(.*)\/extensions\/KHR_texture_transform\/(offset|rotation|scale)$/.exec( path );

		if ( tt ) {

			// find the texture info at that path to locate its transform node
			const info = tt[ 1 ].split( '/' ).reduce( ( o, k ) => o?.[ k ], material );
			const node = info && inputs[ `texture:${ info.index }:transform` ];
			if ( ! node ) return false;
			const prim = this.findSpec( node );
			const transform = info.extensions.KHR_texture_transform;
			const out = new Map();

			for ( const [ k, v ] of samples ) {

				const u = usdTextureTransform( { ...transform, [ tt[ 2 ] ]: tt[ 2 ] === 'rotation' ? v[ 0 ] : v } );
				out.set( k, u );

			}

			setSamples( specFor( prim ), 'inputs:translation', 'float2', new Map( [ ...out ].map( ( [ k, u ] ) => [ k, u.translation ] ) ) );
			setSamples( specFor( prim ), 'inputs:rotation', 'float', new Map( [ ...out ].map( ( [ k, u ] ) => [ k, u.rotation ] ) ) );
			setSamples( specFor( prim ), 'inputs:scale', 'float2', new Map( [ ...out ].map( ( [ k, u ] ) => [ k, u.scale ] ) ) );
			return true;

		}

		return false;

	}

	findSpec( path ) {

		return this.b.layer.getPrimAtPath( path );

	}

	// --- material variants ---

	convertMaterialVariants() {

		const variants = this.json.extensions?.KHR_materials_variants?.variants;
		if ( ! variants?.length ) return;

		const set = new Map();
		const names = [];

		variants.forEach( ( v, i ) => {

			let name = sanitize( v.name, `variant_${ i }` );
			while ( names.includes( name ) ) name += '_';
			names.push( name );
			const variant = new PrimSpec( name, 'over', '' );
			set.set( name, variant );

			for ( const [ key, prim ] of this.meshPrims ) {

				const [ nodeIndex, p ] = key.split( '/' ).map( Number );
				const primitive = this.json.meshes[ this.json.nodes[ nodeIndex ].mesh ].primitives[ p ];
				const mapping = primitive.extensions?.KHR_materials_variants?.mappings?.find( ( m ) => m.variants.includes( i ) );
				const material = mapping ? mapping.material : primitive.material;
				const path = material !== undefined ? this.materialPaths.get( material ) : this.defaultMaterialPath();
				if ( ! path ) continue;
				// the binding without a variant selected, which glTF has and USD doesn't
				if ( i === 0 && primitive.material !== undefined ) gltfData( prim ).material = this.materialPaths.get( primitive.material );
				const over = this.overFor( variant, prim );
				const rel = over.addProperty( new PropertySpec( 'material:binding', 'relationship' ) );
				rel.targets = ListOp.explicit( [ path ] );

			}

		} );

		this.root.variantSets.set( 'materialVariant', set );
		const op = this.root.metadata.variantSetNames || new ListOp();
		op.prepended.push( 'materialVariant' );
		this.root.metadata.variantSetNames = op;
		this.root.metadata.variants = { ...this.root.metadata.variants, materialVariant: names[ 0 ] };
		this.moveDefaultsIntoVariants( set );

	}

}

// The customData.gltf dictionary of a prim spec, where glTF only data is kept.
function gltfData( spec ) {

	const customData = spec.metadata.customData ||= {};
	return customData.gltf ||= {};

}

function setSamples( spec, name, typeName, samples ) {

	let prop = spec.properties.get( name );

	if ( ! prop ) {

		prop = spec.addProperty( new PropertySpec( name, 'attribute' ) );
		prop.typeName = typeName;

	}

	prop.timeSamples = samples;

}

function jointParent( j, parents, jointSet ) {

	for ( let p = parents.get( j ); p !== undefined; p = parents.get( p ) ) if ( jointSet.has( p ) ) return p;
	return null;

}

// Orders joints so parents come before children.
function orderJoints( joints, parents, jointSet ) {

	const depth = ( j ) => {

		let d = 0;
		for ( let p = jointParent( j, parents, jointSet ); p !== null; p = jointParent( p, parents, jointSet ) ) d ++;
		return d;

	};

	return joints.map( ( j, i ) => ( { j, i, d: depth( j ) } ) ).sort( ( a, b ) => a.d - b.d || a.i - b.i ).map( ( x ) => x.j );

}

export function sampleTrack( track, time ) {

	const { input, output, width, interpolation } = track;
	const n = input.length;
	const cubic = interpolation === 'CUBICSPLINE';
	const get = ( k ) => Array.from( output.subarray( cubic ? ( k * 3 + 1 ) * width : k * width, ( cubic ? ( k * 3 + 1 ) * width : k * width ) + width ) );

	if ( time <= input[ 0 ] ) return get( 0 );
	if ( time >= input[ n - 1 ] ) return get( n - 1 );

	let k = 0;
	let lo = 0, hi = n - 1;
	while ( lo <= hi ) { const mid = ( lo + hi ) >> 1; if ( input[ mid ] <= time ) { k = mid; lo = mid + 1; } else hi = mid - 1; }
	k = Math.min( k, n - 2 );

	const t0 = input[ k ], t1 = input[ k + 1 ];
	const u = t1 > t0 ? ( time - t0 ) / ( t1 - t0 ) : 0;
	if ( interpolation === 'STEP' ) return get( k );

	if ( cubic ) {

		const dt = t1 - t0;
		const p0 = get( k ), p1 = get( k + 1 );
		const m0 = Array.from( output.subarray( ( k * 3 + 2 ) * width, ( k * 3 + 3 ) * width ) );
		const m1 = Array.from( output.subarray( ( k + 1 ) * 3 * width, ( ( k + 1 ) * 3 + 1 ) * width ) );
		const u2 = u * u, u3 = u2 * u;
		const r = p0.map( ( _, i ) => ( 2 * u3 - 3 * u2 + 1 ) * p0[ i ] + ( u3 - 2 * u2 + u ) * dt * m0[ i ] + ( - 2 * u3 + 3 * u2 ) * p1[ i ] + ( u3 - u2 ) * dt * m1[ i ] );
		if ( track.path === 'rotation' ) { const l = Math.hypot( ...r ) || 1; return r.map( ( v ) => v / l ); }
		return r;

	}

	const a = get( k ), b = get( k + 1 );

	if ( track.path === 'rotation' ) {

		let dot = a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ] + a[ 3 ] * b[ 3 ];
		const bb = dot < 0 ? b.map( ( v ) => - v ) : b;
		dot = Math.abs( dot );
		if ( dot > 0.9995 ) { const r = a.map( ( v, i ) => v + ( bb[ i ] - v ) * u ); const l = Math.hypot( ...r ); return r.map( ( v ) => v / l ); }
		const th = Math.acos( dot ), s = Math.sin( th );
		return a.map( ( v, i ) => v * Math.sin( ( 1 - u ) * th ) / s + bb[ i ] * Math.sin( u * th ) / s );

	}

	return a.map( ( v, i ) => v + ( b[ i ] - v ) * u );

}

function extent( positions ) {

	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	for ( let i = 0; i < positions.length; i += 3 ) for ( let k = 0; k < 3; k ++ ) {

		const v = positions[ i + k ];
		if ( v < min[ k ] ) min[ k ] = v;
		if ( v > max[ k ] ) max[ k ] = v;

	}

	if ( min[ 0 ] === Infinity ) return Float32Array.of( 0, 0, 0, 0, 0, 0 );
	return Float32Array.of( ...min, ...max );

}

// glTF KHR_texture_transform (v down) -> UsdTransform2d parameters (v up).
export function usdTextureTransform( t ) {

	const [ ox, oy ] = t.offset || [ 0, 0 ];
	const r = t.rotation || 0;
	const [ sx, sy ] = t.scale || [ 1, 1 ];
	const c = Math.cos( r ), s = Math.sin( r );
	// glTF matrix = T * R * S with R = [ c s; -s c ] in column major [ c, -s, s, c ]
	const g = [ c * sx, - s * sx, 0, 0, s * sy, c * sy, 0, 0, 0, 0, 1, 0, ox, oy, 0, 1 ];
	const flip = [ 1, 0, 0, 0, 0, - 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1 ];
	const m = multiply( flip, multiply( g, flip ) );
	const usx = Math.hypot( m[ 0 ], m[ 1 ] );
	const det = m[ 0 ] * m[ 5 ] - m[ 1 ] * m[ 4 ];
	const usy = Math.hypot( m[ 4 ], m[ 5 ] ) * Math.sign( det || 1 );
	return { rotation: Math.atan2( m[ 1 ], m[ 0 ] ) * 180 / Math.PI, scale: [ usx, usy ], translation: [ m[ 12 ], m[ 13 ] ] };

}

