import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUSDA } from '../src/usd/usda/reader.js';
import { writeUSDA } from '../src/usd/usda/writer.js';

const fixtures = [ 'usdc/types.usda', 'usdc/extra.usda', 'usdc/legacy.usda', 'usda/reorder-references.usda' ].map( ( f ) => new URL( `fixtures/${ f }`, import.meta.url ) );

const python = [ '../.venv/Scripts/python.exe', '../.venv/bin/python' ].map( ( p ) => new URL( p, import.meta.url ).pathname.replace( /^\/([A-Za-z]:)/, '$1' ) ).find( existsSync );
let pxr = false;
if ( python ) try { execFileSync( python, [ '-c', 'from pxr import Sdf' ] ); pxr = true; } catch { /* no usd-core */ }

test( 'writing then reading usda is stable', () => {

	for ( const file of fixtures ) {

		const once = writeUSDA( readUSDA( readFileSync( file, 'utf8' ) ) );
		const twice = writeUSDA( readUSDA( once ) );
		assert.equal( twice, once, file.pathname );

	}

} );

test( 'OpenUSD reads our usda exactly as it reads the source', { skip: ! pxr && 'usd-core is not available' }, () => {

	const dir = mkdtempSync( join( tmpdir(), 'usd-gltf-usda-' ) );

	for ( const file of fixtures ) {

		const source = file.pathname.replace( /^\/([A-Za-z]:)/, '$1' );
		const mine = join( dir, source.split( /[\/]/ ).pop() );
		writeFileSync( mine, writeUSDA( readUSDA( readFileSync( file, 'utf8' ) ) ) );
		const script = 'import sys\nfrom pxr import Sdf\na = Sdf.Layer.FindOrOpen(sys.argv[1]).ExportToString()\nb = Sdf.Layer.FindOrOpen(sys.argv[2]).ExportToString()\nprint("same" if a == b else b)';
		const result = execFileSync( python, [ '-c', script, source, mine ], { encoding: 'utf8' } ).trim();
		assert.equal( result, 'same', source );

	}

} );

test( 'reference customData and reorder properties survive', () => {

	const layer = readUSDA( readFileSync( fixtures[ 3 ], 'utf8' ) );
	const prim = layer.getPrimAtPath( '/A' );
	assert.deepEqual( prim.metadata.propertyOrder, [ 'x', 'y' ] );
	const ref = prim.metadata.references.prepended[ 0 ];
	assert.equal( ref.customData.note, 'hello' );
	assert.equal( ref.layerOffset.offset, 2 );
	const text = writeUSDA( layer );
	assert.match( text, /reorder properties = \["x", "y"\]/ );
	assert.match( text, /customData = \{/ );

} );
