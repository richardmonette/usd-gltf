// Converts USD materials (UsdPreviewSurface networks and MaterialX graphs of the same shape) to glTF.
//
// Shader graphs are evaluated into per channel terms: each output channel is either a constant
// (tex null, value = bias) or one channel of a texture times scale plus bias. That covers texture
// lookups, scale/bias, channel selection and the arithmetic nodes MaterialX uses for normal maps,
// and lets textures be referenced directly when glTF can express the result, or be repacked
// (baked) into a new image when it can't, e.g. separate roughness and metallic maps.

import { decodeImageAsync, encodePNG, imageMimeType } from '../image/index.js';
import { multiply } from '../util/math.js';
import { resolveAssetPath } from '../usd/stage.js';

const WRAP = { repeat: 10497, mirror: 33648, clamp: 33071, black: 33071 };
const CHANNEL = { r: 0, g: 1, b: 2, a: 3, x: 0, y: 1, z: 2, w: 3 };

const constTerms = ( v ) => ( Array.isArray( v ) || ArrayBuffer.isView( v ) ? Array.from( v ) : [ v ] ).map( ( c ) => ( { tex: null, channel: 0, scale: 0, bias: + c || 0 } ) );

function broadcast( terms, n ) {

	if ( terms.length >= n ) return terms.slice( 0, n );
	if ( terms.length === 1 ) return new Array( n ).fill( terms[ 0 ] );
	const out = terms.slice();
	while ( out.length < n ) out.push( { tex: null, channel: 0, scale: 0, bias: out.length === 3 ? 1 : 0 } );
	return out;

}

const isConst = ( terms ) => terms.every( ( t ) => ! t.tex );

function binary( a, b, op ) {

	const n = Math.max( a.length, b.length );
	a = broadcast( a, n ); b = broadcast( b, n );

	return a.map( ( x, i ) => {

		const y = b[ i ];

		if ( op === 'add' || op === 'subtract' ) {

			const s = op === 'add' ? 1 : - 1;
			if ( ! y.tex ) return { ...x, bias: x.bias + s * y.bias };
			if ( ! x.tex ) return { ...y, scale: s * y.scale, bias: x.bias + s * y.bias };
			return x; // texture plus texture: not affine, keep the first

		}

		if ( op === 'multiply' ) {

			if ( ! y.tex ) return { ...x, scale: x.scale * y.bias, bias: x.bias * y.bias };
			if ( ! x.tex ) return { ...y, scale: y.scale * x.bias, bias: y.bias * x.bias };
			return x;

		}

		if ( op === 'divide' ) {

			if ( ! y.tex && y.bias ) return { ...x, scale: x.scale / y.bias, bias: x.bias / y.bias };
			return x;

		}

		return x;

	} );

}

export class MaterialConverter {

	constructor( stage, builder, { log = () => {}, imageDecoder = null } = {} ) {

		this.stage = stage;
		this.builder = builder;
		this.log = log;
		this.imageDecoder = imageDecoder;
		this.uvNames = []; // uv set names in texCoord order
		this.materials = new Map(); // key -> glTF material index
		this.images = new Map(); // file -> { index, mimeType } | null
		this.decoded = new Map(); // file -> decoded image promise
		this.textures = new Map();
		this.samplers = new Map();
		this.pending = [];

	}

	uvIndex( name ) {

		let i = this.uvNames.indexOf( name );
		if ( i < 0 ) i = this.uvNames.push( name ) - 1;
		return i;

	}

	// --- graph evaluation ---

	evalProperty( prop, depth = 0 ) {

		if ( ! prop || depth > 32 ) return null;
		const connections = prop.connections;
		if ( connections.length ) return this.evalConnection( connections[ 0 ], depth + 1 );
		const v = prop.value;
		if ( v === undefined || v === null ) return null;
		if ( typeof v === 'string' ) return null;
		return constTerms( v );

	}

	// Like evalProperty but for string/token inputs (varname, file, wrap modes), following interface connections.
	evalString( prop, depth = 0 ) {

		if ( ! prop || depth > 32 ) return undefined;
		const connections = prop.connections;

		if ( connections.length ) {

			const [ primPath, name ] = splitPropertyPath( connections[ 0 ] );
			const target = this.stage.getPrimAtPath( primPath )?.getProperty( name );
			return this.evalString( target, depth + 1 );

		}

		return prop.value;

	}

	evalConnection( path, depth ) {

		const [ primPath, name ] = splitPropertyPath( path );
		const prim = this.stage.getPrimAtPath( primPath );
		if ( ! prim ) return null;

		if ( prim.typeName === 'Shader' && name.startsWith( 'outputs:' ) ) return this.evalShader( prim, name.slice( 8 ), depth );

		// material or node graph interface input / output
		return this.evalProperty( prim.getProperty( name ), depth );

	}

	input( shader, name, depth ) {

		return this.evalProperty( shader.getProperty( 'inputs:' + name ), depth );

	}

