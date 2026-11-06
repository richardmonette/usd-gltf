import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readUSDC } from '../src/usd/usdc/reader.js';
import { writeUSDC, CrateWriter } from '../src/usd/usdc/writer.js';
import { compressBlock, decompressBlock, compressFast, decompressFast } from '../src/usd/usdc/lz4.js';
import { compressInts32, decompressInts32, decodeInts64, encodeInts32 } from '../src/usd/usdc/intcompression.js';
import { SPEC, TYPE, floatToHalf, halfToFloat } from '../src/usd/usdc/types.js';
import { AssetPath, DICT_TYPES, Layer, ListOp, PrimSpec, PropertySpec, Reference } from '../src/usd/model.js';
import { writeUSDA } from '../src/usd/usda/writer.js';

const root = path.join( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const fixtures = path.join( root, 'test', 'fixtures', 'usdc' );
const fixture = ( name ) => fs.readFileSync( path.join( fixtures, name ) );

const LEGACY_VERSIONS = [ '0.0.1', '0.1.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0' ];

// Pixar's OpenUSD from the repo venv, when present, is the oracle.
const python = [ '.venv/Scripts/python.exe', '.venv/bin/python' ].map( ( p ) => path.join( root, p ) ).find( ( p ) => fs.existsSync( p ) && hasPxr( p ) );
const noPxr = python ? false : 'needs usd-core in .venv';
const corpus = path.join( root, 'corpus', 'apple' );
const noCorpus = noPxr || ( fs.existsSync( corpus ) ? false : 'needs corpus/apple' );

function hasPxr( exe ) {

	try {

		execFileSync( exe, [ '-I', '-c', 'from pxr import Sdf' ], { stdio: 'ignore' } );
		return true;

	} catch {

		return false;

	}

}

let tmp = null;

function tempDir() {

	if ( tmp === null ) {

		tmp = fs.mkdtempSync( path.join( os.tmpdir(), 'usd-gltf-usdc-' ) );
		process.on( 'exit', () => fs.rmSync( tmp, { recursive: true, force: true } ) );

	}

	return tmp;

}

const PXR_SCRIPT = `
import json, os, sys
cmd = sys.argv[1]
if cmd == 'convert':
    if sys.argv[4] != 'default':
        os.environ['USD_WRITE_NEW_USDC_FILES_AS_VERSION'] = sys.argv[4]
    from pxr import Sdf
    try:
        Sdf.Layer.FindOrOpen(sys.argv[2]).Export(sys.argv[3])
    except Exception:
        pass  # re-reading files older than 0.4.0 fails after they are written
    sys.exit(0)
from pxr import Sdf
def export(p):
    layer = Sdf.Layer.FindOrOpen(p)
    return layer.ExportToString() if layer else None
if cmd == 'compare':
    # the first file against each of the others, by pxr's text export
    a = export(sys.argv[2])
    out = {}
    for p in sys.argv[3:]:
        b = export(p)
        if a == b:
            out[p] = None
        else:
            import difflib
            out[p] = '\\n'.join(list(difflib.unified_diff((a or '').splitlines(), (b or 'unreadable').splitlines(), lineterm='', n=1))[:40])
    print(json.dumps(out))
elif cmd == 'counts':
    layer = Sdf.Layer.FindOrOpen(sys.argv[2])
    counts = {'prims': 0, 'variants': 0, 'properties': 0}
    def visit(p):
        if p == Sdf.Path.absoluteRootPath: return
        if p.IsPrimVariantSelectionPath(): counts['variants'] += 1
        elif p.IsPrimPath(): counts['prims'] += 1
        elif p.IsPropertyPath(): counts['properties'] += 1
    layer.Traverse('/', visit)
    print(json.dumps(counts))
`;

function pxr( ...args ) {

	const script = path.join( tempDir(), 'pxr_oracle.py' );
	if ( ! fs.existsSync( script ) ) fs.writeFileSync( script, PXR_SCRIPT );
	const out = execFileSync( python, [ '-I', script, ...args ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ], maxBuffer: 1 << 26 } );
	return out.trim() ? JSON.parse( out ) : null;

}

function pxrConvert( src, version = 'default' ) {

	const out = path.join( tempDir(), `${ path.basename( src, '.usda' ) }_${ version }.usdc` );
	pxr( 'convert', src, out, version );
	return out;

}

// Asserts pxr exports each file identically to the reference file.
function assertSameAsPxr( reference, ...files ) {

	const result = pxr( 'compare', reference, ...files );
	for ( const file of files ) assert.equal( result[ file ], null, `${ path.basename( file ) } differs from ${ path.basename( reference ) }:\n${ result[ file ] }` );

}

function writeTemp( name, data ) {

	const file = path.join( tempDir(), name );
	fs.writeFileSync( file, data );
	return file;

}

function countSpecs( layer ) {

	const counts = { prims: 0, variants: 0, properties: 0 };

	const visit = ( prim ) => {

		counts.properties += prim.properties.size;

		for ( const child of prim.children.values() ) {

			counts.prims ++;
			visit( child );

		}

		for ( const variants of prim.variantSets.values() ) {

			counts.variants += 1 + variants.size; // the set and its variants

			for ( const variant of variants.values() ) visit( variant );

		}

	};

	visit( layer.root );
	return counts;

}

