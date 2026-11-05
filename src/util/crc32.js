const TABLE = new Uint32Array( 256 );

for ( let n = 0; n < 256; n ++ ) {

	let c = n;
	for ( let k = 0; k < 8; k ++ ) c = c & 1 ? 0xEDB88320 ^ ( c >>> 1 ) : c >>> 1;
	TABLE[ n ] = c >>> 0;

}

// CRC-32 as used by zip and png. Pass a previous result as crc to continue a running checksum.
export function crc32( bytes, crc = 0 ) {

	crc = ~ crc;
	for ( let i = 0; i < bytes.length; i ++ ) crc = TABLE[ ( crc ^ bytes[ i ] ) & 0xFF ] ^ ( crc >>> 8 );
	return ~ crc >>> 0;

}
