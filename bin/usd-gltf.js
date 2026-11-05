#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { detectFormat, usdToGLB, glbToUSD } from '../src/index.js';

const [ input, output ] = process.argv.slice( 2 );

if ( ! input || ! output ) {

	console.error( 'usage: usd-gltf <input.usd[a|c|z]|input.glb|input.gltf> <output.glb|output.usd[a|c|z]>' );
	process.exit( 1 );

}

const data = await readFile( input );
const from = detectFormat( data );
const to = extname( output ).slice( 1 ).toLowerCase();

// files referenced by relative paths (gltf buffers and textures, usd sublayers and references)
const dir = dirname( resolve( input ) );
const resolver = ( path ) => readFile( resolve( dir, path ) );
const log = ( message ) => console.warn( `warning: ${ message }` );

let result;

try {

	if ( from === 'usda' || from === 'usdc' || from === 'usdz' ) {

		if ( to !== 'glb' ) throw new Error( `cannot write .${ to } from USD, use .glb` );
		result = await usdToGLB( data, { identifier: resolve( input ).replace( /\\/g, '/' ), resolver, log } );

	} else if ( from === 'glb' || from === 'gltf' ) {

		const format = to === 'usd' ? 'usdc' : to;
		if ( format !== 'usda' && format !== 'usdc' && format !== 'usdz' ) throw new Error( `cannot write .${ to } from glTF, use .usda, .usdc or .usdz` );
		result = await glbToUSD( data, { format, resolver, log } );

	} else {

		throw new Error( `${ basename( input ) } is not a USD or glTF file` );

	}

} catch ( e ) {

	console.error( `usd-gltf: ${ e.message.replace( /^usd-gltf: /, '' ) }` );
	process.exit( 1 );

}

await writeFile( output, result );