// Stored (uncompressed) zip entries, which is all usdz allows.
function readStoredZip( bytes ) {

	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	let eocd = bytes.length - 22;
	while ( eocd >= 0 && view.getUint32( eocd, true ) !== 0x06054b50 ) eocd --;

	const entries = new Map();
	let p = view.getUint32( eocd + 16, true );
	const count = view.getUint16( eocd + 10, true );

	for ( let i = 0; i < count; i ++ ) {

		const size = view.getUint32( p + 20, true );
		const nameLength = view.getUint16( p + 28, true );
		const extraLength = view.getUint16( p + 30, true );
		const commentLength = view.getUint16( p + 32, true );
		const local = view.getUint32( p + 42, true );
		const name = new TextDecoder().decode( bytes.subarray( p + 46, p + 46 + nameLength ) );
		const start = local + 30 + view.getUint16( local + 26, true ) + view.getUint16( local + 28, true );
		entries.set( name, bytes.subarray( start, start + size ) );
		p += 46 + nameLength + extraLength + commentLength;

	}

	return entries;

}

// Compression.

test( 'LZ4 block and TfFastCompression round trip', () => {

	let seed = 1;
	const random = () => ( seed = ( Math.imul( seed, 1103515245 ) + 12345 ) >>> 0 ) / 4294967296;

	const inputs = [
		new Uint8Array( 0 ),
		new Uint8Array( [ 1, 2, 3 ] ),
		new Uint8Array( 1000 ).fill( 7 ),
		Uint8Array.from( { length: 5000 }, () => random() * 256 ),
		Uint8Array.from( { length: 100000 }, ( _, i ) => ( i % 97 ) ^ ( random() < 0.05 ? 255 : 0 ) ),
		new TextEncoder().encode( 'primChildren\0properties\0specifier\0typeName\0'.repeat( 50 ) )
	];

	for ( const input of inputs ) {

		const block = compressBlock( input );
		const out = new Uint8Array( input.length );
		assert.equal( decompressBlock( block, 0, block.length, out, 0 ), input.length );
		assert.deepEqual( out, input );
		assert.deepEqual( decompressFast( compressFast( input ), input.length ), input );

	}

	assert.ok( compressBlock( inputs[ 2 ] ).length < 20, 'runs compress' );

} );

test( 'LZ4 decodes an overlapping match', () => {

	// literal 'ab', then a match of length 8 at offset 2
	const block = new Uint8Array( [ 0x24, 97, 98, 2, 0, 0x10, 99 ] );
	const out = new Uint8Array( 11 );
	decompressBlock( block, 0, block.length, out, 0 );
	assert.equal( new TextDecoder().decode( out ), 'ababababab' + 'c' );

} );

test( 'integer coding matches the Sdf_IntegerCompression example', () => {

	const input = [ 123, 124, 125, 100125, 100125, 100126, 100126 ];
	const encoded = encodeInts32( input );
	// common value 1, codes 01 00 00 11 | 01 00 01, then int8(123) int32(100000) int8(0) int8(0)
	assert.deepEqual( [ ...encoded ], [ 1, 0, 0, 0, 0b11000001, 0b00010001, 123, 0xa0, 0x86, 0x01, 0x00, 0, 0 ] );
	assert.deepEqual( [ ...decompressInts32( compressInts32( input ), input.length ) ], input );

} );

test( 'integer coding round trips signed, unsigned and empty lists', () => {

	const values = Int32Array.from( { length: 3000 }, ( _, i ) => i % 7 === 0 ? - i * 1000 : i % 5 === 0 ? 2147483647 - i : i );
	assert.deepEqual( decompressInts32( compressInts32( values ), values.length ), values );

	const unsigned = Uint32Array.from( [ 0, 4294967295, 1, 3000000000 ] );
	assert.deepEqual( new Uint32Array( decompressInts32( compressInts32( unsigned ), 4 ).buffer ), unsigned );
	assert.deepEqual( decompressInts32( compressInts32( [] ), 0 ), new Int32Array( 0 ) );

} );

test( '64 bit integer decoding', () => {

	// common value 1; codes: common, int16 -5, int32 70000, int64 2^40
	const bytes = new Uint8Array( 8 + 1 + 2 + 4 + 8 );
	const view = new DataView( bytes.buffer );
	view.setBigInt64( 0, 1n, true );
	bytes[ 8 ] = 0 | ( 1 << 2 ) | ( 2 << 4 ) | ( 3 << 6 );
	view.setInt16( 9, - 5, true );
	view.setInt32( 11, 70000, true );
	view.setBigInt64( 15, 2n ** 40n, true );
	assert.deepEqual( [ ...decodeInts64( bytes, 4 ) ], [ 1, - 4, 69996, 69996 + 2 ** 40 ] );

} );

test( 'half floats', () => {

	for ( const v of [ 0, 1, - 2, 0.5, 65504, 6.103515625e-05, 5.960464477539063e-08, 0.333251953125 ] ) assert.equal( halfToFloat( floatToHalf( v ) ), v );
	assert.equal( floatToHalf( 1 ), 0x3c00 );
	assert.equal( floatToHalf( 1 / 3 ), 0x3555 );
	assert.equal( halfToFloat( floatToHalf( 1e6 ) ), Infinity );
	assert.ok( Number.isNaN( halfToFloat( floatToHalf( NaN ) ) ) );
	assert.ok( Object.is( halfToFloat( floatToHalf( - 0 ) ), - 0 ) );

} );

