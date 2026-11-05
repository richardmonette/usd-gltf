#!/usr/bin/env node
// Downloads the acceptance corpora into corpus/ (gitignored):
//   corpus/apple    every model on https://developer.apple.com/augmented-reality/quick-look/
//   corpus/khronos  the glTF and glTF-Binary variants of https://github.com/KhronosGroup/glTF-Sample-Assets

import { mkdir, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

const root = new URL( '../corpus/', import.meta.url ).pathname.replace( /^\/([A-Za-z]:)/, '$1' );
const only = process.argv[ 2 ]; // optional: 'apple' or 'khronos'

async function exists( path ) {

	try { await access( path ); return true; } catch { return false; }

}

async function fetchApple() {

	const dir = join( root, 'apple' );
	await mkdir( dir, { recursive: true } );

	const page = await ( await fetch( 'https://developer.apple.com/augmented-reality/quick-look/' ) ).text();
	const paths = [ ...new Set( page.match( /\/quick-look-gallery\/models\/[^"' ]+\.(?:usdz|reality)/g ) ) ];

	for ( const path of paths ) {

		const file = join( dir, basename( path ) );
		if ( await exists( file ) ) continue;
		const res = await fetch( 'https://developer.apple.com' + path );
		if ( ! res.ok ) throw new Error( `${ res.status } ${ path }` );
		await writeFile( file, new Uint8Array( await res.arrayBuffer() ) );
		console.log( 'apple', basename( path ) );

	}

}

function fetchKhronos() {

	const dir = join( root, 'khronos' );
	const git = ( ...args ) => execFileSync( 'git', args, { cwd: dir, stdio: 'inherit' } );

	execFileSync( 'git', [ 'clone', '--depth=1', '--filter=blob:none', '--no-checkout', 'https://github.com/KhronosGroup/glTF-Sample-Assets.git', dir ], { stdio: 'inherit' } );
	git( 'sparse-checkout', 'set', '--no-cone', '/Models/model-index.json', '/Models/*/glTF/', '/Models/*/glTF-Binary/', '/Models/*/glTF-Embedded/' );
	git( 'checkout' );

}

if ( ! only || only === 'apple' ) await fetchApple();
if ( ( ! only || only === 'khronos' ) && ! await exists( join( root, 'khronos', '.git' ) ) ) fetchKhronos();