	evalUV( prop, depth = 0 ) {

		const fallback = { name: 'st', transform: null };
		if ( ! prop || depth > 32 ) return fallback;
		const connections = prop.connections;
		if ( ! connections.length ) return fallback;

		const [ primPath, name ] = splitPropertyPath( connections[ 0 ] );
		const prim = this.stage.getPrimAtPath( primPath );
		if ( ! prim ) return fallback;
		if ( prim.typeName !== 'Shader' ) return this.evalUV( prim.getProperty( name ), depth + 1 );

		const id = prim.get( 'info:id', '' );

		if ( id.startsWith( 'UsdPrimvarReader' ) ) return { name: this.evalString( prim.getProperty( 'inputs:varname' ) ) || 'st', transform: null };
		if ( id === 'ND_geompropvalue_vector2' ) return { name: this.evalString( prim.getProperty( 'inputs:geomprop' ) ) || 'st', transform: null };
		if ( id === 'ND_texcoord_vector2' ) return { name: prim.get( 'inputs:index', 0 ) ? 'st' + prim.get( 'inputs:index', 0 ) : 'st', transform: null };

		if ( id === 'UsdTransform2d' ) {

			const inner = this.evalUV( prim.getProperty( 'inputs:in' ), depth + 1 );
			const t = {
				rotation: this.constValue( prim.getProperty( 'inputs:rotation' ), 0 ),
				scale: this.constValue( prim.getProperty( 'inputs:scale' ), [ 1, 1 ] ),
				translation: this.constValue( prim.getProperty( 'inputs:translation' ), [ 0, 0 ] ),
			};
			return { name: inner.name, transform: inner.transform ? composeTransforms( inner.transform, t ) : t };

		}

		if ( id === 'ND_place2d_vector2' ) {

			const inner = this.evalUV( prim.getProperty( 'inputs:texcoord' ), depth + 1 );
			const t = {
				rotation: this.constValue( prim.getProperty( 'inputs:rotate' ), 0 ),
				scale: this.constValue( prim.getProperty( 'inputs:scale' ), [ 1, 1 ] ),
				translation: this.constValue( prim.getProperty( 'inputs:offset' ), [ 0, 0 ] ),
			};
			return { name: inner.name, transform: t };

		}

		// any other node: follow its first connected input
		for ( const p of prim.properties.values() ) if ( p.name.startsWith( 'inputs:' ) && p.connections.length ) return this.evalUV( p, depth + 1 );
		return fallback;

	}

	constValue( prop, fallback ) {

		const t = this.evalProperty( prop );
		if ( ! t || ! isConst( t ) ) return fallback;
		return t.length === 1 ? t[ 0 ].bias : t.map( ( x ) => x.bias );

	}

	texture( shader, fileInput, uvInput, wrapS, wrapT, colorSpace ) {

		const fileProp = shader.getProperty( 'inputs:' + fileInput );
		let file = this.evalString( fileProp );
		if ( ! file?.resolved && fileProp?.connections.length ) file = null;
		if ( ! file || ! file.resolved ) return null;
		const uv = this.evalUV( shader.getProperty( 'inputs:' + uvInput ) );
		return { file: file.resolved, uv, wrapS: wrapS || 'repeat', wrapT: wrapT || 'repeat', colorSpace };

	}