// Reading (fixtures written by Pixar's usd-core 26.11 from the .usda files next to them).

test( 'readUSDC decodes every value type', () => {

	const layer = readUSDC( fixture( 'types.usdc' ), 'types.usdc' );
	const world = layer.getPrimAtPath( '/World' );
	const value = ( name ) => world.properties.get( name ).default;
	const close = ( a, b ) => assert.ok( Math.abs( a - b ) < 1e-6, `${ a } != ${ b }` );

	assert.equal( layer.identifier, 'types.usdc' );
	assert.equal( layer.metadata.defaultPrim, 'World' );
	assert.equal( layer.metadata.upAxis, 'Y' );
	assert.equal( layer.metadata.metersPerUnit, 0.01 );
	assert.equal( layer.metadata.doc, 'Layer documentation' );
	assert.deepEqual( layer.metadata.subLayers, [ './sub1.usda', './sub2.usda' ] );
	assert.deepEqual( layer.metadata.subLayerOffsets, [ { offset: 2, scale: 0.5 }, { offset: 0, scale: 1 } ] );

	const cld = layer.metadata.customLayerData;
	assert.equal( cld.author, 'test' );
	assert.equal( cld.d, 0.1 );
	assert.equal( cld.i, - 7 );
	assert.equal( cld.b, true );
	assert.deepEqual( cld.a, new AssetPath( 'x.png' ) );
	assert.deepEqual( cld.names, [ 'a', 'b' ] );
	assert.deepEqual( cld.floats, new Float32Array( [ 1.5, 2.5 ] ) );
	assert.deepEqual( cld.m, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1 ] );
	assert.deepEqual( cld.nested, { f: 1.5, t: 'tok', v: [ 1, 2, 3 ] } );
	assert.deepEqual( cld[ DICT_TYPES ], { a: 'asset', author: 'string', b: 'bool', d: 'double', floats: 'float[]', i: 'int', m: 'matrix4d', names: 'string[]', nested: 'dictionary' } );
	assert.deepEqual( cld.nested[ DICT_TYPES ], { f: 'float', t: 'token', v: 'int3' } );

	assert.deepEqual( [ ...layer.root.children.keys() ], [ 'Base', 'World', 'Over', 'SinglePayload', 'InternalPayload', 'AppendRefs' ] );
	assert.equal( layer.getPrimAtPath( '/Base' ).specifier, 'class' );
	assert.equal( layer.getPrimAtPath( '/Over' ).specifier, 'over' );

	// prim metadata
	assert.equal( world.typeName, 'Xform' );
	assert.equal( world.metadata.kind, 'assembly' );
	assert.equal( world.metadata.documentation, 'The world' );
	assert.equal( world.metadata.hidden, false );
	assert.deepEqual( world.metadata.apiSchemas, new ListOp( { prepended: [ 'MaterialBindingAPI', 'GeomModelAPI' ] } ) );
	assert.deepEqual( world.metadata.inherits, ListOp.explicit( [ '/Base' ] ) );
	assert.deepEqual( world.metadata.specializes, ListOp.explicit( [ '/Base' ] ) );
	assert.deepEqual( world.metadata.references, new ListOp( { prepended: [ new Reference( './ref.usda', '/Ref', { offset: 1, scale: 2 } ), new Reference( '', '/Base' ) ] } ) );
	assert.deepEqual( world.metadata.payload, new ListOp( { prepended: [ new Reference( './payload.usda', '/P' ) ] } ) );
	assert.deepEqual( world.metadata.variants, { shading: 'red', size: 'big' } );
	assert.deepEqual( world.metadata.variantSetNames, new ListOp( { prepended: [ 'shading', 'size' ] } ) );
	assert.deepEqual( world.metadata.primOrder, [ 'Mesh', 'Looks' ] );
	assert.deepEqual( { ...world.metadata.customData }, { count: 3 } );
	assert.deepEqual( world.metadata.assetInfo, { identifier: new AssetPath( './World.usd' ), name: 'World' } );
	assert.deepEqual( layer.getPrimAtPath( '/World/Mesh' ).metadata, { active: false, instanceable: true, propertyOrder: [ 'faceVertexIndices', 'faceVertexCounts' ] } );

	// a single SdfPayload becomes an explicit list op; an empty one an explicit empty list
	assert.deepEqual( layer.getPrimAtPath( '/SinglePayload' ).metadata.payload, ListOp.explicit( [ new Reference( './single.usda', '' ) ] ) );
	assert.deepEqual( layer.getPrimAtPath( '/InternalPayload' ).metadata.payload, ListOp.explicit( [ new Reference( '', '/World' ) ] ) );
	assert.deepEqual( layer.getPrimAtPath( '/Over' ).metadata.payload, ListOp.explicit( [] ) );
	assert.deepEqual( layer.getPrimAtPath( '/Over' ).metadata.references, ListOp.explicit( [] ) );

	const appendRefs = layer.getPrimAtPath( '/AppendRefs' ).metadata;
	assert.deepEqual( appendRefs.references.appended, [ new Reference( './a.usda', '', { offset: 0, scale: 1 }, { why: 'because' } ) ] );
	assert.deepEqual( appendRefs.references.deleted, [ new Reference( './old.usda', '' ) ] );
	assert.deepEqual( appendRefs.apiSchemas.added, [ 'Added' ] );

	// scalars, inlined and not
	assert.equal( value( 'b' ), true );
	assert.equal( value( 'uc' ), 200 );
	assert.equal( value( 'i' ), - 123456 );
	assert.equal( value( 'smallInt' ), 5 );
	assert.equal( value( 'ui' ), 4000000000 );
	assert.equal( value( 'i64' ), - 9000000000 );
	assert.equal( value( 'i64small' ), 12 );
	assert.equal( value( 'u64' ), 9000000000 );
	assert.equal( value( 'h' ), 1.5 );
	assert.equal( value( 'f' ), 0.25 );
	assert.equal( value( 'd' ), 0.1 );
	assert.equal( value( 'dExact' ), 0.5 );
	assert.equal( value( 'tc' ), 12.5 );
	assert.equal( value( 's' ), 'hello "world"' );
	assert.equal( value( 't' ), 'myToken' );
	assert.deepEqual( value( 'a' ), new AssetPath( './textures/a.png' ) );
	assert.deepEqual( value( 'm2' ), [ 1, 2, 3, 4 ] );
	assert.deepEqual( value( 'm3' ), [ 1, 0, 0, 0, 2, 0, 0, 0, 3 ] );
	assert.deepEqual( value( 'm4' ), [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10.5, 20, 30, 1 ] );
	assert.deepEqual( value( 'm4id' ), [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );
	assert.deepEqual( value( 'qd' ), [ 2, 3, 4, 1 ] );
	assert.deepEqual( value( 'qf' ), [ 0.25, 0.125, 1, 0.5 ] );
	assert.deepEqual( value( 'qh' ), [ 0, 0, 0, 1 ] );
	assert.deepEqual( value( 'd2' ), [ 1.5, 2.5 ] );
	assert.deepEqual( value( 'd3' ), [ 1, 2, 3 ] );
	assert.deepEqual( value( 'd4' ), [ 0.1, 0.2, 0.3, 0.4 ] );
	assert.deepEqual( value( 'f2' ), [ 1, - 2 ] );
	value( 'f3' ).forEach( ( v, i ) => close( v, [ 0.1, 0.2, 0.3 ][ i ] ) );
	assert.deepEqual( value( 'f4' ), [ 1, 2, 3, 400 ] );
	assert.deepEqual( value( 'h2' ), [ 1.5, - 2 ] );
	assert.deepEqual( value( 'h3' ), [ 0.5, 1, 2 ] );
	assert.deepEqual( value( 'h4' ), [ 1, 2, 3, 4 ] );
	assert.deepEqual( value( 'i2' ), [ 1, 2 ] );
	assert.deepEqual( value( 'i3' ), [ 1000, 2, 3 ] );
	assert.deepEqual( value( 'i4' ), [ 1, 2, 3, 4 ] );
	assert.deepEqual( value( 'p' ), [ 1, 2, 3 ] );
	assert.deepEqual( value( 'v' ), [ 1, 0.5, 0.25 ] );
	assert.equal( value( 'blocked' ), null );

	const u = world.properties.get( 'u' );
	assert.equal( u.custom, true );
	assert.equal( u.variability, 'uniform' );
	assert.equal( u.typeName, 'token' );
	assert.deepEqual( u.metadata.allowedTokens, [ 'uniformValue', 'other' ] );
	assert.equal( u.metadata.displayName, 'Nice name' );
	assert.equal( u.metadata.displayGroup, 'group' );
	assert.equal( u.metadata.documentation, 'property doc' );
	assert.equal( u.metadata.hidden, true );
	assert.deepEqual( { ...u.metadata.customData }, { note: 'n' } );

	// arrays, including integer, lookup table and raw compressed encodings
	assert.deepEqual( value( 'ba' ), [ true, false, true ] );
	assert.deepEqual( value( 'uca' ), new Uint8Array( [ 1, 2, 255 ] ) );
	assert.deepEqual( value( 'ia' ), new Int32Array( [ 1, 2, 3 ] ) );
	assert.deepEqual( value( 'iaBig' ), new Int32Array( [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, - 100000, 70000, 3, 3, 3, 3 ] ) );
	assert.deepEqual( value( 'empty' ), new Int32Array( 0 ) );
	assert.deepEqual( value( 'uia' ), new Uint32Array( [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 4000000000 ] ) );
	assert.deepEqual( value( 'i64a' ), new Float64Array( [ 1, - 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 9000000000 ] ) );
	assert.deepEqual( value( 'u64a' ), new Float64Array( [ 1, 2, 9000000000 ] ) );
	assert.deepEqual( value( 'ha' ), Float32Array.from( { length: 17 }, ( _, i ) => ( i + 1 ) / 2 ) );
	assert.deepEqual( value( 'fInts' ), new Float32Array( [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, - 17 ] ) );
	assert.deepEqual( value( 'fLut' ), new Float32Array( [ ...Array( 8 ).fill( [ 0.5, 0.25 ] ).flat(), 0.75 ] ) );
	assert.deepEqual( value( 'fRaw' ), new Float32Array( [ 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8 ] ) );
	assert.deepEqual( value( 'da' ), new Float64Array( [ 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8 ] ) );
	assert.deepEqual( value( 'daInts' ), Float64Array.from( { length: 17 }, ( _, i ) => i + 1 ) );
	assert.deepEqual( value( 'tca' ), new Float64Array( [ 1, 2.5 ] ) );
	assert.deepEqual( value( 'sa' ), [ 'a', 'b', 'a' ] );
	assert.deepEqual( value( 'ta' ), [ 'x', 'y' ] );
	assert.deepEqual( value( 'aa' ), [ new AssetPath( 'a.png' ), new AssetPath( 'b.png' ) ] );
	assert.deepEqual( value( 'm4a' ), new Float64Array( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1 ] ) );
	assert.deepEqual( value( 'qfa' ), new Float32Array( [ 0, 0, 0, 1, 0.5, 0.5, 0.5, 0.5 ] ) );
	assert.deepEqual( value( 'qha' ), new Float32Array( [ 0, 0, 0, 1, 1, 0, 0, 0 ] ) );
	assert.deepEqual( value( 'qda' ), new Float64Array( [ 0, 0, 0, 1 ] ) );
	assert.deepEqual( value( 'points' ), new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0.25, 0.125 ] ) );
	assert.deepEqual( value( 'nh' ), new Float32Array( [ 0, 1, 0 ] ) );
	assert.deepEqual( value( 'i2a' ), new Int32Array( [ 1, 2, 3, 4 ] ) );
	assert.deepEqual( value( 'd3a' ), new Float64Array( [ 1, 2, 3 ] ) );
	assert.deepEqual( value( 'xformOpOrder' ), [ 'xformOp:translate', 'xformOp:rotateY' ] );
	assert.equal( world.properties.get( 'xformOpOrder' ).variability, 'uniform' );

	const st = world.properties.get( 'primvars:st' );
	assert.equal( st.typeName, 'texCoord2f[]' );
	assert.deepEqual( st.metadata, { elementSize: 1, interpolation: 'faceVarying' } );

	// time samples, sharing one times array, with blocks
	assert.deepEqual( world.properties.get( 'xformOp:translate' ).timeSamples, new Map( [ [ 1, [ 0, 0, 0 ] ], [ 2, [ 1, 2, 3 ] ], [ 3, null ], [ 4, [ 4, 5, 6 ] ] ] ) );
	assert.deepEqual( world.properties.get( 'xformOp:rotateY' ).timeSamples, new Map( [ [ 1, 0 ], [ 2, 90 ], [ 3, 180 ], [ 4, 270 ] ] ) );
	assert.deepEqual( world.properties.get( 'animPoints' ).timeSamples, new Map( [ [ 0.5, new Float32Array( [ 0, 0, 0, 1, 1, 1 ] ) ], [ 1.5, new Float32Array( [ 2, 2, 2, 3, 3, 3 ] ) ] ] ) );
	assert.equal( world.properties.get( 'both' ).default, 1 );
	assert.deepEqual( world.properties.get( 'both' ).timeSamples, new Map( [ [ 0, 5 ] ] ) );
	assert.equal( world.properties.get( 'animPoints' ).default, undefined );

	// relationships and connections
	const binding = world.properties.get( 'material:binding' );
	assert.equal( binding.type, 'relationship' );
	assert.deepEqual( binding.targets, ListOp.explicit( [ '/World/Looks/Mat' ] ) );
	assert.equal( world.properties.get( 'noTargets' ).targets, null );
	assert.deepEqual( world.properties.get( 'listRel' ).targets, new ListOp( { prepended: [ '/World/A', '/World/B' ], appended: [ '/World/D' ], deleted: [ '/World/C' ] } ) );
	assert.deepEqual( world.properties.get( 'customRel' ).targets, ListOp.explicit( [] ) );
	assert.equal( world.properties.get( 'customRel' ).custom, true );
	assert.deepEqual( world.properties.get( 'inputs:diffuseColor' ).connections, ListOp.explicit( [ '/World/Looks/Mat/Shader.outputs:rgb' ] ) );
	assert.deepEqual( world.properties.get( 'connected' ).connections, new ListOp( { prepended: [ '/World/Looks/Mat/Shader.outputs:r' ] } ) );
	assert.deepEqual( layer.getPrimAtPath( '/World/Looks/Mat' ).properties.get( 'outputs:surface' ).connections, ListOp.explicit( [ '/World/Looks/Mat/Shader.outputs:surface' ] ) );

	// ordering follows primChildren / properties, not spec order
	assert.deepEqual( [ ...world.children.keys() ], [ 'Looks', 'Mesh' ] );
	assert.deepEqual( [ ...layer.getPrimAtPath( '/World/Mesh' ).properties.keys() ], [ 'faceVertexCounts', 'faceVertexIndices' ] );
	assert.deepEqual( [ ...world.properties.keys() ].slice( 0, 4 ), [ 'b', 'uc', 'i', 'smallInt' ] );
	assert.deepEqual( [ ...layer.getPrimAtPath( '/World/Looks/Mat/Shader' ).properties.keys() ], [ 'info:id', 'outputs:surface', 'outputs:rgb', 'outputs:r' ] );

	// variants
	assert.deepEqual( [ ...world.variantSets.keys() ], [ 'shading', 'size' ] );
	assert.deepEqual( [ ...world.variantSets.get( 'shading' ).keys() ], [ 'blue', 'red' ] );
	assert.deepEqual( [ ...world.variantSets.get( 'size' ).keys() ], [ 'big', 'small' ] );
	const blue = layer.getPrimAtPath( '/World{shading=blue}' );
	assert.ok( blue instanceof PrimSpec );
	assert.equal( blue.specifier, 'over' );
	assert.deepEqual( { ...blue.metadata.customData }, { v: 'blue' } );
	assert.deepEqual( blue.properties.get( 'color' ).default, [ 0, 0, 1 ] );
	assert.equal( layer.getPrimAtPath( '/World{shading=blue}Looks' ).properties.get( 'inVariant' ).default, 2 );
	assert.equal( layer.getPrimAtPath( '/World{shading=red}{nested=a}' ).properties.get( 'deep' ).default, 1 );
	assert.deepEqual( layer.getPrimAtPath( '/World{size=small}' ).properties.get( 'xformOp:scale' ).default, [ 0.5, 0.5, 0.5 ] );
	assert.equal( layer.getPrimAtPath( '/World{size=big}' ).properties.size, 0 );

	assert.deepEqual( countSpecs( layer ), { prims: 11, variants: 8, properties: 96 } );

} );

