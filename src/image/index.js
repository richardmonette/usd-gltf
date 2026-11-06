import { decodePNG, encodePNG } from './png.js';
import { decodeJPEG } from './jpeg.js';
import { decodeWebP } from './webp.js';

export { decodePNG, encodePNG, decodeJPEG, decodeWebP };
export { inflate, inflateZlib } from './inflate.js';
export { deflate, deflateZlib } from './deflate.js';

function toBytes( data ) {

	return data instanceof Uint8Array ? data : new Uint8Array( data.buffer || data, data.byteOffset || 0, data.byteLength );

}

function matches( bytes, offset, magic ) {

	if ( bytes.length < offset + magic.length ) return false;
	for ( let i = 0; i < magic.length; i ++ ) if ( bytes[ offset + i ] !== magic[ i ] ) return false;
	return true;

}

/**
 * Identifies an image from its magic bytes.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/ktx2'|null}
 */
export function imageMimeType( bytes ) {

	bytes = toBytes( bytes );

	if ( matches( bytes, 0, [ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A ] ) ) return 'image/png';
	if ( matches( bytes, 0, [ 0xFF, 0xD8, 0xFF ] ) ) return 'image/jpeg';
	if ( matches( bytes, 0, [ 0x52, 0x49, 0x46, 0x46 ] ) && matches( bytes, 8, [ 0x57, 0x45, 0x42, 0x50 ] ) ) return 'image/webp'; // RIFF....WEBP
	if ( matches( bytes, 0, [ 0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A ] ) ) return 'image/ktx2';
	return null;

}

/**
 * Whether a PNG or JPEG stores a single grey channel, from its header.
 * @param {Uint8Array} bytes
 */
export function isGreyscaleImage( bytes ) {

	bytes = toBytes( bytes );
	const type = imageMimeType( bytes );
	if ( type === 'image/png' ) return bytes[ 25 ] === 0 || bytes[ 25 ] === 4; // IHDR colour type

	if ( type === 'image/jpeg' ) {

		// walk the markers to the frame header, whose component count follows the dimensions
		for ( let o = 2; o + 9 < bytes.length; ) {

			if ( bytes[ o ] !== 0xFF ) return false;
			const marker = bytes[ o + 1 ];
			if ( marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC ) return bytes[ o + 9 ] === 1;
			o += 2 + ( ( bytes[ o + 2 ] << 8 ) | bytes[ o + 3 ] );

		}

	}

	return false;

}

/**
 * Width, height and bytes per pixel of a PNG, JPEG or WebP from its header, or null.
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, pixelBytes: number }|null}
 */
export function imageSize( bytes ) {

	bytes = toBytes( bytes );
	const type = imageMimeType( bytes );
	const be16 = ( o ) => ( bytes[ o ] << 8 ) | bytes[ o + 1 ];
	const le16 = ( o ) => bytes[ o ] | ( bytes[ o + 1 ] << 8 );
	const le24 = ( o ) => le16( o ) | ( bytes[ o + 2 ] << 16 );

	if ( type === 'image/png' && bytes.length >= 26 ) {

		const width = ( be16( 16 ) * 65536 ) + be16( 18 ), height = ( be16( 20 ) * 65536 ) + be16( 22 );
		return { width, height, pixelBytes: bytes[ 24 ] === 16 ? 8 : 4 };

	}

	if ( type === 'image/jpeg' ) {

		for ( let o = 2; o + 9 < bytes.length; ) {

			if ( bytes[ o ] !== 0xFF ) return null;
			const marker = bytes[ o + 1 ];
			if ( marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC ) return { width: be16( o + 7 ), height: be16( o + 5 ), pixelBytes: 4 };
			o += 2 + be16( o + 2 );

		}

		return null;

	}

	if ( type === 'image/webp' && bytes.length >= 30 ) {

		const chunk = String.fromCharCode( bytes[ 12 ], bytes[ 13 ], bytes[ 14 ], bytes[ 15 ] );
		if ( chunk === 'VP8X' ) return { width: le24( 24 ) + 1, height: le24( 27 ) + 1, pixelBytes: 4 };
		if ( chunk === 'VP8 ' ) return { width: le16( 26 ) & 0x3FFF, height: le16( 28 ) & 0x3FFF, pixelBytes: 4 };
		if ( chunk === 'VP8L' ) { const b = bytes[ 21 ] | ( bytes[ 22 ] << 8 ) | ( bytes[ 23 ] << 16 ) | ( bytes[ 24 ] << 24 ); return { width: ( b & 0x3FFF ) + 1, height: ( ( b >>> 14 ) & 0x3FFF ) + 1, pixelBytes: 4 }; }

	}

	return null;

}