	evalShader( shader, output, depth ) {

		const id = shader.get( 'info:id', '' );

		if ( id === 'UsdUVTexture' ) {

			const fallback = this.constValue( shader.getProperty( 'inputs:fallback' ), [ 0, 0, 0, 1 ] );
			const tex = this.texture( shader, 'file', 'st', this.evalString( shader.getProperty( 'inputs:wrapS' ) ), this.evalString( shader.getProperty( 'inputs:wrapT' ) ), this.evalString( shader.getProperty( 'inputs:sourceColorSpace' ) ) );
			const scale = broadcast( this.input( shader, 'scale', depth ) || constTerms( [ 1, 1, 1, 1 ] ), 4 ).map( ( t ) => t.bias );
			const bias = broadcast( this.input( shader, 'bias', depth ) || constTerms( [ 0, 0, 0, 0 ] ), 4 ).map( ( t ) => t.bias );
			const channels = output === 'rgb' ? [ 0, 1, 2 ] : output === 'rgba' ? [ 0, 1, 2, 3 ] : [ CHANNEL[ output ] ?? 0 ];
			if ( ! tex ) return channels.map( ( c ) => ( { tex: null, channel: 0, scale: 0, bias: ( fallback[ c ] ?? 1 ) * scale[ c ] + bias[ c ] } ) );
			return channels.map( ( c ) => ( { tex, channel: c, scale: scale[ c ], bias: bias[ c ] } ) );

		}

		if ( id.startsWith( 'ND_image_' ) || id.startsWith( 'ND_tiledimage_' ) || id.startsWith( 'ND_gltf_image_' ) ) {

			const type = id.replace( /^ND_(tiled|gltf_)?image_/, '' );
			const n = type.startsWith( 'float' ) ? 1 : type.endsWith( '2' ) ? 2 : type.endsWith( '4' ) ? 4 : 3;
			const mode = ( m ) => ( { periodic: 'repeat', clamp: 'clamp', mirror: 'mirror', constant: 'black' }[ m ] || 'repeat' );
			const tex = this.texture( shader, 'file', 'texcoord', mode( this.evalString( shader.getProperty( 'inputs:uaddressmode' ) ) ), mode( this.evalString( shader.getProperty( 'inputs:vaddressmode' ) ) ), type.startsWith( 'color' ) ? 'sRGB' : 'raw' );
			if ( ! tex ) return this.input( shader, 'default', depth ) || constTerms( new Array( n ).fill( 0 ) );
			return Array.from( { length: n }, ( _, c ) => ( { tex, channel: c, scale: 1, bias: 0 } ) );

		}

		if ( id.startsWith( 'UsdPrimvarReader' ) ) {

			const name = this.evalString( shader.getProperty( 'inputs:varname' ) ) || 'displayColor';
			const fallback = this.input( shader, 'fallback', depth ) || constTerms( [ 1, 1, 1 ] );
			return fallback.map( ( t, c ) => ( { ...t, primvar: name, channel: c } ) );

		}

		const op = /^ND_(multiply|add|subtract|divide)_/.exec( id );

		if ( op ) {

			const a = this.input( shader, 'in1', depth );
			const b = this.input( shader, 'in2', depth ) || constTerms( op[ 1 ] === 'multiply' || op[ 1 ] === 'divide' ? 1 : 0 );
			if ( ! a ) return b;
			return binary( a, b, op[ 1 ] );

		}

		if ( /^ND_separate[234]_/.test( id ) ) {

			const v = this.input( shader, 'in', depth );
			const c = CHANNEL[ output.slice( - 1 ) ] ?? 0;
			return v ? [ broadcast( v, 4 )[ c ] ] : null;

		}

		if ( /^ND_combine[234]_/.test( id ) ) {

			const parts = [ 'in1', 'in2', 'in3', 'in4' ].map( ( n ) => this.input( shader, n, depth ) ).filter( Boolean );
			return parts.map( ( p ) => p[ 0 ] );

		}

		if ( /^ND_mix_/.test( id ) ) {

			const fg = this.input( shader, 'fg', depth );
			const bg = this.input( shader, 'bg', depth );
			const mix = this.input( shader, 'mix', depth );
			const m = mix && isConst( mix ) ? mix[ 0 ].bias : 0.5;
			if ( fg && bg && isConst( fg ) && isConst( bg ) ) return fg.map( ( t, i ) => ( { ...t, bias: bg[ i % bg.length ].bias * ( 1 - m ) + t.bias * m } ) );
			return ( m >= 0.5 ? fg || bg : bg || fg );

		}

		if ( /^ND_normalmap/.test( id ) ) {

			const v = this.input( shader, 'in', depth );
			return v ? broadcast( v, 3 ).map( ( t ) => ( { ...t, scale: t.scale * 2, bias: t.bias * 2 - 1 } ) ) : constTerms( [ 0, 0, 1 ] );

		}

		if ( /^ND_constant_/.test( id ) ) return this.input( shader, 'value', depth );

		// dot, convert, swizzle and anything else: pass the first input through
		for ( const name of [ 'in', 'in1', 'input', 'fg', 'bg' ] ) {

			const v = this.input( shader, name, depth );
			if ( v ) return v;

		}

		for ( const p of shader.properties.values() ) {

			if ( p.name.startsWith( 'inputs:' ) && p.connections.length ) {

				const v = this.evalProperty( p, depth );
				if ( v ) return v;

			}

		}

		return null;

	}

	// The surface shader of a material and how to read its inputs.
	surfaceOf( material ) {

		let best = null;

		for ( const output of [ 'outputs:surface', 'outputs:mtlx:surface', 'outputs:glslfx:surface', 'outputs:ri:surface' ] ) {

			const prop = material.getProperty( output );
			if ( ! prop ) continue;
			let shader = null;
			let path = prop.connections[ 0 ];

			for ( let i = 0; path && i < 16; i ++ ) {

				const [ primPath, name ] = splitPropertyPath( path );
				const prim = this.stage.getPrimAtPath( primPath );
				if ( ! prim ) break;
				if ( prim.typeName === 'Shader' ) { shader = prim; break; }
				path = prim.getProperty( name )?.connections[ 0 ];

			}

			if ( ! shader ) continue;
			const id = shader.get( 'info:id', '' );
			let kind = null;
			if ( id === 'UsdPreviewSurface' || id === 'ND_UsdPreviewSurface_surfaceshader' ) kind = 'preview';
			else if ( id === 'ND_standard_surface_surfaceshader' ) kind = 'standard';
			else if ( id === 'ND_open_pbr_surface_surfaceshader' ) kind = 'openpbr';
			else if ( id === 'ND_gltf_pbr_surfaceshader' ) kind = 'gltf';
			else if ( /unlit/i.test( id ) ) kind = 'unlit';
			if ( ! kind ) continue;

			// some files author an empty UsdPreviewSurface beside a full MaterialX network: prefer the one with inputs
			const authored = [ ...shader.properties.values() ].filter( ( p ) => p.name.startsWith( 'inputs:' ) && ( p.connections.length || p.value !== undefined ) ).length;
			if ( ! best || authored > best.authored ) best = { shader, kind, authored };

		}

		return best;

	}