test( 'readUSDC reads crate versions 0.0.1 through 0.8.0 identically', () => {

	const expected = readUSDC( fixture( 'legacy_0.8.0.usdc' ) );
	const root = expected.getPrimAtPath( '/Root' );
	assert.deepEqual( root.properties.get( 'big' ).default.slice( 18, 22 ), new Int32Array( [ 18, 19, - 100000, 70000 ] ) );
	assert.deepEqual( root.properties.get( 'hLut' ).default, Float32Array.from( { length: 18 }, ( _, i ) => i % 2 ? 1 : 0.5 ) );
	assert.deepEqual( root.properties.get( 'uv' ).default, new Float32Array( [ 0, 0.5, 1, 1 ] ) );
	assert.deepEqual( root.metadata.payload, ListOp.explicit( [ new Reference( './payload.usda', '' ) ] ) );
	assert.deepEqual( root.metadata.references, ListOp.explicit( [ new Reference( './ref.usda', '/R' ) ] ) );
	assert.deepEqual( [ ...root.variantSets.get( 'look' ).keys() ], [ 'a', 'b' ] );

	for ( const version of LEGACY_VERSIONS ) {

		const bytes = fixture( `legacy_${ version }.usdc` );
		assert.equal( [ ...bytes.subarray( 8, 11 ) ].join( '.' ), version );
		assert.deepEqual( readUSDC( bytes ), expected, `version ${ version }` );

	}

} );

