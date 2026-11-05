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