	// Surface inputs as terms, in UsdPreviewSurface vocabulary.
	surfaceInputs( material ) {

		const surface = this.surfaceOf( material );
		const s = surface?.shader;
		const get = ( name, fallback ) => ( s && this.input( s, name ) ) || constTerms( fallback );
		const kind = surface?.kind;

		if ( kind === 'standard' || kind === 'openpbr' ) {

			const std = kind === 'standard';
			const base = get( std ? 'base' : 'base_weight', 1 );
			const emission = get( std ? 'emission' : 'emission_luminance', std ? 0 : 0 );
			return {
				diffuseColor: binary( get( 'base_color', [ 0.8, 0.8, 0.8 ] ), base, 'multiply' ),
				metallic: get( std ? 'metalness' : 'base_metalness', 0 ),
				roughness: get( 'specular_roughness', std ? 0.2 : 0.3 ),
				emissiveColor: binary( get( 'emission_color', [ 1, 1, 1 ] ), emission, 'multiply' ),
				opacity: [ broadcast( get( std ? 'opacity' : 'geometry_opacity', 1 ), 1 )[ 0 ] ],
				opacityThreshold: constTerms( 0 ),
				normal: s && this.input( s, std ? 'normal' : 'geometry_normal' ) || null,
				occlusion: constTerms( 1 ),
				clearcoat: get( std ? 'coat' : 'coat_weight', 0 ),
				clearcoatRoughness: get( 'coat_roughness', 0.1 ),
				ior: get( std ? 'specular_IOR' : 'specular_ior', 1.5 ),
				unlit: false,
			};

		}

		if ( kind === 'gltf' ) {

			return {
				diffuseColor: get( 'base_color', [ 1, 1, 1 ] ),
				metallic: get( 'metallic', 1 ),
				roughness: get( 'roughness', 1 ),
				emissiveColor: get( 'emissive', [ 0, 0, 0 ] ),
				opacity: get( 'alpha', 1 ),
				opacityThreshold: constTerms( 0 ),
				normal: s && this.input( s, 'normal' ) || null,
				occlusion: get( 'occlusion', 1 ),
				clearcoat: get( 'clearcoat', 0 ),
				clearcoatRoughness: get( 'clearcoat_roughness', 0 ),
				ior: get( 'ior', 1.5 ),
				unlit: false,
			};

		}

		if ( kind === 'unlit' ) {

			return {
				diffuseColor: get( 'color', [ 1, 1, 1 ] ),
				metallic: constTerms( 0 ), roughness: constTerms( 1 ), emissiveColor: constTerms( [ 0, 0, 0 ] ),
				opacity: get( 'opacity', 1 ), opacityThreshold: get( 'opacityThreshold', 0 ), normal: null,
				occlusion: constTerms( 1 ), clearcoat: constTerms( 0 ), clearcoatRoughness: constTerms( 0 ), ior: constTerms( 1.5 ),
				unlit: true,
			};

		}

		const specularWorkflow = s && this.constValue( s.getProperty( 'inputs:useSpecularWorkflow' ), 0 );

		return {
			diffuseColor: get( 'diffuseColor', [ 0.18, 0.18, 0.18 ] ),
			metallic: specularWorkflow ? constTerms( 0 ) : get( 'metallic', 0 ),
			roughness: get( 'roughness', 0.5 ),
			emissiveColor: get( 'emissiveColor', [ 0, 0, 0 ] ),
			opacity: get( 'opacity', 1 ),
			opacityThreshold: get( 'opacityThreshold', 0 ),
			opacityMode: s && this.evalString( s.getProperty( 'inputs:opacityMode' ) ),
			normal: s && this.input( s, 'normal' ) || null,
			occlusion: get( 'occlusion', 1 ),
			clearcoat: get( 'clearcoat', 0 ),
			clearcoatRoughness: get( 'clearcoatRoughness', 0.01 ),
			ior: get( 'ior', 1.5 ),
			specularColor: specularWorkflow ? get( 'specularColor', [ 0, 0, 0 ] ) : null,
			unlit: false,
			missing: ! s,
		};

	}

	// --- images and textures ---

	async imageFor( file ) {

		if ( this.images.has( file ) ) return this.images.get( file );

		let result = null;

		try {

			const bytes = await this.stage.readAsset( file );
			let mimeType = imageMimeType( bytes );

			if ( mimeType === 'image/png' || mimeType === 'image/jpeg' ) {

				result = { index: this.builder.addImage( bytes, mimeType, imageName( file ) ), mimeType };

			} else {

				// anything else (webp, exr, tga...) is decoded and re-encoded as png when we can
				const decoded = await this.decode( file );
				if ( decoded ) result = { index: this.builder.addImage( encodePNG( decoded ), 'image/png', imageName( file ) ), mimeType: 'image/png' };
				mimeType = 'image/png';

			}

		} catch ( e ) {

			this.log( `texture ${ file }: ${ e.message }` );

		}

		this.images.set( file, result );
		return result;

	}

	decode( file ) {

		if ( ! this.decoded.has( file ) ) {

			this.decoded.set( file, ( async () => {

				try {

					return await decodeImageAsync( await this.stage.readAsset( file ), undefined, this.imageDecoder );

				} catch ( e ) {

					this.log( `decode ${ file }: ${ e.message }` );
					return null;

				}

			} )() );

		}

		return this.decoded.get( file );

	}

	sampler( wrapS, wrapT ) {

		const key = wrapS + '/' + wrapT;
		if ( ! this.samplers.has( key ) ) {

			const s = { wrapS: WRAP[ wrapS ] ?? 10497, wrapT: WRAP[ wrapT ] ?? 10497 };
			const json = this.builder.json;
			this.samplers.set( key, json.samplers.push( s ) - 1 );

		}

		return this.samplers.get( key );

	}

