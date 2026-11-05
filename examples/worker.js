// Runs conversions off the main thread. Receives the dropped files, returns the converted file
// plus a GLB of the result for previewing.

import { detectFormat, usdToGLB, glbToUSD } from '../src/index.js';

const USD = new Set( [ 'usda', 'usdc', 'usdz' ] );

function basename( path ) {

	return path.replace( /\\/g, '/' ).split( '/' ).pop();

}

self.onmessage = async ( { data: { files, main } } ) => {

	const logs = [];
	const log = ( message ) => logs.push( message );

	// resolve references between dropped files by relative path, then by file name
	const byPath = new Map( files.map( ( f ) => [ f.path.replace( /\\/g, '/' ), f.bytes ] ) );
	const byName = new Map( files.map( ( f ) => [ basename( f.path ), f.bytes ] ) );
	const dir = main.path.replace( /\\/g, '/' ).replace( /[^/]*$/, '' );
	const resolver = ( uri ) => {

		const clean = uri.replace( /^\.\//, '' );
		const bytes = byPath.get( dir + clean ) ?? byPath.get( clean ) ?? byName.get( basename( clean ) );
		if ( ! bytes ) throw new Error( `missing file ${ uri } (drop it together with ${ basename( main.path ) })` );
		return bytes;

	};

	try {

		const t0 = performance.now();
		const format = detectFormat( main.bytes );
		const name = basename( main.path ).replace( /\.[^.]*$/, '' );
		let output, preview, outputName;

		if ( USD.has( format ) ) {

			output = await usdToGLB( main.bytes, { identifier: basename( main.path ), resolver, log } );
			preview = output;
			outputName = name + '.glb';

		} else if ( format === 'glb' || format === 'gltf' ) {

			output = await glbToUSD( main.bytes, { resolver, log } );
			const t1 = performance.now();
			// preview what the usdz contains by reading it back
			preview = await usdToGLB( output, { identifier: name + '.usdz', log } );
			outputName = name + '.usdz';
			self.postMessage( { output, preview, outputName, from: format, ms: t1 - t0, logs }, [ output.buffer, preview.buffer ] );
			return;

		} else {

			throw new Error( 'not a USD (usda, usdc, usdz) or glTF (gltf, glb) file' );

		}

		self.postMessage( { output, preview, outputName, from: format, ms: performance.now() - t0, logs }, [ output.buffer ] );

	} catch ( e ) {

		self.postMessage( { error: e.message, logs } );

	}

};