test( 'readUSDC reads path expressions, relocates and payload layer offsets', () => {

	const layer = readUSDC( fixture( 'extra.usdc' ) );
	const a = layer.getPrimAtPath( '/A' );
	assert.equal( fixture( 'extra.usdc' )[ 9 ], 11 );
	assert.deepEqual( layer.metadata.layerRelocates, [ [ '/A/B', '/A/C' ] ] );
	assert.deepEqual( a.metadata.payload, ListOp.explicit( [ new Reference( './p.usda', '/P', { offset: 3, scale: 2 } ) ] ) );
	assert.equal( a.properties.get( 'pe' ).default, '/A//*' );
	assert.deepEqual( a.properties.get( 'pea' ).default, [ '/A', '/B' ] );
	assert.deepEqual( a.properties.get( 'tc' ).default, new Float64Array( [ 1, 2.5 ] ) );

} );

test( 'readUSDC skips unsupported value types with one warning', ( t ) => {

	const warn = t.mock.method( console, 'warn', () => {} );
	const bytes = fixture( 'spline.usdc' );
	assert.equal( bytes[ 9 ], 12 );

	const attr = readUSDC( bytes ).getPrimAtPath( '/A' ).properties.get( 'splineAttr' );
	assert.equal( attr.default, 4 );
	assert.equal( attr.metadata.spline, undefined );
	readUSDC( bytes );
	assert.equal( warn.mock.callCount(), 1 );

} );