	textureInfo( imageIndex, tex, key ) {

		const tkey = key + '|' + tex.wrapS + '|' + tex.wrapT;
		let index = this.textures.get( tkey );

		if ( index === undefined ) {

			index = this.builder.json.textures.push( { sampler: this.sampler( tex.wrapS, tex.wrapT ), source: imageIndex } ) - 1;
			this.textures.set( tkey, index );

		}

		const info = { index };
		const texCoord = this.uvIndex( tex.uv.name );
		if ( texCoord ) info.texCoord = texCoord;

		if ( tex.uv.transform ) {

			const ext = gltfTextureTransform( tex.uv.transform );
			if ( ext ) {

				if ( texCoord ) ext.texCoord = texCoord;
				info.extensions = { KHR_texture_transform: ext };
				this.builder.useExtension( 'KHR_texture_transform' );

			}

		}

		return info;

	}

	/**
	 * Produces a texture whose channels hold the given terms, referencing the source image when
	 * possible. layout: one entry per output channel (0..3): { terms index, apply: 'factor'|'none' }.
	 * Returns { info, factors } or null when every term is constant.
	 */
	async channelTexture( slots, { allowFactor = true } = {} ) {

		const textured = slots.filter( ( s ) => s && s.term.tex );
		if ( ! textured.length ) return null;

		const tex = textured[ 0 ].term.tex;
		const sameTexture = textured.every( ( s ) => s.term.tex.file === tex.file && s.term.tex.uv.name === tex.uv.name && JSON.stringify( s.term.tex.uv.transform ) === JSON.stringify( tex.uv.transform ) );

		// direct use: each textured slot reads its own channel, no bias, scale expressible as a factor
		const direct = sameTexture && textured.every( ( s ) => s.term.channel === s.out && Math.abs( s.term.bias ) < 1e-6 && ( allowFactor || Math.abs( s.term.scale - 1 ) < 1e-6 ) ) &&
			slots.every( ( s ) => ! s || s.term.tex || s.ignoreConst || ( allowFactor && s.constOk ) );

		if ( direct ) {

			const image = await this.imageFor( tex.file );

			if ( image ) {

				return { info: this.textureInfo( image.index, tex, tex.file ), factors: slots.map( ( s ) => ( s ? ( s.term.tex ? s.term.scale : s.term.bias ) : 1 ) ) };

			}

		}

		// bake: decode sources and write a new image
		const sources = await Promise.all( textured.map( ( s ) => this.decode( s.term.tex.file ) ) );
		if ( sources.some( ( s ) => ! s ) ) {

			// fall back to the first decodable texture's channels
			const image = await this.imageFor( tex.file );
			return image ? { info: this.textureInfo( image.index, tex, tex.file ), factors: slots.map( () => 1 ) } : null;

		}

		const width = Math.max( ...sources.map( ( s ) => s.width ) );
		const height = Math.max( ...sources.map( ( s ) => s.height ) );
		const out = new Uint8Array( width * height * 4 );
		const srcOf = new Map( textured.map( ( s, i ) => [ s, sources[ i ] ] ) );

		for ( let c = 0; c < 4; c ++ ) {

			const slot = slots.find( ( s ) => s && s.out === c );

			if ( ! slot ) {

				for ( let i = c; i < out.length; i += 4 ) out[ i ] = 255;
				continue;

			}

			const { term } = slot;

			if ( ! term.tex ) {

				const v = Math.round( clamp01( term.bias ) * 255 );
				for ( let i = c; i < out.length; i += 4 ) out[ i ] = v;
				continue;

			}

			const src = srcOf.get( slot );
			const max = src.bitDepth === 16 ? 65535 : 255;
			const sc = Math.min( term.channel, src.channels - 1 );
			const alphaMissing = term.channel === 3 && src.channels < 4 && src.channels !== 2;
			const channel = src.channels === 2 && term.channel === 3 ? 1 : src.channels <= 2 && term.channel < 3 ? 0 : sc;

			for ( let y = 0; y < height; y ++ ) {

				const sy = Math.min( src.height - 1, Math.floor( y * src.height / height ) );

				for ( let x = 0; x < width; x ++ ) {

					const sx = Math.min( src.width - 1, Math.floor( x * src.width / width ) );
					const raw = alphaMissing ? 1 : src.data[ ( sy * src.width + sx ) * src.channels + channel ] / max;
					out[ ( y * width + x ) * 4 + c ] = Math.round( clamp01( raw * term.scale + term.bias ) * 255 );

				}

			}

		}

		const key = 'baked:' + slots.map( ( s ) => s ? `${ s.term.tex?.file }#${ s.term.channel }*${ s.term.scale }+${ s.term.bias }` : '-' ).join( ',' );
		let imageIndex = this.images.get( key )?.index;
		if ( imageIndex === undefined ) {

			imageIndex = this.builder.addImage( encodePNG( { width, height, channels: 4, data: out } ), 'image/png', imageName( tex.file ) + '_packed' );
			this.images.set( key, { index: imageIndex, mimeType: 'image/png' } );

		}

		return { info: this.textureInfo( imageIndex, tex, key ), factors: slots.map( () => 1 ) };

	}

	// --- materials ---

