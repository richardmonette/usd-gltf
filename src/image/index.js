import { decodePNG, encodePNG } from './png.js';
import { decodeJPEG } from './jpeg.js';

export { decodePNG, encodePNG, decodeJPEG };
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
 * Decodes a PNG or JPEG. The format is sniffed from the bytes; mimeType is only a fallback.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} [mimeType]
 * @returns {{ width: number, height: number, channels: number, bitDepth: number, data: Uint8Array|Uint16Array }}
 */
export function decodeImage( bytes, mimeType ) {

	bytes = toBytes( bytes );
	const type = imageMimeType( bytes ) || mimeType;

	if ( type === 'image/png' ) return decodePNG( bytes );
	if ( type === 'image/jpeg' || type === 'image/jpg' ) return decodeJPEG( bytes );
	throw new Error( `usd-gltf: cannot decode ${ type || 'unknown' } image` );

}

const hasNativeDecoder = typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';

/**
 * Decodes with the platform's image decoder where there is one (browsers and workers), which is
 * faster and supports more formats, falling back to the JavaScript decoders (Node).
 * Canvas pixels are 8 bit RGBA with premultiplied storage, so alpha below 1 can lose precision.
 * @param {Uint8Array} bytes
 * @param {string} [mimeType]
 * @param {( bytes: Uint8Array, mimeType?: string ) => Promise<object>|object} [decoder] overrides both
 */
export async function decodeImageAsync( bytes, mimeType, decoder = null ) {

	bytes = toBytes( bytes );
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