test( 'readUSDC rejects other data', () => {

	assert.throws( () => readUSDC( new TextEncoder().encode( '#usda 1.0\n' ) ), /not a usdc/ );
	assert.throws( () => readUSDC( fixture( 'types.usdc' ).subarray( 0, 200 ) ), /truncated|corrupt|out of bounds|Offset/i );

} );

// Writing.

test( 'writeUSDC round trips through readUSDC', () => {

	for ( const name of [ 'types.usdc', 'extra.usdc', 'legacy_0.0.1.usdc' ] ) {

		const layer = readUSDC( fixture( name ) );
		const bytes = writeUSDC( layer );
		assert.equal( new TextDecoder().decode( bytes.subarray( 0, 8 ) ), 'PXR-USDC' );
		assert.deepEqual( readUSDC( bytes ), layer, name );

	}

	// timecode needs 0.9.0, relocates 0.11.0
	assert.equal( writeUSDC( readUSDC( fixture( 'types.usdc' ) ) )[ 9 ], 9 );
	assert.equal( writeUSDC( readUSDC( fixture( 'extra.usdc' ) ) )[ 9 ], 11 );
	assert.equal( writeUSDC( readUSDC( fixture( 'legacy_0.8.0.usdc' ) ) )[ 9 ], 8 );

} );