	/**
	 * @returns {Promise<number>} glTF material index
	 */
	async convert( material, { doubleSided = false, vertexColors = false, variant = '' } = {} ) {

		const key = material.path + ( doubleSided ? '|ds' : '' ) + ( variant ? '|' + variant : '' );
		if ( this.materials.has( key ) ) return this.materials.get( key );

		const index = this.builder.json.materials.push( { name: material.name } ) - 1;
		this.materials.set( key, index );
		const m = this.builder.json.materials[ index ];
		if ( doubleSided ) m.doubleSided = true;

		// glTF data that UsdPreviewSurface can't express, kept by our glTF -> USD conversion
		let stash = null;
		try { stash = JSON.parse( material.getMetadata( 'customData' )?.gltf?.json ?? 'null' ); } catch { /* not ours */ }

		const inputs = this.surfaceInputs( material );

		if ( stash?.KHR_materials_unlit ) {

			// written with the color in emissiveColor and black diffuse
			inputs.diffuseColor = inputs.emissiveColor;
			inputs.unlit = true;

		}

		await this.fill( m, inputs, vertexColors );
		if ( stash ) await this.restoreStash( m, stash, material );
		return index;

	}

	async restoreStash( m, stash, material ) {

		const anchor = material.nodes[ 0 ]?.specs[ 0 ]?.layer.identifier ?? '';
		if ( stash.name !== undefined ) m.name = stash.name;
		if ( stash.doubleSided ) m.doubleSided = true;
		if ( stash.extras !== undefined ) m.extras = stash.extras;

		for ( const [ key, value ] of Object.entries( stash ) ) {

			if ( key === 'name' || key === 'doubleSided' || key === 'extras' ) continue;
			m.extensions = { ...m.extensions, [ key ]: await this.restoreTextures( value, anchor ) };
			this.builder.useExtension( key );

		}

		// the specular glossiness original replaces our metal rough approximation of it
		if ( m.extensions?.KHR_materials_pbrSpecularGlossiness && m.extensions.KHR_materials_specular && ! stash.KHR_materials_specular ) delete m.extensions.KHR_materials_specular;

	}

	async restoreTextures( value, anchor ) {

		if ( Array.isArray( value ) ) return Promise.all( value.map( ( v ) => this.restoreTextures( v, anchor ) ) );
		if ( ! value || typeof value !== 'object' ) return value;

		if ( 'uri' in value && ! ( 'index' in value && typeof value.index === 'number' ) ) {

			const { uri, sampler, ...info } = value;
			const image = uri ? await this.imageFor( resolveAssetPath( anchor, uri ) ) : null;
			if ( ! image ) return undefined;
			const texture = { source: image.index };
			if ( sampler ) texture.sampler = this.gltfSampler( sampler );
			const key = JSON.stringify( texture );
			let index = this.textures.get( key );
			if ( index === undefined ) this.textures.set( key, index = this.builder.json.textures.push( texture ) - 1 );
			if ( info.extensions?.KHR_texture_transform ) this.builder.useExtension( 'KHR_texture_transform' );
			return { ...info, index };

		}

		const out = {};
		for ( const [ k, v ] of Object.entries( value ) ) {

			const r = await this.restoreTextures( v, anchor );
			if ( r !== undefined ) out[ k ] = r;

		}

		return out;

	}

	gltfSampler( sampler ) {

		const key = 'gltf:' + JSON.stringify( sampler );
		if ( ! this.samplers.has( key ) ) this.samplers.set( key, this.builder.json.samplers.push( sampler ) - 1 );
		return this.samplers.get( key );

	}