/**
 * Decodes a PNG, JPEG or WebP. The format is sniffed from the bytes; mimeType is only a fallback.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} [mimeType]
 * @returns {{ width: number, height: number, channels: number, bitDepth: number, data: Uint8Array|Uint16Array }}
 */
export function decodeImage( bytes, mimeType ) {

	bytes = toBytes( bytes );
	const type = imageMimeType( bytes ) || mimeType;

	if ( type === 'image/png' ) return decodePNG( bytes );
	if ( type === 'image/jpeg' || type === 'image/jpg' ) return decodeJPEG( bytes );
	if ( type === 'image/webp' ) return decodeWebP( bytes );
	throw new Error( `usd-gltf: cannot decode ${ type || 'unknown' } image` );

}

const hasNativeDecoder = typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';

/**
 * Encodes a PNG, with the platform's encoder where there is one (much faster) unless the image has
 * partial transparency, which canvases store premultiplied.
 * @param {{ width: number, height: number, channels: number, data: Uint8Array }} image 8 bit
 * @returns {Promise<Uint8Array>}
 */
export async function encodePNGAsync( image ) {

	const { width, height, channels, data } = image;
	let opaque = channels !== 2 && channels !== 4;
	if ( ! opaque ) {

		opaque = true;
		for ( let i = channels - 1; i < data.length; i += channels ) if ( data[ i ] !== 255 ) { opaque = false; break; }

	}

	if ( hasNativeDecoder && opaque && ( image.bitDepth ?? 8 ) === 8 ) {

		try {

			const rgba = new Uint8ClampedArray( width * height * 4 );
			for ( let i = 0, n = width * height; i < n; i ++ ) {

				const s = i * channels;
				rgba[ i * 4 ] = data[ s ];
				rgba[ i * 4 + 1 ] = data[ channels >= 3 ? s + 1 : s ];
				rgba[ i * 4 + 2 ] = data[ channels >= 3 ? s + 2 : s ];
				rgba[ i * 4 + 3 ] = 255;

			}

			const canvas = new OffscreenCanvas( width, height );
			canvas.getContext( '2d' ).putImageData( new ImageData( rgba, width, height ), 0, 0 );
			const blob = await canvas.convertToBlob( { type: 'image/png' } );
			return new Uint8Array( await blob.arrayBuffer() );

		} catch {

			// fall through to the JavaScript encoder

		}

	}

	return encodePNG( image );

}

/**
 * Decodes with the platform's image decoder where there is one (browsers and workers), which is
 * faster and supports more formats, falling back to the JavaScript decoders (Node).
 * Canvas pixels are 8 bit RGBA with premultiplied storage, so alpha below 1 can lose precision.
 * @param {Uint8Array} bytes
 * @param {string} [mimeType]
 * @param {( bytes: Uint8Array, mimeType?: string ) => Promise<object>|object} [decoder] overrides both
 * @param {import('../limits.js').Budget} [budget] charged with the decoded size, from the header, before decoding
 */
export async function decodeImageAsync( bytes, mimeType, decoder = null, budget = null ) {

	bytes = toBytes( bytes );
	const size = budget && imageSize( bytes );
	if ( size ) budget.decode( size.width * size.height * size.pixelBytes, 'image' );
	if ( decoder ) return decoder( bytes, mimeType );
	const type = imageMimeType( bytes ) || mimeType;

	if ( hasNativeDecoder ) {

		try {

			const bitmap = await createImageBitmap( new Blob( [ bytes ], { type } ), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' } );
			const canvas = new OffscreenCanvas( bitmap.width, bitmap.height );
			const context = canvas.getContext( '2d', { willReadFrequently: true } );
			context.drawImage( bitmap, 0, 0 );
			bitmap.close?.();
			const { data } = context.getImageData( 0, 0, canvas.width, canvas.height );
			return { width: canvas.width, height: canvas.height, channels: 4, bitDepth: 8, data: new Uint8Array( data.buffer ) };

		} catch {

			// fall through to the JavaScript decoders

		}

	}

	return decodeImage( bytes, type );

}