test( 'writeUSDC compresses large arrays and keeps their values', () => {

	const layer = readUSDC( writeUSDC( readUSDC( fixture( 'types.usdc' ) ) ) );
	const mesh = layer.getPrimAtPath( '/World/Mesh' );
	const n = 200000;
	const indices = Int32Array.from( { length: n }, ( _, i ) => ( i * 7 ) % 1000 );
	const points = Float32Array.from( { length: n * 3 }, ( _, i ) => Math.sin( i ) );
	const halves = Float32Array.from( { length: n }, ( _, i ) => ( i % 5 ) / 4 );
	mesh.properties.get( 'faceVertexIndices' ).default = indices;
	mesh.properties.get( 'faceVertexCounts' ).default = new Int32Array( n / 4 ).fill( 4 );
	const add = ( name, typeName, value ) => {

		const prop = mesh.addProperty( new PropertySpec( name ) );
		prop.typeName = typeName;
		prop.default = value;

	};

	add( 'points', 'point3f[]', points );
	add( 'halves', 'half[]', halves );
	add( 'doubles', 'double[]', Float64Array.from( halves ) );

	const bytes = writeUSDC( layer );
	assert.ok( bytes.length < n * 4 * 3 + n * 2, `${ bytes.length } bytes` );

	const out = readUSDC( bytes ).getPrimAtPath( '/World/Mesh' );
	assert.deepEqual( out.properties.get( 'faceVertexIndices' ).default, indices );
	assert.deepEqual( out.properties.get( 'points' ).default, points );
	assert.deepEqual( out.properties.get( 'halves' ).default, halves );
	assert.deepEqual( out.properties.get( 'doubles' ).default, Float64Array.from( halves ) );
	assert.equal( out.properties.get( 'faceVertexCounts' ).default.length, n / 4 );

} );

test( 'writeUSDC honours DICT_TYPES and infers dictionary value types', () => {

	const layer = readUSDC( fixture( 'legacy_0.8.0.usdc' ) );
	const dict = { f: 1.5, t: 'tok', v: [ 1, 2, 3 ], s: 'str', n: 3, d: 0.25, b: true, a: new AssetPath( 'x.png' ), sub: { k: 'v' } };
	Object.defineProperty( dict, DICT_TYPES, { value: { f: 'float', t: 'token', v: 'float3' } } );
	layer.metadata.customLayerData = dict;

	const out = readUSDC( writeUSDC( layer ) ).metadata.customLayerData;
	assert.deepEqual( out, { ...dict, sub: { k: 'v' } } );
	assert.deepEqual( out[ DICT_TYPES ], { f: 'float', t: 'token', v: 'float3', s: 'string', n: 'int', d: 'double', b: 'bool', a: 'asset', sub: 'dictionary' } );

} );

test( 'writeUSDC writes every list op type', () => {

	const w = new CrateWriter();
	const fields = [
		[ 'ints', w.pack( new ListOp( { prepended: [ 1, - 2 ], deleted: [ 3 ] } ), TYPE.IntListOp ) ],
		[ 'uints', w.pack( ListOp.explicit( [ 4000000000 ] ), TYPE.UIntListOp ) ],
		[ 'int64s', w.pack( new ListOp( { appended: [ - 9000000000 ] } ), TYPE.Int64ListOp ) ],
		[ 'uint64s', w.pack( new ListOp( { added: [ 9000000000 ], ordered: [ 1 ] } ), TYPE.UInt64ListOp ) ],
		[ 'tokens', w.pack( new ListOp( { prepended: [ 'a' ] } ), TYPE.TokenListOp ) ],
		[ 'strings', w.pack( ListOp.explicit( [] ), TYPE.StringListOp ) ],
		[ 'paths', w.pack( ListOp.explicit( [ '/X/Y.z' ] ), TYPE.PathListOp ) ],
		[ 'payloads', w.pack( new ListOp( { deleted: [ new Reference( 'p.usda', '/P', { offset: 1, scale: 1 } ) ] } ), TYPE.PayloadListOp ) ],
		[ 'payload', w.pack( new Reference( 'single.usda', '/S' ), TYPE.Payload ) ],
		[ 'pathVector', w.pack( [ '/X', '/X/Y' ], TYPE.PathVector ) ],
		[ 'doubles', w.pack( [ 1.5, 2 ], TYPE.DoubleVector ) ],
		[ 'permission', w.pack( 'private', TYPE.Permission ) ]
	];
	w.addSpec( '/', SPEC.PseudoRoot, [ [ 'primChildren', w.pack( [ 'X' ], TYPE.TokenVector ) ] ] );
	w.addSpec( '/X', SPEC.Prim, [ [ 'specifier', w.pack( 'def', TYPE.Specifier ) ], ...fields ] );

	const meta = readUSDC( w.finish() ).getPrimAtPath( '/X' ).metadata;
	assert.deepEqual( meta.ints, new ListOp( { prepended: [ 1, - 2 ], deleted: [ 3 ] } ) );
	assert.deepEqual( meta.uints, ListOp.explicit( [ 4000000000 ] ) );
	assert.deepEqual( meta.int64s, new ListOp( { appended: [ - 9000000000 ] } ) );
	assert.deepEqual( meta.uint64s, new ListOp( { added: [ 9000000000 ], ordered: [ 1 ] } ) );
	assert.deepEqual( meta.tokens, new ListOp( { prepended: [ 'a' ] } ) );
	assert.deepEqual( meta.strings, ListOp.explicit( [] ) );
	assert.deepEqual( meta.paths, ListOp.explicit( [ '/X/Y.z' ] ) );
	assert.deepEqual( meta.payloads, new ListOp( { deleted: [ new Reference( 'p.usda', '/P', { offset: 1, scale: 1 } ) ] } ) );
	assert.deepEqual( meta.payload, ListOp.explicit( [ new Reference( 'single.usda', '/S' ) ] ) );
	assert.deepEqual( meta.pathVector, [ '/X', '/X/Y' ] );
	assert.deepEqual( meta.doubles, [ 1.5, 2 ] );
	assert.equal( meta.permission, 'private' );

} );