	async fill( m, inputs, vertexColors ) {

		const pbr = {};
		const diffuse = broadcast( inputs.diffuseColor, 3 );
		const opacity = broadcast( inputs.opacity, 1 )[ 0 ];
		const threshold = broadcast( inputs.opacityThreshold, 1 )[ 0 ].bias;
		const opacityUsed = opacity.tex || opacity.bias < 1;

		if ( opacityUsed ) {

			if ( threshold > 0 ) {

				m.alphaMode = 'MASK';
				m.alphaCutoff = threshold;

			} else {

				m.alphaMode = 'BLEND';

			}

		}

		// base color: rgb from diffuse, alpha from opacity
		const baseSlots = [ 0, 1, 2 ].map( ( c ) => ( { term: diffuse[ c ], out: c, constOk: true } ) );
		baseSlots.push( { term: opacity, out: 3, constOk: ! opacity.tex, ignoreConst: ! opacityUsed } );
		const base = await this.channelTexture( baseSlots);

		if ( base ) {

			pbr.baseColorTexture = base.info;
			const f = base.factors.map( ( v ) => clamp01( v ) );
			if ( ! opacityUsed ) f[ 3 ] = 1;
			if ( f.some( ( v ) => v !== 1 ) ) pbr.baseColorFactor = f;

		} else if ( diffuse.some( ( t ) => t.primvar ) || vertexColors ) {

			pbr.baseColorFactor = [ 1, 1, 1, clamp01( opacity.bias ) ];
			if ( pbr.baseColorFactor[ 3 ] === 1 ) delete pbr.baseColorFactor;

		} else {

			const f = [ ...diffuse.map( ( t ) => clamp01( t.bias ) ), clamp01( opacity.bias ) ];
			if ( f.some( ( v ) => v !== 1 ) ) pbr.baseColorFactor = f;

		}

		if ( inputs.unlit ) {

			m.extensions = { KHR_materials_unlit: {} };
			this.builder.useExtension( 'KHR_materials_unlit' );
			m.pbrMetallicRoughness = pbr;
			return;

		}

		// metallic roughness: G roughness, B metallic
		const rough = broadcast( inputs.roughness, 1 )[ 0 ];
		const metal = broadcast( inputs.metallic, 1 )[ 0 ];
		const mr = await this.channelTexture( [ null, { term: rough, out: 1, constOk: true }, { term: metal, out: 2, constOk: metal.bias === 0 || ! rough.tex }, null ] );

		if ( mr ) {

			pbr.metallicRoughnessTexture = mr.info;
			if ( mr.factors[ 1 ] !== 1 ) pbr.roughnessFactor = clamp01( mr.factors[ 1 ] );
			if ( mr.factors[ 2 ] !== 1 ) pbr.metallicFactor = clamp01( mr.factors[ 2 ] );

		} else {

			pbr.roughnessFactor = clamp01( rough.bias );
			pbr.metallicFactor = clamp01( metal.bias );

		}

		m.pbrMetallicRoughness = pbr;

		// emissive
		const emissive = broadcast( inputs.emissiveColor, 3 );
		const em = await this.channelTexture( [ 0, 1, 2 ].map( ( c ) => ( { term: emissive[ c ], out: c, constOk: true } ) ));
		let emissiveFactor = em ? em.factors.slice( 0, 3 ) : emissive.map( ( t ) => Math.max( 0, t.bias ) );
		if ( em ) m.emissiveTexture = em.info;
		const strength = Math.max( ...emissiveFactor );

		if ( strength > 1 ) {

			emissiveFactor = emissiveFactor.map( ( v ) => v / strength );
			m.extensions = { ...m.extensions, KHR_materials_emissive_strength: { emissiveStrength: strength } };
			this.builder.useExtension( 'KHR_materials_emissive_strength' );

		}

		if ( emissiveFactor.some( ( v ) => v > 0 ) ) m.emissiveFactor = emissiveFactor;
		else if ( m.emissiveTexture ) delete m.emissiveTexture;

		// occlusion from the R channel
		const occ = broadcast( inputs.occlusion, 1 )[ 0 ];

		if ( occ.tex ) {

			// glTF occlusion is lerp( 1, tex, strength ): scale s with bias 1 - s maps exactly
			const strength = occ.scale;
			const asStrength = Math.abs( occ.scale + occ.bias - 1 ) < 1e-5 && strength > 0 && strength <= 1;
			const o = await this.channelTexture( [ { term: asStrength ? { ...occ, scale: 1, bias: 0 } : occ, out: 0 } ], { allowFactor: false } );

			if ( o ) {

				m.occlusionTexture = o.info;
				if ( asStrength && Math.abs( strength - 1 ) > 1e-6 ) m.occlusionTexture.strength = strength;

			}

		}

		// normals: UsdPreviewSurface expects tangent space normals in [-1, 1], usually tex * 2 - 1
		if ( inputs.normal && inputs.normal.some( ( t ) => t.tex ) ) {

			const n = broadcast( inputs.normal, 3 );
			const s = n[ 0 ].scale / 2;
			const standard = n.every( ( t ) => t.tex ) && n[ 0 ].tex.file === n[ 2 ].tex.file && n.every( ( t, c ) => t.channel === c ) &&
				Math.abs( n[ 1 ].scale / 2 - s ) < 1e-4 && Math.abs( n[ 0 ].bias + s ) < 1e-4 && Math.abs( n[ 1 ].bias + s ) < 1e-4 &&
				Math.abs( n[ 2 ].scale - 2 ) < 1e-4 && Math.abs( n[ 2 ].bias + 1 ) < 1e-4;

			if ( standard ) {

				const image = await this.imageFor( n[ 0 ].tex.file );
				if ( image ) {

					m.normalTexture = this.textureInfo( image.index, n[ 0 ].tex, n[ 0 ].tex.file );
					if ( Math.abs( s - 1 ) > 1e-4 ) m.normalTexture.scale = s;

				}

			} else {

				// bake n = tex * scale + bias back into [0, 1]
				const slots = n.map( ( t, c ) => ( { term: { ...t, scale: t.scale / 2, bias: ( t.bias + 1 ) / 2 }, out: c } ) );
				const baked = await this.channelTexture( slots, { allowFactor: false } );
				if ( baked ) m.normalTexture = baked.info;

			}

		}

		// clearcoat
		const cc = broadcast( inputs.clearcoat, 1 )[ 0 ];

		if ( cc.tex || cc.bias > 0 ) {

			const ext = { clearcoatFactor: cc.tex ? 1 : clamp01( cc.bias ) };
			const ccr = broadcast( inputs.clearcoatRoughness, 1 )[ 0 ];

			if ( cc.tex ) {

				const t = await this.channelTexture( [ { term: cc, out: 0, constOk: true } ] );
				if ( t ) { ext.clearcoatTexture = t.info; ext.clearcoatFactor = clamp01( t.factors[ 0 ] ); }

			}

			if ( ccr.tex ) {

				const t = await this.channelTexture( [ null, { term: ccr, out: 1, constOk: true } ] );
				if ( t ) { ext.clearcoatRoughnessTexture = t.info; ext.clearcoatRoughnessFactor = clamp01( t.factors[ 1 ] ); }

			} else {

				ext.clearcoatRoughnessFactor = clamp01( ccr.bias );

			}

			m.extensions = { ...m.extensions, KHR_materials_clearcoat: ext };
			this.builder.useExtension( 'KHR_materials_clearcoat' );

		}

		const ior = broadcast( inputs.ior, 1 )[ 0 ].bias;

		if ( Math.abs( ior - 1.5 ) > 1e-6 && ( ior === 0 || ior >= 1 ) ) {

			m.extensions = { ...m.extensions, KHR_materials_ior: { ior } };
			this.builder.useExtension( 'KHR_materials_ior' );

		}

		if ( inputs.specularColor ) {

			const sc = broadcast( inputs.specularColor, 3 );
			const t = await this.channelTexture( sc.map( ( term, c ) => ( { term, out: c, constOk: true } ) ));
			const ext = {};
			if ( t ) { ext.specularColorTexture = t.info; ext.specularColorFactor = t.factors.slice( 0, 3 ); }
			else ext.specularColorFactor = sc.map( ( x ) => Math.max( 0, x.bias ) );
			m.extensions = { ...m.extensions, KHR_materials_specular: ext };
			this.builder.useExtension( 'KHR_materials_specular' );

		}

	}

