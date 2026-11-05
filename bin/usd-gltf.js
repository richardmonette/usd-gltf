#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { detectFormat, usdToGLB, glbToUSD } from '../src/index.js';

const [ input, output ] = process.argv.slice( 2 );

if ( ! input || ! output ) {

	console.error( 'usage: usd-gltf <input.usd[a|c|z]|input.glb> <output.glb|output.usd[a|c|z]>' );
	process.exit( 1 );

}

const data = await readFile( input );
const from = detectFormat( data );
const to = extname( output ).slice( 1 ).toLowerCase();

let result;

if ( from === 'usda' || from === 'usdc' || from === 'usdz' ) {

	if ( to !== 'glb' ) throw new Error( `usd-gltf: cannot write .${ to } from USD, use .glb` );
	result = await usdToGLB( data );

} else if ( from === 'glb' || from === 'gltf' ) {

	const format = to === 'usd' ? 'usdc' : to;
	if ( format !== 'usda' && format !== 'usdc' && format !== 'usdz' ) throw new Error( `usd-gltf: cannot write .${ to } from glTF, use .usda, .usdc or .usdz` );
	result = await glbToUSD( data, { format } );

} else {

	throw new Error( `usd-gltf: unrecognised input ${ input }` );

}

await writeFile( output, result );