// Against Pixar's OpenUSD.

test( 'pxr reads what writeUSDC writes, for every crate version pxr writes', { skip: noPxr }, () => {

	for ( const name of [ 'types', 'legacy', 'extra' ] ) {

		const src = path.join( fixtures, `${ name }.usda` );
		const versions = name === 'legacy' ? [ ...LEGACY_VERSIONS, 'default' ] : [ 'default', '0.16.0' ];
		const outputs = [];

		for ( const version of versions ) {

			const crate = pxrConvert( src, version );
			const layer = readUSDC( fs.readFileSync( crate ) );
			outputs.push( writeTemp( `${ name }_${ version }.ours.usdc`, writeUSDC( layer ) ) );

			if ( name === 'legacy' ) outputs.push( writeTemp( `${ name }_${ version }.ours.usda`, writeUSDA( layer ) ) );

		}

		assertSameAsPxr( src, ...outputs );

	}

} );

test( 'readUSDC and writeUSDC match pxr on every Apple AR Quick Look layer', { skip: noCorpus, timeout: 600000 }, () => {

	const files = fs.readdirSync( corpus ).filter( ( f ) => f.endsWith( '.usdz' ) );
	let layers = 0;

	for ( const file of files ) {

		for ( const [ name, bytes ] of readStoredZip( fs.readFileSync( path.join( corpus, file ) ) ) ) {

			if ( ! /\.usdc?$/.test( name ) || new TextDecoder().decode( bytes.subarray( 0, 8 ) ) !== 'PXR-USDC' ) continue;

			const base = path.basename( name ).replace( /\.usdc?$/, '' );
			const original = writeTemp( `${ base }.usdc`, bytes );
			const layer = readUSDC( bytes, name );

			assert.deepEqual( countSpecs( layer ), pxr( 'counts', original ), `${ file } ${ name } spec counts` );

			const ours = writeTemp( `${ base }.ours.usdc`, writeUSDC( layer ) );
			const text = writeTemp( `${ base }.ours.usda`, writeUSDA( layer ) );
			assertSameAsPxr( original, ours, text );
			layers ++;

		}

	}

	assert.ok( layers >= files.length, `${ layers } layers in ${ files.length } files` );

} );

test( 'identical arrays are stored once', () => {

	const layer = ( copies ) => {

		const root = new PrimSpec( 'Mesh', 'def', 'Mesh' );
		const points = Float32Array.from( { length: 3000 }, ( _, i ) => Math.sin( i ) );
		for ( let i = 0; i < copies; i ++ ) {

			const p = root.addProperty( new PropertySpec( 'primvars:copy' + i, 'attribute' ) );
			p.typeName = 'float3[]';
			p.default = i === copies - 1 ? points : Float32Array.from( points ); // equal values, separate arrays

		}

		const negative = root.addProperty( new PropertySpec( 'primvars:negativeZero', 'attribute' ) );
		negative.typeName = 'float3[]';
		negative.default = Float32Array.from( points, ( v, i ) => i === 0 ? - 0 : v ); // sin( 0 ) is +0
		const l = new Layer();
		l.root.children.set( 'Mesh', root );
		return l;

	};

	const one = writeUSDC( layer( 1 ) ), four = writeUSDC( layer( 4 ) );
	assert.ok( four.length - one.length < 1000, `${ one.length } vs ${ four.length }` );

	const back = readUSDC( four ).root.children.get( 'Mesh' );
	for ( let i = 0; i < 4; i ++ ) assert.equal( back.properties.get( 'primvars:copy' + i ).default.length, 3000 );
	assert.ok( Object.is( back.properties.get( 'primvars:negativeZero' ).default[ 0 ], - 0 ), 'values differing only by -0 are kept apart' );

} );