	// A material for meshes with no binding, from displayColor / displayOpacity.
	defaultMaterial( color, opacity, vertexColors, doubleSided ) {

		const key = `display|${ color }|${ opacity }|${ vertexColors }|${ doubleSided }`;
		if ( this.materials.has( key ) ) return this.materials.get( key );

		const m = { name: 'displayColor', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.5 } };
		const c = vertexColors ? [ 1, 1, 1 ] : color || [ 0.18, 0.18, 0.18 ];
		const f = [ ...c.map( clamp01 ), clamp01( opacity ?? 1 ) ];
		if ( f.some( ( v ) => v !== 1 ) ) m.pbrMetallicRoughness.baseColorFactor = f;
		if ( f[ 3 ] < 1 ) m.alphaMode = 'BLEND';
		if ( doubleSided ) m.doubleSided = true;
		const index = this.builder.json.materials.push( m ) - 1;
		this.materials.set( key, index );
		return index;

	}

}

function clamp01( v ) {

	return Math.min( 1, Math.max( 0, + v || 0 ) );

}

export function splitPropertyPath( path ) {

	const i = path.lastIndexOf( '.' );
	return [ path.slice( 0, i ), path.slice( i + 1 ) ];

}

function imageName( file ) {

	const m = /([^/[\]]+?)(\.[^./[\]]*)?\]?$/.exec( file );
	return m ? m[ 1 ] : 'image';

}

function affine( t ) {

	// UsdTransform2d: result = translate * rotate * scale * in
	const r = ( t.rotation || 0 ) * Math.PI / 180;
	const c = Math.cos( r ), s = Math.sin( r );
	const [ sx, sy ] = t.scale || [ 1, 1 ];
	const [ tx, ty ] = t.translation || [ 0, 0 ];
	return [ c * sx, s * sx, 0, 0, - s * sy, c * sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1 ];

}

function composeTransforms( inner, outer ) {

	const m = multiply( affine( outer ), affine( inner ) );
	return fromAffine( m );

}

function fromAffine( m ) {

	const sx = Math.hypot( m[ 0 ], m[ 1 ] );
	const sy = Math.hypot( m[ 4 ], m[ 5 ] ) * Math.sign( m[ 0 ] * m[ 5 ] - m[ 1 ] * m[ 4 ] || 1 );
	return { rotation: Math.atan2( m[ 1 ], m[ 0 ] ) * 180 / Math.PI, scale: [ sx, sy ], translation: [ m[ 12 ], m[ 13 ] ] };

}

// USD uv space has v up; glTF has v down. The glTF transform is flip * usd * flip.
export function gltfTextureTransform( t ) {

	const flip = [ 1, 0, 0, 0, 0, - 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1 ];
	const m = multiply( flip, multiply( affine( t ), flip ) );
	// KHR_texture_transform matrix = T * R * S with R = [ cos sin; -sin cos ] (rotation counter clockwise in uv)
	const sx = Math.hypot( m[ 0 ], m[ 1 ] );
	const det = m[ 0 ] * m[ 5 ] - m[ 1 ] * m[ 4 ];
	const sy = Math.hypot( m[ 4 ], m[ 5 ] ) * Math.sign( det || 1 );
	const rotation = Math.atan2( - m[ 1 ], m[ 0 ] );
	const ext = {};
	if ( Math.abs( m[ 12 ] ) > 1e-9 || Math.abs( m[ 13 ] ) > 1e-9 ) ext.offset = [ m[ 12 ], m[ 13 ] ];
	if ( Math.abs( rotation ) > 1e-9 ) ext.rotation = rotation;
	if ( Math.abs( sx - 1 ) > 1e-9 || Math.abs( sy - 1 ) > 1e-9 ) ext.scale = [ sx, sy ];
	return Object.keys( ext ).length ? ext : null;

}
